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
// 2K: a peça final sai em 1080px, então 4K era desperdício (custa ~50% a mais)
const GEMINI_IMAGE_SIZE = process.env.GEMINI_IMAGE_SIZE || '2K';
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
  exposedHeaders: ['X-Autoedit-Plan', 'X-Autoedit-Id'],
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

// A vaga de processamento (ffmpeg) é reservada DEPOIS do upload, num passo
// só (checar e ocupar acontecem juntos, sem brecha de corrida). Upload lento
// em 4G não prende vaga. Se as vagas estiverem ocupadas, espera até 3 min
// em vez de recusar na hora. A vaga volta quando a resposta termina, de
// qualquer jeito (sucesso, erro, ou o cliente fechou a página).
function uploadedFiles(req) {
  var out = [];
  if (req.file) out.push(req.file);
  if (Array.isArray(req.files)) out = out.concat(req.files);
  else if (req.files) Object.keys(req.files).forEach(function (k) { out = out.concat(req.files[k]); });
  return out;
}
function waitSlot(req, res, next) {
  var t0 = Date.now();
  var gone = false;
  res.on('close', function () { if (!res.writableEnded) gone = true; });
  (function tryTake() {
    if (gone) { cleanupFiles(uploadedFiles(req)); return; }
    if (activeJobs < MAX_CONCURRENT) {
      activeJobs++;
      req._slot = true;
      req._releaseSlot = function () { if (req._slot) { req._slot = false; activeJobs--; } };
      res.on('finish', req._releaseSlot);
      res.on('close', req._releaseSlot);
      return next();
    }
    if (Date.now() - t0 > 3 * 60 * 1000) {
      cleanupFiles(uploadedFiles(req));
      return res.status(503).json({ error: 'Servidor ocupado, tenta de novo em alguns segundos.' });
    }
    setTimeout(tryTake, 400);
  })();
}
// Durante a espera da IA (rede, não CPU) a vaga fica livre pra outro render.
function pauseSlot(req) {
  if (req._slot) { req._slot = false; activeJobs--; }
}
async function resumeSlot(req, maxWaitMs) {
  var t0 = Date.now();
  while (activeJobs >= MAX_CONCURRENT) {
    if (Date.now() - t0 > maxWaitMs) return false;
    await new Promise(function (r) { setTimeout(r, 400); });
  }
  activeJobs++;
  req._slot = true;
  return true;
}

// ---------------------- métricas de uso (anônimas) ----------------------
// Eventos do site + um registro por trabalho do servidor, em JSON Lines.
// Pra sobreviver aos deploys, precisa de um Volume no Railway (o Railway
// informa o caminho em RAILWAY_VOLUME_MOUNT_PATH). Sem volume, os dados
// ficam no /tmp e somem a cada deploy — o painel avisa.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir();
const DATA_PERSISTENT = !!(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH);
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const EVENTS_FILE = path.join(DATA_DIR, 'studio-eventos.jsonl');
var eventsChecked = 0;
function appendEvent(obj) {
  // guarda no máximo ~40MB; o mais antigo vai pra .1 (e o .1 anterior some)
  if (++eventsChecked % 500 === 0) {
    try { if (fs.statSync(EVENTS_FILE).size > 40 * 1024 * 1024) fs.renameSync(EVENTS_FILE, EVENTS_FILE + '.1'); } catch (e) {}
  }
  fs.appendFile(EVENTS_FILE, JSON.stringify(obj) + '\n', function (err) {
    if (err) console.error('[metricas] não consegui gravar evento:', err.message);
  });
}
function logJob(data) {
  var e = Object.assign({ t: new Date().toISOString(), tipo: 'job' }, data);
  console.log('[job]', JSON.stringify(e));
  appendEvent(e);
}

