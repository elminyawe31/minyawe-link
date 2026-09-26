const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const app = express();
app.set('trust proxy', 1); // مهم عشان Railway يطلع https صح
app.disable('x-powered-by'); // منع بصمة Express الافتراضية (التعريف باسمك فقط عبر X-Powered-By: BRAND)
app.use(cors({ origin: '*', exposedHeaders: ['X-Powered-By'] }));
app.use(express.json());

// ===== هيدرات أمان عامة (لا تكسر الهوتلينك: الميديا لا تتأثر بها) =====
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff', // منع تخمين المتصفح لنوع الملف
    'Referrer-Policy': 'no-referrer',    // منع تسريب ?admin= لأي موقع خارجي
    'X-Frame-Options': 'SAMEORIGIN'      // منع تضمين صفحاتك في مواقع غريبة (clickjacking)
  });
  next();
});

// ===== حد معدل بسيط ضد السبام (بدون مكتبات): 60 طلب لكل IP كل 10 دقايق (الرفع المتعدد بيستهلك واحد لكل ملف) =====
const RL = new Map();
const RL_MAX = parseInt(process.env.RATE_MAX || '60', 10);
const RL_WIN = 10 * 60 * 1000;
function rateLimit(req, res, next) {
  try {
    const fwd = req.get('x-forwarded-for') || '';
    const ip = ((req.ip || fwd.split(',')[0] || 'unknown') + '').slice(0, 64);
    const now = Date.now();
    let rec = RL.get(ip);
    if (!rec || now - rec.t > RL_WIN) rec = { n: 0, t: now };
    rec.n++;
    RL.set(ip, rec);
    if (RL.size > 5000) { // تنظيف دوري عشان الذاكرة
      for (const [k, v] of RL) { if (now - v.t > RL_WIN) RL.delete(k); if (RL.size < 4000) break; }
    }
    if (rec.n > RL_MAX) return res.status(429).json({ error: 'Too many requests — try again in a few minutes' });
    next();
  } catch { next(); }
}

// ===== تحقق صارم من الهوست (منع Host header poisoning → روابط و SSRF مزيفة) =====
function safeHost(h) {
  h = String(h || '').split(',')[0].trim().toLowerCase();
  if (!h || h.length > 253 || !/^[a-z0-9.-]+(?::\d+)?$/.test(h)) return '';
  return h;
}
// ===== تحقق من توكن الأدمن (timing-safe + يدعم الهيدر بدل الكويري) =====
function isAdminReq(req) {
  const tok = process.env.ADMIN_TOKEN;
  if (!tok) return false;
  const got = String(req.get('x-admin-token') || req.query.admin || '');
  try {
    const a = Buffer.from(got), b = Buffer.from(tok);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
// كلمات محجوزة لا تصلح كاسم مخصص (عشان متلخبطش الروابط)
const RESERVED_SLUGS = new Set(['api', 'health', 'v', 'e', 'd', 'i', 'a', 'admin', 'config', 'docs', 'stats', 'llms.txt']);

// ===== MINYAWE-LINK V2 | ELMINYAWE =====
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '200', 10);
const BRAND = 'MINYAWE-LINK | ELMINYAWE';
const AUDIT_PATH = path.join(DATA_DIR, 'audit.log');
const AUDIT_MAX_BYTES = 3 * 1024 * 1024; // تدوير السجل بعد 3MB

// IP العميل للسجل فقط (Railway يبعت x-forwarded-for — قابل للتزوير، للتوثيق مش للأمان)
function clientIp(req) {
  try {
    const fwd = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
    return ((fwd || req.ip || 'unknown') + '').slice(0, 64);
  } catch { return 'unknown'; }
}
// سجل العمليات: سطر JSON لكل حدث {t, ip, act, ...} — يُقرأ من /api/admin/audit
function audit(act, req, detail) {
  try {
    if (fs.existsSync(AUDIT_PATH) && fs.statSync(AUDIT_PATH).size > AUDIT_MAX_BYTES) {
      try { fs.renameSync(AUDIT_PATH, AUDIT_PATH + '.old'); } catch {}
    }
    const line = JSON.stringify({ t: Date.now(), ip: (detail && detail.ip) || clientIp(req), act, ...(detail || {}) });
    fs.appendFileSync(AUDIT_PATH, line + '\n');
  } catch {}
}
// باسورد الملف: scrypt مدمج (بدون مكتبات) — المخزن "salt:hash" فقط، والمقارنة timing-safe
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return salt + ':' + h;
}
function verifyPw(pw, stored) {
  try {
    const [salt, h] = String(stored || '').split(':');
    if (!salt || !h) return false;
    const a = Buffer.from(crypto.scryptSync(String(pw || ''), salt, 32).toString('hex'));
    const b = Buffer.from(h);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
// هل الملف مقفول والطلب معهوش الباسورد الصح؟ (?pw= في الرابط)
function needPw(meta, req) {
  if (!meta || !meta.pw) return false;
  return !verifyPw(req.query.pw, meta.pw);
}

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

// أسماء العرض العامة — البصمة بس (MINYAWE-*) من غير أسماء مخازن خارجية
// المنطق الداخلي بيفضل شغال بأسماء الدرايفرات الحقيقية، العرض بس اللي متجمّل
function dispDriver(d) {
  d = String(d || '').toLowerCase();
  if (d.includes('local') || d.includes('vault')) return 'MINYAWE-VAULT';
  return 'MINYAWE-CLOUD';
}

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
let db = { files: {}, albums: {} };
try {
  if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
} catch { db = { files: {}, albums: {} }; }
if (!db.files) db.files = {};
if (!db.albums) db.albums = {};
const saveDB = () => { try { fs.writeFileSync(DB_PATH, JSON.stringify(db)); } catch {} };

const genId = () => crypto.randomBytes(4).toString('hex');

// إصلاح أسماء العربي: المتصفح بيبعت UTF-8 وmulter بيقراها latin1 فبتطلع رموز غريبة (Ø±Ø¨…)
// الحل: نرجع البايتات لأصلها أول ما الملف يوصل
function fixName(n) {
  try {
    const f = Buffer.from(String(n), 'latin1').toString('utf8');
    if (f !== String(n) && !f.includes('�')) return f;
  } catch {}
  return String(n);
}
// هجرة لمرة واحدة: صلح الأسماء اللي اتخزنت غلط قبل كده (تحتوي عربي بعد الإصلاح فقط)
(function healNames() {
  let changed = false;
  for (const [id, m] of Object.entries(db.files)) {
    if (m && m.original && /[ØÙÞÃÂ]/.test(m.original)) {
      const f = fixName(m.original);
      if (f !== m.original && /[؀-ۿ]/.test(f)) { m.original = f; changed = true; }
    }
  }
  if (changed) saveDB();
})();

// أسماء مخصصة: 3-30 حرف (انجليزي/أرقام/-/_%) وفريدة
const SLUG_RE = /^[a-z0-9-_]{3,30}$/i;
function slugTaken(s) {
  const l = String(s).toLowerCase();
  if (db.files[s]) return true;
  return Object.values(db.files).some(f => (f.slug || '').toLowerCase() === l);
}
function findFile(key) {
  if (db.files[key]) return { id: key, meta: db.files[key] };
  const e = Object.entries(db.files).find(([id, f]) => (f.slug || '').toLowerCase() === String(key).toLowerCase());
  return e ? { id: e[0], meta: e[1] } : null;
}
function fileLinks(req, id, meta) {
  const b = baseUrl(req), key = meta.slug || id;
  const ext = path.extname(meta.original || '').replace(/^\./, '').toLowerCase() || 'bin';
  return {
    short: `${b}/i/${key}`,
    view: `${b}/v/${key}`,
    stream: `${b}/e/${key}.${ext}`,     // بامتداد الملف عشان كل المشغلات تقبله
    download: `${b}/d/${key}.${ext}`    // بامتداد الملف عشان يتحفظ صح
  };
}
// يفصل الامتداد الاختياري من آخر اللينك: "id.mp3" → {key:id, ext:mp3}
function parseKey(s) {
  const m = String(s).match(/^(.+)\.([A-Za-z0-9]{1,8})$/);
  if (m) {
    const base = m[1], bl = base.toLowerCase();
    const exists = db.files[base] || Object.values(db.files).some(f => (f.slug || '').toLowerCase() === bl);
    if (exists) return { key: base, ext: m[2].toLowerCase() };
  }
  return { key: String(s), ext: null };
}
function realExt(meta) {
  return (path.extname(meta.original || '').replace(/^\./, '').toLowerCase()) || 'bin';
}

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
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 10, fields: 8, parts: 20, fieldNameSize: 100, fieldSize: 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED.includes(ext)) return cb(new Error('File type blocked by MINYAWE'));
    cb(null, true);
  }
});

