// Studio Giovani — servidor de vídeo + IA
//
// /render            vídeo + overlay PNG -> MP4 com a arte queimada (ffmpeg)
// /autoedit          N clipes + trechos já escolhidos -> um vídeo só
// /autoedit/smart    N clipes -> IA (Gemini) monta a edição -> um vídeo só
// /enhance-photo     foto -> IA (Gemini imagem) devolve a foto tratada
//
// A chave do Gemini vive SÓ aqui, na variável de ambiente GEMINI_API_KEY do
// Railway. Ela nunca vai pro navegador e nunca aparece em log.

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
const ENCODE_THREADS = process.env.FFMPEG_THREADS || '2';

// --- Gemini (configurável por variável de ambiente, sem mexer no código) ---
const GEMINI_API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com';
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash';
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const GEMINI_IMAGE_SIZE = process.env.GEMINI_IMAGE_SIZE || '4K';
// preço por 1M tokens do modelo de texto/vídeo (só pra mostrar custo estimado)
const PRICE_IN_PER_M = Number(process.env.GEMINI_PRICE_IN_PER_M || 0.75);
const PRICE_OUT_PER_M = Number(process.env.GEMINI_PRICE_OUT_PER_M || 3.75);

function geminiKey() {
  return (process.env.GEMINI_API_KEY || '').trim();
}

// Domínios que podem chamar esse servidor. Aceita também qualquer preview
// do Cloudflare Pages (*.pages.dev) e localhost, pra facilitar teste.
const ALLOWED_ORIGINS = [
  'https://giovani.bustamante.stream',
  'https://studio-giovani-video.pages.dev',
];
function isKnownSiteOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.studio-giovani-video\.pages\.dev$/.test(origin)) return true;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  return false;
}
function isOriginAllowed(origin) {
  if (!origin) return true; // requests sem origin (curl, health checks)
  if (origin === 'null') return true; // pagina html local aberta com file:// (só nos endpoints sem IA)
  return isKnownSiteOrigin(origin);
}

const app = express();
app.set('trust proxy', true); // Railway fica atrás de proxy — req.ip vem do X-Forwarded-For
app.use(cors({
  origin: function (origin, cb) {
    cb(null, isOriginAllowed(origin));
  },
  exposedHeaders: ['X-Autoedit-Plan'],
}));

// Endpoints que gastam crédito do Gemini só aceitam chamadas vindas do site
// (o navegador sempre manda Origin em POST cross-origin). Não é segurança
// absoluta, mas evita que qualquer um use a chave de graça.
function requireSiteOrigin(req, res, next) {
  if (process.env.ALLOW_ANY_ORIGIN_FOR_AI === '1') return next();
  if (isKnownSiteOrigin(req.headers.origin)) return next();
  return res.status(403).json({ error: 'Esse recurso só funciona pelo site do Studio Giovani.' });
}

// Limite simples por IP (memória) + teto diário global, pra conta do Gemini
// não disparar se alguém abusar.
function makeRateLimiter(name, perIpPerHour, globalPerDay) {
  var hits = new Map();
  var day = { key: '', count: 0 };
  return function (req, res, next) {
    var now = Date.now();
    var today = new Date().toISOString().slice(0, 10);
    if (day.key !== today) { day.key = today; day.count = 0; }
    if (day.count >= globalPerDay) {
      return res.status(429).json({ error: 'Limite diário de uso da IA atingido. Tenta de novo amanhã.' });
    }
    var ip = req.ip || 'desconhecido';
    var list = (hits.get(ip) || []).filter(function (t) { return now - t < 60 * 60 * 1000; });
    if (list.length >= perIpPerHour) {
      hits.set(ip, list);
      return res.status(429).json({ error: 'Muitos pedidos seguidos. Espera um pouco e tenta de novo.' });
    }
    list.push(now);
    hits.set(ip, list);
    day.count++;
    if (hits.size > 5000) hits.clear();
    next();
  };
}
const enhanceLimiter = makeRateLimiter('enhance', Number(process.env.ENHANCE_PER_IP_HOUR || 40), Number(process.env.ENHANCE_PER_DAY || 400));
const smartEditLimiter = makeRateLimiter('smart', Number(process.env.SMART_PER_IP_HOUR || 15), Number(process.env.SMART_PER_DAY || 150));

// Limite de jobs de ffmpeg simultâneos — instância pequena, evita derrubar o
// servidor se vários renders caírem ao mesmo tempo.
const MAX_CONCURRENT = 2;
let activeJobs = 0;
// Chamadas de IA de foto quase não usam CPU (é espera de rede), então têm
// um limite separado.
const MAX_AI_CONCURRENT = 4;
let activeAiJobs = 0;

function tempName(id, suffix) {
  return path.join(os.tmpdir(), 'sg-' + id + '-' + suffix);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) { cb(null, os.tmpdir()); },
    filename: function (req, file, cb) {
      var id = req.jobId || (req.jobId = crypto.randomUUID());
      var suffix = file.fieldname === 'overlay' ? 'overlay.png' : 'input.mp4';
      cb(null, 'sg-' + id + '-' + suffix);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

const uploadClips = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) { cb(null, os.tmpdir()); },
    filename: function (req, file, cb) {
      var id = req.jobId || (req.jobId = crypto.randomUUID());
      if (file.fieldname === 'voice') return cb(null, 'sg-' + id + '-voice-raw');
      var idx = req._clipCounter === undefined ? (req._clipCounter = 0) : ++req._clipCounter;
      cb(null, 'sg-' + id + '-clip' + idx + '.mp4');
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024, files: 11 },
});

const uploadPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

app.get('/', function (req, res) {
  res.status(200).send('Studio Giovani video server — ok');
});
app.get('/health', function (req, res) {
  res.status(200).json({
    ok: true,
    ia: { chaveConfigurada: !!geminiKey(), modeloEdicao: GEMINI_TEXT_MODEL, modeloFoto: GEMINI_IMAGE_MODEL, tamanhoFoto: GEMINI_IMAGE_SIZE },
  });
});

// ============================ ffmpeg helpers ============================