// ---------------------- eventos do site + painel ----------------------
// O site manda eventos anônimos (um id aleatório por aparelho, sem nome,
// e-mail ou dado do imóvel). O painel em /painel?token=... junta tudo.
const EVENTOS_OK = new Set([
  'app_aberto', 'aba', 'midia', 'melhorar_foto', 'montagem', 'remontagem', 'ouvir_previa', 'locucao',
  'validacao_bloqueou', 'conferencia', 'gerar', 'pronto_salvar', 'pronto_compartilhar', 'pronto_fechar',
  'rascunho_restaurado', 'rascunho_descartado', 'tipo_anuncio', 'estilo', 'formato', 'erro',
]);
const eventsLimiter = makeRateLimiter('events', Number(process.env.EVENTS_PER_IP_HOUR || 600), Number(process.env.EVENTS_PER_DAY || 50000));
function cleanProps(p) {
  var out = {};
  if (!p || typeof p !== 'object') return out;
  Object.keys(p).slice(0, 12).forEach(function (k) {
    var key = String(k).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24);
    var v = p[k];
    if (typeof v === 'number' && isFinite(v)) out[key] = Math.round(v * 100) / 100;
    else if (typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'string') out[key] = v.slice(0, 60);
  });
  return out;
}
app.post('/events', requireSiteOrigin, eventsLimiter, express.text({ type: '*/*', limit: '32kb' }), function (req, res) {
  var body;
  try { body = JSON.parse(req.body || '{}'); } catch (e) { return res.status(400).end(); }
  var d = String(body.d || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  var sid = String(body.s || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  var dev = body.dev === 'mobile' ? 'mobile' : 'desktop';
  var evs = Array.isArray(body.ev) ? body.ev.slice(0, 40) : [];
  var now = new Date().toISOString();
  evs.forEach(function (x) {
    if (!x || !EVENTOS_OK.has(x.e)) return;
    appendEvent({ t: now, tipo: 'ev', d: d, s: sid, dev: dev, e: x.e, p: cleanProps(x.p) });
  });
  res.status(204).end();
});

function tokenOk(given) {
  var want = (process.env.ADMIN_TOKEN || '').trim();
  if (!want || !given) return false;
  var a = crypto.createHash('sha256').update(String(given)).digest();
  var b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

function lerEventos(desdeMs) {
  var out = [];
  var txt = '';
  try { txt = fs.readFileSync(EVENTS_FILE, 'utf8'); } catch (e) { return out; }
  txt.split('\n').forEach(function (l) {
    if (!l) return;
    try { var o = JSON.parse(l); if (Date.parse(o.t) >= desdeMs) out.push(o); } catch (e) {}
  });
  return out;
}

function calcularMetricas(dias) {
  var desde = Date.now() - dias * 86400000;
  var todos = lerEventos(desde);
  var evs = todos.filter(function (o) { return o.tipo === 'ev'; });
  var jobs = todos.filter(function (o) { return o.tipo === 'job'; });
  var dia = function (t) { return String(t).slice(0, 10); };
  var aparelhos = new Set(), aparelhos7 = new Set(), sessoes = {};
  var porDia = {};
  var d7 = Date.now() - 7 * 86400000;
  evs.forEach(function (o) {
    if (o.d) { aparelhos.add(o.d); if (Date.parse(o.t) >= d7) aparelhos7.add(o.d); }
    var s = sessoes[o.s] || (sessoes[o.s] = { dev: o.dev, evs: new Set(), gerou: {}, abas: new Set() });
    s.evs.add(o.e);
    if (o.e === 'aba' && o.p && o.p.aba) s.abas.add(o.p.aba);
    var pd = porDia[dia(o.t)] || (porDia[dia(o.t)] = { aparelhos: new Set(), pecas: 0, fotoIA: 0, montagens: 0 });
    if (o.d) pd.aparelhos.add(o.d);
    if (o.e === 'gerar' && o.p && o.p.ok) pd.pecas++;
  });
  jobs.forEach(function (j) {
    var pd = porDia[dia(j.t)] || (porDia[dia(j.t)] = { aparelhos: new Set(), pecas: 0, fotoIA: 0, montagens: 0 });
    if (j.endpoint === 'foto' && j.ok) pd.fotoIA++;
    if (j.endpoint === 'montagem' && j.ok) pd.montagens++;
  });
  var listaSessoes = Object.keys(sessoes).map(function (k) { return sessoes[k]; });
  function conta(fn) { return listaSessoes.filter(fn).length; }
  var funil = [
    ['Abriram o Studio', conta(function (s) { return s.evs.has('app_aberto'); })],
    ['Escolheram foto ou vídeo', conta(function (s) { return s.evs.has('midia'); })],
    ['Geraram uma peça', conta(function (s) { return s.evs.has('gerar'); })],
    ['Salvaram ou enviaram', conta(function (s) { return s.evs.has('pronto_salvar') || s.evs.has('pronto_compartilhar'); })],
  ];
  function contaEv(nome, filtro) { return evs.filter(function (o) { return o.e === nome && (!filtro || filtro(o.p || {})); }).length; }
  var gerar = { foto: contaEv('gerar', function (p) { return p.tipo === 'foto' && p.ok; }), video: contaEv('gerar', function (p) { return p.tipo === 'video' && p.ok; }), montagem: contaEv('gerar', function (p) { return p.tipo === 'montagem' && p.ok; }), falhas: contaEv('gerar', function (p) { return !p.ok; }) };
  function jobStats(ep) {
    var js = jobs.filter(function (j) { return j.endpoint === ep; });
    var ok = js.filter(function (j) { return j.ok; });
    var ms = ok.map(function (j) { return j.ms || 0; }).sort(function (a, b) { return a - b; });
    var custo = ok.reduce(function (s, j) { return s + (j.custoUSD || 0); }, 0);
    return { total: js.length, ok: ok.length, falhas: js.length - ok.length, medianaSeg: ms.length ? Math.round(ms[Math.floor(ms.length / 2)] / 100) / 10 : 0, custoUSD: Math.round(custo * 100) / 100 };
  }
  var erros = {};
  jobs.filter(function (j) { return !j.ok && j.erro; }).forEach(function (j) { var k = j.endpoint + ': ' + j.erro; erros[k] = (erros[k] || 0) + 1; });
  evs.filter(function (o) { return o.e === 'erro'; }).forEach(function (o) { var k = 'site: ' + ((o.p && o.p.onde) || '?') + ' · ' + ((o.p && o.p.msg) || ''); erros[k] = (erros[k] || 0) + 1; });
  var dias_ = Object.keys(porDia).sort().map(function (k) { var v = porDia[k]; return { dia: k, aparelhos: v.aparelhos.size, pecas: v.pecas, fotoIA: v.fotoIA, montagens: v.montagens }; });
  var anuncios = {};
  evs.filter(function (o) { return o.e === 'gerar' && o.p && o.p.ok && o.p.anuncio; }).forEach(function (o) { anuncios[o.p.anuncio] = (anuncios[o.p.anuncio] || 0) + 1; });
  return {
    dias: dias, persistente: DATA_PERSISTENT,
    aparelhos: aparelhos.size, aparelhos7: aparelhos7.size, sessoes: listaSessoes.length,
    celular: conta(function (s) { return s.dev === 'mobile'; }), computador: conta(function (s) { return s.dev !== 'mobile'; }),
    funil: funil, gerar: gerar,
    foto: jobStats('foto'), montagem: jobStats('montagem'), remontar: jobStats('remontar'), render: jobStats('render'),
    comLocucao: jobs.filter(function (j) { return j.endpoint === 'montagem' && j.ok && j.comVoz; }).length,
    validacaoBloqueou: contaEv('validacao_bloqueou'), conferenciaCorrigir: contaEv('conferencia', function (p) { return p.acao === 'corrigir'; }),
    rascunhos: contaEv('rascunho_restaurado'), ouvirPrevia: contaEv('ouvir_previa'),
    anuncios: anuncios,
    erros: Object.keys(erros).map(function (k) { return [k, erros[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 12),
    porDia: dias_,
  };
}

function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

app.get('/painel', function (req, res) {
  if (!(process.env.ADMIN_TOKEN || '').trim()) return res.status(503).type('text/plain').send('Painel desligado: defina a variável ADMIN_TOKEN no Railway.');
  if (!tokenOk(req.query.token)) return res.status(401).type('text/plain').send('Acesso negado.');
  var dias = Math.min(180, Math.max(1, Number(req.query.dias) || 30));
  var m = calcularMetricas(dias);
  if (req.query.formato === 'json') return res.json(m);
  var usd = function (v) { return 'US$ ' + v.toFixed(2).replace('.', ','); };
  var maxF = Math.max(1, m.funil[0][1]);
  var custoTotal = m.foto.custoUSD + m.montagem.custoUSD;
  var pecasTotal = m.gerar.foto + m.gerar.video + m.gerar.montagem;
  var html = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Painel · Studio Giovani</title><style>' +
    ':root{--bg:#F5F3EE;--s:#fff;--i:#1C1B18;--m:#5E584C;--l:#DDD5C4;--g:#C9A24D;--r:#C12A2A}@media(prefers-color-scheme:dark){:root{--bg:#141517;--s:#1D1D1B;--i:#F1EFE9;--m:#B3AC9C;--l:#39352C;--g:#D8B15C;--r:#F08A7A}}' +
    'body{margin:0;background:var(--bg);color:var(--i);font:15px/1.5 system-ui,-apple-system,sans-serif}.w{max-width:980px;margin:0 auto;padding:24px 16px 60px}h1{font:600 28px Georgia,serif;margin:0 0 4px}h2{font:600 19px Georgia,serif;margin:28px 0 10px}.mut{color:var(--m)}' +
    '.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}.c{background:var(--s);border:1px solid var(--l);border-radius:12px;padding:14px}.n{font:600 30px Georgia,serif;font-variant-numeric:tabular-nums}.l{font-size:13px;color:var(--m)}' +
    '.bar{display:grid;grid-template-columns:200px 1fr 60px;gap:10px;align-items:center;margin:6px 0}.bar div.t{height:14px;border-radius:7px;background:var(--g)}.tw{overflow-x:auto;background:var(--s);border:1px solid var(--l);border-radius:12px}table{border-collapse:collapse;width:100%;min-width:480px;font-variant-numeric:tabular-nums}td,th{padding:8px 12px;border-bottom:1px solid var(--l);text-align:left}th{font-size:12px;color:var(--m);text-transform:uppercase}.av{background:#FBF0D9;color:#6b4700;padding:10px 14px;border-radius:10px;margin:14px 0}' +
    '@media(max-width:560px){.bar{grid-template-columns:1fr 50px}.bar span.lb{grid-column:1/-1}}</style></head><body><div class="w">' +
    '<h1>Painel do Studio Giovani</h1><div class="mut">Últimos ' + dias + ' dias · <a href="?token=' + esc(req.query.token) + '&dias=7">7 dias</a> · <a href="?token=' + esc(req.query.token) + '&dias=30">30 dias</a> · <a href="?token=' + esc(req.query.token) + '&dias=90">90 dias</a></div>' +
    (m.persistente ? '' : '<div class="av"><b>Atenção:</b> sem Volume no Railway, estes dados zeram a cada publicação do servidor.</div>') +
    '<div class="g" style="margin-top:16px">' +
    '<div class="c"><div class="n">' + m.aparelhos + '</div><div class="l">aparelhos diferentes (' + m.aparelhos7 + ' nos últimos 7 dias)</div></div>' +
    '<div class="c"><div class="n">' + m.sessoes + '</div><div class="l">sessões · ' + m.celular + ' no celular, ' + m.computador + ' no computador</div></div>' +
    '<div class="c"><div class="n">' + pecasTotal + '</div><div class="l">peças geradas · ' + m.gerar.foto + ' fotos, ' + m.gerar.video + ' vídeos, ' + m.gerar.montagem + ' montagens</div></div>' +
    '<div class="c"><div class="n">' + usd(custoTotal) + '</div><div class="l">gasto com IA · ' + (pecasTotal ? usd(custoTotal / pecasTotal) + ' por peça' : '—') + '</div></div>' +
    '</div><h2>Funil</h2><div class="c">' +
    m.funil.map(function (f) { return '<div class="bar"><span class="lb">' + esc(f[0]) + '</span><div class="t" style="width:' + Math.max(2, Math.round(100 * f[1] / maxF)) + '%"></div><b>' + f[1] + '</b></div>'; }).join('') +
    '</div><h2>IA e processamento</h2><div class="tw"><table><tr><th></th><th>Pedidos</th><th>Com sucesso</th><th>Falhas</th><th>Tempo (mediana)</th><th>Custo</th></tr>' +
    [['Melhorar foto', m.foto], ['Montagem automática', m.montagem], ['Ajuste manual da montagem', m.remontar], ['Vídeo final (arte)', m.render]].map(function (r) {
      var j = r[1]; return '<tr><td>' + r[0] + '</td><td>' + j.total + '</td><td>' + j.ok + '</td><td>' + j.falhas + '</td><td>' + (j.medianaSeg ? j.medianaSeg + ' s' : '—') + '</td><td>' + (j.custoUSD ? usd(j.custoUSD) : '—') + '</td></tr>';
    }).join('') + '</table></div>' +
    '<p class="mut">' + m.comLocucao + ' montagens com locução · "Ouvir a prévia" usado ' + m.ouvirPrevia + ' vezes · ' + m.validacaoBloqueou + ' vezes o site pediu bairro/valor antes de gerar · ' + m.conferenciaCorrigir + ' vezes o corretor voltou pra corrigir na conferência · ' + m.rascunhos + ' rascunhos retomados.</p>' +
    '<h2>Tipo de anúncio das peças</h2><div class="c">' + (Object.keys(m.anuncios).length ? Object.keys(m.anuncios).map(function (k) { return esc(k) + ': <b>' + m.anuncios[k] + '</b>'; }).join(' · ') : '<span class="mut">ainda sem dados</span>') + '</div>' +
    '<h2>Por dia</h2><div class="tw"><table><tr><th>Dia</th><th>Aparelhos</th><th>Peças</th><th>Fotos com IA</th><th>Montagens</th></tr>' +
    m.porDia.slice().reverse().map(function (d) { return '<tr><td>' + d.dia.split('-').reverse().join('/') + '</td><td>' + d.aparelhos + '</td><td>' + d.pecas + '</td><td>' + d.fotoIA + '</td><td>' + d.montagens + '</td></tr>'; }).join('') +
    '</table></div><h2>Erros mais comuns</h2><div class="c">' + (m.erros.length ? m.erros.map(function (e) { return esc(e[0]) + ' — <b>' + e[1] + '</b>'; }).join('<br>') : '<span class="mut">nenhum erro registrado</span>') + '</div>' +
    '<p class="mut" style="margin-top:28px">Dados anônimos: um código aleatório por aparelho, sem nome, telefone ou dados do imóvel. <a href="?token=' + esc(req.query.token) + '&dias=' + dias + '&formato=json">Baixar em JSON</a></p></div></body></html>';
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(html);
});

// ---------------------- montagens guardadas no servidor ----------------------
// Depois da montagem com IA, os clipes originais, a locução tratada e o
// vídeo montado ficam aqui por 1 hora. Assim:
//  - "Gerar vídeo final" aplica a arte direto aqui (o vídeo não precisa
//    descer pro celular e subir de novo);
//  - o corretor pode ajustar a montagem na mão sem reenviar os clipes.
const MONTAGENS = new Map();
const MONTAGEM_TTL = 60 * 60 * 1000;
const MAX_MONTAGENS = 6;
function montagemFiles(m) {
  return m.clips.map(function (c) { return c.path; })
    .concat(m.voice ? [m.voice.cleanPath] : [], m.montagemPath ? [m.montagemPath] : []);
}
function dropMontagem(id) {
  var m = MONTAGENS.get(id);
  if (!m) return;
  MONTAGENS.delete(id);
  cleanupPaths(montagemFiles(m));
}
function storeMontagem(id, m) {
  m.usadoEm = Date.now();
  MONTAGENS.set(id, m);
  if (MONTAGENS.size > MAX_MONTAGENS) {
    var oldest = null;
    MONTAGENS.forEach(function (v, k) { if (!oldest || v.usadoEm < MONTAGENS.get(oldest).usadoEm) oldest = k; });
    if (oldest && oldest !== id) dropMontagem(oldest);
  }
}
function getMontagem(id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id || ''))) return null;
  var m = MONTAGENS.get(id);
  if (!m) return null;
  if (Date.now() - m.usadoEm > MONTAGEM_TTL) { dropMontagem(id); return null; }
  m.usadoEm = Date.now();
  return m;
}
setInterval(function () {
  MONTAGENS.forEach(function (m, id) { if (Date.now() - m.usadoEm > MONTAGEM_TTL) dropMontagem(id); });
}, 5 * 60 * 1000);
const MONTAGEM_EXPIRADA = 'A montagem guardada no servidor expirou (fica 1 hora). Toque em "Montar vídeo com IA" de novo.';
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
    metricas: { persistentes: DATA_PERSISTENT },
    montagensGuardadas: MONTAGENS.size,
  });
});

