const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const app = express();
app.set('trust proxy', 1); // مهم عشان Railway يطلع https صح
app.use(cors({ origin: '*', exposedHeaders: ['X-Powered-By'] }));
app.use(express.json());

// ===== MINYAWE-LINK V2 | ELMINYAWE =====
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '200', 10);
const BRAND = 'MINYAWE-LINK | ELMINYAWE';

// التخزين: catbox (أساسي — من غير حساب) ثم local (احتياطي دايما)
// اللي ظاهر للمستخدم بصمة ELMINYAWE بس — التخزين مجرد مخزن ورا الكواليس
function availDrivers() {
  const have = ['catbox', 'local'];
  const order = (process.env.STORAGE_ORDER || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.STORAGE_DRIVER) order.unshift(process.env.STORAGE_DRIVER.toLowerCase());
  if (!order.length) return have;
  const picked = order.filter(d => have.includes(d));
  return picked.length ? picked : have;
}
const DRIVERS = availDrivers();
const DRIVER = DRIVERS[0];

// تخمين النوع الحقيقي من الامتداد — بعض المتصفحات بتبعت octet-stream
// وده اللي بيخلي الأغنية تشتغل مش تتحمل، والمشغل يظهر صح في صفحة العرض
const EXT_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac', '.opus': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.html': 'text/html' };
function mimeOf(original, fallback) {
  if (fallback && fallback !== 'application/octet-stream') return fallback;
  return EXT_MIME[path.extname(original || '').toLowerCase()] || fallback || 'application/octet-stream';
}
function kindOf(meta) {
  const mt = mimeOf(meta.original, meta.mimetype);
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('audio/')) return 'audio';
  const e = path.extname(meta.original || '').toLowerCase();
  if (mt.startsWith('text/') || mt === 'application/json' || ['.md', '.json', '.js', '.py', '.css', '.html', '.csv', '.log', '.xml', '.yml', '.yaml', '.sh', '.txt'].includes(e)) return 'text';
  return 'file';
}

async function catboxUpload(buffer, filename) {
  const fd = new FormData();
  fd.append('reqtype', 'fileupload');
  fd.append('fileToUpload', new Blob([buffer], { type: 'application/octet-stream' }), filename);
  const r = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
  const t = (await r.text()).trim();
  if (!r.ok || !t.startsWith('http')) throw new Error('catbox rejected: ' + t.slice(0, 120));
  return t;
}

console.log('  Storage chain:', DRIVERS.join(' -> '));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ===== DB =====
let db = { files: {} };
try {
  if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
} catch { db = { files: {} }; }
const saveDB = () => { try { fs.writeFileSync(DB_PATH, JSON.stringify(db)); } catch {} };

const genId = () => crypto.randomBytes(4).toString('hex');

function parseExpiry(v) {
  const now = Date.now();
  const MONTH = 30 * 24 * 3600 * 1000; // أقصى مدة: شهر (بطلب ELMINYAWE)
  if (v === '1h') return now + 3600 * 1000;
  if (v === '7d') return now + 7 * 24 * 3600 * 1000;
  if (v === '30d' || v === 'never') return now + MONTH;
  return now + 24 * 3600 * 1000;
}

// نمنع الخطر بس، ونسمح بأغاني وفيديو وصور زي top4top
const BLOCKED = ['.exe', '.scr', '.com', '.bat', '.ps1', '.vbs', '.jar', '.msi', '.dll'];

const upload = multer({
  storage: multer.memoryStorage(), // دايما في الرام، والحفظ على الديسك يدوي لو local كسب
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED.includes(ext)) return cb(new Error('File type blocked by MINYAWE'));
    cb(null, true);
  }
});

function baseUrl(req) {
  const envBase = (process.env.BASE_URL || '').replace(/\/$/, '');
  if (envBase) return envBase;
  const proto = req.protocol === 'http' && req.get('x-forwarded-proto')
    ? req.get('x-forwarded-proto').split(',')[0]
    : req.protocol;
  return `${proto}://${req.get('host')}`;
}