// Roda um binário (ffmpeg/ffprobe) e resolve quando termina (nunca rejeita —
// devolve sempre {code, stdout, stderrTail}, com code=null se nem iniciou).
function runProcess(bin, args) {
  var stderrTail = '';
  var stdout = '';
  var proc;
  try {
    proc = spawn(bin, args);
  } catch (err) {
    return { promise: Promise.resolve({ code: null, stdout: '', stderrTail: '', spawnError: err }), kill: function () {} };
  }
  proc.stdout.on('data', function (chunk) { stdout = (stdout + chunk.toString()).slice(-20000); });
  proc.stderr.on('data', function (chunk) { stderrTail = (stderrTail + chunk.toString()).slice(-4000); });
  var promise = new Promise(function (resolve) {
    var settled = false;
    proc.on('error', function (err) {
      if (settled) return;
      settled = true;
      resolve({ code: null, stdout: stdout, stderrTail: stderrTail, spawnError: err });
    });
    proc.on('close', function (code, signal) {
      if (settled) return;
      settled = true;
      resolve({ code: code, signal: signal, stdout: stdout, stderrTail: stderrTail });
    });
  });
  return { promise: promise, kill: function () { try { proc.kill('SIGKILL'); } catch (e) {} } };
}

function runWithTimeout(bin, args, timeoutMs) {
  var run = runProcess(bin, args);
  var timedOut = false;
  var timer = setTimeout(function () { timedOut = true; run.kill(); }, timeoutMs);
  return run.promise.then(function (result) {
    clearTimeout(timer);
    result.timedOut = timedOut;
    return result;
  });
}

function runFfmpegWithTimeout(args, timeoutMs) {
  return runWithTimeout('ffmpeg', args, timeoutMs);
}

// Duração do vídeo em segundos (ou null se não deu pra ler).
async function probeDuration(filePath) {
  var r = await runWithTimeout('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath], 30 * 1000);
  var d = parseFloat((r.stdout || '').trim());
  return isFinite(d) && d > 0 ? d : null;
}

// Garante um trecho válido dentro da duração real do clipe (a IA às vezes
// sugere tempo além do fim do vídeo, e o ffmpeg aí gera um arquivo vazio).
function clampSegment(inicio, fim, duration) {
  inicio = Number(inicio);
  fim = Number(fim);
  if (!isFinite(inicio) || inicio < 0) inicio = 0;
  var dur = isFinite(duration) && duration > 0 ? duration : null;
  if (dur !== null) {
    if (inicio > dur - 0.6) inicio = Math.max(0, dur - 2);
    if (!isFinite(fim) || fim <= inicio + 0.4) fim = Math.min(dur, inicio + 3);
    if (fim > dur) fim = dur;
  } else if (!isFinite(fim) || fim <= inicio + 0.4) {
    fim = inicio + 3;
  }
  return { inicio: Math.round(inicio * 100) / 100, fim: Math.round(fim * 100) / 100 };
}

// Corta cada item {path, inicio, fim, hold?}, normaliza pra 1080x1920/30fps/yuv420p
// (yuv420p é essencial: vídeo HDR/10-bit de iPhone senão vira H.264 "High 10",
// que não toca em navegador nem no Instagram) e junta na ordem recebida.
// "hold" congela o último quadro por N segundos (usado quando a locução é
// mais longa que o material disponível). Se opts.audioPath vier, a trilha
// (locução já tratada) entra como áudio do vídeo final.
async function trimAndConcat(items, jobId, opts) {
  opts = opts || {};
  var trimmedPaths = items.map(function (it, i) { return tempName(jobId, 'trim' + i + '.mp4'); });
  var concatListPath = tempName(jobId, 'concat.txt');
  var videoOnlyPath = tempName(jobId, 'concat-video.mp4');
  var outputPath = tempName(jobId, 'autoedit-output.mp4');
  var temps = trimmedPaths.concat([concatListPath, videoOnlyPath]);

  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var vf = 'scale=' + W + ':' + H + ':force_original_aspect_ratio=increase,crop=' + W + ':' + H + ',setsar=1,fps=30';
    if (it.hold && it.hold > 0.05) vf += ',tpad=stop_mode=clone:stop_duration=' + it.hold.toFixed(2);
    vf += ',format=yuv420p';
    var trimArgs = [
      '-y',
      '-ss', String(it.inicio),
      '-t', String(Math.max(0.4, it.fim - it.inicio)),
      '-i', it.path,
      '-vf', vf,
      '-an',
      '-c:v', 'libx264', '-threads', ENCODE_THREADS, '-preset', 'veryfast', '-crf', '21',
      trimmedPaths[i],
    ];
    var trimResult = await runFfmpegWithTimeout(trimArgs, 3 * 60 * 1000);
    if (trimResult.code !== 0) {
      console.error('[autoedit] falha cortando clipe ' + i + ', codigo', trimResult.code, 'sinal', trimResult.signal, '| stderr:', trimResult.stderrTail.slice(-800));
      await cleanupPaths(temps.concat([outputPath]));
      return { ok: false, error: 'Não deu pra cortar o clipe ' + (i + 1) + '. Tenta com outro arquivo.' };
    }
  }

  var listContent = trimmedPaths.map(function (p) { return "file '" + p.replace(/'/g, "'\\''") + "'"; }).join('\n');
  await fsp.writeFile(concatListPath, listContent);
  var concatTarget = opts.audioPath ? videoOnlyPath : outputPath;
  var concatArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', '-movflags', '+faststart', concatTarget];
  var concatResult = await runFfmpegWithTimeout(concatArgs, 2 * 60 * 1000);
  if (concatResult.code !== 0) {
    console.error('[autoedit] falha concatenando, codigo', concatResult.code, 'sinal', concatResult.signal, '| stderr:', concatResult.stderrTail.slice(-800));
    await cleanupPaths(temps.concat([outputPath]));
    return { ok: false, error: 'Não deu pra juntar os clipes.' };
  }

  if (opts.audioPath) {
    var muxArgs = [
      '-y', '-i', videoOnlyPath, '-i', opts.audioPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
      '-movflags', '+faststart', outputPath,
    ];
    var muxResult = await runFfmpegWithTimeout(muxArgs, 2 * 60 * 1000);
    if (muxResult.code !== 0) {
      console.error('[autoedit] falha juntando a locução, codigo', muxResult.code, '| stderr:', muxResult.stderrTail.slice(-800));
      await cleanupPaths(temps.concat([outputPath]));
      return { ok: false, error: 'Não deu pra colocar a locução no vídeo.' };
    }
  }
  await cleanupPaths(temps);
  return { ok: true, outputPath: outputPath };
}

// Trata a locução gravada no celular/navegador: tira ruído de fundo e grave
// de manuseio, comprime de leve, corta silêncio do começo e do fim e deixa
// o volume no padrão de redes sociais (-16 LUFS). Gera também um WAV leve
// (16 kHz mono) só pra IA ouvir.
async function prepareVoice(rawPath, jobId) {
  var cleanPath = tempName(jobId, 'voice-clean.m4a');
  var aiPath = tempName(jobId, 'voice-ai.wav');
  var af = [
    'highpass=f=80',
    'afftdn=nf=-25',
    'silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB',
    'areverse',
    'silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB',
    'areverse',
    'acompressor=threshold=-20dB:ratio=3:attack=10:release=150:makeup=2',
    'loudnorm=I=-16:TP=-1.5:LRA=11',
    'adelay=300:all=1',
  ].join(',');
  var r = await runFfmpegWithTimeout(['-y', '-i', rawPath, '-vn', '-af', af, '-ac', '1', '-ar', '48000', '-c:a', 'aac', '-b:a', '160k', cleanPath], 2 * 60 * 1000);
  if (r.code !== 0) {
    console.error('[voz] falha tratando a locução, codigo', r.code, '| stderr:', r.stderrTail.slice(-800));
    await cleanupPaths([cleanPath]);
    return null;
  }
  var dur = await probeDuration(cleanPath);
  if (!dur || dur < 0.8) {
    await cleanupPaths([cleanPath]);
    return { empty: true };
  }
  var r2 = await runFfmpegWithTimeout(['-y', '-i', cleanPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', aiPath], 60 * 1000);
  if (r2.code !== 0) {
    await cleanupPaths([cleanPath, aiPath]);
    return null;
  }
  return { cleanPath: cleanPath, aiPath: aiPath, duracao: dur };
}

function streamFileAndCleanup(res, filePath, contentType, downloadName, cleanup) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', 'attachment; filename="' + downloadName + '"');
  var readStream = fs.createReadStream(filePath);
  readStream.pipe(res);
  readStream.on('close', function () { cleanup(); });
  readStream.on('error', function (err) {
    console.error('[stream] falha lendo o arquivo final:', err);
    cleanup();
    if (!res.headersSent) res.status(500).end();
  });
}

// ================================ /render ================================

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

  var outputPath = tempName(req.jobId || crypto.randomUUID(), 'output.mp4');
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

  var withAudioArgs = [
    '-y', '-i', videoFile.path, '-i', overlayFile.path,
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
    '-y', '-i', videoFile.path, '-i', overlayFile.path,
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
      if (!res.headersSent) res.status(504).json({ error: 'O processamento demorou demais e foi cancelado. Tenta com um vídeo menor.' });
      return;
    }
    if (result.code !== 0) {
      await cleanupFiles([videoFile, overlayFile, { path: outputPath }]);
      if (!res.headersSent) res.status(500).json({ error: 'Não deu pra gerar o vídeo. Tenta de novo, ou com outro arquivo.' });
      return;
    }

    streamFileAndCleanup(res, outputPath, 'video/mp4', 'giovani-video.mp4', function () {
      cleanupFiles([videoFile, overlayFile, { path: outputPath }]);
    });
  } catch (err) {
    console.error('[render] erro inesperado:', err);
    await cleanupFiles([videoFile, overlayFile, { path: outputPath }]);
    if (!res.headersSent) res.status(500).json({ error: 'Não consegui processar o vídeo no servidor.' });
  } finally {
    activeJobs--;
  }
});

// ========================= /autoedit (manual) =========================
// Recebe N clipes + os trechos (inicio/fim em segundos, na ORDEM FINAL do
// vídeo — os clipes já vêm na ordem da montagem), corta e junta.
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
  if (!clipFiles.length || !Array.isArray(segments) || clipFiles.length !== segments.length) {
    await cleanupFiles(clipFiles);
    return res.status(400).json({ error: 'O número de vídeos enviados não bate com o número de trechos em "segments".' });
  }

  var jobId = req.jobId || crypto.randomUUID();
  activeJobs++;
  try {
    var items = [];
    for (var i = 0; i < clipFiles.length; i++) {
      var dur = await probeDuration(clipFiles[i].path);
      var seg = clampSegment((segments[i] || {}).inicio, (segments[i] || {}).fim, dur);
      items.push({ path: clipFiles[i].path, inicio: seg.inicio, fim: seg.fim });
    }
    var out = await trimAndConcat(items, jobId);
    if (!out.ok) {
      await cleanupFiles(clipFiles);
      if (!res.headersSent) res.status(500).json({ error: out.error });
      return;
    }
    streamFileAndCleanup(res, out.outputPath, 'video/mp4', 'giovani-autoedit.mp4', function () {
      cleanupFiles(clipFiles.concat([{ path: out.outputPath }]));
    });
  } catch (err) {
    console.error('[autoedit] erro inesperado:', err);
    await cleanupFiles(clipFiles);
    if (!res.headersSent) res.status(500).json({ error: 'Não consegui processar o auto edit no servidor.' });
  } finally {
    activeJobs--;
  }
});

