// server.js — the back end of CleanTrack.
// It does two jobs:
//   1. Sends the website files (HTML, CSS, JS) from the "public" folder to the browser.
//   2. Answers API requests (URLs starting with /api/) by reading and writing the database.
// It uses only Node's built-in "http" module — no Express, no npm packages.
// The protections (rate limits, sessions, cleaning input, ...) are in security.js.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { db, transaction, hashPassword, checkPassword, needsNewHash, lockedStaff, LOCKED, DATA_DIR } = require('./db');
const {
  HttpError, MINUTE, HOUR, setSecurityHeaders, limit, giveBack, clientIp,
  findSession, passwordStamp, createSession, endSession, clearedCookie, requireSameSite, readBody,
  cleanText, cleanId, cleanEmail, passwordProblem, cleanMapLink, cleanPhoto,
} = require('./security');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });

// The two public demo accounts (their passwords are shown on the login page).
const DEMO_IDS = ['riya@cleantrack.test', 'arjun@cleantrack.test'];

const STATUSES = ['Submitted', 'In Progress', 'Resolved', 'Rejected'];
const MAX_UPLOAD_FOLDER = 300 * 1024 * 1024; // all photos together
const PHOTO_BODY = 3 * 1024 * 1024;          // a 2 MB photo is bigger when sent as text

// ---------- Small helpers ----------
// What the browser may know about an account (never the password hash).
const USER_FIELDS = 'id, name, email, role, area_id, is_owner';
const publicUser = (id) => db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(id);

// The logged-in user, or null. Suspending an account or changing its password ends its sessions,
// because this is checked again on every request.
function getUser(req) {
  const session = findSession(req);
  const row = session && db.prepare('SELECT password_hash, suspended FROM users WHERE id = ?').get(session.userId);
  if (!row || row.suspended || passwordStamp(row.password_hash) !== session.stamp) { if (session) endSession(req); return null; }
  return publicUser(session.userId);
}

function sendJSON(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(data));
}

// Scrambling a password is slow on purpose. Only a few may run at once, so that many
// logins at the same moment cannot use up the whole computer.
let busyHashing = 0;
async function slowly(work) {
  if (busyHashing >= 8) throw new HttpError(503, 'The server is busy. Please try again in a moment.', { 'Retry-After': 2 });
  busyHashing += 1;
  try { return await work(); } finally { busyHashing -= 1; }
}
// Used when an email does not exist, so that answer takes as long as a wrong password.
const nobodysHash = hashPassword(require('node:crypto').randomBytes(16).toString('hex'));

// Works out the category (or area) of a new report. "table" is always one of our own two
// table names, never something the user typed.
//  - A normal choice: just use it.
//  - "Other": the typed text is needed. If it matches a name we already have (ignoring
//    capital letters), use that one, so "littering" and "Littering" are counted together.
function pickOrCustom(table, id, typed) {
  const row = db.prepare(`SELECT id, name FROM ${table} WHERE id = ?`).get(cleanId(id) || 0);
  if (!row) return { error: true };
  if (row.name !== 'Other') return { id: row.id, custom: null };
  const custom = cleanText(typed, 40).replace(/\s+/g, ' ');
  if (!/[\p{L}\p{N}]/u.test(custom) || custom.toLowerCase() === 'other') return { needText: true };
  const same = db.prepare(`SELECT id, name FROM ${table}`).all()
    .find((r) => r.name.toLowerCase() === custom.toLowerCase());
  return same ? { id: same.id, custom: null } : { id: row.id, custom };
}

// A home area is optional, but if one is given it must exist. ("Other" is only for reports.)
function pickHomeArea(value) {
  if (value === undefined || value === null || value === '') return null;
  const area = db.prepare("SELECT id FROM areas WHERE id = ? AND name != 'Other'").get(cleanId(value) || 0);
  if (!area) throw new HttpError(400, 'Unknown area.');
  return area.id;
}