function baseUrl(req) {
  const envBase = (process.env.BASE_URL || '').replace(/\/$/, '');
  if (/^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(envBase)) return envBase;
  let proto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  if (proto !== 'http' && proto !== 'https') proto = req.protocol === 'https' ? 'https' : 'http';
  const host = safeHost(req.get('host'));
  if (!host) return `${proto}://localhost:${PORT}`; // هوست غريب/مسموم → fallback آمن
  return `${proto}://${host}`;
}

// هل المحتوى نشط (ممكن يشغل JS)؟ → لازم sandbox
function isActiveContent(ct) {
  return /text\/html|image\/svg|application\/xhtml|text\/xml|application\/xml/i.test(String(ct || ''));
}
function localFilePath(meta) {
  if (!meta || meta.driver === 'catbox') return null;
  try {
    const p = path.join(UPLOAD_DIR, String(meta.stored || ''));
    if (!p.startsWith(UPLOAD_DIR + path.sep) && p !== UPLOAD_DIR) return null;
    if (!fs.existsSync(p)) return null;
    return p;
  } catch { return null; }
}


// تحميل الميتا مع تنظيف المنتهي (مشترك بين /e و /d و /v) — يقبل id أو اسم مخصص
async function loadMeta(key, req) {
  const found = findFile(key);
  if (!found) return { err: 404 };
  const { id, meta } = found;
  if (meta.expiryAt && Date.now() > meta.expiryAt) {
    if (meta.driver !== 'catbox') { try { fs.unlinkSync(path.join(UPLOAD_DIR, meta.stored)); } catch {} }
    audit('expired', req, { id, key: meta.slug || id, name: meta.original, driver: meta.driver || '?', lazy: true });
    delete db.files[id]; saveDB();
    return { err: 410 };
  }
  return { id, meta };
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
      if (r.status === 416) {
        const cr416 = r.headers.get('content-range');
        res.status(416);
        if (cr416) res.set('Content-Range', cr416);
        res.set({ 'Accept-Ranges': 'bytes', 'X-Powered-By': BRAND });
        try { r.body.cancel(); } catch {}
        return res.send('Range Not Satisfiable | MINYAWE-LINK');
      }
      if (!r.ok && r.status !== 206) { lastStatus = r.status; continue; }
      res.status(r.status);
      // لو التخزين بعت نوع عام (octet-stream) نخمن الصح من الامتداد — عشان الـ .md والـ .txt يتعرضوا مش يتحملوا
      const upstreamCT = r.headers.get('content-type') || '';
      const effCT = (!upstreamCT || upstreamCT.includes('octet-stream')) ? mimeOf(meta.original, meta.mimetype) : upstreamCT;
      const hdrs = {
        'Content-Type': effCT,
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(meta.original)}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Powered-By': BRAND
      };
      // محتوى نشط (html/svg/xml) يتعرض inline → لازم sandbox عشان أي JS جواه ميتشتغلش على دومينك (stored XSS)
      if (disposition === 'inline' && isActiveContent(effCT)) hdrs['Content-Security-Policy'] = 'sandbox';
      res.set(hdrs);
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
        // ملحوظة صريحة: local يتمسح من القرص فعلا — catbox لا يمكن مسحه عن بعد، فيتشال من الفهرس فقط
        if (meta.driver !== 'catbox') { try { fs.unlinkSync(path.join(UPLOAD_DIR, meta.stored)); } catch {} }
        audit('expired', null, { ip: 'cron', id, key: (meta && meta.slug) || id, name: meta && meta.original, driver: (meta && meta.driver) || '?' });
        delete db.files[id];
        changed = true;
      }
    }
    for (const [aid, al] of Object.entries(db.albums || {})) { // سجلات الألبومات المنتهية (ملفاتها بتنتهي لوحدها)
      if (al && al.expiryAt && now > al.expiryAt) { delete db.albums[aid]; changed = true; }
    }
    if (changed) saveDB();
  })();
}
setInterval(cleanup, 5 * 60 * 1000);
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
  storage: dispDriver(DRIVER),
  chain: DRIVERS.map(dispDriver), // ترتيب المحاولة لو التخزين الأساسي وقع (أسماء عرض فقط)
  mirror: 'retry×2 per driver + vault fallback',
  disk, // مساحة الفوليوم — عشان الموقع ميملاش ويموت فجأة
  direct: true,
  features: { multiUpload: true, password: true, adminFiles: true, audit: true, backup: true, themes: ['dark', 'light'] },
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
    version: '6.5',
    base: b,
    auth: 'none',
    limits: { maxMB: MAX_MB, maxExpiryDays: 30, expiryValues: ['1h', '24h', '7d', '30d'], blockedExtensions: BLOCKED },
    storage: { chain: DRIVERS.map(dispDriver), note: 'each driver gets 2 attempts (1.5s apart), then next driver; vault disk is final fallback.' },
    endpoints: [
      { method: 'POST', path: '/api/upload', fields: { file: 'binary (multipart field "file")', expiry: '1h|24h|7d|30d (default 24h)', alias: 'optional slug a-z0-9-_ (3-30)', password: 'optional (min 3 chars) — locks file, access via ?pw=' }, returns: ['id', 'slug', 'url(raw storage)', 'short', 'view(page)', 'stream(direct play)', 'download(force download)', 'views', 'expiryAt', 'locked', 'deleteToken'] },
      { method: 'POST', path: '/api/album', fields: { files: 'up to 10 binaries (multipart field "files")', expiry: 'same as upload' }, returns: ['id', 'url(/a/:id)', 'count', 'files[]'] },
      { method: 'GET', path: '/a/:id', desc: 'album page: all files with links' },
      { method: 'GET', path: '/api/stats', desc: 'dashboard: files, views, bytes, byKind, top5' },
      { method: 'GET', path: '/v/:id', desc: 'branded preview page with player (password form if locked)' },
      { method: 'GET', path: '/e/:id.:ext', desc: 'branded direct stream with file extension (inline + Range); ext optional; locked files need ?pw=' },
      { method: 'GET', path: '/d/:id.:ext', desc: 'branded force download with file extension (attachment); ext optional; locked files need ?pw=' },
      { method: 'GET', path: '/i/:id', desc: 'short link (redirects to file); locked files need ?pw=' },
      { method: 'DELETE', path: '/api/:id?token=DELETE_TOKEN', desc: 'delete file record' },
      { method: 'POST', path: '/api/:id/password (admin)', fields: { password: 'new password, or empty string to remove' }, returns: ['ok', 'locked'] },
      { method: 'GET', path: '/api/admin/ping?admin=TOKEN', desc: 'admin: verify token (200 = valid, 403 = wrong)' },
      { method: 'GET', path: '/api/admin/files?admin=TOKEN&q=', desc: 'admin: full file list with search (name/slug/id)' },
      { method: 'GET', path: '/api/admin/audit?admin=TOKEN&q=&limit=', desc: 'admin: operation log (upload/delete/expired/pw/backup) with IP+time' },
      { method: 'GET', path: '/api/admin/backup?admin=TOKEN', desc: 'admin: download ZIP (db.json + audit.log + uploads + server.js)' },
      { method: 'GET', path: '/api/config', desc: 'live limits + storage chain' },
      { method: 'GET', path: '/health', desc: 'liveness probe, returns text OK' }
    ],
    examples: {
      curl: `curl -F "file=@song.mp3" -F "expiry=30d" -F "password=s3cret" "${b}/api/upload"`,
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
Storage chain (tried in order): ${DRIVERS.map(dispDriver).join(' -> ')}.

## Upload
POST ${b}/api/upload (multipart: file=<binary>, expiry=30d, alias=my-song [optional, unique], password=s3cret [optional, min 3 chars])
=> JSON: { id, slug, url, short, view, stream, download, views, expiryAt, locked, deleteToken }
Locked files: open ${b}/v/:id?pw=s3cret (form shown automatically) or append ?pw= to /e /d /i links.

## Album (up to 10 files, one page)
POST ${b}/api/album (multipart: files=<binaries>, expiry=7d)
=> JSON: { id, url: ${b}/a/:id, count, files[] }

## Admin (header x-admin-token or ?admin=TOKEN)
- GET ${b}/api/admin/ping — verify token (200 valid / 403 wrong)
- POST ${b}/api/:id/password {password} — set/change/remove (empty) file password
- GET ${b}/api/admin/files?q= — full list + search
- GET ${b}/api/admin/audit?q=&limit= — operation log with IP+time
- GET ${b}/api/admin/backup — ZIP download (db + audit + uploads)

## Stats
GET ${b}/api/stats => { files, totalViews, totalBytes, byKind, top[5] }

## Links (replace :id)
- Preview page: ${b}/v/:id
- Direct stream with extension (inline + Range): ${b}/e/:id.:ext (ext optional)
- Force download with extension: ${b}/d/:id.:ext (ext optional)
- Short redirect: ${b}/i/:id

## Manage
- DELETE ${b}/api/:id?token=DELETE_TOKEN
- Limits: ${b}/api/config | Full spec: ${b}/api/docs | Health: ${b}/health
- Blocked types: ${BLOCKED.join(' ')}`
  );
});

// نواة الرفع المشتركة (ملف واحد) — ترجع {id, meta}
async function persistUpload({ buffer, original, mimetype, size, expiryAt, alias, password }, req) {
  original = fixName(original); // صلح العربي قبل أي حاجة
  original = String(original).replace(/[\r\n\x00-\x1f\x7f]/g, '').slice(0, 180); // منع حقن هيدرات + أسماء عملاقة
  let slug = null;
  if (alias !== undefined && alias !== null && String(alias).trim() !== '') {
    const a = String(alias).trim();
    if (!SLUG_RE.test(a)) {
      const err = new Error('bad alias (3-30 chars: a-z 0-9 - _)');
      err.code = 400; throw err;
    }
    if (RESERVED_SLUGS.has(a.toLowerCase())) {
      const err = new Error('alias reserved');
      err.code = 400; throw err;
    }
    if (slugTaken(a)) {
      const err = new Error('alias taken');
      err.code = 409; throw err;
    }
    slug = a.toLowerCase();
  }
  let id = genId();
  while (db.files[id]) id = genId();
  const buf = buffer;
  // صحح النوع من الامتداد لو المتصفح بعت octet-stream — عشان التشغيل والمشغل
  const mtype = mimeOf(original, mimetype);
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
          const ext = path.extname(original).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12); // whitelist ضد traversal
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

  const meta = {
    stored, driver, directUrl,
    original, mimetype: mtype, size,
    expiryAt, deleteToken: crypto.randomBytes(8).toString('hex'),
    createdAt: Date.now(), views: 0
  };
  if (slug) meta.slug = slug;
  // باسورد اختياري: يتخزن hash فقط (scrypt) — أبدا plain text
  if (password !== undefined && password !== null && String(password) !== '') {
    const pw = String(password).slice(0, 128);
    if (pw.length < 3) { const err = new Error('password too short (min 3 chars)'); err.code = 400; throw err; }
    meta.pw = hashPw(pw);
  }
  db.files[id] = meta;
  saveDB();
  return { id, meta };
}

function apiErr(res, e) {
  let code = (e && Number.isInteger(e.code)) ? e.code : 500;
  let msg = (e && e.message) || 'error';
  if (e && e.code === 'LIMIT_FILE_SIZE') { code = 413; msg = `File too large (max ${MAX_MB}MB)`; }
  else if (code >= 500) { try { console.error('  [err]', String(msg).slice(0, 300)); } catch {} msg = 'server error — try again'; }
  res.status(code).json({ error: msg });
}

// رفع — يقبل صور/أغاني/فيديو/ملفات ويرجع لينك مباشر (+ اسم مخصص اختياري)
app.post('/api/upload', rateLimit, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const expiryAt = parseExpiry(req.body.expiry || req.query.expiry || '24h');
    const { id, meta } = await persistUpload({
      buffer: req.file.buffer, original: req.file.originalname,
      mimetype: req.file.mimetype, size: req.file.size,
      expiryAt, alias: req.body.alias || req.query.alias,
      password: req.body.password || req.query.password
    }, req);
    audit('upload', req, { id, key: meta.slug || id, name: meta.original, size: meta.size, locked: !!meta.pw });
    res.json({
      id, slug: meta.slug || null,
      url: meta.directUrl,           // اللينك الخام للتخزين
      ...fileLinks(req, id, meta),   // short/view/stream/download باسمك
      mirror: null,
      expiryAt, deleteToken: meta.deleteToken, views: 0,
      locked: !!meta.pw,             // هل محتاج باسورد (?pw=)
      powered_by: BRAND
    });
  } catch (e) { apiErr(res, e); }
});

// ألبوم — لحد 10 ملفات مع بعض في صفحة واحدة
app.post('/api/album', rateLimit, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files (max 10)' });
    const expiryAt = parseExpiry(req.body.expiry || req.query.expiry || '24h');
    const out = [];
    for (const f of req.files) {
      const { id, meta } = await persistUpload({
        buffer: f.buffer, original: f.originalname,
        mimetype: f.mimetype, size: f.size, expiryAt
      }, req);
      out.push({ id, name: f.originalname, size: f.size, views: 0, ...fileLinks(req, id, meta) });
    }
    let aid = genId();
    while (db.albums[aid]) aid = genId();
    db.albums[aid] = { files: out.map(o => o.id), createdAt: Date.now(), expiryAt };
    saveDB();
    audit('album', req, { id: aid, count: out.length });
    res.json({ id: aid, url: `${baseUrl(req)}/a/${aid}`, count: out.length, expiryAt, files: out, powered_by: BRAND });
  } catch (e) { apiErr(res, e); }
});

// فحص وجود ملفات (لتبويب "ملفاتي"): يرجع true للموجود وغير المنتهي فقط — بدون أي آثار جانبية (لا عداد ولا مسح)
app.get('/api/check', (req, res) => {
  const now = Date.now();
  const ids = String(req.query.ids || '').split(',').map(s => s.trim().slice(0, 64)).filter(Boolean).slice(0, 20);
  const ok = {};
  for (const key of ids) {
    const found = findFile(key);
    ok[key] = !!(found && (!found.meta.expiryAt || found.meta.expiryAt > now));
  }
  res.json({ ok });
});

// إحصائيات — لوحة الأرقام
app.get('/api/stats', (req, res) => {
  const now = Date.now();
  const live = Object.entries(db.files).filter(([id, m]) => !m.expiryAt || m.expiryAt > now);
  const byKind = { image: 0, audio: 0, video: 0, text: 0, file: 0 };
  let totalViews = 0, totalBytes = 0;
  live.forEach(([id, m]) => {
    totalViews += m.views || 0; totalBytes += m.size || 0;
    try { const k = kindOf(m); if (byKind[k] !== undefined) byKind[k]++; } catch {}
  });
  // الخصوصية: التفاصيل (أسماء/لينكات) للأدمن بس — أي حد تاني يشوف الأرقام الإجمالية بس
  // أي مستخدم يشوف ملفاته هو من متصفحه (ملفاتي الأخيرة)، وأي ملف يتفتح بالرابط بتاعه عادي
  // التوكن يتقبل في هيدر x-admin-token (الأفضل) أو كويري ?admin= — يقارن timing-safe
  const isAdmin = isAdminReq(req);
  // الأدمن يشوف لحد 100 (?limit=) مع سكرول في الواجهة — الزائر أول 5 فقط
  const lim = isAdmin ? Math.min(Math.max(parseInt(req.query.limit || '5', 10) || 5, 1), 100) : 5;
  const top = live.map(([id, m]) => isAdmin
  ? { id, key: m.slug || id, name: m.original, views: m.views || 0, size: m.size, view: `${baseUrl(req)}/v/${m.slug || id}` }
  : { views: m.views || 0, size: m.size })
    .sort((a, b) => b.views - a.views).slice(0, lim);
  res.json({ files: live.length, totalViews, totalBytes, byKind, top, admin: !!isAdmin, powered_by: BRAND });
});

// لينك مباشر دايما — inline + CORS مفتوح عشان يشتغل في أي مشغل/موقع
app.get('/i/:id', async (req, res) => {
  const found = findFile(req.params.id);
  if (!found) return res.status(404).send('Not found | MINYAWE-LINK');
  const { id, meta } = found;
  if (meta.expiryAt && Date.now() > meta.expiryAt) {
    if (meta.driver !== 'catbox') { try { fs.unlinkSync(path.join(UPLOAD_DIR, meta.stored)); } catch {} }
    audit('expired', req, { id, key: meta.slug || id, name: meta.original, driver: meta.driver || '?', lazy: true });
    delete db.files[id]; saveDB();
    return res.status(410).send('Expired | MINYAWE-LINK');
  }
  if (needPw(meta, req)) return res.status(403).send('Locked — password required (?pw=) | MINYAWE-LINK');
  res.set({
    'X-Powered-By': BRAND,
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Accept-Ranges': 'bytes' // مهم للفيديو/الأغاني seek
  });
  if (meta.driver === 'catbox' && meta.directUrl) {
    return res.redirect(302, meta.directUrl);
  }
  // ملف محلي → يتخدم مباشرة من الديسك (من غير self-proxy)
  const filePath = localFilePath(meta);
  if (!filePath) return res.status(410).send('Gone | MINYAWE-LINK');
  const ct = mimeOf(meta.original, meta.mimetype);
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(meta.original)}"`);
  res.type(ct);
  if (isActiveContent(ct)) res.set('Content-Security-Policy', 'sandbox'); // html/svg inline = بدون JS
  res.sendFile(filePath);
});