// ============================ Gemini helpers ============================

class GeminiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function callGemini(apiVersion, model, body, timeoutMs) {
  var key = geminiKey();
  if (!key) throw new GeminiError('Chave do Gemini não configurada no servidor.', 0, '');
  var url = GEMINI_API_BASE + '/' + apiVersion + '/models/' + encodeURIComponent(model) + ':generateContent';
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  var res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') throw new GeminiError('A IA demorou demais pra responder.', 504, '');
    throw new GeminiError('Não consegui falar com a IA do Google.', 502, String(err && err.message || err));
  }
  var raw = await res.text();
  clearTimeout(timer);
  if (!res.ok) {
    throw new GeminiError('A IA do Google recusou o pedido (HTTP ' + res.status + ').', res.status, raw.slice(0, 1200));
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new GeminiError('Resposta da IA veio num formato inesperado.', 502, raw.slice(0, 600));
  }
}

function responseParts(json) {
  var cand = json && json.candidates && json.candidates[0];
  return (cand && cand.content && cand.content.parts) || [];
}

function responseText(json) {
  return responseParts(json).map(function (p) { return p.text || ''; }).join('');
}

function geminiErrorResponse(res, err, fallbackMsg) {
  if (err instanceof GeminiError) {
    console.error('[gemini] ' + err.message, err.detail || '');
    if (err.status === 0) return res.status(503).json({ error: err.message });
    if (err.status === 429) return res.status(429).json({ error: 'A cota da IA do Google estourou por agora. Espera um minuto e tenta de novo.' });
    if (err.status === 401 || err.status === 403) return res.status(502).json({ error: 'A chave do Gemini no servidor foi recusada pelo Google (inválida ou sem permissão).' });
    if (err.status === 504) return res.status(504).json({ error: err.message });
    return res.status(502).json({ error: err.message });
  }
  console.error('[gemini] erro inesperado:', err);
  return res.status(500).json({ error: fallbackMsg });
}

