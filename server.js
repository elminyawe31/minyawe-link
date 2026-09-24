const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// S3-compatible storage (R2 / Storj / B2 / MinIO) — اختياري
// لو المتغيرات دي موجودة هنخزن عليها، لو مش موجودة هنخزن local على /data
const S3_ENDPOINT = process.env.S3_ENDPOINT || '';
const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_KEY = process.env.S3_ACCESS_KEY || '';
const S3_SECRET = process.env.S3_SECRET_KEY || '';
const S3_REGION = process.env.S3_REGION || 'auto';
const S3_PUBLIC_URL = (process.env.S3_PUBLIC_URL || '').replace(/\/$/, '');
const USE_S3 = Boolean(S3_ENDPOINT && S3_BUCKET && S3_KEY && S3_SECRET);

let s3 = null;
if (USE_S3) {
  const { S3Client } = require('@aws-sdk/client-s3');
  s3 = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET },
    forcePathStyle: true
  });
  console.log('  Storage: S3/R2 mode ->', S3_BUCKET);
} else {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log('  Storage: LOCAL mode ->', UPLOAD_DIR);
}

// ===== DB =====
let db = { files: {} };
try {
  if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
} catch { db = { files: {} }; }
const saveDB = () => { try { fs.writeFileSync(DB_PATH, JSON.stringify(db)); } catch {} };

const genId = () => crypto.randomBytes(4).toString('hex');

function parseExpiry(v) {
  const now = Date.now();
  if (v === '1h') return now + 3600 * 1000;
  if (v === '7d') return now + 7 * 24 * 3600 * 1000;
  if (v === '30d') return now + 30 * 24 * 3600 * 1000;
  if (v === 'never') return null;
  return now + 24 * 3600 * 1000;
}

// نمنع الخطر بس، ونسمح بأغاني وفيديو وصور زي top4top
const BLOCKED = ['.exe', '.scr', '.com', '.bat', '.ps1', '.vbs', '.jar', '.msi', '.dll'];

const upload = multer({
  storage: USE_S3 ? multer.memoryStorage() : multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      let id = genId();
      while (db.files[id]) id = genId();
      req.minyaweId = id;
      cb(null, id + path.extname(file.originalname).toLowerCase());
    }
  }),
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

async function putToS3(key, buffer, mimetype, original) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimetype || 'application/octet-stream',
    ContentDisposition: `inline; filename="${encodeURIComponent(original)}"`
  }));
}

async function deleteFromS3(key) {
  try {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  } catch {}
}

function cleanup() {
  const now = Date.now();
  let changed = false;
  (async () => {
    for (const [id, meta] of Object.entries(db.files)) {
      if (meta.expiryAt && now > meta.expiryAt) {
        if (meta.driver === 's3' && USE_S3) await deleteFromS3(meta.stored);
        else { try { fs.unlinkSync(path.join(UPLOAD_DIR, meta.stored)); } catch {} }
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

app.get('/api/config', (req, res) => res.json({
  brand: BRAND,
  maxMB: MAX_MB,
  storage: USE_S3 ? 's3:' + S3_BUCKET : 'local',
  direct: true
}));

// رفع — يقبل صور/أغاني/فيديو/ملفات ويرجع لينك مباشر
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const expiryInput = req.body.expiry || req.query.expiry || '24h';
    const expiryAt = parseExpiry(expiryInput);
    const deleteToken = crypto.randomBytes(8).toString('hex');

    let id, stored, driver, directUrl;
    if (USE_S3) {
      id = genId();
      while (db.files[id]) id = genId();
      const ext = path.extname(req.file.originalname).toLowerCase();
      stored = id + ext;
      await putToS3(stored, req.file.buffer, req.file.mimetype, req.file.originalname);
      driver = 's3';
      directUrl = S3_PUBLIC_URL ? `${S3_PUBLIC_URL}/${stored}` : `${baseUrl(req)}/i/${id}`;
    } else {
      id = req.minyaweId;
      stored = req.file.filename;
      driver = 'local';
      directUrl = `${baseUrl(req)}/i/${id}`;
    }

    db.files[id] = {
      stored, driver,
      original: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      expiryAt, deleteToken,
      createdAt: Date.now()
    };
    saveDB();
    res.json({ id, url: directUrl, short: `${baseUrl(req)}/i/${id}`, expiryAt, deleteToken, powered_by: BRAND });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// لينك مباشر دايما — inline + CORS مفتوح عشان يشتغل في أي مشغل/موقع
app.get('/i/:id', async (req, res) => {
  const meta = db.files[req.params.id];
  if (!meta) return res.status(404).send('Not found | MINYAWE-LINK');
  if (meta.expiryAt && Date.now() > meta.expiryAt) {
    if (meta.driver === 's3' && USE_S3) await deleteFromS3(meta.stored);
    else { try { fs.unlinkSync(path.join(UPLOAD_DIR, meta.stored)); } catch {} }
    delete db.files[req.params.id]; saveDB();
    return res.status(410).send('Expired | MINYAWE-LINK');
  }
  res.set({
    'X-Powered-By': BRAND,
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Accept-Ranges': 'bytes' // مهم للفيديو/الأغاني seek
  });
  if (meta.driver === 's3' && USE_S3 && S3_PUBLIC_URL) {
    return res.redirect(302, `${S3_PUBLIC_URL}/${meta.stored}`);
  }
  const filePath = path.join(UPLOAD_DIR, meta.stored);
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(meta.original)}"`);
  if (meta.mimetype) res.type(meta.mimetype);
  res.sendFile(filePath);
});

app.delete('/api/:id', async (req, res) => {
  const meta = db.files[req.params.id];
  if (!meta) return res.status(404).json({ error: 'Not found' });
  if (req.query.token !== meta.deleteToken && req.query.admin !== process.env.ADMIN_TOKEN)
    return res.status(403).json({ error: 'Forbidden' });
  if (meta.driver === 's3' && USE_S3) await deleteFromS3(meta.stored);
  else { try { fs.unlinkSync(path.join(UPLOAD_DIR, meta.stored)); } catch {} }
  delete db.files[req.params.id]; saveDB();
  res.json({ ok: true, brand: BRAND });
});

app.use((err, req, res, next) => res.status(400).json({ error: err.message }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('==========================================');
  console.log('  MINYAWE-LINK V2 by ELMINYAWE is READY');
  console.log(`  Port: ${PORT} | Max: ${MAX_MB}MB | Storage: ${USE_S3 ? 'S3/R2' : 'LOCAL'}`);
  console.log('==========================================');
});