// ▶️ التشغيل المباشر باسمك (يقبل /e/id.mp3 عشان المشغلات — والقديم من غير امتداد شغال)

// ▶️ التشغيل المباشر باسمك (يقبل /e/id.mp3 عشان المشغلات — والقديم من غير امتداد شغال)
app.get('/e/:file', async (req, res) => {
  const { key, ext } = parseKey(req.params.file);
  const { id, meta, err } = await loadMeta(key, req);
  if (err === 404) return res.status(404).send('Not found | MINYAWE-LINK');
  if (err === 410) return res.status(410).send('Expired | MINYAWE-LINK');
  if (needPw(meta, req)) return res.status(403).send('Locked — password required (?pw=) | MINYAWE-LINK');
  const rx = realExt(meta);
  const keepPw = req.query.pw ? '?pw=' + encodeURIComponent(req.query.pw) : '';
  if (ext && ext !== rx) return res.redirect(301, `/e/${meta.slug || id}.${rx}${keepPw}`);
  meta.views = (meta.views || 0) + 1; saveDB(); // عداد المشاهدات
  if (meta.driver !== 'local' && meta.directUrl) return proxyFile(meta, req, res, 'inline');
  const filePath = localFilePath(meta);
  if (!filePath) return res.status(410).send('Gone | MINYAWE-LINK');
  const ct = mimeOf(meta.original, meta.mimetype);
  res.set({
    'X-Powered-By': BRAND, 'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin', 'Accept-Ranges': 'bytes'
  });
  res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.original)}`);
  res.type(ct);
  if (isActiveContent(ct)) res.set('Content-Security-Policy', 'sandbox'); // html/svg inline = بدون JS
  res.sendFile(filePath);
});

// ⬇️ التحميل المباشر باسمك (يقبل /d/id.mp3 — والقديم شغال)
app.get('/d/:file', async (req, res) => {
  const { key, ext } = parseKey(req.params.file);
  const { id, meta, err } = await loadMeta(key, req);
  if (err === 404) return res.status(404).send('Not found | MINYAWE-LINK');
  if (err === 410) return res.status(410).send('Expired | MINYAWE-LINK');
  if (needPw(meta, req)) return res.status(403).send('Locked — password required (?pw=) | MINYAWE-LINK');
  const rx = realExt(meta);
  const keepPw2 = req.query.pw ? '?pw=' + encodeURIComponent(req.query.pw) : '';
  if (ext && ext !== rx) return res.redirect(301, `/d/${meta.slug || id}.${rx}${keepPw2}`);
  if (meta.driver !== 'local' && meta.directUrl) return proxyFile(meta, req, res, 'attachment');
  const dlPath = localFilePath(meta);
  if (!dlPath) return res.status(410).send('Gone | MINYAWE-LINK');
  res.download(dlPath, meta.original);
});

// 👁️ صفحة العرض باسمك (مشغل أنيق + كل اللينكات)
app.get('/v/:id', async (req, res) => {
  const { id, meta, err } = await loadMeta(req.params.id, req);
  if (err === 404) return res.status(404).send('Not found | MINYAWE-LINK');
  if (err === 410) return res.status(410).send('Expired | MINYAWE-LINK');
  // ملف محمي: من غير الباسورد الصح اعرض نموذج فتح (GET ?pw=) — لا يزيد عداد المشاهدات
  if (needPw(meta, req)) {
    const wrong = req.query.pw !== undefined ? '<div class="err">باسورد غلط — حاول تاني</div>' : '';
    return res.status(200).send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ملف محمي | MINYAWE-LINK</title>
<style>body{margin:0;background:#000;color:#f0f0f0;font-family:Inter,system-ui,sans-serif;text-align:center;padding:24px 16px 60px}
.wrap{max-width:480px;margin:0 auto}.logo{font-weight:600;color:#fff;text-decoration:none}
.card{background:#000;border:1px solid #292d30;border-radius:16px;padding:32px;margin-top:20px}
h2{font-size:20px;font-weight:500;color:#fff;margin:0 0 8px}.hint{font-family:monospace;font-size:12px;color:#a1a4a5;margin-bottom:20px}
.err{font-size:14px;color:#ff9592;margin-bottom:12px}
input{background:transparent;border:1px solid #292d30;border-radius:6px;color:#fff;font-family:monospace;font-size:14px;padding:12px 16px;width:100%;box-sizing:border-box;outline:none;direction:ltr;text-align:center}
input:focus{border-color:#fff}
button{background:transparent;color:#fff;border:1px solid #292d30;border-radius:6px;padding:12px 16px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;width:100%;margin-top:12px}
button:hover{border-color:#fff}
footer{margin-top:28px;font-family:monospace;font-size:12px;color:#464a4d}footer b{color:#fff}</style></head>
<body><div class="wrap"><a class="logo" href="/">MINYAWE-LINK</a>
<div class="card"><h2>🔒 ملف محمي</h2><div class="hint">${esc(meta.original)}</div>${wrong}
<form method="GET"><input type="password" name="pw" placeholder="password" autocomplete="off"><button type="submit">فتح الملف</button></form></div>
<footer>Dev <b>ELMINYAWE</b></footer></div></body></html>`);
  }
  meta.views = (meta.views || 0) + 1; saveDB(); // عداد المشاهدات
  const L = fileLinks(req, id, meta);
  const pwSuffix = meta.pw && req.query.pw ? '?pw=' + encodeURIComponent(req.query.pw) : '';
  const stream = L.stream + pwSuffix, dl = L.download + pwSuffix, view = L.view;
  const enc = encodeURIComponent(view);
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
      if (meta.driver !== 'local' && meta.directUrl) {
        const tr = await fetch(meta.directUrl, { headers: { Range: 'bytes=0-29999' } });
        if (tr.ok || tr.status === 206) snippet = (await tr.text()).slice(0, 30000);
      } else {
        const lp = localFilePath(meta);
        if (lp) snippet = fs.readFileSync(lp, 'utf8').slice(0, 30000);
      }
    } catch {}
    player = snippet
      ? `<div class="fn">${name}</div><pre class="txt">${esc(snippet)}</pre>`
      : `<div class="file">📁<div class="fn">${name}</div><div class="sz">${size}</div></div>`;
  }
  else player = `<div class="file">📁<div class="fn">${name}</div><div class="sz">${size}</div></div>`;
  res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} | MINYAWE-LINK</title>