// ========================= /autoedit/smart =========================

function buildEditPrompt(clips, targetSeconds, voice) {
  var lista = clips.map(function (c) {
    return '- Clipe ' + c.indice + ': duração real ' + c.duracao.toFixed(1) + 's';
  }).join('\n');
  var n = clips.length;
  var minIncluidos = Math.max(2, Math.ceil(n * 0.7));
  var comVoz = !!voice;

  var abertura = [
    'Você é um montador com 15 anos de carreira editando vídeo de imóveis para imobiliárias — e ao mesmo tempo um editor nativo de TikTok e Reels que roda mídia paga: sabe que o vídeo morre nos primeiros 2 segundos se o hook for fraco, pensa em taxa de retenção, e monta no CapCut todo dia (cortes secos no movimento, ritmo que não deixa o dedo rolar a tela).',
    '',
    'Vou te mandar ' + n + ' clipes brutos de UM imóvel à venda, filmados no celular/gimbal, identificados como "Clipe 0", "Clipe 1"… na ordem de envio — que NÃO é a ordem do vídeo. A ordem é decisão sua. Os vídeos chegam em baixa resolução só pra análise; os tempos que você devolver serão aplicados no arquivo original, com a mesma linha do tempo. Duração real de cada clipe:',
    lista,
    '',
  ];

  var formato = comVoz
    ? [
      'O vídeo final: vertical 9:16, cortes secos (sem transição), e o ÁUDIO É A LOCUÇÃO do corretor, que vem por último, depois dos clipes, marcada como "Locução". Ela já está tratada e começa em 0.3s. O vídeo vai ter a duração da locução: a soma das durações de todos os trechos incluídos precisa dar ' + targetSeconds.toFixed(1) + ' segundos (tolerância de meio segundo). A voz manda no ritmo; a imagem serve à fala.',
      '',
    ]
    : [
      'O vídeo final: vertical 9:16, SEM trilha e SEM texto — só imagem. Cortes secos (sem transição). Duração total alvo: cerca de ' + targetSeconds + ' segundos. Sem música, o ritmo visual é a única coisa que segura a pessoa.',
      '',
    ];

  var regras = [
    'Como você monta (siga nessa ordem de prioridade):',
    '',
    '1. ASSISTA ' + (comVoz ? 'E OUÇA ' : '') + 'TUDO ANTES DE DECIDIR. Identifique o ambiente de cada clipe, o movimento de câmera (push-in, pull-out, pan pra esquerda/direita, tilt, travelling lateral, parado) e dê uma nota visual de 0 a 10 (luz, nitidez, estabilidade, quão vendável é o ambiente).' + (comVoz ? ' Transcreva a locução com os tempos de cada frase.' : ''),
    '',
  ];
  if (comVoz) {
    regras = regras.concat([
      '2. IMAGEM CASADA COM A FALA (a regra mais importante). Quando o corretor fala de um ambiente ou de uma característica ("sala integrada", "cozinha planejada", "suíte", "varanda", "vista"), o clipe desse ambiente precisa estar na tela NAQUELE momento. Monte a linha do tempo seguindo a ordem da fala: a ordem dos cortes é a ordem em que os ambientes são citados. Cada corte começa na pausa antes da frase (ou no começo da menção) e vai até a próxima menção — cortes caem nas pausas entre frases, nunca no meio de uma palavra.',
      '',
      '3. HOOK (ordem 0). O primeiro corte acompanha a primeira frase. Se a primeira frase não cita um ambiente específico (ex.: "Olha esse apartamento em Icaraí"), abre com o plano mais impactante do lote: vista, sala ampla com luz, varanda, um reveal — nunca corredor, banheiro ou plano escuro. Começa com a câmera já em movimento.',
      '',
      '4. TRECHOS SEM MENÇÃO. Se a locução fala de algo geral (preço, localização, chamada pra ação), use o plano mais bonito que ainda não foi usado, ou o que acompanha melhor o tom. O fechamento (último corte) fica num plano aberto e forte enquanto ele faz a chamada final.',
      '',
      '5. CONTINUIDADE E PONTO DE CORTE. Prefira movimentos que continuam na mesma direção entre cortes seguidos; evite colar movimentos opostos e dois planos parados seguidos. Corte no movimento, nunca na câmera arrancando ou freando. Evite os primeiros e últimos ~0.5s de cada clipe. Nenhum trecho com pessoa, mão, reflexo do cinegrafista, desfoque ou tremida forte.',
      '',
      '6. DURAÇÕES. Aqui quem define a duração é a fala: um corte pode ir de 1.2s até o clipe inteiro. Se a locução for mais longa que o material bom, use trechos maiores dos clipes; se for curta, use menos clipes. Clipes que não couberem ou não tiverem relação com a fala: "incluir": false.',
      '',
    ]);
  } else {
    regras = regras.concat([
      '2. HOOK (ordem 0). Abre com o plano mais impactante do lote: vista, sala ampla com luz natural, varanda, piscina, cozinha gourmet, um reveal. Nunca abre com corredor, banheiro, lavanderia ou plano escuro. O corte do hook é curto (1.2 a 2.2s) e já começa com a câmera em movimento — nada de começo parado ou "respiro".',
      '',
      '3. PERCURSO. Depois do hook, monte uma visita que faça sentido no espaço: área social → cozinha → quartos (suíte por último entre os quartos) → banheiros → diferenciais (varanda, vista, lazer). Pode quebrar essa lógica se isso melhorar o ritmo ou a continuidade de movimento.',
      '',
      '4. CONTINUIDADE DE MOVIMENTO (o que separa montagem amadora de profissional). Entre dois cortes seguidos, prefira movimentos que continuam na mesma direção (pan pra direita → pan pra direita, push-in → push-in) ou que se completam (fim de um travelling → começo de outro no mesmo sentido). Evite colar movimentos opostos (pan pra direita seguido de pan pra esquerda) e evite dois planos parados seguidos.',
      '',
      '5. PONTO DE CORTE. Corte NO movimento, nunca no início da câmera arrancando nem no fim dela freando. Descarte os primeiros ~0.5s e os últimos ~0.5s de cada clipe (tremida de apertar o botão), a não ser que o clipe seja curto demais pra isso. Nenhum trecho pode ter pessoa, mão, reflexo do cinegrafista em destaque, desfoque ou tremida forte.',
      '',
      '6. RITMO. Varie a duração de propósito, como um bom editor de CapCut: hook curto, depois alterna — ambientes fortes ganham 2.5 a 4s, ambientes de passagem ou fracos ficam em 1.2 a 2s. Nunca 3 cortes seguidos com a mesma duração. O ritmo pode acelerar no meio e respirar no penúltimo plano.',
      '',
      '7. FECHAMENTO (último da ordem). Termina no segundo plano mais forte do lote — um plano aberto e bonito que deixa vontade de ver o imóvel pessoalmente. Nunca termina num ambiente fraco.',
      '',
      '8. CORTE O QUE NÃO AJUDA. Se um clipe for fraco (nota ≤ 4), repetido (mesmo ambiente de outro clipe melhor) ou quebrar o ritmo, marque "incluir": false. Mantenha pelo menos ' + minIncluidos + ' clipes no vídeo.',
      '',
    ]);
  }

  var numeros = [
    'Regras dos números: "inicio" e "fim" em segundos com uma casa decimal, dentro da duração real do clipe (0 ≤ inicio < fim ≤ duração). "ordem" é a posição no vídeo final: 0 = hook, depois 1, 2, 3… consecutivos, sem repetir; clipes com "incluir": false recebem "ordem": -1.' + (comVoz ? ' Na "locucao", "inicio"/"fim" são os tempos de cada frase no áudio da locução.' : ''),
    '',
    'Responda SOMENTE com JSON válido, sem markdown, exatamente neste formato (um objeto por clipe enviado, todos os índices de 0 a ' + (n - 1) + '):',
    comVoz
      ? '{"resumo":"uma frase explicando a estratégia da montagem","locucao":[{"inicio":0.3,"fim":2.6,"texto":"frase exatamente como foi falada"}],"clipes":[{"indice":0,"ambiente":"sala de estar","movimento":"pan para a direita","nota":8,"incluir":true,"ordem":0,"inicio":1.4,"fim":3.9,"motivo":"frase curta: qual fala esse corte acompanha e por quê"}]}'
      : '{"resumo":"uma frase explicando a estratégia da montagem","clipes":[{"indice":0,"ambiente":"sala de estar","movimento":"pan para a direita","nota":8,"incluir":true,"ordem":0,"inicio":1.4,"fim":3.2,"motivo":"frase curta: por que esse trecho e por que nessa posição/duração"}]}',
  ];

  return abertura.concat(formato, regras, numeros).join('\n');
}