// تحميل الميتا مع تنظيف المنتهي (مشترك بين /e و /d و /v)
async function loadMeta(id) {
  const meta = db.files[id];
  if (!meta) return { err: 404 };
  if (meta.expiryAt && Date.now() > meta.expiryAt) {
    if (meta.driver !== 'catbox') { try { fs.unlinkSync(path.join(UPLOAD_DIR, meta.stored)); } catch {} }
    delete db.files[id]; saveDB();
    return { err: 410 };
  }
  return { meta };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// بروكسي باسمك: يجيب الملف من التخزين ويقدمه بدومين موقعك (يدعم seek للصوت/الفيديو)
// لو الأساسي ميت بيتحول تلقائيا على المراية — المستمع مبيحسش بحاجة
async function proxyFile(meta, req, res, disposition) {
  const targets = [meta.directUrl, meta.mirrorUrl].filter(Boolean);
  let lastStatus = 502;
  for (const target of targets) {
    try {
      const headers = {};
      if (req.headers.range) headers.Range = req.headers.range;
      const r = await fetch(target, { headers });
      if (!r.ok && r.status !== 206) { lastStatus = r.status; continue; }
      res.status(r.status);
      // لو التخزين بعت نوع عام (octet-stream) نخمن الصح من الامتداد — عشان الـ .md والـ .txt يتعرضوا مش يتحملوا
      const upstreamCT = r.headers.get('content-type') || '';
      const effCT = (!upstreamCT || upstreamCT.includes('octet-stream')) ? mimeOf(meta.original, meta.mimetype) : upstreamCT;
      res.set({
        'Content-Type': effCT,
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(meta.original)}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Powered-By': BRAND
      });
      const cl = r.headers.get('content-length'); if (cl) res.set('Content-Length', cl);
      const cr = r.headers.get('content-range'); if (cr) res.set('Content-Range', cr);
      return Readable.fromWeb(r.body).pipe(res);
    } catch (e) { lastStatus = 502; continue; }
  }
  return res.status(lastStatus === 404 ? 404 : 502).send('upstream error | MINYAWE-LINK');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cleanup() {
  const now = Date.now();
  let changed = false;
  (async () => {
    for (const [id, meta] of Object.entries(db.files)) {
      if (meta.expiryAt && now > meta.expiryAt) {
        if (meta.driver !== 'catbox') { try { fs.unlinkSync(path.join(UPLOAD_DIR, meta.stored)); } catch {} }
        delete db.files[id];
        changed = true;
      }
    }
    if (changed) saveDB();
  })();
}
setInterval(cleanup, 10 * 60 * 1000);
cleanup();

// ===== ROUTES =====
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.send('MINYAWE-LINK OK'));

app.get('/api/config', (req, res) => {
  let disk = null;
  try {
    const st = fs.statfsSync(DATA_DIR);
    disk = { freeMB: Math.floor(st.bavail * st.bsize / 1048576), totalMB: Math.floor(st.blocks * st.bsize / 1048576) };
  } catch {}
  res.json({
  brand: BRAND,
  maxMB: MAX_MB,
  maxExpiryDays: 30,
  storage: DRIVER,
  chain: DRIVERS, // ترتيب المحاولة لو التخزين الأساسي وقع
  mirror: 'retry×2 per driver + local fallback',
  disk, // مساحة الفوليوم — عشان الموقع ميملاش ويموت فجأة
  direct: true,
  docs: `${baseUrl(req)}/api/docs`,
  agents: `${baseUrl(req)}/llms.txt`
  });
});