// Saves a photo that was already checked by cleanPhoto().
async function savePhoto(photo) {
  let used = 0;
  for (const f of await fs.promises.readdir(UPLOAD_DIR)) used += (await fs.promises.stat(path.join(UPLOAD_DIR, f))).size;
  if (used + photo.bytes.length > MAX_UPLOAD_FOLDER) throw new HttpError(507, 'There is no room for more photos. You can send the report without one.');
  await fs.promises.writeFile(path.join(UPLOAD_DIR, photo.name), photo.bytes, { flag: 'wx', mode: 0o600 }); // wx = never overwrite
  return '/uploads/' + photo.name;
}

// The same SELECT is used in several places, so we keep it in one string.
const COMPLAINT_SELECT = `
  SELECT c.id, c.title, c.description, c.location, c.map_link, c.image_path, c.status,
         c.created_at, c.updated_at, c.user_id, c.category_id, c.area_id, c.team_id,
         COALESCE(c.custom_category, cat.name) AS category, cat.icon AS category_icon,
         COALESCE(c.custom_area, a.name) AS area, t.name AS team, u.name AS reporter
  FROM complaints c
  JOIN categories cat ON cat.id = c.category_id
  JOIN areas a        ON a.id = c.area_id
  JOIN users u        ON u.id = c.user_id
  LEFT JOIN teams t   ON t.id = c.team_id`;