// ============================ ffmpeg helpers ============================

// Roda um binário (ffmpeg/ffprobe) e resolve quando termina (nunca rejeita —
// devolve sempre {code, stdout, stderrTail}, com code=null se nem iniciou).
function runProcess(bin, args, onStderr) {
  var stderrTail = '';
  var stdout = '';
  var proc;
  try {
    proc = spawn(bin, args);
  } catch (err) {
    return { promise: Promise.resolve({ code: null, stdout: '', stderrTail: '', spawnError: err }), kill: function () {} };
  }
  proc.stdout.on('data', function (chunk) { stdout = (stdout + chunk.toString()).slice(-20000); });
  proc.stderr.on('data', function (chunk) {
    var txt = chunk.toString();
    stderrTail = (stderrTail + txt).slice(-4000);
    if (onStderr) { try { onStderr(txt); } catch (e) {} }
  });
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

function runWithTimeout(bin, args, timeoutMs, onStderr) {
  var run = runProcess(bin, args, onStderr);
  var timedOut = false;
  var timer = setTimeout(function () { timedOut = true; run.kill(); }, timeoutMs);
  return run.promise.then(function (result) {
    clearTimeout(timer);
    result.timedOut = timedOut;
    return result;
  });
}

function runFfmpegWithTimeout(args, timeoutMs, onStderr) {
  return runWithTimeout('ffmpeg', args, timeoutMs, onStderr);
}

// Progresso real do /render: o site manda um "progressId" junto com o
// upload e consulta GET /render/progresso/:id enquanto o ffmpeg trabalha.
const RENDER_PROGRESS = new Map();
function cleanProgressId(v) { return String(v || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40); }
function setRenderProgress(id, fase, pct) {
  if (!id) return;
  RENDER_PROGRESS.set(id, { fase: fase, pct: Math.max(0, Math.min(1, pct || 0)), t: Date.now() });
}
function ffmpegProgressWatcher(id, durationSec) {
  if (!id || !durationSec) return null;
  return function (txt) {
    var m, last = null, re = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/g;
    while ((m = re.exec(txt))) last = m;
    if (!last) return;
    var sec = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
    setRenderProgress(id, 'processando', sec / durationSec);
  };
}
setInterval(function () {
  var lim = Date.now() - 15 * 60 * 1000;
  RENDER_PROGRESS.forEach(function (v, k) { if (v.t < lim) RENDER_PROGRESS.delete(k); });
}, 60 * 1000).unref();

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

// Versão leve (540x960) só pra prévia no celular: ~5x menor que o original.
async function makePreview(inputPath, outPath) {
  var r = await runFfmpegWithTimeout(['-y', '-i', inputPath,
    '-vf', 'scale=540:960,format=yuv420p',
    '-c:v', 'libx264', '-threads', ENCODE_THREADS, '-preset', 'veryfast', '-crf', '30',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', outPath], 2 * 60 * 1000);
  if (r.code !== 0) console.error('[preview] falha, codigo', r.code, '| stderr:', r.stderrTail.slice(-500));
  return r.code === 0;
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

app.post('/render', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'overlay', maxCount: 1 }]), waitSlot, async function (req, res) {
  var t0 = Date.now();
  var videoFile = req.files && req.files.video && req.files.video[0];
  var overlayFile = req.files && req.files.overlay && req.files.overlay[0];
  // Montagem automática: o vídeo já está no servidor, só vem a arte (PNG).
  var montagem = null;
  if (!videoFile && req.body && req.body.montagemId) {
    montagem = getMontagem(req.body.montagemId);
    if (!montagem) {
      await cleanupFiles([overlayFile]);
      return res.status(410).json({ error: MONTAGEM_EXPIRADA });
    }
  }

  if ((!videoFile && !montagem) || !overlayFile) {
    await cleanupFiles([videoFile, overlayFile]);
    return res.status(400).json({ error: 'Envie o campo "video" (ou "montagemId") e o campo "overlay" (PNG).' });
  }
  var inputPath = videoFile ? videoFile.path : montagem.montagemPath;
  var origem = videoFile ? 'upload' : 'montagem';
  var progId = cleanProgressId(req.body && req.body.progressId);
  setRenderProgress(progId, 'processando', 0);
  var inputDur = progId ? await probeDuration(inputPath) : null;
  var watch = ffmpegProgressWatcher(progId, inputDur);

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
    '-y', '-i', inputPath, '-i', overlayFile.path,
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
    '-y', '-i', inputPath, '-i', overlayFile.path,
    '-filter_complex', filter,
    '-map', '[outv]',
    '-c:v', 'libx264', '-threads', ENCODE_THREADS, '-preset', 'veryfast', '-crf', '23',
    '-an', '-movflags', '+faststart',
    outputPath,
  ];

  try {
    var result = await runFfmpegWithTimeout(withAudioArgs, 5 * 60 * 1000, watch);

    if (result.code !== 0 && !result.timedOut) {
      console.error('[render] 1a tentativa (com audio) falhou, codigo', result.code, 'sinal', result.signal, '| stderr:', result.stderrTail.slice(-800));
      await fsp.unlink(outputPath).catch(function () {});
      setRenderProgress(progId, 'processando', 0);
      result = await runFfmpegWithTimeout(noAudioArgs, 5 * 60 * 1000, watch);
      if (result.code !== 0 && !result.timedOut) {
        console.error('[render] 2a tentativa (sem audio) tambem falhou, codigo', result.code, 'sinal', result.signal, '| stderr:', result.stderrTail.slice(-800));
      }
    }

    if (result.timedOut) {
      await cleanupFiles([videoFile, overlayFile, { path: outputPath }]);
      logJob({ endpoint: 'render', origem: origem, ok: false, erro: 'timeout', ms: Date.now() - t0 });
      if (!res.headersSent) res.status(504).json({ error: 'O processamento demorou demais e foi cancelado. Tenta com um vídeo menor.' });
      return;
    }
    if (result.code !== 0) {
      await cleanupFiles([videoFile, overlayFile, { path: outputPath }]);
      logJob({ endpoint: 'render', origem: origem, ok: false, erro: 'ffmpeg ' + result.code, ms: Date.now() - t0 });
      if (!res.headersSent) res.status(500).json({ error: 'Não deu pra gerar o vídeo. Tenta de novo, ou com outro arquivo.' });
      return;
    }

    setRenderProgress(progId, 'enviando', 1);
    logJob({ endpoint: 'render', origem: origem, ok: true, ms: Date.now() - t0, mb: videoFile ? Math.round(videoFile.size / 1048576) : 0 });
    streamFileAndCleanup(res, outputPath, 'video/mp4', 'giovani-video.mp4', function () {
      cleanupFiles([videoFile, overlayFile, { path: outputPath }]);
    });
  } catch (err) {
    console.error('[render] erro inesperado:', err);
    await cleanupFiles([videoFile, overlayFile, { path: outputPath }]);
    logJob({ endpoint: 'render', origem: origem, ok: false, erro: 'inesperado', ms: Date.now() - t0 });
    if (!res.headersSent) res.status(500).json({ error: 'Não consegui processar o vídeo no servidor.' });
  }
});

