// Studio Giovani — servidor de render de vídeo
// Recebe o vídeo original + o overlay (PNG transparente, já desenhado no
// navegador) e queima um em cima do outro com o ffmpeg do sistema — bem
// mais rápido que rodar ffmpeg.wasm no navegador do cliente, principalmente
// em celular.

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const W = 1080;
const H = 1920;

// Domínios que podem chamar esse servidor. Aceita também qualquer preview
// do Cloudflare Pages (*.pages.dev) e localhost, pra facilitar teste.
const ALLOWED_ORIGINS = [
  'https://giovani.bustamante.stream',
  'https://studio-giovani-video.pages.dev',
];
function isOriginAllowed(origin) {
  if (!origin) return true; // requests sem origin (curl, health checks)
  if (origin === 'null') return true; // pagina html local aberta com file:// (protótipo de teste)
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.studio-giovani-video\.pages\.dev$/.test(origin)) return true;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  return false;
}

const app = express();
app.use(cors({
  origin: function (origin, cb) {
    cb(null, isOriginAllowed(origin));
  },
}));

// Limite de jobs simultâneos — instância pequena, evita derrubar o servidor
// se vários renders caírem ao mesmo tempo.
const MAX_CONCURRENT = 2;
let activeJobs = 0;

const upload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, os.tmpdir());
    },
    filename: function (req, file, cb) {
      var id = req.jobId || (req.jobId = crypto.randomUUID());
      var suffix = file.fieldname === 'overlay' ? 'overlay.png' : 'input.mp4';
      cb(null, id + '-' + suffix);
    },
  }),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB por arquivo, bem folgado pra um Reels
  },
});

app.get('/', function (req, res) {
  res.status(200).send('Studio Giovani video server — ok');
});
app.get('/health', function (req, res) {
  res.status(200).json({ ok: true });
});

