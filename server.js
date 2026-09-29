require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const {
  CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, SESSION_SECRET,
  BOT_TOKEN, PORT = 3000, DATA_FILE,
} = process.env;

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !BOT_TOKEN) {
  console.error('❌ عبّي ملف .env في مجلد dashboard اول (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, BOT_TOKEN).');
  process.exit(1);
}

const DB_FILE = DATA_FILE || path.join(__dirname, '..', 'data.json');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads'); // نفس المجلد اللي يقرأه البوت مباشرة من القرص
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const ADMIN = 0x8n;

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}
function writeDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// نفس منطق الترقية اللي في البوت: تصنيف واحد قديم -> يتحول الى تصنيف "عام"
function getGuild(db, id) {
  const g = (db[id] ||= {});
  if (!g.panels && (g.supportRoles || g.options || g.categoryId)) {
    g.panels = {
      default: {
        name: 'عام',
        categoryId: g.categoryId || null,
        logChannelId: g.logChannelId || null,
        supportRoles: g.supportRoles || [],
        options: g.options || [],
      },
    };
    delete g.categoryId; delete g.logChannelId; delete g.supportRoles; delete g.options;
  }
  g.panels ||= {};
  for (const p of Object.values(g.panels)) p.archiveCategoryId ??= null;
  g.welcome ||= { channelId: null, message: null, memberRoleId: null, botRoleId: null, image: null };
  g.welcome.image ??= null;
  return g;
}
function slugify(name) {
  return 'p' + Buffer.from(name.trim().toLowerCase()).toString('hex').slice(0, 12) + Date.now().toString(36).slice(-4);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.png').toLowerCase();
      cb(null, `${req.params.id}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)),
});
app.use(session({
  secret: SESSION_SECRET || 'change-me-please',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 },
}));

const api = (url, opts = {}) =>
  fetch(`https://discord.com/api/v10${url}`, opts).then(async (r) => {
    if (!r.ok) { const e = new Error(`Discord API ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  });
const botApi = (url) => api(url, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  next();
}
function requireGuildAdmin(req, res, next) {
  const guild = (req.session.adminGuilds || []).find((g) => g.id === req.params.id);
  if (!guild) return res.status(403).json({ error: 'not_admin' });
  next();
}

// ---------- تسجيل الدخول ----------
app.get('/auth/login', (req, res) => {
  const p = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code',
    scope: 'identify guilds', prompt: 'consent',
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${p}`);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.redirect('/?error=no_code');
    const token = await api('/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
      }),
    });
    const user = await api('/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    const guilds = await api('/users/@me/guilds', { headers: { Authorization: `Bearer ${token.access_token}` } });
    const adminGuilds = guilds.filter((g) => g.owner || (BigInt(g.permissions) & ADMIN) === ADMIN);
    req.session.user = { id: user.id, username: user.username, avatar: user.avatar };
    req.session.adminGuilds = adminGuilds.map((g) => ({ id: g.id, name: g.name, icon: g.icon }));
    res.redirect('/');
  } catch (e) {
    console.error(e);
    res.redirect('/?error=auth_failed');
  }
});

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));

// ---------- قائمة السيرفرات ----------
app.get('/api/guilds', requireAuth, async (req, res) => {
  const results = [];
  for (const g of req.session.adminGuilds) {
    let inBot = true;
    try { await botApi(`/guilds/${g.id}`); } catch { inBot = false; }
    results.push({ ...g, botPresent: inBot });
  }
  res.json({ guilds: results, inviteBase: `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&permissions=268692496&scope=bot%20applications.commands` });
});

// ---------- بيانات سيرفر: التصنيفات + رتب/رومات السيرفر ----------
app.get('/api/guilds/:id', requireAuth, requireGuildAdmin, async (req, res) => {
  try {
    const [roles, channels] = await Promise.all([
      botApi(`/guilds/${req.params.id}/roles`),
      botApi(`/guilds/${req.params.id}/channels`),
    ]);
    const db = readDb();
    const g = getGuild(db, req.params.id);
    writeDb(db); // نحفظ في حال صار ترقية بيانات قديمة
    res.json({
      panels: g.panels,
      welcome: g.welcome,
      roles: roles.filter((r) => r.name !== '@everyone').sort((a, b) => b.position - a.position),
      categories: channels.filter((c) => c.type === 4),
      textChannels: channels.filter((c) => c.type === 0),
    });
  } catch (e) {
    res.status(e.status === 404 ? 404 : 500).json({ error: 'bot_not_in_guild_or_error' });
  }
});

// ---------- انشاء / تعديل / حذف تصنيف ----------
app.post('/api/guilds/:id/panels', requireAuth, requireGuildAdmin, (req, res) => {
  const { name, supportRoles, categoryId, logChannelId, archiveCategoryId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });
  const db = readDb();
  const g = getGuild(db, req.params.id);
  if (Object.values(g.panels).some((p) => p.name === name.trim()))
    return res.status(400).json({ error: 'name_taken' });
  const id = slugify(name);
  g.panels[id] = {
    name: name.trim().slice(0, 50),
    categoryId: categoryId || null,
    logChannelId: logChannelId || null,
    archiveCategoryId: archiveCategoryId || null,
    supportRoles: Array.isArray(supportRoles) ? supportRoles : [],
    options: [],
  };
  writeDb(db);
  res.json({ ok: true, panels: g.panels });
});