// توثيق آلي للـ API — أي AI agent يقدر يفهم الموقع من هنا من غير تضارب
app.get('/api/docs', (req, res) => {
  const b = baseUrl(req);
  res.json({
    name: 'MINYAWE-LINK',
    by: 'ELMINYAWE',
    version: '5.1',
    base: b,
    auth: 'none',
    limits: { maxMB: MAX_MB, maxExpiryDays: 30, expiryValues: ['1h', '24h', '7d', '30d'], blockedExtensions: BLOCKED },
    storage: { chain: DRIVERS, note: 'each driver gets 2 attempts (1.5s apart), then next driver; local disk is final fallback.' },
    endpoints: [
      { method: 'POST', path: '/api/upload', fields: { file: 'binary (multipart field "file")', expiry: '1h|24h|7d|30d (default 24h)' }, returns: ['id', 'url(raw storage)', 'short', 'view(page)', 'stream(direct play)', 'download(force download)', 'expiryAt', 'deleteToken'] },
      { method: 'GET', path: '/v/:id', desc: 'branded preview page with player' },
      { method: 'GET', path: '/e/:id', desc: 'branded direct stream (inline, supports Range)' },
      { method: 'GET', path: '/d/:id', desc: 'branded force download (attachment)' },
      { method: 'GET', path: '/i/:id', desc: 'short link (redirects to file)' },
      { method: 'DELETE', path: '/api/:id?token=DELETE_TOKEN', desc: 'delete file record' },
      { method: 'GET', path: '/api/config', desc: 'live limits + storage chain' },
      { method: 'GET', path: '/health', desc: 'liveness probe, returns text OK' }
    ],
    examples: {
      curl: `curl -F "file=@song.mp3" -F "expiry=30d" "${b}/api/upload"`,
      sharex: { RequestURL: `${b}/api/upload`, FileFormName: 'file', URL: '$json:url$' }
    }
  });
});

// ملف يعرف أي AI agent بالموقع — المعيار بتاع llms.txt
app.get('/llms.txt', (req, res) => {
  const b = baseUrl(req);
  res.type('text/plain').send(
`# MINYAWE-LINK by ELMINYAWE
Direct file hosting: upload image/audio/video/any file, get permanent direct links.
No auth. Max ${MAX_MB}MB per file. Expiry: 1h|24h|7d|30d (default 24h, max 30 days).
Storage chain (tried in order): ${DRIVERS.join(' -> ')}.

## Upload
POST ${b}/api/upload (multipart: file=<binary>, expiry=30d)
=> JSON: { id, url, short, view, stream, download, expiryAt, deleteToken }

## Links (replace :id)
- Preview page: ${b}/v/:id
- Direct stream (inline + Range): ${b}/e/:id
- Force download: ${b}/d/:id
- Short redirect: ${b}/i/:id

## Manage
- DELETE ${b}/api/:id?token=DELETE_TOKEN
- Limits: ${b}/api/config | Full spec: ${b}/api/docs | Health: ${b}/health
- Blocked types: ${BLOCKED.join(' ')}`
  );
});