// Roda o ffmpeg com os args dados e resolve quando termina (nunca rejeita —
// devolve sempre {code, stderrTail}, com code=null se nem chegou a iniciar).
function runFfmpeg(args) {
  var stderrTail = '';
  var proc;
  try {
    proc = spawn('ffmpeg', args);
  } catch (err) {
    return { promise: Promise.resolve({ code: null, stderrTail: '', spawnError: err }), kill: function () {} };
  }
  proc.stderr.on('data', function (chunk) {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  var promise = new Promise(function (resolve) {
    var settled = false;
    proc.on('error', function (err) {
      if (settled) return;
      settled = true;
      resolve({ code: null, stderrTail: stderrTail, spawnError: err });
    });
    proc.on('close', function (code, signal) {
      if (settled) return;
      settled = true;
      resolve({ code: code, signal: signal, stderrTail: stderrTail });
    });
  });
  return { promise: promise, kill: function () { try { proc.kill('SIGKILL'); } catch (e) {} } };
}

function runFfmpegWithTimeout(args, timeoutMs) {
  var run = runFfmpeg(args);
  var timedOut = false;
  var timer = setTimeout(function () {
    timedOut = true;
    run.kill();
  }, timeoutMs);
  return run.promise.then(function (result) {
    clearTimeout(timer);
    result.timedOut = timedOut;
    return result;
  });
}

app.post('/render', function (req, res, next) {
  if (activeJobs >= MAX_CONCURRENT) {
    return res.status(503).json({ error: 'Servidor ocupado, tenta de novo em alguns segundos.' });
  }
  next();
}, upload.fields([{ name: 'video', maxCount: 1 }, { name: 'overlay', maxCount: 1 }]), async function (req, res) {
  var videoFile = req.files && req.files.video && req.files.video[0];
  var overlayFile = req.files && req.files.overlay && req.files.overlay[0];

  if (!videoFile || !overlayFile) {
    await cleanupFiles([videoFile, overlayFile]);
    return res.status(400).json({ error: 'Envie o campo "video" e o campo "overlay" (PNG).' });
  }

  var outputPath = path.join(os.tmpdir(), (req.jobId || crypto.randomUUID()) + '-output.mp4');
  // "format=auto" no overlay deixa o ffmpeg escolher o pixel format --
  // como o overlay tem alpha, ele quase sempre escolhe yuv444p (3 planos em
  // resolucao cheia) em vez do yuv420p padrao. Isso, combinado com o
  // ffmpeg detectando dezenas de "cpus" dentro do container (mas so tendo
  // a memoria de uma instancia pequena de verdade), faz o libx264 abrir
  // threads e buffers demais e o processo morre (OOM/kill do container --
  // Node ve so "code: null", sem mensagem de erro nenhuma). Forcamos
  // yuv420p (padrao pra Reels/Stories de qualquer forma) e limitamos as
  // threads do encoder pra manter o uso de memoria previsivel.
  var filter =
    '[0:v]scale=' + W + ':' + H + ':force_original_aspect_ratio=increase,' +
    'crop=' + W + ':' + H + ',setsar=1[bg];' +
    '[bg][1:v]overlay=0:0:format=auto,format=yuv420p[outv]';
  var ENCODE_THREADS = process.env.FFMPEG_THREADS || '2';

  var withAudioArgs = [
    '-y',
    '-i', videoFile.path,
    '-i', overlayFile.path,
    '-filter_complex', filter,
    '-map', '[outv]', '-map', '0:a?',
    '-c:v', 'libx264', '-threads', ENCODE_THREADS, '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-movflags', '+faststart',
    outputPath,
  ];
  // Alguns celulares (iPhone com audio espacial, por exemplo) gravam o
  // audio num codec que esse ffmpeg nao sabe decodificar ("unknown
  // codec") -- a 1a tentativa falha inteira por causa disso. Em vez de
  // devolver erro pro usuario, tentamos de novo sem audio: o Reels/Stories
  // deixa adicionar musica por cima depois de qualquer forma.
  var noAudioArgs = [
    '-y',
    '-i', videoFile.path,
    '-i', overlayFile.path,
    '-filter_complex', filter,
    '-map', '[outv]',
    '-c:v', 'libx264', '-threads', ENCODE_THREADS, '-preset', 'veryfast', '-crf', '23',
    '-an', '-movflags', '+faststart',
    outputPath,
  ];

  activeJobs++;
  try {
    var result = await runFfmpegWithTimeout(withAudioArgs, 5 * 60 * 1000);

    if (result.code !== 0 && !result.timedOut) {
      console.error('[render] 1a tentativa (com audio) falhou, codigo', result.code, 'sinal', result.signal, '| stderr:', result.stderrTail.slice(-800));
      await fsp.unlink(outputPath).catch(function () {});
      result = await runFfmpegWithTimeout(noAudioArgs, 5 * 60 * 1000);
      if (result.code !== 0 && !result.timedOut) {
        console.error('[render] 2a tentativa (sem audio) tambem falhou, codigo', result.code, 'sinal', result.signal, '| stderr:', result.stderrTail.slice(-800));
      }
    }

    if (result.timedOut) {
      await cleanupFiles([videoFile, overlayFile, { path: outputPath }]);
      if (!res.headersSent) {
        res.status(504).json({ error: 'O processamento demorou demais e foi cancelado. Tenta com um vídeo menor.' });
      }
      return;
    }

    if (result.code !== 0) {
      await cleanupFiles([videoFile, overlayFile, { path: outputPath }]);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Não deu pra gerar o vídeo. Tenta de novo, ou com outro arquivo.' });
      }
      return;
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="giovani-video.mp4"');
    var readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);
    readStream.on('close', function () {
      cleanupFiles([videoFile, overlayFile, { path: outputPath }]);
    });
    readStream.on('error', function (err) {
      console.error('[render] falha lendo o arquivo final:', err);
      cleanupFiles([videoFile, overlayFile, { path: outputPath }]);
      if (!res.headersSent) res.status(500).end();
    });
  } catch (err) {
    console.error('[render] erro inesperado:', err);
    await cleanupFiles([videoFile, overlayFile, { path: outputPath }]);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Não consegui processar o vídeo no servidor.' });
    }
  } finally {
    activeJobs--;
  }
});

// --- auto edit: recebe N clipes brutos + os trechos (inicio/fim em
// segundos, na mesma ordem dos clipes) escolhidos por uma IA de visão no
// cliente, corta cada um, normaliza pra 1080x1920 (padrao Reels/Stories,
// senao o concat quebra com clipes de resolucao/orientacao diferentes) e
// junta tudo num video final só, na ordem recebida. V0: sem áudio (ver
// comentario no /render sobre codec de audio de iPhone — aqui, com N
// clipes de fontes diferentes, é bem mais provável de dar problema, e o
// pedido original nem precisava de trilha sonora).
const uploadClips = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, os.tmpdir());
    },
    filename: function (req, file, cb) {
      var id = req.jobId || (req.jobId = crypto.randomUUID());
      var idx = req._clipCounter === undefined ? (req._clipCounter = 0) : ++req._clipCounter;
      cb(null, id + '-clip' + idx + '.mp4');
    },
  }),
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 10,
  },
});