function r2(n) { return Math.round(n * 100) / 100; }

// Com locução: ajusta as durações pra soma bater com a duração da voz,
// escalando todos os cortes na mesma proporção (preserva o ritmo e o
// alinhamento que a IA escolheu), dentro do que cada clipe tem e com
// mínimo de 1s por corte. Se o material não der, congela o último quadro.
function fitPlanToDuration(plan, clips, target) {
  if (!plan.length) return;
  plan.forEach(function (e) { e.hold = 0; });
  function dur(e) { return e.fim - e.inicio; }
  function total() { return plan.reduce(function (s, e) { return s + dur(e); }, 0); }
  function setDur(e, want) {
    var clipDur = clips[e.indice].duracao;
    want = Math.max(1.0, Math.min(want, clipDur));
    var d = dur(e);
    if (want > d) {
      var grow = want - d;
      var addEnd = Math.min(grow, Math.max(0, clipDur - e.fim));
      e.fim = r2(e.fim + addEnd);
      e.inicio = r2(Math.max(0, e.inicio - (grow - addEnd)));
    } else if (want < d) {
      e.fim = r2(e.inicio + want);
    }
  }
  for (var iter = 0; iter < 6; iter++) {
    var tot = total();
    if (Math.abs(tot - target) < 0.08 || tot <= 0) break;
    var k = target / tot;
    plan.forEach(function (e) { setDur(e, dur(e) * k); });
  }
  var rest = target - total();
  if (rest > 0.08) plan[plan.length - 1].hold = r2(rest);
  else if (rest < -0.08) {
    // ainda sobrando (todos no mínimo): corta do último
    var last = plan[plan.length - 1];
    last.fim = r2(Math.max(last.inicio + 0.6, last.fim + rest));
  }
}