// رفع — يقبل صور/أغاني/فيديو/ملفات ويرجع لينك مباشر
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const expiryInput = req.body.expiry || req.query.expiry || '24h';
    const expiryAt = parseExpiry(expiryInput);
    const deleteToken = crypto.randomBytes(8).toString('hex');

    let id = genId();
    while (db.files[id]) id = genId();
    const buf = req.file.buffer, original = req.file.originalname;
    // صحح النوع من الامتداد لو المتصفح بعت octet-stream — عشان التشغيل والمشغل
    const mimetype = mimeOf(original, req.file.mimetype);
    let stored, driver, directUrl, lastErr;

    // سلسلة المحاولة: كل تخزين بياخد محاولتين (بينهم 1.5 ثانية) قبل ما ننتقل للي بعده
    // يعني الرفع ميفشلش عشان هزة شبكة عابرة — لازم كل حاجة تموت عشان يفشل
    for (const drv of DRIVERS) {
      let ok = false;
      for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        try {
          if (drv === 'catbox') {
            directUrl = await catboxUpload(buf, original);
            stored = directUrl; // ملحوظة: catbox مفيهوش مسح، اللينك بيفضل عايش والمسح بيشيله من عندنا بس
            driver = 'catbox';
          } else {
            const ext = path.extname(original).toLowerCase();
            stored = id + ext;
            fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
            driver = 'local';
            directUrl = `${baseUrl(req)}/i/${id}`;
          }
          ok = true;
        } catch (e) {
          lastErr = e;
          console.log(`  [${drv}] attempt ${attempt} failed: ${e.message}`);
          if (attempt < 2) await sleep(1500);
        }
      }
      if (ok) break; // نجح — اخرج من السلسلة
    }
    if (!driver) throw lastErr || new Error('all storage drivers failed');

    db.files[id] = {
      stored, driver, directUrl,
      original: req.file.originalname,
      mimetype,
      size: req.file.size,
      expiryAt, deleteToken,
      createdAt: Date.now()
    };
    saveDB();
    const b = baseUrl(req);
    res.json({
      id,
      url: directUrl,              // اللينك الخام للتخزين
      short: `${b}/i/${id}`,       // اللينك المختصر
      view: `${b}/v/${id}`,        // 👁️ صفحة العرض باسمك
      stream: `${b}/e/${id}`,      // ▶️ التشغيل المباشر باسمك (inline)
      download: `${b}/d/${id}`,    // ⬇️ التحميل المباشر باسمك (attachment)
      mirror: null,
      expiryAt, deleteToken,
      powered_by: BRAND
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// لينك مباشر دايما — inline + CORS مفتوح عشان يشتغل في أي مشغل/موقع
app.get('/i/:id', async (req, res) => {
  const meta = db.files[req.params.id];
  if (!meta) return res.status(404).send('Not found | MINYAWE-LINK');
  if (meta.expiryAt && Date.now() > meta.expiryAt) {
    if (meta.driver !== 'catbox') { try { fs.unlinkSync(path.join(UPLOAD_DIR, meta.stored)); } catch {} }
    delete db.files[req.params.id]; saveDB();
    return res.status(410).send('Expired | MINYAWE-LINK');
  }
  res.set({
    'X-Powered-By': BRAND,
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Accept-Ranges': 'bytes' // مهم للفيديو/الأغاني seek
  });
  if (meta.driver === 'catbox' && meta.directUrl) {
    return res.redirect(302, meta.directUrl);
  }
  const filePath = path.join(UPLOAD_DIR, meta.stored);
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(meta.original)}"`);
  res.type(mimeOf(meta.original, meta.mimetype));
  res.sendFile(filePath);
});

// ▶️ التشغيل المباشر باسمك (inline — يشتغل جوه المتصفح والمشغل)
app.get('/e/:id', async (req, res) => {
  const { meta, err } = await loadMeta(req.params.id);
  if (err === 404) return res.status(404).send('Not found | MINYAWE-LINK');
  if (err === 410) return res.status(410).send('Expired | MINYAWE-LINK');
  if (meta.directUrl) return proxyFile(meta, req, res, 'inline');
  const filePath = path.join(UPLOAD_DIR, meta.stored);
  res.set({
    'X-Powered-By': BRAND, 'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin', 'Accept-Ranges': 'bytes'
  });
  res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.original)}`);
  res.type(mimeOf(meta.original, meta.mimetype));
  res.sendFile(filePath);
});

// ⬇️ التحميل المباشر باسمك (attachment — يحمّل علطول)
app.get('/d/:id', async (req, res) => {
  const { meta, err } = await loadMeta(req.params.id);
  if (err === 404) return res.status(404).send('Not found | MINYAWE-LINK');
  if (err === 410) return res.status(410).send('Expired | MINYAWE-LINK');
  if (meta.directUrl) return proxyFile(meta, req, res, 'attachment');
  res.download(path.join(UPLOAD_DIR, meta.stored), meta.original);
});

// 👁️ صفحة العرض باسمك (مشغل أنيق + كل اللينكات)
app.get('/v/:id', async (req, res) => {
  const { meta, err } = await loadMeta(req.params.id);
  if (err === 404) return res.status(404).send('Not found | MINYAWE-LINK');
  if (err === 410) return res.status(410).send('Expired | MINYAWE-LINK');
  const b = baseUrl(req);
  const stream = `${b}/e/${req.params.id}`, dl = `${b}/d/${req.params.id}`;
  const name = esc(meta.original), kind = kindOf(meta);
  const size = (meta.size / 1048576).toFixed(2) + ' MB';
  let player;
  if (kind === 'image') player = `<img src="${stream}" alt="${name}">`;
  else if (kind === 'video') player = `<video src="${stream}" controls playsinline></video>`;
  else if (kind === 'audio') player = `<div class="fn">${name}</div><audio src="${stream}" controls></audio>`;
  else if (kind === 'text') {
    // معاينة النص: أول 30KB بس (Range) عشان الصفحة تفتح بسرعة حتى مع الملفات الكبيرة
    let snippet = '';
    try {
      if (meta.directUrl) {
        const tr = await fetch(meta.directUrl, { headers: { Range: 'bytes=0-29999' } });
        if (tr.ok || tr.status === 206) snippet = (await tr.text()).slice(0, 30000);
      } else {
        snippet = fs.readFileSync(path.join(UPLOAD_DIR, meta.stored), 'utf8').slice(0, 30000);
      }
    } catch {}
    player = snippet
      ? `<div class="fn">${name}</div><pre class="txt">${esc(snippet)}</pre>`
      : `<div class="file">📁<div class="fn">${name}</div><div class="sz">${size}</div></div>`;
  }
  else player = `<div class="file">📁<div class="fn">${name}</div><div class="sz">${size}</div></div>`;
  res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} | MINYAWE-LINK</title>
<style>body{margin:0;background:#010314;color:#dfe1f4;font-family:system-ui;text-align:center;padding:24px 16px 60px}
.wrap{max-width:640px;margin:0 auto}.logo{font-weight:600;letter-spacing:-.02em;color:#ececfb;text-decoration:none}
.logo span{color:#b88cff}.card{background:#2a2b3a;border-radius:16px;padding:24px;margin-top:20px;box-shadow:rgba(0,0,0,.25) 0 8px 16px -4px,rgba(190,167,255,.24) 0 0 0 1.5px inset}
img,video{max-width:100%;border-radius:12px}audio{width:100%;margin-top:12px}.fn{font-family:monospace;font-size:13px;word-break:break-all;margin:8px 0}
pre.txt{direction:ltr;text-align:left;background:#0b0b15;border:1px solid #343543;border-radius:12px;padding:14px;font-family:monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;margin-top:12px}
.sz{font-family:monospace;font-size:11px;color:#9fa2b9}.meta{font-family:monospace;font-size:11px;color:#9fa2b9;margin-top:10px}
.btns{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:16px}
a.btn{background:#fff;color:#010314;border-radius:9999px;padding:10px 22px;font-size:14px;font-weight:500;text-decoration:none}
a.btn.ghost{background:transparent;color:#ececfb;border:1px solid #343543}
footer{margin-top:28px;font-family:monospace;font-size:11px;color:#5e6077}footer b{color:#b88cff}</style></head>
<body><div class="wrap"><a class="logo" href="/">MINYAWE<span>-LINK</span></a>
<div class="card">${player}<div class="meta">${size} • ينتهي: ${meta.expiryAt ? new Date(meta.expiryAt).toLocaleString('ar-EG') : 'شهر كحد أقصى'}</div>
<div class="btns"><a class="btn" href="${stream}" target="_blank">▶️ تشغيل مباشر</a><a class="btn ghost" href="${dl}">⬇️ تحميل</a><a class="btn ghost" href="#" onclick="navigator.clipboard.writeText('${dl}');return false">📋 نسخ</a></div></div>
<footer>MADE WITH 💜 BY <b>ELMINYAWE</b></footer></div></body></html>`);
});

app.delete('/api/:id', async (req, res) => {
  const meta = db.files[req.params.id];
  if (!meta) return res.status(404).json({ error: 'Not found' });
  if (req.query.token !== meta.deleteToken && req.query.admin !== process.env.ADMIN_TOKEN)
    return res.status(403).json({ error: 'Forbidden' });
  if (meta.driver !== 'catbox') { try { fs.unlinkSync(path.join(UPLOAD_DIR, meta.stored)); } catch {} }
  delete db.files[req.params.id]; saveDB();
  res.json({ ok: true, brand: BRAND });
});

app.use((err, req, res, next) => res.status(400).json({ error: err.message }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('==========================================');
  console.log('  MINYAWE-LINK V5.1 by ELMINYAWE is READY');
  console.log(`  Port: ${PORT} | Max: ${MAX_MB}MB | Storage: ${DRIVER.toUpperCase()}`);
  console.log('==========================================');
});