app.post('/autoedit', function (req, res, next) {
  if (activeJobs >= MAX_CONCURRENT) {
    return res.status(503).json({ error: 'Servidor ocupado, tenta de novo em alguns segundos.' });
  }
  next();
}, uploadClips.array('clips', 10), async function (req, res) {
  var clipFiles = req.files || [];

  var segments;
  try {
    segments = JSON.parse(req.body.segments || '[]');
  } catch (e) {
    await cleanupFiles(clipFiles);
    return res.status(400).json({ error: 'Campo "segments" precisa ser um JSON válido (array de {inicio, fim}).' });
  }

  if (!clipFiles.length || clipFiles.length !== segments.length) {
    await cleanupFiles(clipFiles);
    return res.status(400).json({ error: 'O número de vídeos enviados não bate com o número de trechos em "segments".' });
  }

  var jobId = req.jobId || crypto.randomUUID();
  var trimmedPaths = clipFiles.map(function (f, i) {
    return path.join(os.tmpdir(), jobId + '-trim' + i + '.mp4');
  });
  var concatListPath = path.join(os.tmpdir(), jobId + '-concat.txt');
  var outputPath = path.join(os.tmpdir(), jobId + '-autoedit-output.mp4');
  var ENCODE_THREADS = process.env.FFMPEG_THREADS || '2';
  var allTempPaths = clipFiles.map(function (f) { return f.path; })
    .concat(trimmedPaths, [concatListPath, outputPath]);

  function cleanupAll() {
    return cleanupFiles(allTempPaths.map(function (p) { return { path: p }; }));
  }

  activeJobs++;
  try {
    // 1) corta e normaliza cada clipe pro mesmo formato (senao o concat
    // por stream copy do passo 2 falha ou sai com aspecto/tamanho errado)
    for (var i = 0; i < clipFiles.length; i++) {
      var seg = segments[i] || {};
      var inicio = Number(seg.inicio);
      var fim = Number(seg.fim);
      if (!isFinite(inicio) || inicio < 0) inicio = 0;
      var dur = (isFinite(fim) && fim > inicio) ? (fim - inicio) : 4;

      var trimArgs = [
        '-y',
        '-ss', String(inicio),
        '-i', clipFiles[i].path,
        '-t', String(dur),
        '-vf', 'scale=' + W + ':' + H + ':force_original_aspect_ratio=increase,crop=' + W + ':' + H + ',setsar=1,fps=30',
        '-an',
        '-c:v', 'libx264', '-threads', ENCODE_THREADS, '-preset', 'veryfast', '-crf', '23',
        trimmedPaths[i],
      ];
      var trimResult = await runFfmpegWithTimeout(trimArgs, 3 * 60 * 1000);
      if (trimResult.code !== 0) {
        console.error('[autoedit] falha cortando clipe ' + i + ', codigo', trimResult.code, 'sinal', trimResult.signal, '| stderr:', trimResult.stderrTail.slice(-800));
        await cleanupAll();
        if (!res.headersSent) {
          res.status(500).json({ error: 'Não deu pra cortar o clipe ' + (i + 1) + '. Tenta com outro arquivo.' });
        }
        return;
      }
    }

    // 2) concatena os trechos já normalizados — como todos saíram do
    // passo 1 com o mesmo codec/resolução/fps, dá pra juntar com stream
    // copy (rápido, sem recodificar de novo)
    var listContent = trimmedPaths.map(function (p) {
      return "file '" + p.replace(/'/g, "'\\''") + "'";
    }).join('\n');
    await fsp.writeFile(concatListPath, listContent);

    var concatArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', outputPath];
    var concatResult = await runFfmpegWithTimeout(concatArgs, 2 * 60 * 1000);
    if (concatResult.code !== 0) {
      console.error('[autoedit] falha concatenando, codigo', concatResult.code, 'sinal', concatResult.signal, '| stderr:', concatResult.stderrTail.slice(-800));
      await cleanupAll();
      if (!res.headersSent) {
        res.status(500).json({ error: 'Não deu pra juntar os clipes.' });
      }
      return;
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="giovani-autoedit.mp4"');
    var readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);
    readStream.on('close', function () {
      cleanupAll();
    });
    readStream.on('error', function (err) {
      console.error('[autoedit] falha lendo o arquivo final:', err);
      cleanupAll();
      if (!res.headersSent) res.status(500).end();
    });
  } catch (err) {
    console.error('[autoedit] erro inesperado:', err);
    await cleanupAll();
    if (!res.headersSent) {
      res.status(500).json({ error: 'Não consegui processar o auto edit no servidor.' });
    }
  } finally {
    activeJobs--;
  }
});

async function cleanupFiles(files) {
  await Promise.all((files || []).filter(Boolean).map(function (f) {
    return fsp.unlink(f.path).catch(function () {});
  }));
}

// Limpeza de segurança: qualquer arquivo temporário nosso mais velho que
// 30 minutos (caso algum request tenha morrido sem limpar) é apagado.
setInterval(function () {
  var dir = os.tmpdir();
  fs.readdir(dir, function (err, files) {
    if (err) return;
    var now = Date.now();
    files.forEach(function (name) {
      if (!/^[0-9a-f-]{36}-(input\.mp4|overlay\.png|output\.mp4)$/.test(name)) return;
      var fp = path.join(dir, name);
      fs.stat(fp, function (err, stat) {
        if (err) return;
        if (now - stat.mtimeMs > 30 * 60 * 1000) {
          fs.unlink(fp, function () {});
        }
      });
    });
  });
}, 10 * 60 * 1000);

app.use(function (err, req, res, next) {
  console.error('[server] erro não tratado:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erro interno no servidor.' });
});

app.listen(PORT, function () {
  console.log('Studio Giovani video server ouvindo na porta ' + PORT);
});
