// db.js — everything to do with the database lives here.
// We use SQLite through Node's built-in "node:sqlite" module, so no npm install is needed.
// The whole database is one file: data/cleantrack.db

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { staffPasswordProblem } = require('./security');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'cleantrack.db');

// Make sure the data folder exists before SQLite tries to create the file in it.
// 0o700 = only the account that runs the server may open it (Linux and Mac; Windows uses its own rules).
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA foreign_keys = ON;      -- respect the links between tables
  PRAGMA trusted_schema = OFF;   -- a tampered database file cannot run SQL functions
  PRAGMA secure_delete = ON;     -- deleted data is overwritten, not just hidden
  PRAGMA busy_timeout = 3000;    -- wait a moment instead of failing when the file is busy
`);
try { fs.chmodSync(DB_FILE, 0o600); } catch { /* not supported here */ }

// ---------- Password hashing ----------
// We never store a real password. We store a "salt" (random text) and a "hash"
// (a scrambled version made by scrypt). To check a login we scramble the typed
// password the same way and compare the results.
// N, r and p say how much work one scramble takes: the more work, the slower it is to guess.
// They are saved next to the hash, so they can be raised later: scrypt$N$r$p$salt$hash
const WORK = { N: 32768, r: 8, p: 3, maxmem: 96 * 1024 * 1024 };
const scrypt = promisify(crypto.scrypt); // runs in the background, so other visitors do not wait

// Stored instead of a hash: an account with no password yet. Nobody can log in to it.
const LOCKED = '!locked';

const pack = (salt, hash) => ['scrypt', WORK.N, WORK.r, WORK.p, salt, hash.toString('hex')].join('$');
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return pack(salt, await scrypt(password, salt, 64, WORK));
}
// The same, but waits. Only used once, while the sample data is made.
function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return pack(salt, crypto.scryptSync(password, salt, 64, WORK));
}

async function checkPassword(password, stored) {
  const now = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([0-9a-f]+)\$([0-9a-f]{128})$/.exec(stored);
  const old = /^([0-9a-f]+):([0-9a-f]{128})$/.exec(stored); // made by the first version of CleanTrack
  if (!now && !old) return false;
  const [work, salt, hash] = now
    ? [{ N: Number(now[1]), r: Number(now[2]), p: Number(now[3]), maxmem: WORK.maxmem }, now[4], now[5]]
    : [{}, old[1], old[2]];
  const test = await scrypt(password, salt, 64, work);
  // timingSafeEqual takes the same time for every wrong password, so nothing can be learned from it.
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
// True when a hash was made with less work than we use now.
const needsNewHash = (stored) => !stored.startsWith(`scrypt$${WORK.N}$${WORK.r}$${WORK.p}$`);

// ---------- Tables ----------
// 6 tables. "REFERENCES" means "this column points at a row in another table".
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('resident', 'admin')),
  area_id       INTEGER REFERENCES areas(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS areas (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS categories (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL UNIQUE,
  area_id INTEGER REFERENCES areas(id)
);

CREATE TABLE IF NOT EXISTS complaints (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  location    TEXT NOT NULL,
  image_path  TEXT,
  status      TEXT NOT NULL DEFAULT 'Submitted'
              CHECK (status IN ('Submitted', 'In Progress', 'Resolved', 'Rejected')),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  area_id     INTEGER NOT NULL REFERENCES areas(id),
  team_id     INTEGER REFERENCES teams(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS status_updates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,
  note         TEXT,
  updated_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- The two staff accounts ----------
const OWNER_ID = 'owner@cleantrack.test'; // highest: everything an admin can do, plus managing accounts
const ADMIN_ID = 'admin@cleantrack.test'; // reviews reports

// ---------- Sample data (MOCK DATA, clearly fake) ----------
// Only runs the very first time, when the users table is empty.
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;

  const areaNames = ['Sector 12', 'Green Park', 'Old Market', 'Lake View', 'Station Road'];
  const insArea = db.prepare('INSERT INTO areas (name) VALUES (?)');
  areaNames.forEach((n) => insArea.run(n));

  const cats = [
    ['Overflowing bin', '🗑️'],
    ['Littering', '🧻'],
    ['Plastic waste', '🧴'],
    ['E-waste', '🔌'],
    ['Missed collection', '🚛'],
    ['Illegal dumping', '⚠️'],
  ];
  const insCat = db.prepare('INSERT INTO categories (name, icon) VALUES (?, ?)');
  cats.forEach(([n, i]) => insCat.run(n, i));

  const insTeam = db.prepare('INSERT INTO teams (name, area_id) VALUES (?, ?)');
  insTeam.run('Team Alpha', 1);
  insTeam.run('Team Bravo', 2);
  insTeam.run('Team Charlie', 3);

  const insUser = db.prepare(
    'INSERT INTO users (name, email, password_hash, role, area_id) VALUES (?, ?, ?, ?, ?)'
  );
  insUser.run('Riya Sharma', 'riya@cleantrack.test', hashPasswordSync('resident123'), 'resident', 1); // id 1
  insUser.run('Arjun Mehta', 'arjun@cleantrack.test', hashPasswordSync('resident123'), 'resident', 2); // id 2
  insUser.run('City Admin', 'admin@cleantrack.test', LOCKED, 'admin', null); // id 3, locked until a password is set

  // A few sample complaints so the dashboards are not empty on day one.
  const insC = db.prepare(`
    INSERT INTO complaints (title, description, location, status, user_id, category_id, area_id, team_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))`);
  const insU = db.prepare(
    "INSERT INTO status_updates (complaint_id, status, note, updated_by, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))"
  );

  const samples = [
    ['Bin overflowing near park gate', 'The green bin has not been emptied for 3 days and garbage is on the road.', 'Near Gate 2, Sector 12 park', 'Resolved', 1, 1, 1, 1, '-5 days'],
    ['Plastic bottles dumped by the lake', 'Lots of plastic bottles and wrappers thrown along the walking path.', 'Lake View walking track', 'In Progress', 2, 3, 4, 2, '-3 days'],
    ['Old TV and wires left on footpath', 'Someone left an old TV and cables on the footpath. Kids play here.', 'Opposite Old Market post office', 'Submitted', 1, 4, 3, null, '-1 days'],
    ['Garbage truck did not come', 'No collection in our lane since Monday.', 'Lane 4, Green Park', 'Submitted', 2, 5, 2, null, '-2 hours'],
    ['Construction debris dumped', 'Bricks and cement bags dumped on empty plot.', 'Behind Station Road bus stop', 'In Progress', 1, 6, 5, 3, '-4 days'],
  ];

  samples.forEach((s, i) => {
    const [title, desc, loc, status, user, cat, area, team, ago] = s;
    const id = i + 1;
    insC.run(title, desc, loc, status, user, cat, area, team, ago, ago);
    insU.run(id, 'Submitted', 'Complaint created by resident', user, ago);
    if (status !== 'Submitted') insU.run(id, 'In Progress', 'Assigned to collection team', 3, ago);
    if (status === 'Resolved') insU.run(id, 'Resolved', 'Bin emptied and area cleaned', 3, '-4 days');
  });

  console.log('Database created and filled with sample (mock) data.');
}

seed();

// ---------- Upgrades for databases made by an older version ----------
// Residents can choose "Other" and type their own category or area. The typed text is
// stored on that one complaint, so it never changes the shared lists.
// This runs at every start and only adds what is missing, so no data is lost.
function upgrade() {
  const columns = db.prepare('PRAGMA table_info(complaints)').all().map((c) => c.name);
  if (!columns.includes('custom_category')) db.exec('ALTER TABLE complaints ADD COLUMN custom_category TEXT');
  if (!columns.includes('custom_area')) db.exec('ALTER TABLE complaints ADD COLUMN custom_area TEXT');
  if (!columns.includes('map_link')) db.exec('ALTER TABLE complaints ADD COLUMN map_link TEXT'); // optional Google Maps link
  db.prepare("INSERT OR IGNORE INTO categories (name, icon) VALUES ('Other', '✏️')").run();
  db.prepare("INSERT OR IGNORE INTO areas (name) VALUES ('Other')").run();

  // The owner is an admin who may also manage accounts. The index allows only one owner.
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userColumns.includes('is_owner')) db.exec('ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0');
  if (!userColumns.includes('suspended')) db.exec('ALTER TABLE users ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS only_one_owner ON users (is_owner) WHERE is_owner = 1');
  if (!db.prepare('SELECT id FROM users WHERE is_owner = 1').get()) {
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(OWNER_ID)) throw new Error(`Somebody already uses ${OWNER_ID}. Remove that account first.`);
    db.prepare("INSERT INTO users (name, email, password_hash, role, is_owner) VALUES ('Site Owner', ?, ?, 'admin', 1)").run(OWNER_ID, LOCKED);
  }
}

upgrade();

// Runs several changes as one: either all of them are saved, or none.
function transaction(work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- Staff passwords ----------
// No staff password is written in this project. There are two ways to set them:
//   - on your computer:  npm run set-passwords   (you type them, hidden)
//   - on a hosting site: the settings OWNER_PASSWORD and ADMIN_PASSWORD
const findUser = (email) => db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
const setHash = (email, hash) => db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, email);

// Older versions had a public admin password. If it is still there, lock the account.
function hasOldPublicPassword(stored) {
  const p = stored.split(/[$:]/);
  const work = p[0] === 'scrypt' ? { N: Number(p[1]), r: Number(p[2]), p: Number(p[3]), maxmem: WORK.maxmem } : {};
  try { return crypto.scryptSync('admin123', p.at(-2), 64, work).toString('hex') === p.at(-1); } catch { return false; }
}
const adminNow = findUser(ADMIN_ID);
if (adminNow && adminNow.password_hash !== LOCKED && hasOldPublicPassword(adminNow.password_hash)) setHash(ADMIN_ID, LOCKED);

for (const [name, email] of [['OWNER_PASSWORD', OWNER_ID], ['ADMIN_PASSWORD', ADMIN_ID]]) {
  const password = name === 'OWNER_PASSWORD' ? process.env.OWNER_PASSWORD : process.env.ADMIN_PASSWORD;
  if (password === undefined) continue;
  const problem = staffPasswordProblem(password)
    || (process.env.OWNER_PASSWORD === process.env.ADMIN_PASSWORD ? 'It must be different from the other staff password.' : null);
  if (problem) {
    console.error(`${name}: ${problem} The server did not start.`);
    process.exit(1);
  }
  setHash(email, hashPasswordSync(password));
}
const lockedStaff = () => [OWNER_ID, ADMIN_ID].filter((e) => findUser(e)?.password_hash === LOCKED);

module.exports = { db, transaction, hashPassword, checkPassword, needsNewHash, setHash, findUser, lockedStaff, LOCKED, OWNER_ID, ADMIN_ID, DATA_DIR };
