const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ===== MINYAWE CONFIG =====
const PORT = process.env.PORT || 3000; // مهم: Railway بيدي PORT لوحده
const DATA_DIR = process.env.DATA_DIR || '/data';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10);
const BRAND = 'MINYAWE-LINK | ELMINYAWE';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ===== DB بسيطة JSON عشان تشتغل من غير Postgres =====
let db = { files: {} };
try {
  if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
} catch { db = { files: {} }; }
const saveDB = () => fs.writeFileSync(DB_PATH, JSON.stringify(db));

const genId = () => crypto.randomBytes(4).toString('hex'); // 8 حروف

function parseExpiry(v) {
  const now = Date.now();
  if (v === '1h') return now + 3600 * 1000;
  if (v === '7d') return now + 7 * 24 * 3600 * 1000;
  if (v === 'never') return null;
  return now + 24 * 3600 * 1000; // default 24h
}

const BLOCKED = ['.exe', '.scr', '.com', '.bat', '.ps1', '.vbs', '.jar'];
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    let id = genId();
    while (db.files[id]) id = genId();
    req.minyaweId = id;
    cb(null, id + path.extname(file.originalname).toLowerCase());
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED.includes(ext)) return cb(new Error('File type blocked by MINYAWE'));
    cb(null, true);
  }
});

function baseUrl(req) {
  const b = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return b;
}

function cleanup() {
  const now = Date.now();
  let changed = false;
  for (const [id, meta] of Object.entries(db.files)) {
    if (meta.expiryAt && now > meta.expiryAt) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, meta.stored)); } catch {}
      delete db.files[id];
      changed = true;
    }
  }
  if (changed) saveDB();
}
setInterval(cleanup, 10 * 60 * 1000);
cleanup();

// ===== ROUTES =====
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.send('MINYAWE-LINK OK'));

app.get('/api/config', (req, res) => res.json({ brand: BRAND, maxMB: MAX_MB }));

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const id = req.minyaweId;
  const expiryInput = req.body.expiry || req.query.expiry || '24h';
  const expiryAt = parseExpiry(expiryInput);
  const deleteToken = crypto.randomBytes(8).toString('hex');
  db.files[id] = {
    stored: req.file.filename,
    original: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    expiryAt,
    deleteToken,
    createdAt: Date.now()
  };
  saveDB();
  res.json({
    id,
    url: `${baseUrl(req)}/i/${id}`,
    expiryAt,
    deleteToken,
    powered_by: BRAND
  });
});

app.get('/i/:id', (req, res) => {
  const meta = db.files[req.params.id];
  if (!meta) return res.status(404).send('Not found | MINYAWE-LINK');
  if (meta.expiryAt && Date.now() > meta.expiryAt) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, meta.stored)); } catch {}
    delete db.files[req.params.id]; saveDB();
    return res.status(410).send('Expired | MINYAWE-LINK');
  }
  res.set('X-Powered-By', BRAND);
  res.sendFile(path.join(UPLOAD_DIR, meta.stored));
});

app.delete('/api/:id', (req, res) => {
  const meta = db.files[req.params.id];
  if (!meta) return res.status(404).json({ error: 'Not found' });
  if (req.query.token !== meta.deleteToken && req.query.admin !== process.env.ADMIN_TOKEN)
    return res.status(403).json({ error: 'Forbidden' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, meta.stored)); } catch {}
  delete db.files[req.params.id]; saveDB();
  res.json({ ok: true, brand: BRAND });
});

app.use((err, req, res, next) => res.status(400).json({ error: err.message }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('==========================================');
  console.log('  MINYAWE-LINK by ELMINYAWE is READY');
  console.log(`  Port: ${PORT} | Max: ${MAX_MB}MB | Dir: ${DATA_DIR}`);
  console.log('==========================================');
});