// ---------- API routes ----------
async function handleApi(req, res, url) {
  const method = req.method;
  const route = url.pathname;
  const ip = clientIp(req);
  limit('api|' + ip, 600, MINUTE);

  if (!['GET', 'HEAD', 'POST', 'PATCH'].includes(method)) throw new HttpError(405, 'Not allowed.', { Allow: 'GET, HEAD, POST, PATCH' });
  if (method === 'POST' || method === 'PATCH') requireSameSite(req); // a change must come from our own pages

  const user = getUser(req);

  // Who am I? (used by every page to know if you are logged in)
  if (method === 'GET' && route === '/api/me') {
    return sendJSON(res, 200, { user });
  }

  // Lists for dropdowns: areas, categories, teams.
  if (method === 'GET' && route === '/api/meta') {
    return sendJSON(res, 200, {
      areas: db.prepare("SELECT id, name FROM areas ORDER BY name = 'Other', name").all(),
      categories: db.prepare("SELECT id, name, icon FROM categories ORDER BY name = 'Other', id").all(),
      teams: db.prepare('SELECT id, name FROM teams ORDER BY name').all(),
      statuses: STATUSES,
    });
  }

  // Public numbers for the home page and the admin summary.
  if (method === 'GET' && route === '/api/stats') {
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    db.prepare('SELECT status, COUNT(*) AS n FROM complaints GROUP BY status').all()
      .forEach((r) => { byStatus[r.status] = r.n; });
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const byArea = db.prepare(`
      SELECT a.name AS area,
             COUNT(c.id) AS total,
             SUM(CASE WHEN c.status = 'Resolved' THEN 1 ELSE 0 END) AS resolved,
             SUM(CASE WHEN c.status IN ('Submitted','In Progress') THEN 1 ELSE 0 END) AS open
      FROM areas a LEFT JOIN complaints c ON c.area_id = a.id
      GROUP BY a.id HAVING a.name != 'Other' OR COUNT(c.id) > 0
      ORDER BY open DESC, a.name = 'Other', a.name`).all();
    const byCategory = db.prepare(`
      SELECT cat.name AS category, cat.icon, COUNT(c.id) AS total
      FROM categories cat LEFT JOIN complaints c ON c.category_id = cat.id
      GROUP BY cat.id ORDER BY total DESC`).all();
    return sendJSON(res, 200, { total, byStatus, byArea, byCategory });
  }

  // Create a new resident account.
  if (method === 'POST' && route === '/api/register') {
    const body = await readBody(req);
    const name = cleanText(body.name, 60);
    const email = cleanEmail(body.email);
    if (!name || !email) throw new HttpError(400, 'Please enter your name and a valid email.');
    const problem = passwordProblem(body.password, email);
    if (problem) throw new HttpError(400, problem);
    const areaId = pickHomeArea(body.area_id);
    limit('register|' + ip, 10, HOUR, 'Too many new accounts from here. Please try again later.');
    const taken = () => db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (taken()) throw new HttpError(409, 'That email is already registered.');
    const hash = await slowly(() => hashPassword(body.password));
    if (taken()) throw new HttpError(409, 'That email is already registered.'); // someone was faster meanwhile
    // New accounts are ALWAYS residents. Nobody can sign up as an admin.
    const result = db.prepare('INSERT INTO users (name, email, password_hash, role, area_id) VALUES (?, ?, ?, ?, ?)')
      .run(name, email, hash, 'resident', areaId);
    return logIn(req, res, Number(result.lastInsertRowid));
  }

  // Log in.
  if (method === 'POST' && route === '/api/login') {
    const body = await readBody(req);
    const email = cleanText(body.email, 100).toLowerCase();
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    // Wrong passwords are limited twice: per account, and per visitor for all accounts.
    // Each try is counted BEFORE the check, so sending many at once does not help.
    const tooMany = 'Too many login attempts. Please wait 15 minutes and try again.';
    const keys = [`login|${ip}|${email}`, `login|${ip}`];
    limit(keys[0], 8, 15 * MINUTE, tooMany);
    limit(keys[1], 40, 15 * MINUTE, tooMany);
    const row = db.prepare('SELECT id, password_hash, suspended FROM users WHERE email = ?').get(email);
    const usable = row && row.password_hash !== LOCKED; // a locked account has no password yet
    const correct = await slowly(async () => checkPassword(password, usable ? row.password_hash : await nobodysHash));
    if (!usable || !correct) throw new HttpError(401, 'Wrong email or password.');
    if (row.suspended) throw new HttpError(403, 'This account is suspended. Please contact the site owner.');
    keys.forEach(giveBack); // a correct password does not count
    if (needsNewHash(row.password_hash)) { // an older, weaker hash: replace it now that we know the password
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?')
        .run(await slowly(() => hashPassword(password)), row.id, row.password_hash);
    }
    return logIn(req, res, row.id);
  }

  // Log out.
  if (method === 'POST' && route === '/api/logout') {
    endSession(req);
    return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': clearedCookie(req) });
  }

  // ----- Everything below needs you to be logged in -----
  if (!user) throw new HttpError(401, 'Please log in first.');
  if (method === 'POST' || method === 'PATCH') limit('change|' + user.id, 120, MINUTE);

  // Settings: change your own display name and default area. (Never the role or the email.)
  if (method === 'PATCH' && route === '/api/me') {
    const body = await readBody(req);
    const name = cleanText(body.name, 60) || user.name;
    const areaId = pickHomeArea(body.area_id);
    db.prepare('UPDATE users SET name = ?, area_id = ? WHERE id = ?').run(name, areaId, user.id);
    return sendJSON(res, 200, { user: publicUser(user.id) });
  }

  // ----- Accounts: only for the owner -----
  if (route === '/api/users' || route.startsWith('/api/users/')) {
    if (!user.is_owner) throw new HttpError(403, 'Only the owner can manage accounts.');

    if (method === 'GET' && route === '/api/users') {
      const users = db.prepare(`
        SELECT u.id, u.name, u.email, u.role, u.is_owner, u.suspended, u.created_at, u.password_hash = ? AS locked,
               (SELECT COUNT(*) FROM complaints c WHERE c.user_id = u.id) AS reports
        FROM users u ORDER BY u.is_owner DESC, u.role, u.name`).all(LOCKED);
      return sendJSON(res, 200, { users: users.map((u) => ({ ...u, demo: DEMO_IDS.includes(u.email) })) });
    }

    // Change one account: make it admin or resident, or suspend it.
    const one = /^\/api\/users\/(\d{1,9})$/.exec(route);
    if (method === 'PATCH' && one) {
      const body = await readBody(req);
      const target = db.prepare('SELECT id, email, role, is_owner, suspended FROM users WHERE id = ?').get(Number(one[1]));
      if (!target) throw new HttpError(404, 'Account not found.');
      if (target.is_owner) throw new HttpError(403, 'The owner account cannot be changed here.');
      if (body.role !== undefined && !['resident', 'admin'].includes(body.role)) throw new HttpError(400, 'Unknown role.');
      if (body.suspended !== undefined && typeof body.suspended !== 'boolean') throw new HttpError(400, 'That request was not valid.');
      if (body.role === undefined && body.suspended === undefined) throw new HttpError(400, 'Nothing to save.');
      // Everybody knows the demo passwords, so a demo account must never become an admin.
      if (body.role === 'admin' && DEMO_IDS.includes(target.email)) throw new HttpError(400, 'A demo account cannot become an admin, because its password is public.');
      const role = body.role ?? target.role;
      const suspended = body.suspended === undefined ? target.suspended : Number(body.suspended);
      db.prepare('UPDATE users SET role = ?, suspended = ? WHERE id = ? AND is_owner = 0').run(role, suspended, target.id);
      console.log(`Account #${target.id}: role ${role}, ${suspended ? 'suspended' : 'active'} (changed by the owner)`);
      return sendJSON(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Unknown API route.');
  }

  // Inbox.
  //  Resident: every status update someone else (the admin) made on your complaints, newest first.
  //  Admin:    every complaint still "Submitted", i.e. waiting for review, newest first.
  if (method === 'GET' && route === '/api/inbox') {
    if (user.role === 'admin') {
      const items = db.prepare(COMPLAINT_SELECT + " WHERE c.status = 'Submitted' ORDER BY c.created_at DESC").all();
      return sendJSON(res, 200, { kind: 'new-reports', items });
    }
    const items = db.prepare(`
      SELECT s.id, s.status, s.note, s.created_at, c.id AS complaint_id, c.title, u.name AS by_name
      FROM status_updates s
      JOIN complaints c ON c.id = s.complaint_id
      JOIN users u ON u.id = s.updated_by
      WHERE c.user_id = ? AND s.updated_by != ?
      ORDER BY s.created_at DESC, s.id DESC`).all(user.id, user.id);
    return sendJSON(res, 200, { kind: 'updates', items });
  }

  // List complaints. Admins see all, with filters. Everybody else sees only their own.
  if (method === 'GET' && route === '/api/complaints') {
    const where = [];
    const params = [];
    if (user.role !== 'admin') { where.push('c.user_id = ?'); params.push(user.id); }
    const status = url.searchParams.get('status');
    const areaId = url.searchParams.get('area_id');
    const categoryId = url.searchParams.get('category_id');
    const q = cleanText(url.searchParams.get('q'), 100);
    if (status && STATUSES.includes(status)) { where.push('c.status = ?'); params.push(status); }
    if (areaId) { where.push('c.area_id = ?'); params.push(cleanId(areaId) || 0); }
    if (categoryId) { where.push('c.category_id = ?'); params.push(cleanId(categoryId) || 0); }
    if (q) { where.push('(c.title LIKE ? OR c.location LIKE ? OR c.custom_category LIKE ? OR c.custom_area LIKE ?)'); params.push(...Array(4).fill(`%${q}%`)); }
    const sql = COMPLAINT_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY c.created_at DESC';
    // The "?" placeholders are filled in safely by SQLite (prevents SQL injection).
    return sendJSON(res, 200, { complaints: db.prepare(sql).all(...params) });
  }

  // Resident submits a new complaint.
  if (method === 'POST' && route === '/api/complaints') {
    if (user.role !== 'resident') throw new HttpError(403, 'Only residents can report issues.');
    const body = await readBody(req, PHOTO_BODY);
    const title = cleanText(body.title, 100);
    const description = cleanText(body.description, 1000, true);
    const location = cleanText(body.location, 150);
    if (!title || !description || !location) throw new HttpError(400, 'Title, description and location are required.');
    const category = pickOrCustom('categories', body.category_id, body.custom_category);
    const area = pickOrCustom('areas', body.area_id, body.custom_area);
    if (category.error) throw new HttpError(400, 'Please choose a category.');
    if (area.error) throw new HttpError(400, 'Please choose an area.');
    if (category.needText) throw new HttpError(400, 'Please type your category.');
    if (area.needText) throw new HttpError(400, 'Please type your area.');
    const mapLink = cleanMapLink(body.map_link); // optional
    const photo = cleanPhoto(body.image);
    limit('report|' + user.id, 20, HOUR, 'You have sent many reports. Please try again later.');
    const imagePath = photo ? await savePhoto(photo) : null;

    const id = transaction(() => {
      const result = db.prepare(`INSERT INTO complaints (title, description, location, image_path, user_id, category_id, area_id, custom_category, custom_area, map_link)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(title, description, location, imagePath, user.id, category.id, area.id, category.custom, area.custom, mapLink);
      const newId = Number(result.lastInsertRowid);
      db.prepare('INSERT INTO status_updates (complaint_id, status, note, updated_by) VALUES (?, ?, ?, ?)')
        .run(newId, 'Submitted', 'Complaint created by resident', user.id);
      return newId;
    });
    return sendJSON(res, 201, { id });
  }

  // One complaint with its full history: /api/complaints/5
  const match = /^\/api\/complaints\/(\d{1,9})$/.exec(route);
  if (match) {
    const id = Number(match[1]);
    const find = () => {
      const c = db.prepare(COMPLAINT_SELECT + ' WHERE c.id = ?').get(id);
      if (!c) throw new HttpError(404, 'Complaint not found.');
      // Only its owner and admins may open a complaint. This check is on the SERVER,
      // so hiding a button in the browser is not the only protection.
      if (user.role !== 'admin' && c.user_id !== user.id) throw new HttpError(403, 'Not your complaint.');
      return c;
    };

    if (method === 'GET') {
      const complaint = find();
      const history = db.prepare(`
        SELECT s.status, s.note, s.created_at, u.name AS by_name
        FROM status_updates s JOIN users u ON u.id = s.updated_by
        WHERE s.complaint_id = ? ORDER BY s.id`).all(id);
      return sendJSON(res, 200, { complaint, history });
    }

    // Admin updates status and/or assigns a team.
    if (method === 'PATCH') {
      if (user.role !== 'admin') throw new HttpError(403, 'Only admins can update complaints.');
      const body = await readBody(req);
      const complaint = find();
      if (body.status !== undefined && !STATUSES.includes(body.status)) throw new HttpError(400, 'Unknown status.');
      const status = body.status === undefined ? complaint.status : body.status;
      const noTeam = body.team_id === undefined || body.team_id === null || body.team_id === '';
      const team = noTeam ? null : db.prepare('SELECT id, name FROM teams WHERE id = ?').get(cleanId(body.team_id) || 0);
      if (!noTeam && !team) throw new HttpError(400, 'Unknown team.');
      const teamId = team ? team.id : null;
      const note = cleanText(body.note, 300);
      const statusChanged = status !== complaint.status;
      const teamChanged = teamId !== complaint.team_id;
      if (!statusChanged && !teamChanged && !note) throw new HttpError(400, 'Nothing to save. Change the status or team, or add a note.');

      // If the admin wrote no note, describe what really changed.
      const changes = [];
      if (teamChanged) changes.push(team ? `Assigned to ${team.name}` : 'Team removed');
      if (statusChanged) changes.push(`Status changed to ${status}`);
      const autoNote = note || changes.join('. ');
      transaction(() => {
        db.prepare("UPDATE complaints SET status = ?, team_id = ?, updated_at = datetime('now') WHERE id = ?")
          .run(status, teamId, id);
        db.prepare('INSERT INTO status_updates (complaint_id, status, note, updated_by) VALUES (?, ?, ?, ?)')
          .run(id, status, autoNote, user.id);
      });

      // SIMULATED notification: we only print to the console. No SMS/email is really sent.
      console.log(`[SIMULATED NOTIFICATION] Complaint #${id} is now "${status}".`);
      return sendJSON(res, 200, { ok: true, simulatedNotification: `Resident ${complaint.reporter} would be notified (simulated).` });
    }
  }

  throw new HttpError(404, 'Unknown API route.');
}

function logIn(req, res, userId) {
  const { password_hash: hash } = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  return sendJSON(res, 200, { user: publicUser(userId) }, { 'Set-Cookie': createSession(req, userId, hash) });
}

// ---------- Website files ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8',
};

// When the server starts it makes a list of every file in "public". Only an address that is
// exactly in this list is answered, so no trick with ".." or odd spelling can reach another file.
// (After ADDING a new file to public, restart the server. Changing a file needs no restart.)
const siteFiles = new Map();
for (const name of fs.readdirSync(PUBLIC_DIR, { recursive: true })) {
  const full = path.join(PUBLIC_DIR, name);
  const address = '/' + name.split(path.sep).join('/');
  if (TYPES[path.extname(name)] && !address.includes('/.') && fs.statSync(full).isFile()) siteFiles.set(address, full);
}
siteFiles.set('/', path.join(PUBLIC_DIR, 'index.html'));

// These pages are given only to someone who is logged in with the right role.
const PAGE_ROLES = { '/admin.html': 'admin', '/resident.html': 'resident' };

function sendFile(req, res, full, cache) {
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    const headers = { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': cache };
    const body = (part) => res.end(req.method === 'HEAD' ? undefined : part);

    // Videos: to jump to a moment, the browser asks for only part of the file, for example
    // "Range: bytes=1000-1999" (or "bytes=1000-" = to the end, "bytes=-500" = the last 500).
    const range = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      const last = data.length - 1;
      const start = range[1] ? Number(range[1]) : Math.max(0, data.length - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), last) : last;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
      return body(data.subarray(start, end + 1));
    }
    res.writeHead(200, { ...headers, 'Content-Length': data.length });
    body(data);
  });
}