app.put('/api/guilds/:id/panels/:panelId', requireAuth, requireGuildAdmin, (req, res) => {
  const { name, supportRoles, categoryId, logChannelId, archiveCategoryId } = req.body;
  const db = readDb();
  const g = getGuild(db, req.params.id);
  const panel = g.panels[req.params.panelId];
  if (!panel) return res.status(404).json({ error: 'not_found' });
  if (name && name.trim()) panel.name = name.trim().slice(0, 50);
  if (Array.isArray(supportRoles)) panel.supportRoles = supportRoles;
  if (categoryId !== undefined) panel.categoryId = categoryId || null;
  if (logChannelId !== undefined) panel.logChannelId = logChannelId || null;
  if (archiveCategoryId !== undefined) panel.archiveCategoryId = archiveCategoryId || null;
  writeDb(db);
  res.json({ ok: true, panel });
});

app.delete('/api/guilds/:id/panels/:panelId', requireAuth, requireGuildAdmin, (req, res) => {
  const db = readDb();
  const g = getGuild(db, req.params.id);
  delete g.panels[req.params.panelId];
  writeDb(db);
  res.json({ ok: true, panels: g.panels });
});

// ---------- اقسام تصنيف معيّن ----------
app.post('/api/guilds/:id/panels/:panelId/options', requireAuth, requireGuildAdmin, (req, res) => {
  const { label, description, emoji } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'label_required' });
  const db = readDb();
  const g = getGuild(db, req.params.id);
  const panel = g.panels[req.params.panelId];
  if (!panel) return res.status(404).json({ error: 'not_found' });
  if (panel.options.length >= 25) return res.status(400).json({ error: 'max_25' });
  panel.options.push({
    label: label.trim().slice(0, 100),
    value: `s${Date.now().toString(36)}${Math.floor(Math.random() * 100)}`,
    description: description ? description.trim().slice(0, 100) : undefined,
    emoji: emoji ? emoji.trim() : undefined,
  });
  writeDb(db);
  res.json({ ok: true, options: panel.options });
});

app.delete('/api/guilds/:id/panels/:panelId/options/:value', requireAuth, requireGuildAdmin, (req, res) => {
  const db = readDb();
  const g = getGuild(db, req.params.id);
  const panel = g.panels[req.params.panelId];
  if (!panel) return res.status(404).json({ error: 'not_found' });
  panel.options = panel.options.filter((o) => o.value !== req.params.value);
  writeDb(db);
  res.json({ ok: true, options: panel.options });
});

// ---------- اعدادات الترحيب (رسالة + رتب) ----------
app.post('/api/guilds/:id/welcome', requireAuth, requireGuildAdmin, (req, res) => {
  const { channelId, message, memberRoleId, botRoleId } = req.body;
  const db = readDb();
  const g = getGuild(db, req.params.id);
  if (channelId !== undefined) g.welcome.channelId = channelId || null;
  if (message !== undefined) g.welcome.message = message || null;
  if (memberRoleId !== undefined) g.welcome.memberRoleId = memberRoleId || null;
  if (botRoleId !== undefined) g.welcome.botRoleId = botRoleId || null;
  writeDb(db);
  res.json({ ok: true, welcome: g.welcome });
});

// رفع خلفية الترحيب (صورة ثابتة او GIF متحركة) - تنحفظ على القرص ويقرأها البوت مباشرة
app.post('/api/guilds/:id/welcome/image', requireAuth, requireGuildAdmin, upload.single('background'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const db = readDb();
  const g = getGuild(db, req.params.id);

  // نحذف الملف القديم لو موجود
  if (g.welcome.image && g.welcome.image.file) {
    const old = path.join(__dirname, '..', g.welcome.image.file);
    fs.unlink(old, () => {});
  }

  const relFile = path.join('uploads', req.file.filename);
  g.welcome.image = {
    file: relFile,
    x: g.welcome.image?.x ?? 50,
    y: g.welcome.image?.y ?? 50,
    size: g.welcome.image?.size ?? 30,
  };
  writeDb(db);
  res.json({ ok: true, image: g.welcome.image, previewUrl: `/uploads/${req.file.filename}` });
});

app.put('/api/guilds/:id/welcome/image/position', requireAuth, requireGuildAdmin, (req, res) => {
  const { x, y, size } = req.body;
  const db = readDb();
  const g = getGuild(db, req.params.id);
  if (!g.welcome.image) return res.status(400).json({ error: 'no_image' });
  if (typeof x === 'number') g.welcome.image.x = x;
  if (typeof y === 'number') g.welcome.image.y = y;
  if (typeof size === 'number') g.welcome.image.size = size;
  writeDb(db);
  res.json({ ok: true, image: g.welcome.image });
});

app.delete('/api/guilds/:id/welcome/image', requireAuth, requireGuildAdmin, (req, res) => {
  const db = readDb();
  const g = getGuild(db, req.params.id);
  if (g.welcome.image && g.welcome.image.file) {
    fs.unlink(path.join(__dirname, '..', g.welcome.image.file), () => {});
  }
  g.welcome.image = null;
  writeDb(db);
  res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`✅ Dashboard running on http://localhost:${PORT}`));
