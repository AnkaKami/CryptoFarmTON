'use strict';

// Booking site for hair extension masters. No dependencies: Node 18+ only.
// Slots and bookings live in DATA_DIR/db.json; salon content lives in config.json.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const CONFIG_FILE = path.resolve(process.env.CONFIG_FILE || path.join(ROOT, 'config.json'));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SESSION_DAYS = 14;

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const TZ = config.timezone || 'Asia/Ho_Chi_Minh';

fs.mkdirSync(DATA_DIR, { recursive: true });

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(6).toString('hex');
  console.warn(`ADMIN_PASSWORD is not set. Temporary password for this run: ${ADMIN_PASSWORD}`);
}

// ---------- storage ----------

function loadDb() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { slots: parsed.slots || [], bookings: parsed.bookings || [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { slots: [], bookings: [] };
    throw err;
  }
}

const db = loadDb();

function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}

function loadSecret() {
  try {
    return fs.readFileSync(SECRET_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const key = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_FILE, key, { mode: 0o600 });
    return key;
  }
}

// Changing ADMIN_PASSWORD signs everyone out.
const SESSION_KEY = crypto.createHmac('sha256', loadSecret()).update(ADMIN_PASSWORD).digest();

const newId = () => crypto.randomBytes(6).toString('hex');

// ---------- dates (all slot times are local salon time, stored as strings) ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const isTime = (s) => typeof s === 'string' && TIME_RE.test(s);

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

// 1 = Monday ... 7 = Sunday
function isoWeekday(date) {
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  return day === 0 ? 7 : day;
}

const nowFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function nowLocal() {
  const p = Object.fromEntries(nowFormatter.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const isPast = (slot, now) => slot.date < now.date || (slot.date === now.date && slot.time <= now.time);
const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

function overlaps(a, b) {
  if (a.masterId !== b.masterId || a.date !== b.date) return false;
  const a0 = toMinutes(a.time);
  const b0 = toMinutes(b.time);
  return a0 < b0 + b.duration && b0 < a0 + a.duration;
}

// ---------- helpers ----------

const masterById = (id) => config.masters.find((m) => m.id === id);
const serviceById = (id) => config.services.find((s) => s.id === id);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    rateBuckets.set(key, hits);
    throw new HttpError(429, 'rate_limited');
  }
  hits.push(now);
  rateBuckets.set(key, hits);
}
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateBuckets) {
    if (hits.every((t) => now - t > 3600000)) rateBuckets.delete(key);
  }
}, 600000).unref();

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.startsWith('application/json')) {
      reject(new HttpError(415, 'json_required'));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 20000) {
        reject(new HttpError(413, 'too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new HttpError(400, 'bad_json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max) : '');

// ---------- admin session (stateless signed cookie) ----------

function sign(value) {
  return crypto.createHmac('sha256', SESSION_KEY).update(value).digest('base64url');
}

function makeSessionToken() {
  const expires = String(Date.now() + SESSION_DAYS * 86400000);
  return `${expires}.${sign(expires)}`;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAdmin(req) {
  const token = parseCookies(req).adm;
  if (!token) return false;
  const [expires, sig] = token.split('.');
  if (!expires || !sig || Number(expires) < Date.now()) return false;
  const expected = Buffer.from(sign(expires));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function sessionCookie(req, token, maxAge) {
  const secure = req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
  return `adm=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function passwordMatches(given) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------- telegram ----------

function notifyTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  })
    .then((r) => { if (!r.ok) console.error('Telegram notify failed:', r.status); })
    .catch((err) => console.error('Telegram notify failed:', err.message));
}

const MESSENGERS = { zalo: 'Zalo', telegram: 'Telegram', whatsapp: 'WhatsApp', call: 'Звонок' };

function bookingMessage(b) {
  const master = masterById(b.masterId);
  const service = serviceById(b.serviceId);
  const [y, m, d] = b.date.split('-');
  const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(new Date(b.date + 'T00:00:00Z'));
  const lines = [
    'Новая заявка на наращивание',
    `${d}.${m}.${y} (${weekday}), ${b.time}`,
    `Мастер: ${master ? master.name.ru : b.masterId}`,
    `Услуга: ${service ? service.name.ru : '—'}${b.length ? `, ${b.length} см` : ''}`,
    `Клиент: ${b.name}`,
    `Телефон: ${b.phone}`,
    `Связь: ${MESSENGERS[b.messenger] || b.messenger}${b.handle ? ` ${b.handle}` : ''}`,
  ];
  if (b.comment) lines.push(`Комментарий: ${b.comment}`);
  return lines.join('\n');
}

// ---------- API handlers ----------

function publicConfig() {
  return {
    timezone: TZ,
    salon: config.salon,
    lengths: config.lengths,
    masters: config.masters,
    services: config.services,
  };
}

function parseRange(query, maxDays) {
  const from = query.get('from');
  const to = query.get('to');
  if (!isDate(from) || !isDate(to)) throw new HttpError(400, 'bad_range');
  const span = daysBetween(from, to);
  if (span < 0 || span > maxDays) throw new HttpError(400, 'bad_range');
  return { from, to };
}

function getPublicSlots(query) {
  const { from, to } = parseRange(query, 62);
  const now = nowLocal();
  const slots = db.slots
    .filter((s) => s.status === 'free' && s.date >= from && s.date <= to && !isPast(s, now) && masterById(s.masterId))
    .map(({ id, masterId, date, time, duration }) => ({ id, masterId, date, time, duration }))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return { today: now.date, now: now.time, slots };
}

function createBooking(body, ip) {
  // Honeypot: real people never see this field.
  if (cleanText(body.company, 100)) return { booking: { id: newId() } };

  rateLimit('book:' + ip, 8, 3600000);

  const name = cleanText(body.name, 60);
  const phone = cleanText(body.phone, 30);
  const messenger = cleanText(body.messenger, 20);
  const handle = cleanText(body.handle, 60);
  const comment = cleanText(body.comment, 500);
  const serviceId = cleanText(body.serviceId, 40);
  const length = body.length ? Number(body.length) : null;

  const errors = [];
  if (name.length < 2) errors.push('name');
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15 || !/^[+\d][\d\s()-]*$/.test(phone)) errors.push('phone');
  if (!MESSENGERS[messenger]) errors.push('messenger');
  if (!serviceById(serviceId)) errors.push('serviceId');
  if (length !== null && !config.lengths.includes(length)) errors.push('length');
  if (errors.length) throw new HttpError(400, 'invalid', errors.join(','));

  const slot = db.slots.find((s) => s.id === body.slotId);
  if (!slot || slot.status !== 'free' || isPast(slot, nowLocal()) || !masterById(slot.masterId)) {
    throw new HttpError(409, 'slot_taken');
  }

  const booking = {
    id: newId(),
    slotId: slot.id,
    masterId: slot.masterId,
    date: slot.date,
    time: slot.time,
    duration: slot.duration,
    serviceId,
    length,
    name,
    phone,
    messenger,
    handle,
    comment,
    status: 'new',
    createdAt: new Date().toISOString(),
  };
  slot.status = 'booked';
  slot.bookingId = booking.id;
  db.bookings.push(booking);
  saveDb();
  notifyTelegram(bookingMessage(booking));

  const { id, masterId, date, time, duration } = booking;
  return { booking: { id, masterId, date, time, duration, serviceId } };
}

function getAdminSlots(query) {
  const { from, to } = parseRange(query, 62);
  const now = nowLocal();
  const byId = new Map(db.bookings.map((b) => [b.id, b]));
  const slots = db.slots
    .filter((s) => s.date >= from && s.date <= to)
    .map((s) => {
      const b = s.bookingId ? byId.get(s.bookingId) : null;
      return {
        ...s,
        past: isPast(s, now),
        booking: b ? { id: b.id, name: b.name, status: b.status, serviceId: b.serviceId } : null,
      };
    })
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return { today: now.date, now: now.time, slots };
}

function addSlots(body) {
  const { masterId, from, to, times, duration } = body;
  const weekdays = Array.isArray(body.weekdays) ? body.weekdays.map(Number) : [1, 2, 3, 4, 5, 6, 7];
  if (!masterById(masterId)) throw new HttpError(400, 'invalid', 'masterId');
  if (!isDate(from) || !isDate(to)) throw new HttpError(400, 'invalid', 'dates');
  const span = daysBetween(from, to);
  if (span < 0 || span > 120) throw new HttpError(400, 'invalid', 'dates');
  if (!Array.isArray(times) || !times.length || times.length > 24 || !times.every(isTime)) {
    throw new HttpError(400, 'invalid', 'times');
  }
  const dur = Number(duration);
  if (!Number.isInteger(dur) || dur < 15 || dur > 720) throw new HttpError(400, 'invalid', 'duration');

  const now = nowLocal();
  let added = 0;
  let skippedOverlap = 0;
  let skippedPast = 0;
  for (let i = 0; i <= span; i++) {
    const date = addDays(from, i);
    if (!weekdays.includes(isoWeekday(date))) continue;
    for (const time of [...new Set(times)].sort()) {
      const candidate = { masterId, date, time, duration: dur };
      if (isPast(candidate, now)) { skippedPast++; continue; }
      if (db.slots.some((s) => overlaps(s, candidate))) { skippedOverlap++; continue; }
      if (added >= 500) throw new HttpError(400, 'invalid', 'too_many');
      db.slots.push({ id: newId(), ...candidate, status: 'free', bookingId: null, createdAt: new Date().toISOString() });
      added++;
    }
  }
  if (added) saveDb();
  return { added, skippedOverlap, skippedPast };
}

function deleteSlot(id) {
  const idx = db.slots.findIndex((s) => s.id === id);
  if (idx === -1) throw new HttpError(404, 'not_found');
  if (db.slots[idx].status === 'booked') throw new HttpError(409, 'slot_booked');
  db.slots.splice(idx, 1);
  saveDb();
  return { ok: true };
}

function getAdminBookings(query) {
  const status = query.get('status') || 'all';
  const list = db.bookings
    .filter((b) => status === 'all' || b.status === status)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const counts = { new: 0, confirmed: 0, cancelled: 0 };
  for (const b of db.bookings) counts[b.status] = (counts[b.status] || 0) + 1;
  return { today: nowLocal().date, bookings: list, counts };
}

function updateBooking(id, body) {
  const booking = db.bookings.find((b) => b.id === id);
  if (!booking) throw new HttpError(404, 'not_found');
  const status = body.status;
  if (!['new', 'confirmed', 'cancelled'].includes(status)) throw new HttpError(400, 'invalid', 'status');
  if (booking.status === 'cancelled' && status !== 'cancelled') {
    // Restoring a cancelled booking needs its slot back.
    const slot = db.slots.find((s) => s.id === booking.slotId);
    if (!slot || slot.status !== 'free') throw new HttpError(409, 'slot_taken');
    slot.status = 'booked';
    slot.bookingId = booking.id;
  }
  if (status === 'cancelled' && booking.status !== 'cancelled') {
    const slot = db.slots.find((s) => s.id === booking.slotId);
    if (slot && slot.bookingId === booking.id) {
      slot.status = 'free';
      slot.bookingId = null;
    }
  }
  booking.status = status;
  booking.updatedAt = new Date().toISOString();
  saveDb();
  return { booking };
}

// ---------- routing ----------

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const ip = clientIp(req);

  if (route === 'GET /api/config') return sendJson(res, 200, publicConfig());
  if (route === 'GET /api/slots') return sendJson(res, 200, getPublicSlots(url.searchParams));
  if (route === 'POST /api/bookings') return sendJson(res, 201, createBooking(await readJson(req), ip));

  if (route === 'POST /api/admin/login') {
    rateLimit('login:' + ip, 10, 15 * 60000);
    const body = await readJson(req);
    if (!passwordMatches(body.password || '')) throw new HttpError(401, 'wrong_password');
    const cookie = sessionCookie(req, makeSessionToken(), SESSION_DAYS * 86400);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }
  if (route === 'GET /api/admin/session') return sendJson(res, 200, { ok: isAdmin(req) });
  if (route === 'POST /api/admin/logout') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (url.pathname.startsWith('/api/admin/')) {
    if (!isAdmin(req)) throw new HttpError(401, 'unauthorized');
    if (route === 'GET /api/admin/slots') return sendJson(res, 200, getAdminSlots(url.searchParams));
    if (route === 'POST /api/admin/slots') return sendJson(res, 200, addSlots(await readJson(req)));
    if (route === 'GET /api/admin/bookings') return sendJson(res, 200, getAdminBookings(url.searchParams));
    let m = url.pathname.match(/^\/api\/admin\/slots\/([a-f0-9]{12})$/);
    if (m && req.method === 'DELETE') return sendJson(res, 200, deleteSlot(m[1]));
    m = url.pathname.match(/^\/api\/admin\/bookings\/([a-f0-9]{12})$/);
    if (m && req.method === 'PATCH') return sendJson(res, 200, updateBooking(m[1], await readJson(req)));
  }

  throw new HttpError(404, 'not_found');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'bad_path');
  }
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin' || pathname === '/admin/') pathname = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'not_found');

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'Last-Modified': stat.mtime.toUTCString(),
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    if (err instanceof HttpError) {
      if (!res.headersSent) sendJson(res, err.status, { error: err.code, detail: err.message });
    } else {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`${config.salon.name}: http://localhost:${PORT}  (admin: /admin)`);
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) console.log('Telegram notifications are off (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID).');
});