// Transforma a resposta da IA num plano seguro: índices válidos, trechos
// dentro da duração real, hook curto (sem voz), ordem sem buraco, mínimo de
// clipes e, com voz, duração total igual à da locução.
function normalizePlan(parsed, clips, voice) {
  var n = clips.length;
  var raw = parsed && Array.isArray(parsed.clipes) ? parsed.clipes : [];
  var byIndex = new Map();
  raw.forEach(function (c) {
    var idx = Number(c && c.indice);
    if (Number.isInteger(idx) && idx >= 0 && idx < n && !byIndex.has(idx)) byIndex.set(idx, c);
  });

  var entries = clips.map(function (clip) {
    var c = byIndex.get(clip.indice) || {};
    var seg = clampSegment(c.inicio, c.fim, clip.duracao);
    var ordem = Number(c.ordem);
    return {
      indice: clip.indice,
      ambiente: String(c.ambiente || '').slice(0, 60),
      movimento: String(c.movimento || '').slice(0, 60),
      nota: isFinite(Number(c.nota)) ? Number(c.nota) : null,
      incluir: byIndex.has(clip.indice) ? c.incluir !== false : true,
      ordem: isFinite(ordem) && ordem >= 0 ? ordem : null,
      inicio: seg.inicio,
      fim: seg.fim,
      hold: 0,
      motivo: String(c.motivo || '').slice(0, 220),
    };
  });

  var included = entries.filter(function (e) { return e.incluir; });
  // sem voz exige um mínimo de clipes; com voz a fala manda, mas nunca menos de 1
  var minIncl = voice ? 1 : Math.min(n, Math.max(2, Math.ceil(n * 0.7)));
  if (included.length < minIncl) {
    var excluded = entries.filter(function (e) { return !e.incluir; })
      .sort(function (a, b) { return (b.nota || 0) - (a.nota || 0); });
    while (included.length < minIncl && excluded.length) {
      var back = excluded.shift();
      back.incluir = true;
      back.ordem = null;
      included.push(back);
    }
  }

  included.sort(function (a, b) {
    var oa = a.ordem === null ? 1000 + a.indice : a.ordem;
    var ob = b.ordem === null ? 1000 + b.indice : b.ordem;
    return oa - ob || a.indice - b.indice;
  });

  if (!voice) {
    // hook sempre curto: no máximo 2.5s
    if (included.length && included[0].fim - included[0].inicio > 2.5) {
      included[0].fim = r2(included[0].inicio + 2.2);
    }
  } else {
    fitPlanToDuration(included, clips, voice.alvo);
  }

  included.forEach(function (e, i) { e.ordem = i; });
  entries.forEach(function (e) { if (!e.incluir) e.ordem = -1; });

  // transcrição (só com voz) + fala que cai em cima de cada corte
  var locucao = [];
  if (voice && parsed && Array.isArray(parsed.locucao)) {
    locucao = parsed.locucao.map(function (f) {
      return { inicio: Number(f.inicio) || 0, fim: Number(f.fim) || 0, texto: String(f.texto || '').slice(0, 200) };
    }).filter(function (f) { return f.texto && f.fim > f.inicio; }).slice(0, 40);
    // cada frase vai pro corte que fica mais tempo na tela enquanto ela é falada
    var t = 0;
    var spans = included.map(function (e) {
      var a = t; t += (e.fim - e.inicio) + (e.hold || 0);
      e.fala = '';
      return [a, t];
    });
    locucao.forEach(function (f) {
      var best = -1, bestOv = 0;
      spans.forEach(function (sp, i) {
        var ov = Math.min(sp[1], f.fim) - Math.max(sp[0], f.inicio);
        if (ov > bestOv) { bestOv = ov; best = i; }
      });
      if (best >= 0) included[best].fala = (included[best].fala + ' ' + f.texto).trim().slice(0, 220);
    });
  }

  return {
    resumo: String((parsed && parsed.resumo) || '').slice(0, 300),
    plano: included,
    fora: entries.filter(function (e) { return !e.incluir; }),
    locucao: locucao,
  };
}

// Proxy leve só pra análise: mantém a linha do tempo (timestamps iguais ao
// original), mas em baixa resolução — assim cabe folgado no limite de
// payload do Gemini mesmo com 10 clipes pesados, e a chamada fica mais rápida.
async function makeAnalysisProxy(inputPath, outputPath) {
  var args = [
    '-y', '-i', inputPath,
    '-vf', 'scale=w=720:h=720:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=10,format=yuv420p',
    '-an', '-c:v', 'libx264', '-threads', ENCODE_THREADS, '-preset', 'veryfast', '-crf', '30',
    outputPath,
  ];
  var r = await runFfmpegWithTimeout(args, 3 * 60 * 1000);
  return r.code === 0;
}