function handlePage(req, res, address) {
  limit('files|' + clientIp(req), 1500, MINUTE);
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Not allowed.', { Allow: 'GET, HEAD' });

  // A photo is shown only to the resident who sent it and to admins.
  if (address.startsWith('/uploads/')) {
    setSecurityHeaders(req, res, 'data');
    const user = getUser(req);
    const name = /^\/uploads\/([0-9a-f]{24,32}\.(?:png|jpg|webp))$/.exec(address)?.[1];
    const owner = user && name && db.prepare('SELECT user_id FROM complaints WHERE image_path = ?').get(address);
    if (!owner || (user.role !== 'admin' && owner.user_id !== user.id)) throw new HttpError(404, 'Not found.');
    return sendFile(req, res, path.join(UPLOAD_DIR, name), 'private, no-store');
  }

  const file = siteFiles.get(address);
  if (!file) throw new HttpError(404, 'Not found.');
  if (address.startsWith('/forest/')) setSecurityHeaders(req, res, 'forest');

  const role = PAGE_ROLES[address];
  if (role) {
    const user = getUser(req);
    if (!user || user.role !== role) { res.writeHead(302, { Location: '/login.html', 'Cache-Control': 'no-store' }); return res.end(); }
    return sendFile(req, res, file, 'no-store');
  }
  const big = ['.png', '.jpg', '.webp', '.woff2', '.mp4'].includes(path.extname(file));
  return sendFile(req, res, file, big ? 'public, max-age=3600' : 'no-cache');
}