app.get('/render/progresso/:id', function (req, res) {
  var p = RENDER_PROGRESS.get(cleanProgressId(req.params.id));
  res.setHeader('Cache-Control', 'no-store');
  res.json(p ? { fase: p.fase, pct: Math.round(p.pct * 1000) / 1000 } : { fase: 'fila', pct: 0 });
});

// Baixar a montagem sem a arte, na qualidade original.
app.get('/montagem/:id', requireSiteOrigin, function (req, res) {
  var m = getMontagem(req.params.id);
  if (!m) return res.status(410).json({ error: MONTAGEM_EXPIRADA });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="giovani-montagem.mp4"');
  fs.createReadStream(m.montagemPath).on('error', function () { if (!res.headersSent) res.status(500).end(); }).pipe(res);
});

// ========================= /autoedit (manual) =========================
// Recebe N clipes + os trechos (inicio/fim em segundos, na ORDEM FINAL do
// vídeo — os clipes já vêm na ordem da montagem), corta e junta.
app.post('/autoedit', uploadClips.array('clips', 10), waitSlot, async function (req, res) {
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

function buildEditPrompt(clips, targetSeconds, voice, contexto) {
  var lista = clips.map(function (c) {
    return '- Clipe ' + c.indice + ': duração real ' + c.duracao.toFixed(1) + 's';
  }).join('\n');
  var n = clips.length;
  var minIncluidos = Math.max(2, Math.ceil(n * 0.7));
  var comVoz = !!voice;

  var abertura = [
    'Você é um montador com 15 anos de carreira editando vídeo de imóveis para imobiliárias — e ao mesmo tempo um editor nativo de TikTok e Reels que roda mídia paga: sabe que o vídeo morre nos primeiros 2 segundos se o hook for fraco, pensa em taxa de retenção, e monta no CapCut todo dia (cortes secos no movimento, ritmo que não deixa o dedo rolar a tela).',
    '',
    'Vou te mandar ' + n + ' clipes brutos de UM imóvel, filmados no celular/gimbal, identificados como "Clipe 0", "Clipe 1"… na ordem de envio — que NÃO é a ordem do vídeo. A ordem é decisão sua. Os vídeos chegam em baixa resolução só pra análise; os tempos que você devolver serão aplicados no arquivo original, com a mesma linha do tempo. Duração real de cada clipe:',
    lista,
    '',
    'O imóvel: ' + (contexto && contexto.tipoImovel ? contexto.tipoImovel : 'não informado') + ' · anúncio de ' + (contexto && contexto.anuncio ? contexto.anuncio : 'venda') + (contexto && contexto.bairro ? ' · ' + contexto.bairro : '') + '. Descreva os ambientes com as palavras certas pra esse tipo de imóvel (num sítio ou terreno não existe "sala de estar do apartamento"; numa sala comercial não existe "quarto").',
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
      '3. PERCURSO. Depois do hook, monte uma visita que faça sentido no espaço: área social → cozinha → quartos (suíte por último entre os quartos) → banheiros → diferenciais (varanda, vista, lazer). Se não for apartamento ou casa (sítio, terreno, sala comercial, loja, galpão), adapte: chegada/acesso → área principal → ambientes internos → área externa e diferenciais → vista. Pode quebrar essa lógica se isso melhorar o ritmo ou a continuidade de movimento.',
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

function cleanCtx(v) { return String(v || '').replace(/[\r\n]+/g, ' ').slice(0, 60).trim(); }

// fala que cai em cima de cada corte: cada frase vai pro corte que fica mais
// tempo na tela enquanto ela é falada
function assignFala(plan, locucao) {
  var t = 0;
  var spans = plan.map(function (e) {
    var a = t; t += (e.fim - e.inicio) + (e.hold || 0);
    e.fala = '';
    return [a, t];
  });
  (locucao || []).forEach(function (f) {
    var best = -1, bestOv = 0;
    spans.forEach(function (sp, i) {
      var ov = Math.min(sp[1], f.fim) - Math.max(sp[0], f.inicio);
      if (ov > bestOv) { bestOv = ov; best = i; }
    });
    if (best >= 0) plan[best].fala = (plan[best].fala + ' ' + f.texto).trim().slice(0, 220);
  });
}

// monta o payload do plano que vai no header (e fica guardado pra remontar)
function buildPlanPayload(resumo, plano, fora, clips, voice, locucao, tokens, custo) {
  return {
    modelo: GEMINI_TEXT_MODEL,
    resumo: resumo,
    comLocucao: !!voice,
    duracaoFinal: Math.round(plano.reduce(function (s, e) { return s + (e.fim - e.inicio) + (e.hold || 0); }, 0) * 10) / 10,
    plano: plano.map(function (e) {
      return { indice: e.indice, nome: clips[e.indice].nome, ambiente: e.ambiente || '', movimento: e.movimento || '', nota: e.nota, inicio: e.inicio, fim: e.fim, hold: e.hold || 0, motivo: e.motivo || '', fala: e.fala || '' };
    }),
    fora: fora.map(function (e) {
      return { indice: e.indice, nome: clips[e.indice].nome, ambiente: e.ambiente || '', nota: e.nota, inicio: e.inicio, fim: e.fim, motivo: e.motivo || '' };
    }),
    locucao: voice ? { duracao: r2(voice.duracao), frases: (locucao || []).length } : null,
    tokens: tokens,
    custoUSD: Math.round((custo || 0) * 10000) / 10000,
  };
}

// guarda o vídeo montado, gera a prévia leve e manda pro celular
async function finishMontagem(req, res, jobId, montagem, outputPath, planPayload, tag) {
  var stamp = Date.now().toString(36);
  var montagemPath = tempName(jobId, 'montagem-' + stamp + '.mp4');
  await fsp.rename(outputPath, montagemPath);
  if (montagem.montagemPath && montagem.montagemPath !== montagemPath) cleanupPaths([montagem.montagemPath]);
  montagem.montagemPath = montagemPath;
  montagem.plan = planPayload;
  storeMontagem(jobId, montagem);
  var previewPath = tempName(jobId, 'preview-' + stamp + '.mp4');
  var ok = await makePreview(montagemPath, previewPath);
  res.setHeader('X-Autoedit-Plan', Buffer.from(JSON.stringify(planPayload), 'utf8').toString('base64'));
  res.setHeader('X-Autoedit-Id', jobId);
  if (!ok) {
    // sem prévia leve: manda o original mesmo
    return streamFileAndCleanup(res, montagemPath, 'video/mp4', 'giovani-montagem.mp4', function () {});
  }
  streamFileAndCleanup(res, previewPath, 'video/mp4', 'giovani-montagem-previa.mp4', function () { cleanupPaths([previewPath]); });
}

app.post('/autoedit/smart', requireSiteOrigin, function (req, res, next) {
  if (!geminiKey()) return res.status(503).json({ error: 'Chave do Gemini não configurada no servidor.' });
  next();
}, smartEditLimiter, uploadClips.fields([{ name: 'clips', maxCount: 10 }, { name: 'voice', maxCount: 1 }]), waitSlot, async function (req, res) {
  var t0 = Date.now();
  var clipFiles = (req.files && req.files.clips) || [];
  var voiceFile = req.files && req.files.voice && req.files.voice[0];
  var jobId = req.jobId || crypto.randomUUID();
  var proxyPaths = clipFiles.map(function (f, i) { return tempName(jobId, 'proxy' + i + '.mp4'); });
  var voice = null;
  var contexto = { tipoImovel: cleanCtx(req.body && req.body.tipoImovel), anuncio: cleanCtx(req.body && req.body.anuncio), bairro: cleanCtx(req.body && req.body.bairro) };
  var jobInfo = { endpoint: 'montagem', clipes: clipFiles.length, mb: Math.round(clipFiles.reduce(function (s, f) { return s + f.size; }, 0) / 1048576), comVoz: !!voiceFile, anuncio: contexto.anuncio };
  function cleanupInputs() {
    var extra = voiceFile ? [voiceFile] : [];
    return cleanupFiles(clipFiles.concat(extra)).then(function () {
      return cleanupPaths(proxyPaths.concat(voice && voice.cleanPath ? [voice.cleanPath, voice.aiPath] : []));
    });
  }
  function fail(status, msg, erro) {
    logJob(Object.assign({}, jobInfo, { ok: false, erro: erro || msg, ms: Date.now() - t0 }));
    return cleanupInputs().then(function () { if (!res.headersSent) res.status(status).json({ error: msg }); });
  }
  if (clipFiles.length < 2) return fail(400, 'Manda pelo menos 2 vídeos.', 'poucos clipes');

  try {
    // 0) locução (opcional): trata a voz e mede a duração
    if (voiceFile) {
      voice = await prepareVoice(voiceFile.path, jobId);
      if (!voice) return fail(400, 'Não consegui ler o áudio da locução. Grava de novo ou envia outro arquivo.', 'audio ilegivel');
      if (voice.empty) { voice = null; return fail(400, 'A locução ficou sem voz (só silêncio). Confere o microfone e grava de novo.', 'audio mudo'); }
      if (voice.duracao > 125) return fail(400, 'A locução passou de 2 minutos. Pra Reels, o ideal é até 60 segundos.', 'audio longo');
      voice.alvo = r2(voice.duracao + 0.6); // meio segundo de respiro no fim
      jobInfo.vozSeg = Math.round(voice.duracao);
    }

    // 1) duração real + proxy de análise de cada clipe
    var clips = [];
    for (var i = 0; i < clipFiles.length; i++) {
      var dur = await probeDuration(clipFiles[i].path);
      if (!dur) return fail(400, 'Não consegui ler o vídeo ' + (i + 1) + ' (' + clipFiles[i].originalname + '). Tenta outro arquivo.', 'clipe ilegivel');
      var ok = await makeAnalysisProxy(clipFiles[i].path, proxyPaths[i]);
      if (!ok) return fail(500, 'Não consegui preparar o vídeo ' + (i + 1) + ' pra análise.', 'proxy');
      clips.push({ indice: i, duracao: dur, nome: clipFiles[i].originalname, path: clipFiles[i].path });
    }

    var totalRaw = clips.reduce(function (s, c) { return s + c.duracao; }, 0);
    var targetSeconds = voice
      ? voice.alvo
      : Math.round(Math.min(35, Math.max(10, Math.min(totalRaw * 0.6, clips.length * 2.8))));

    // 2) IA monta a edição (vendo os clipes e, se tiver, ouvindo a locução).
    // Durante a espera da IA a vaga de processamento fica livre.
    var parts = [{ text: buildEditPrompt(clips, targetSeconds, voice, contexto) }];
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
    pauseSlot(req);
    var tIa = Date.now();
    var json = await callGemini('v1beta', GEMINI_TEXT_MODEL, {
      contents: [{ role: 'user', parts: parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
    }, 4 * 60 * 1000);
    jobInfo.msIa = Date.now() - tIa;
    parts = null;
    await cleanupPaths(proxyPaths.concat(voice ? [voice.aiPath] : []));
    if (!(await resumeSlot(req, 3 * 60 * 1000))) return fail(503, 'Servidor ocupado, tenta de novo em alguns segundos.', 'fila cheia');

    var text = responseText(json).trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
    var parsed = null;
    try { parsed = JSON.parse(text); } catch (e) {
      console.error('[smart] JSON da IA inválido:', text.slice(0, 600));
      jobInfo.jsonInvalido = true;
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
    if (!out.ok) return fail(500, out.error, 'corte');

    var planPayload = buildPlanPayload(result.resumo, result.plano, result.fora, clips, voice, result.locucao, { entrada: inTok, saida: outTok }, custo);
    logJob(Object.assign({}, jobInfo, { ok: true, ms: Date.now() - t0, cortes: result.plano.length, duracao: planPayload.duracaoFinal, tokens: inTok + outTok, custoUSD: planPayload.custoUSD }));
    // os originais ficam guardados (1h) pra aplicar a arte e pra remontar
    var montagem = {
      clips: clips.map(function (c) { return { path: c.path, duracao: c.duracao, nome: c.nome }; }),
      voice: voice ? { cleanPath: voice.cleanPath, alvo: voice.alvo, duracao: voice.duracao } : null,
      locucao: result.locucao,
    };
    await finishMontagem(req, res, jobId, montagem, out.outputPath, planPayload, 'smart');
  } catch (err) {
    if (err instanceof GeminiError) {
      logJob(Object.assign({}, jobInfo, { ok: false, erro: 'IA: ' + err.message, ms: Date.now() - t0 }));
      await cleanupInputs();
      if (!res.headersSent) geminiErrorResponse(res, err, 'Não consegui processar a montagem no servidor.');
      return;
    }
    console.error('[smart] erro inesperado:', err);
    await fail(500, 'Não consegui processar a montagem no servidor.', 'inesperado');
  }
});

// ========================= /autoedit/remontar =========================
// Ajuste manual: o corretor tira, recoloca ou reordena cortes. Usa os clipes
// que ficaram guardados — nada é reenviado e a IA não é chamada de novo.
app.post('/autoedit/remontar', requireSiteOrigin, express.json({ limit: '32kb' }), waitSlot, async function (req, res) {
  var t0 = Date.now();
  var id = req.body && req.body.id;
  var m = getMontagem(id);
  if (!m) return res.status(410).json({ error: MONTAGEM_EXPIRADA });
  var cortes = Array.isArray(req.body.cortes) ? req.body.cortes.slice(0, 12) : [];
  var old = {};
  (m.plan.plano || []).concat(m.plan.fora || []).forEach(function (e) { old[e.indice] = e; });
  var used = {};
  var plan = [];
  cortes.forEach(function (c) {
    var idx = Number(c && c.indice);
    if (!Number.isInteger(idx) || idx < 0 || idx >= m.clips.length || used[idx]) return;
    used[idx] = true;
    var base = old[idx] || {};
    var seg = clampSegment(c.inicio != null ? c.inicio : base.inicio, c.fim != null ? c.fim : base.fim, m.clips[idx].duracao);
    plan.push({ indice: idx, ambiente: base.ambiente || '', movimento: base.movimento || '', nota: base.nota, motivo: base.motivo || '', inicio: seg.inicio, fim: seg.fim, hold: 0 });
  });
  if (!plan.length) return res.status(400).json({ error: 'A montagem precisa de pelo menos 1 corte.' });
  if (m.voice) fitPlanToDuration(plan, m.clips, m.voice.alvo);
  if (m.voice) assignFala(plan, m.locucao);
  var fora = m.clips.map(function (c, i) { return i; }).filter(function (i) { return !used[i]; }).map(function (i) {
    var b = old[i] || {};
    var seg = clampSegment(b.inicio, b.fim, m.clips[i].duracao);
    return { indice: i, ambiente: b.ambiente || '', nota: b.nota, inicio: seg.inicio, fim: seg.fim, motivo: b.motivo || 'Tirado da montagem por você' };
  });
  try {
    var items = plan.map(function (e) { return { path: m.clips[e.indice].path, inicio: e.inicio, fim: e.fim, hold: e.hold || 0 }; });
    var out = await trimAndConcat(items, id + '-r' + Date.now().toString(36), { audioPath: m.voice ? m.voice.cleanPath : null });
    if (!out.ok) {
      logJob({ endpoint: 'remontar', ok: false, erro: 'corte', ms: Date.now() - t0 });
      return res.status(500).json({ error: out.error });
    }
    var planPayload = buildPlanPayload(m.plan.resumo, plan, fora, m.clips, m.voice, m.locucao, m.plan.tokens, m.plan.custoUSD);
    planPayload.ajustadaPeloCorretor = true;
    logJob({ endpoint: 'remontar', ok: true, ms: Date.now() - t0, cortes: plan.length });
    await finishMontagem(req, res, id, m, out.outputPath, planPayload, 'remontar');
  } catch (err) {
    console.error('[remontar] erro inesperado:', err);
    logJob({ endpoint: 'remontar', ok: false, erro: 'inesperado', ms: Date.now() - t0 });
    if (!res.headersSent) res.status(500).json({ error: 'Não consegui refazer a montagem.' });
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

// preço aproximado por imagem gerada (Gemini 3.1 Flash Image, set/2026)
const IMAGE_PRICE_USD = { '1K': 0.067, '2K': 0.101, '4K': 0.151 };
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
  var tFoto = Date.now();
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
    if (!image) {
      logJob({ endpoint: 'foto', ok: false, erro: lastErr ? String(lastErr.message).slice(0, 80) : 'sem imagem', ms: Date.now() - tFoto, tamanho: size });
      return geminiErrorResponse(res, lastErr, 'Não consegui melhorar a foto.');
    }
    logJob({ endpoint: 'foto', ok: true, ms: Date.now() - tFoto, tamanho: size, custoUSD: IMAGE_PRICE_USD[size] || 0.1 });

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
    var guardados = new Set();
    MONTAGENS.forEach(function (m) { montagemFiles(m).forEach(function (f) { guardados.add(f); }); });
    files.forEach(function (name) {
      if (!/^sg-[0-9a-f-]{36}-/.test(name)) return;
      var fp = path.join(dir, name);
      if (guardados.has(fp)) return; // montagem guardada: sai pelo prazo dela (1h)
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