app.post('/autoedit/smart', requireSiteOrigin, function (req, res, next) {
  if (!geminiKey()) return res.status(503).json({ error: 'Chave do Gemini não configurada no servidor.' });
  if (activeJobs >= MAX_CONCURRENT) {
    return res.status(503).json({ error: 'Servidor ocupado, tenta de novo em alguns segundos.' });
  }
  next();
}, smartEditLimiter, uploadClips.fields([{ name: 'clips', maxCount: 10 }, { name: 'voice', maxCount: 1 }]), async function (req, res) {
  var clipFiles = (req.files && req.files.clips) || [];
  var voiceFile = req.files && req.files.voice && req.files.voice[0];
  var jobId = req.jobId || crypto.randomUUID();
  var proxyPaths = clipFiles.map(function (f, i) { return tempName(jobId, 'proxy' + i + '.mp4'); });
  var voice = null;
  function cleanupInputs() {
    var extra = voiceFile ? [voiceFile] : [];
    return cleanupFiles(clipFiles.concat(extra)).then(function () {
      return cleanupPaths(proxyPaths.concat(voice && voice.cleanPath ? [voice.cleanPath, voice.aiPath] : []));
    });
  }
  if (clipFiles.length < 2) {
    await cleanupInputs();
    return res.status(400).json({ error: 'Manda pelo menos 2 vídeos.' });
  }

  activeJobs++;
  try {
    // 0) locução (opcional): trata a voz e mede a duração
    if (voiceFile) {
      voice = await prepareVoice(voiceFile.path, jobId);
      if (!voice) {
        await cleanupInputs();
        return res.status(400).json({ error: 'Não consegui ler o áudio da locução. Grava de novo ou envia outro arquivo.' });
      }
      if (voice.empty) {
        voice = null;
        await cleanupInputs();
        return res.status(400).json({ error: 'A locução ficou sem voz (só silêncio). Confere o microfone e grava de novo.' });
      }
      if (voice.duracao > 125) {
        await cleanupInputs();
        return res.status(400).json({ error: 'A locução passou de 2 minutos. Pra Reels, o ideal é até 60 segundos.' });
      }
      voice.alvo = r2(voice.duracao + 0.6); // meio segundo de respiro no fim
    }

    // 1) duração real + proxy de análise de cada clipe
    var clips = [];
    for (var i = 0; i < clipFiles.length; i++) {
      var dur = await probeDuration(clipFiles[i].path);
      if (!dur) {
        await cleanupInputs();
        return res.status(400).json({ error: 'Não consegui ler o vídeo ' + (i + 1) + ' (' + clipFiles[i].originalname + '). Tenta outro arquivo.' });
      }
      var ok = await makeAnalysisProxy(clipFiles[i].path, proxyPaths[i]);
      if (!ok) {
        await cleanupInputs();
        return res.status(500).json({ error: 'Não consegui preparar o vídeo ' + (i + 1) + ' pra análise.' });
      }
      clips.push({ indice: i, duracao: dur, nome: clipFiles[i].originalname });
    }

    var totalRaw = clips.reduce(function (s, c) { return s + c.duracao; }, 0);
    var targetSeconds = voice
      ? voice.alvo
      : Math.round(Math.min(35, Math.max(10, Math.min(totalRaw * 0.6, clips.length * 2.8))));

    // 2) IA monta a edição (vendo os clipes e, se tiver, ouvindo a locução)
    var parts = [{ text: buildEditPrompt(clips, targetSeconds, voice) }];
    for (var j = 0; j < clips.length; j++) {
      var data = await fsp.readFile(proxyPaths[j]);
      parts.push({ text: 'Clipe ' + j + ' (duração real ' + clips[j].duracao.toFixed(1) + 's):' });
      parts.push({ inline_data: { mime_type: 'video/mp4', data: data.toString('base64') } });
    }
    if (voice) {
      var voiceData = await fsp.readFile(voice.aiPath);
      parts.push({ text: 'Locução (duração ' + voice.duracao.toFixed(1) + 's):' });
      parts.push({ inline_data: { mime_type: 'audio/wav', data: voiceData.toString('base64') } });
    }
    var json = await callGemini('v1beta', GEMINI_TEXT_MODEL, {
      contents: [{ role: 'user', parts: parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
    }, 4 * 60 * 1000);
    parts = null;
    await cleanupPaths(proxyPaths);

    var text = responseText(json).trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
    var parsed = null;
    try { parsed = JSON.parse(text); } catch (e) {
      console.error('[smart] JSON da IA inválido:', text.slice(0, 600));
    }
    var result = normalizePlan(parsed, clips, voice);

    var usage = json.usageMetadata || {};
    var inTok = usage.promptTokenCount || 0;
    var outTok = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
    var custo = (inTok / 1e6) * PRICE_IN_PER_M + (outTok / 1e6) * PRICE_OUT_PER_M;

    // 3) corta os ORIGINAIS na ordem da montagem, junta e põe a locução
    var items = result.plano.map(function (e) {
      return { path: clipFiles[e.indice].path, inicio: e.inicio, fim: e.fim, hold: e.hold || 0 };
    });
    var out = await trimAndConcat(items, jobId, { audioPath: voice ? voice.cleanPath : null });
    if (!out.ok) {
      await cleanupInputs();
      if (!res.headersSent) res.status(500).json({ error: out.error });
      return;
    }

    var planPayload = {
      modelo: GEMINI_TEXT_MODEL,
      resumo: result.resumo,
      comLocucao: !!voice,
      duracaoFinal: Math.round(result.plano.reduce(function (s, e) { return s + (e.fim - e.inicio) + (e.hold || 0); }, 0) * 10) / 10,
      plano: result.plano.map(function (e) {
        return { indice: e.indice, nome: clips[e.indice].nome, ambiente: e.ambiente, movimento: e.movimento, nota: e.nota, inicio: e.inicio, fim: e.fim, hold: e.hold || 0, motivo: e.motivo, fala: e.fala || '' };
      }),
      fora: result.fora.map(function (e) {
        return { indice: e.indice, nome: clips[e.indice].nome, ambiente: e.ambiente, nota: e.nota, motivo: e.motivo };
      }),
      locucao: voice ? { duracao: r2(voice.duracao), frases: result.locucao.length } : null,
      tokens: { entrada: inTok, saida: outTok },
      custoUSD: Math.round(custo * 10000) / 10000,
    };
    res.setHeader('X-Autoedit-Plan', Buffer.from(JSON.stringify(planPayload), 'utf8').toString('base64'));
    var voiceCleanup = voice ? [voice.cleanPath, voice.aiPath] : [];
    streamFileAndCleanup(res, out.outputPath, 'video/mp4', 'giovani-autoedit.mp4', function () {
      cleanupFiles(clipFiles.concat(voiceFile ? [voiceFile] : [], [{ path: out.outputPath }]));
      cleanupPaths(voiceCleanup);
    });
  } catch (err) {
    await cleanupInputs();
    if (!res.headersSent) geminiErrorResponse(res, err, 'Não consegui processar o auto edit no servidor.');
  } finally {
    activeJobs--;
  }
});

// ========================= /enhance-photo =========================

const ENHANCE_PROMPT = [
  'You are a senior architectural and real-estate photo retoucher who grades images for luxury listings and cinema-style property films.',
  '',
  'Retouch the attached photograph of a real property. This is a documentary photo of a real apartment that will be sold: it must remain an honest, faithful photo of the same place.',
  '',
  'ABSOLUTELY PRESERVE (do not change in any way):',
  '- the exact framing, crop, camera position, perspective, lens and composition;',
  '- the architecture: walls, ceiling, floor, windows, doors, frames, columns, stairs, built-ins, layout and proportions;',
  '- every piece of furniture, object, appliance, plant, artwork and decor item — same position, shape, size, color, material and design. Do not add, remove, move, replace, restyle, tidy up or "stage" anything;',
  '- the real materials and finishes: wood, stone, tiles, fabrics, paint colors, metal — keep their true hue and texture;',
  '- what is visible through the windows (only recover detail, never invent a new view).',
  '',
  'IMPROVE ONLY:',
  '- resolution and fine detail: ultra-sharp, crisp micro-texture on wood grain, stone, fabric and fixtures, clean edges, 8K-level clarity; remove noise, compression artifacts and blur without a plastic or painted look;',
  '- light: a cinematic, natural-looking light — balanced exposure, recovered highlights in windows and lamps, open shadows with detail, soft gradual falloff and gentle depth, as if shot on a cinema camera with a large-sensor lens on a beautiful day. Keep the existing light sources and their direction; do not add new lamps, sun rays, flares or glow;',
  '- color grade (the "LUT"): an elegant, premium real-estate cinematic grade — clean neutral whites with no color cast, slightly warm and inviting highlights, soft filmic contrast curve with a gentle roll-off, rich but true-to-life colors, subtle depth in the midtones. No oversaturation, no HDR halos, no crushed blacks, no teal-and-orange cliché, no vintage or faded look;',
  '- straighten nothing and crop nothing.',
  '',
  'Output a single photorealistic image with the same aspect ratio as the input. No text, no watermark, no borders.',
].join('\n');

const IMAGE_ASPECTS = [
  ['1:1', 1], ['2:3', 2 / 3], ['3:2', 3 / 2], ['3:4', 3 / 4], ['4:3', 4 / 3],
  ['4:5', 4 / 5], ['5:4', 5 / 4], ['9:16', 9 / 16], ['16:9', 16 / 9], ['21:9', 21 / 9],
];
function nearestAspect(width, height) {
  var r = width > 0 && height > 0 ? width / height : 1;
  var best = IMAGE_ASPECTS[0];
  IMAGE_ASPECTS.forEach(function (a) {
    if (Math.abs(Math.log(a[1] / r)) < Math.abs(Math.log(best[1] / r))) best = a;
  });
  return best[0];
}

// Formato de config de imagem mudou entre versões da API; tentamos o atual
// primeiro e caímos pros anteriores se o Google recusar (400). O que der
// certo fica memorizado pras próximas chamadas.
function imageRequestVariants(parts, aspect, size) {
  return [
    { name: 'v1-responseFormat', version: 'v1', body: { contents: [{ role: 'user', parts: parts }], generationConfig: { responseFormat: { image: { aspectRatio: aspect, imageSize: size } } } } },
    { name: 'v1beta-imageConfig', version: 'v1beta', body: { contents: [{ role: 'user', parts: parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect, imageSize: size } } } },
    { name: 'v1beta-plain', version: 'v1beta', body: { contents: [{ role: 'user', parts: parts }] } },
  ];
}
var workingImageVariant = null;

function extractImage(json) {
  var parts = responseParts(json);
  for (var i = 0; i < parts.length; i++) {
    var d = parts[i].inline_data || parts[i].inlineData;
    if (d && d.data) return { mime: d.mime_type || d.mimeType || 'image/png', data: d.data };
  }
  return null;
}

app.post('/enhance-photo', requireSiteOrigin, function (req, res, next) {
  if (!geminiKey()) return res.status(503).json({ error: 'Chave do Gemini não configurada no servidor.' });
  if (activeAiJobs >= MAX_AI_CONCURRENT) {
    return res.status(503).json({ error: 'Servidor ocupado, tenta de novo em alguns segundos.' });
  }
  next();
}, enhanceLimiter, uploadPhoto.single('photo'), async function (req, res) {
  var file = req.file;
  if (!file || !/^image\//.test(file.mimetype || '')) {
    return res.status(400).json({ error: 'Envie a foto no campo "photo" (JPG, PNG ou WebP).' });
  }
  var width = Number(req.body.width) || 0;
  var height = Number(req.body.height) || 0;
  var aspect = nearestAspect(width, height);
  var size = ['1K', '2K', '4K'].indexOf(String(req.body.size || '').toUpperCase()) >= 0 ? String(req.body.size).toUpperCase() : GEMINI_IMAGE_SIZE;

  var parts = [
    { text: ENHANCE_PROMPT },
    { inline_data: { mime_type: file.mimetype, data: file.buffer.toString('base64') } },
  ];

  activeAiJobs++;
  try {
    var variants = imageRequestVariants(parts, aspect, size);
    if (workingImageVariant) {
      variants.sort(function (a, b) { return (b.name === workingImageVariant) - (a.name === workingImageVariant); });
    }
    var image = null;
    var lastErr = null;
    for (var i = 0; i < variants.length && !image; i++) {
      var v = variants[i];
      try {
        var json = await callGemini(v.version, GEMINI_IMAGE_MODEL, v.body, 3 * 60 * 1000);
        image = extractImage(json);
        if (image) {
          if (workingImageVariant !== v.name) console.log('[enhance] formato de pedido que funcionou:', v.name);
          workingImageVariant = v.name;
        } else {
          var reason = (json.candidates && json.candidates[0] && json.candidates[0].finishReason) || (json.promptFeedback && json.promptFeedback.blockReason) || 'sem imagem';
          console.error('[enhance] resposta sem imagem (' + v.name + '):', reason, responseText(json).slice(0, 300));
          lastErr = new GeminiError('A IA não devolveu uma imagem (' + reason + '). Tenta de novo.', 502, '');
          break; // o pedido foi aceito; trocar o formato não muda nada
        }
      } catch (err) {
        lastErr = err;
        // 400/404 = formato ou versão da API não aceita — tenta a próxima variação
        if (err instanceof GeminiError && (err.status === 400 || err.status === 404)) {
          console.error('[enhance] variação ' + v.name + ' recusada:', err.detail.slice(0, 300));
          continue;
        }
        break;
      }
    }
    if (!image) return geminiErrorResponse(res, lastErr, 'Não consegui melhorar a foto.');

    var buf = Buffer.from(image.data, 'base64');
    var ext = /jpe?g/.test(image.mime) ? 'jpg' : (/webp/.test(image.mime) ? 'webp' : 'png');
    res.setHeader('Content-Type', image.mime);
    res.setHeader('Content-Disposition', 'attachment; filename="foto-melhorada.' + ext + '"');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(buf);
  } catch (err) {
    if (!res.headersSent) geminiErrorResponse(res, err, 'Não consegui melhorar a foto.');
  } finally {
    activeAiJobs--;
  }
});

// ============================ limpeza ============================

async function cleanupFiles(files) {
  await Promise.all((files || []).filter(Boolean).map(function (f) {
    return fsp.unlink(f.path).catch(function () {});
  }));
}
function cleanupPaths(paths) {
  return cleanupFiles((paths || []).map(function (p) { return { path: p }; }));
}

// Limpeza de segurança: qualquer arquivo temporário nosso (prefixo "sg-")
// mais velho que 30 minutos (caso algum request tenha morrido sem limpar).
setInterval(function () {
  var dir = os.tmpdir();
  fs.readdir(dir, function (err, files) {
    if (err) return;
    var now = Date.now();
    files.forEach(function (name) {
      if (!/^sg-[0-9a-f-]{36}-/.test(name)) return;
      var fp = path.join(dir, name);
      fs.stat(fp, function (err, stat) {
        if (err) return;
        if (now - stat.mtimeMs > 30 * 60 * 1000) fs.unlink(fp, function () {});
      });
    });
  });
}, 10 * 60 * 1000);

// Erros de upload (arquivo grande demais, arquivos demais) viram mensagem
// clara em vez de "erro interno".
app.use(function (err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    var msg = {
      LIMIT_FILE_SIZE: 'Arquivo grande demais.',
      LIMIT_FILE_COUNT: 'Arquivos demais de uma vez (máximo 10).',
      LIMIT_UNEXPECTED_FILE: 'Campo de arquivo inesperado.',
    }[err.code] || 'Erro no upload.';
    return res.status(400).json({ error: msg });
  }
  console.error('[server] erro não tratado:', err);
  res.status(500).json({ error: 'Erro interno no servidor.' });
});

app.listen(PORT, function () {
  console.log('Studio Giovani video server ouvindo na porta ' + PORT + ' | IA: ' + (geminiKey() ? 'chave configurada' : 'SEM chave (GEMINI_API_KEY)'));
});
