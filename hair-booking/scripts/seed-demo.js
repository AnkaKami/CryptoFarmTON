'use strict';

// Fills data/db.json with example slots and requests so the site can be tried locally.
// Never run this on the live site: it overwrites real data when called with --force.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const FILE = path.join(DATA_DIR, 'db.json');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

if (fs.existsSync(FILE) && !process.argv.includes('--force')) {
  console.log('data/db.json already exists, leaving it alone (pass --force to replace it with demo data).');
  process.exit(0);
}

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
const today = fmt.format(new Date());
const addDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const weekday = (date) => new Date(date + 'T00:00:00Z').getUTCDay() || 7;
const id = () => crypto.randomBytes(6).toString('hex');

// [masterId, weekdays, [time, minutes][]]
const plan = [
  ['anna', [2, 4, 6], [['10:00', 240], ['15:00', 240]]],
  ['linh', [1, 3, 5, 6], [['09:30', 300], ['15:30', 180]]],
  ['marina', [1, 2, 3, 4, 5, 6], [['11:00', 120], ['14:00', 120], ['17:00', 60]]],
];

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const slots = [];
for (let i = 1; i <= 24; i++) {
  const date = addDays(today, i);
  for (const [masterId, days, times] of plan) {
    if (!days.includes(weekday(date))) continue;
    for (const [time, duration] of times) {
      if (rand() < 0.22) continue;
      slots.push({ id: id(), masterId, date, time, duration, status: 'free', bookingId: null, createdAt: new Date().toISOString() });
    }
  }
}

const examples = [
  { name: 'Ольга', phone: '+84 93 555 01 27', messenger: 'telegram', handle: '@olga_example', serviceId: 'keratin', length: 60, comment: 'Свои волосы до плеч, хочу до лопаток. Цвет примерно #8.', status: 'new' },
  { name: 'Hà My', phone: '+84 90 555 0182', messenger: 'zalo', handle: '', serviceId: 'tape', length: 50, comment: '', status: 'confirmed' },
  { name: 'Kate', phone: '+61 4 5550 1934', messenger: 'whatsapp', handle: '', serviceId: 'correction', length: null, comment: 'Correction after 3 months.', status: 'new' },
];

const bookings = [];
const pickable = slots.filter((s) => s.date <= addDays(today, 10));
examples.forEach((ex, i) => {
  const slot = pickable[i * 5 + 2];
  if (!slot) return;
  const booking = {
    id: id(), slotId: slot.id, masterId: slot.masterId, date: slot.date, time: slot.time, duration: slot.duration,
    ...ex, createdAt: new Date(Date.now() - (i + 1) * 3600000).toISOString(),
  };
  slot.status = 'booked';
  slot.bookingId = booking.id;
  bookings.push(booking);
});

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(FILE, JSON.stringify({ slots, bookings }, null, 1));
console.log(`Demo data: ${slots.length} slots, ${bookings.length} requests -> ${FILE}`);