// ---------- The server itself ----------
const server = http.createServer(async (req, res) => {
  try {
    setSecurityHeaders(req, res, req.url.startsWith('/api/') ? 'data' : 'page');
    let url, address;
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//')) throw new Error();
      url = new URL(req.url, 'http://localhost');
      address = decodeURIComponent(url.pathname);
    } catch { throw new HttpError(400, 'That address is not valid.'); }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return handlePage(req, res, address);
  } catch (err) {
    // Expected problems have a safe message. For anything else the details stay in our own
    // log, and the visitor only sees "Server error".
    const expected = err instanceof HttpError;
    if (!expected) console.error(err);
    if (res.headersSent) return res.destroy();
    const status = expected ? err.status : 500;
    if (status === 413) res.on('finish', () => req.destroy());
    return sendJSON(res, status, { error: expected ? err.message : 'Server error' }, expected ? err.headers : {});
  }
});

// Slow or broken connections are closed, so they cannot pile up.
server.headersTimeout = 15 * 1000;
server.requestTimeout = 60 * 1000;
server.keepAliveTimeout = 5 * 1000;
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  else socket.destroy();
});

server.listen(PORT, () => {
  console.log(`CleanTrack is running at http://localhost:${PORT}`);
  const locked = lockedStaff();
  if (locked.length) console.log(`Locked until you set a password (npm run set-passwords): ${locked.join(', ')}`);
});