<style>body{margin:0;background:#000;color:#f0f0f0;font-family:Inter,system-ui,sans-serif;text-align:center;padding:24px 16px 60px}
.wrap{max-width:640px;margin:0 auto}.logo{font-weight:600;color:#fff;text-decoration:none}
.logo span{color:#fff}.card{background:#000;border:1px solid #292d30;border-radius:16px;padding:32px;margin-top:20px}
img,video{max-width:100%;border-radius:16px}audio{width:100%;margin-top:12px}.fn{font-family:monospace;font-size:13px;word-break:break-all;margin:8px 0;color:#f0f0f0}
pre.txt{direction:ltr;text-align:left;background:#000;border:1px solid #292d30;border-radius:16px;padding:24px;font-family:monospace;font-size:13px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;margin-top:12px;color:#f0f0f0}
.sz{font-family:monospace;font-size:12px;color:#a1a4a5}.meta{font-family:monospace;font-size:12px;color:#a1a4a5;margin-top:10px}
.btns{display:flex;gap:16px;justify-content:center;flex-wrap:wrap;margin-top:24px}
a.btn{background:transparent;color:#fff;border:1px solid #292d30;border-radius:6px;padding:12px 16px;font-size:14px;font-weight:500;text-decoration:none}
a.btn:hover{border-color:#fff}button.btn{background:transparent;color:#fff;border:1px solid #292d30;border-radius:6px;padding:12px 16px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit}
button.btn:hover{border-color:#fff}
#tst{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#000;border:1px solid #292d30;border-radius:6px;padding:12px 16px;font-family:monospace;font-size:13px;color:#f0f0f0;display:none;z-index:99}
footer{margin-top:28px;font-family:monospace;font-size:12px;color:#464a4d}footer b{color:#fff}</style></head>
<body><div class="wrap"><a class="logo" href="/">MINYAWE<span>-LINK</span></a>
<div class="card">${player}<div class="meta">${size} • المشاهدات: ${meta.views || 0} • ينتهي: ${meta.expiryAt ? new Date(meta.expiryAt).toLocaleString('ar-EG') : 'شهر كحد أقصى'}</div>
<div class="btns"><a class="btn" href="${stream}" target="_blank">تشغيل مباشر</a><a class="btn" href="${dl}">تحميل</a><button class="btn" onclick="cp('${dl}')">نسخ</button></div>
<div class="btns"><a class="btn" href="https://wa.me/?text=${enc}" target="_blank">واتساب</a><a class="btn" href="https://t.me/share/url?url=${enc}" target="_blank">تيليجرام</a><a class="btn" href="https://twitter.com/intent/tweet?url=${enc}" target="_blank">X</a></div></div>
<div id="tst"></div>
<footer>Dev <b>ELMINYAWE</b></footer></div>
<script>function cp(t){function ok(){var e=document.getElementById('tst');e.textContent='تم النسخ ✓';e.style.display='block';setTimeout(function(){e.style.display='none';},5000);}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,function(){ok();});}else{var a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();try{document.execCommand('copy');}catch(_){}a.remove();ok();}}</script></body></html>`);
});

// ===== إدارة الأدمن (كلها تتطلب ADMIN_TOKEN عبر هيدر x-admin-token أو ?admin=) =====
function needAdmin(req, res) {
  if (!isAdminReq(req)) { res.status(403).json({ error: 'Forbidden — admin only' }); return false; }
  return true;
}
// تعيين/تغيير/إزالة باسورد ملف: {password:"..."} للإضافة، {password:""} للإزالة
app.post('/api/:id/password', async (req, res) => {
  if (!needAdmin(req, res)) return;
  const found = findFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  const pw = req.body && req.body.password !== undefined ? String(req.body.password) : null;
  if (pw === null) return res.status(400).json({ error: 'password field required (empty string removes)' });
  if (pw === '') {
    delete found.meta.pw; saveDB();
    audit('pw-remove', req, { id: found.id, key: found.meta.slug || found.id });
    return res.json({ ok: true, locked: false });
  }
  if (pw.length < 3 || pw.length > 128) return res.status(400).json({ error: 'password must be 3-128 chars' });
  found.meta.pw = hashPw(pw); saveDB();
  audit('pw-set', req, { id: found.id, key: found.meta.slug || found.id });
  res.json({ ok: true, locked: true });
});
// تحقق توكن الأدمن (تستخدمه نافذة الدخول قبل إعلان وضع الأدمن — أي توكن غلط يرجع 403 ولا يُقبل أبدا)
app.get('/api/admin/ping', (req, res) => {
  if (!needAdmin(req, res)) return;
  res.json({ ok: true, admin: true });
});
// قائمة الملفات الكاملة + بحث (q يدور في الاسم والرابط والـ id)
app.get('/api/admin/files', (req, res) => {
  if (!needAdmin(req, res)) return;
  const q = String(req.query.q || '').toLowerCase();
  const b = baseUrl(req);
  let arr = Object.entries(db.files).map(([id, m]) => ({
    id, key: m.slug || id, name: m.original, size: m.size || 0,
    views: m.views || 0, kind: kindOf(m), driver: m.driver,
    createdAt: m.createdAt || 0, expiryAt: m.expiryAt || null,
    locked: !!m.pw, view: `${b}/v/${m.slug || id}`
  })).sort((x, y) => y.createdAt - x.createdAt);
  if (q) arr = arr.filter(f => (f.name + ' ' + f.key + ' ' + f.id).toLowerCase().includes(q));
  res.json({ files: arr.slice(0, 500), total: arr.length });
});
// سجل العمليات: الأحدث أولا + بحث نصي + حد أقصى
app.get('/api/admin/audit', (req, res) => {
  if (!needAdmin(req, res)) return;
  const q = String(req.query.q || '').toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10) || 200, 1), 1000);
  let lines = [];
  try {
    if (fs.existsSync(AUDIT_PATH)) {
      const raw = fs.readFileSync(AUDIT_PATH, 'utf8').split('\n').filter(Boolean);
      lines = raw.slice(-2000).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
  } catch {}
  lines.reverse();
  if (q) lines = lines.filter(e => JSON.stringify(e).toLowerCase().includes(q));
  res.json({ entries: lines.slice(0, limit), total: lines.length });
});
// نسخ احتياطي ZIP: db.json + audit.log + كل ملفات uploads (تحميل يدوي من لوحة الأدمن)
app.get('/api/admin/backup', (req, res) => {
  if (!needAdmin(req, res)) return;
  let archiver;
  try { archiver = require('archiver'); }
  catch { return res.status(501).json({ error: 'backup module missing — run npm install' }); }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="minyawe-backup-${stamp}.zip"` });
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', () => { try { res.end(); } catch {} });
  zip.pipe(res);
  try {
    if (fs.existsSync(DB_PATH)) zip.file(DB_PATH, { name: 'db.json' });
    if (fs.existsSync(AUDIT_PATH)) zip.file(AUDIT_PATH, { name: 'audit.log' });
    if (fs.existsSync(AUDIT_PATH + '.old')) zip.file(AUDIT_PATH + '.old', { name: 'audit.old.log' });
    zip.file(__filename, { name: 'server.js' });
    if (fs.existsSync(UPLOAD_DIR)) zip.directory(UPLOAD_DIR, 'uploads');
  } catch {}
  audit('backup', req, {});
  zip.finalize();
});

app.delete('/api/:id', async (req, res) => {
  const found = findFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  const { id, meta } = found;
  // المسح إما بتوكن الحذف الخاص بالملف، أو بتوكن الأدمن (timing-safe، ويفضل عبر هيدر x-admin-token)
  if (req.query.token !== meta.deleteToken && !isAdminReq(req))
    return res.status(403).json({ error: 'Forbidden' });
  if (meta.driver !== 'catbox') { try { fs.unlinkSync(path.join(UPLOAD_DIR, meta.stored)); } catch {} }
  delete db.files[id]; saveDB();
  audit('delete', req, { id, key: meta.slug || id, name: meta.original, by: req.query.token === meta.deleteToken ? 'owner-token' : 'admin' });
  res.json({ ok: true, brand: BRAND });
});

// 📁 صفحة الألبوم — كل ملفات المجموعة في صفحة واحدة
app.get('/a/:id', async (req, res) => {
  const al = db.albums[req.params.id];
  if (!al) return res.status(404).send('Not found | MINYAWE-LINK');
  if (al.expiryAt && Date.now() > al.expiryAt) { delete db.albums[req.params.id]; saveDB(); return res.status(410).send('Expired | MINYAWE-LINK'); }
  const b = baseUrl(req);
  const rows = al.files.map(fid => {
    const m = db.files[fid];
    if (!m) return '';
    const key = m.slug || fid;
    const sz = ((m.size || 0) / 1048576).toFixed(2) + ' MB';
    return `<div class="frow"><span class="fn">${esc(m.original)}</span><span class="sz">${sz} • ${m.views || 0} 👁</span><span class="ops"><a class="btn" href="${b}/v/${key}" target="_blank">عرض</a><a class="btn" href="${b}/d/${key}">تحميل</a></span></div>`;
  }).join('');
  res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ألبوم (${al.files.length}) | MINYAWE-LINK</title>
<style>body{margin:0;background:#000;color:#f0f0f0;font-family:Inter,system-ui,sans-serif;text-align:center;padding:24px 16px 60px}
.wrap{max-width:640px;margin:0 auto}.logo{font-weight:600;color:#fff;text-decoration:none}
.card{background:#000;border:1px solid #292d30;border-radius:16px;padding:32px;margin-top:20px;text-align:right}
.card h2{font-size:20px;font-weight:500;color:#fff;margin:0 0 4px}.card .cnt{font-family:monospace;font-size:12px;color:#a1a4a5;margin-bottom:12px}
.frow{display:flex;align-items:center;gap:16px;padding:14px 0;border-bottom:1px solid #292d30;font-size:14px}
.frow:last-child{border-bottom:0}.fn{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:13px;direction:ltr;text-align:right}
.sz{font-family:monospace;font-size:12px;color:#a1a4a5;white-space:nowrap}.ops{display:flex;gap:8px}
a.btn{background:transparent;color:#fff;border:1px solid #292d30;border-radius:6px;padding:8px 16px;font-size:13px;text-decoration:none;white-space:nowrap}
a.btn:hover{border-color:#fff}
footer{margin-top:28px;font-family:monospace;font-size:12px;color:#464a4d}footer b{color:#fff}</style></head>
<body><div class="wrap"><a class="logo" href="/">MINYAWE-LINK</a>
<div class="card"><h2>ألبوم الملفات</h2><div class="cnt">${al.files.length} files • expires ${al.expiryAt ? new Date(al.expiryAt).toLocaleString('ar-EG') : '—'}</div>${rows || '<div class="cnt">لا توجد ملفات متاحة</div>'}</div>
<footer>Dev <b>ELMINYAWE</b></footer></div></body></html>`);
});

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File too large (max ${MAX_MB}MB)` });
  if (err && /blocked/i.test(err.message || '')) return res.status(400).json({ error: err.message });
  try { console.error('  [req-err]', String((err && err.message) || err).slice(0, 200)); } catch {}
  res.status(400).json({ error: 'bad request' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('==========================================');
  console.log('  MINYAWE-LINK V6.5 by ELMINYAWE is READY');
  console.log(`  Port: ${PORT} | Max: ${MAX_MB}MB | Storage: ${DRIVER.toUpperCase()}`);
  console.log('==========================================');
});
