// Studio Giovani -- servidor de render de video
// Recebe o video original + o overlay (PNG transparente, ja desenhado no
// navegador) e queima um em cima do outro com o ffmpeg do sistema -- bem
// mais rapido que rodar ffmpeg.wasm no navegador do cliente, principalmente
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

// Dominios que podem chamar esse servidor. Aceita tambem qualquer preview
// do Cloudflare Pages (*.pages.dev) e localhost, pra facilitar teste.
const ALLOWED_ORIGINS = [
'https://giovani.bustamante.stream',
'https://studio-giovani-video.pages.dev',
];
function isOriginAllowed(origin) {
if (!origin) return true; // requests sem origin (curl, health checks)
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

// Limite de jobs simultaneos -- instancia pequena, evita derrubar o servidor
// se varios renders cairem ao mesmo tempo.
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
res.status(200).send('Studio Giovani video server -- ok');
});
app.get('/health', function (req, res) {
res.status(200).json({ ok: true });
});

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
var filter =
'[0:v]scale=' + W + ':' + H + ':force_original_aspect_ratio=increase,' +
'crop=' + W + ':' + H + ',setsar=1[bg];' +
'[bg][1:v]overlay=0:0:format=auto[outv]';

var args = [
'-y',
'-i', videoFile.path,
'-i', overlayFile.path,
'-filter_complex', filter,
'-map', '[outv]', '-map', '0:a?',
'-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
'-c:a', 'aac', '-movflags', '+faststart',
outputPath,
];

activeJobs++;
var finished = false;
var ffmpeg = spawn('ffmpeg', args);

var stderrTail = '';
ffmpeg.stderr.on('data', function (chunk) {
stderrTail = (stderrTail + chunk.toString()).slice(-4000);
});

var timeout = setTimeout(function () {
if (!finished) {
finished = true;
ffmpeg.kill('SIGKILL');
activeJobs--;
cleanupFiles([videoFile, overlayFile, { path: outputPath }]);
if (!res.headersSent) {
res.status(504).json({ error: 'O processamento demorou demais e foi cancelado. Tenta com um video menor.' });
}
}
}, 5 * 60 * 1000); // 5 min de seguranca

ffmpeg.on('error', async function (err) {
if (finished) return;
finished = true;
clearTimeout(timeout);
activeJobs--;
await cleanupFiles([videoFile, overlayFile, { path: outputPath }]);
console.error('[render] falha ao iniciar ffmpeg:', err);
if (!res.headersSent) {
res.status(500).json({ error: 'Nao consegui iniciar o processamento de video no servidor.' });
}
});

ffmpeg.on('close', async function (code) {
if (finished) return;
finished = true;
clearTimeout(timeout);
activeJobs--;

if (code !== 0) {
console.error('[render] ffmpeg saiu com codigo', code, stderrTail);
await cleanupFiles([videoFile, overlayFile, { path: outputPath }]);
if (!res.headersSent) {
res.status(500).json({ error: 'Nao deu pra gerar o video. Tenta de novo, ou com outro arquivo.' });
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
});
});

async function cleanupFiles(files) {
await Promise.all((files || []).filter(Boolean).map(function (f) {
return fsp.unlink(f.path).catch(function () {});
}));
}

// Limpeza de seguranca: qualquer arquivo temporario nosso mais velho que
// 30 minutos (caso algum request tenha morrido sem limpar) e apagado.
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
console.error('[server] erro nao tratado:', err);
if (res.headersSent) return next(err);
res.status(500).json({ error: 'Erro interno no servidor.' });
});

app.listen(PORT, function () {
console.log('Studio Giovani video server ouvindo na porta ' + PORT);
});
