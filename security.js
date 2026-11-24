// security.js — the protections used by server.js, all in one place.
//   1. Security headers     tell the browser what it may and may not do
//   2. Rate limiting        stops guessing passwords and flooding the site
//   3. Sessions             who is logged in
//   4. Same-site check      refuses changes sent by other websites (CSRF)
//   5. Reading requests     size limits and JSON only
//   6. Cleaning input       text, numbers, passwords and photos

const crypto = require('node:crypto');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// An error with a status code and a message that is safe to show to the user.
class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

// ---------- 1. Security headers ----------
// Hosting companies talk https to the visitor and then add this header for us.
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https';

// Content-Security-Policy: a list of what a page may load. Scripts may come only from our
// own files, so even if someone sneaks <script> into a page, the browser will not run it.
const CSP = {
  page: "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  // the 3D forest is shown inside our own pages, so it may be framed by our own site only
  forest: "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  // answers and photos are only data: nothing in them may run
  data: "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox",
};

function setSecurityHeaders(req, res, kind = 'page') {
  res.setHeader('Content-Security-Policy', CSP[kind]);
  res.setHeader('X-Frame-Options', kind === 'forest' ? 'SAMEORIGIN' : 'DENY');   // no other site may frame us
  res.setHeader('X-Content-Type-Options', 'nosniff');                            // do not guess file types
  res.setHeader('Referrer-Policy', 'same-origin');                               // do not tell other sites our addresses
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000'); // always use https from now on
}
// We set no CORS headers at all, so browsers do not let other websites read our answers.

// ---------- 2. Rate limiting ----------
// Counts how often something happened in a time window, for example "8 logins in 15 minutes".
const counters = new Map(); // "login|1.2.3.4" -> { count, resetAt }
const MAX_COUNTERS = 50000;

function limit(key, max, windowMs, message = 'Too many requests. Please wait a moment and try again.') {
  const now = Date.now();
  let c = counters.get(key);
  if (!c || c.resetAt <= now) {
    if (counters.size >= MAX_COUNTERS) counters.delete(counters.keys().next().value); // forget the oldest
    c = { count: 0, resetAt: now + windowMs };
    counters.delete(key);
    counters.set(key, c);
  }
  c.count += 1;
  if (c.count > max) throw new HttpError(429, message, { 'Retry-After': Math.ceil((c.resetAt - now) / 1000) });
}
// Gives one try back (used after a correct password, so only wrong ones count).
function giveBack(key) { const c = counters.get(key); if (c && c.count > 0) c.count -= 1; }

// The visitor's address. Behind a hosting company everyone seems to come from the same
// address, so the CLIENT_IP_HEADER setting can name the header that holds the real one.
// It is off by default, because without such a company anyone could fake that header.
const IP_HEADER = (process.env.CLIENT_IP_HEADER || '').toLowerCase();
function clientIp(req) {
  const named = IP_HEADER && req.headers[IP_HEADER];
  return (typeof named === 'string' && named ? named : req.socket.remoteAddress || 'unknown').slice(0, 64);
}

// ---------- 3. Sessions ----------
// After login the browser gets a long random token in a cookie. We keep only a fingerprint
// (SHA-256) of it. NOTE: this lives in memory, so restarting the server logs everyone out.
// A session also remembers a "stamp" of the password it was made with: after the password
// changes, the stamp no longer matches and the session stops working.
const sessions = new Map(); // fingerprint -> { userId, stamp, created, seen }
const passwordStamp = (hash) => crypto.createHash('sha256').update(hash).digest('hex');
const SESSION_MAX = 8 * HOUR;       // log in again after 8 hours
const SESSION_IDLE = 2 * HOUR;      // or after 2 hours without using the site
const MAX_SESSIONS = 10000;
const fingerprint = (token) => crypto.createHash('sha256').update(token).digest('hex');
const tooOld = (s, now) => now - s.created > SESSION_MAX || now - s.seen > SESSION_IDLE;

function sessionKey(req) {
  const match = /(?:^|;\s*)ct_session=([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie || '');
  return match ? fingerprint(match[1]) : null;
}
function findSession(req) {
  const key = sessionKey(req);
  const s = key && sessions.get(key);
  if (!s) return null;
  const now = Date.now();
  if (tooOld(s, now)) { sessions.delete(key); return null; }
  s.seen = now;
  return s;
}
function endSession(req) { const key = sessionKey(req); if (key) sessions.delete(key); }

// HttpOnly: page scripts cannot read the cookie. SameSite=Lax: other sites cannot use it for
// changes. Secure: sent over https only (added when the site runs on https).
const cookieFlags = (req) => `HttpOnly; SameSite=Lax; Path=/${isHttps(req) ? '; Secure' : ''}`;

function createSession(req, userId, passwordHash) {
  endSession(req); // the old session, if any, stops working
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(fingerprint(token), { userId, stamp: passwordStamp(passwordHash), created: now, seen: now });
  return `ct_session=${token}; ${cookieFlags(req)}; Max-Age=${SESSION_MAX / 1000}`;
}
const clearedCookie = (req) => `ct_session=; ${cookieFlags(req)}; Max-Age=0`;

// Every 10 minutes, throw away what is no longer needed.
setInterval(() => {
  const now = Date.now();
  for (const [k, c] of counters) if (c.resetAt <= now) counters.delete(k);
  for (const [k, s] of sessions) if (tooOld(s, now)) sessions.delete(k);
}, 10 * MINUTE).unref();

// ---------- 4. Same-site check (CSRF) ----------
// Browsers say where a request comes from. A change must come from our own pages.
function requireSameSite(req) {
  const site = req.headers['sec-fetch-site'];
  let good = site === undefined || site === 'same-origin' || site === 'none';
  if (site === undefined && req.headers.origin !== undefined) {   // older browsers: compare the address
    try { good = new URL(req.headers.origin).host === req.headers.host; } catch { good = false; }
  } else if (good && site === 'none' && req.headers.origin !== undefined) good = false;
  if (!good) throw new HttpError(403, 'This request came from another website.');
}

// ---------- 5. Reading requests ----------
// Reads the body of a POST/PATCH request. Only JSON, only an object, only up to "max" bytes.
function readBody(req, max = 16 * 1024) {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Please send JSON.');
  const tooLarge = new HttpError(413, 'That is too large.', { Connection: 'close' });
  if (Number(req.headers['content-length']) > max) throw tooLarge;
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { chunks = []; req.pause(); reject(tooLarge); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* handled below */ }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) reject(new HttpError(400, 'That request was not valid.'));
      else resolve(value);
    });
    req.on('error', () => reject(new HttpError(400, 'That request was interrupted.')));
  });
}

// ---------- 6. Cleaning input ----------
// Text: removes invisible control characters and characters that flip the reading direction,
// then cuts it to "max". (HTML is NOT removed here: the pages escape it when they show it.)
function cleanText(value, max, multiline = false) {
  if (typeof value !== 'string') return '';
  const tidy = value.slice(0, max * 4).toWellFormed().normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  const oneLine = multiline ? tidy : tidy.replace(/[\n\t\u2028\u2029]+/g, ' ');
  return oneLine.trim().slice(0, max).toWellFormed().trim();
}

// A row number: 5 or "5". Anything else (text, objects, 1.5, -1, huge numbers) becomes null.
function cleanId(value) {
  if (typeof value === 'string' ? !/^\d{1,9}$/.test(value) : !Number.isInteger(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= 999999999 ? n : null;
}

function cleanEmail(value) {
  const email = cleanText(value, 100).toLowerCase();
  return /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email) ? email : null;
}

const COMMON_PASSWORDS = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', '11111111', '00000000',
  'qwertyui', 'qwerty123', 'iloveyou', 'abcdefgh', 'abcd1234', 'admin123', 'resident123', 'welcome1', 'letmein1', 'cleantrack']);
// Returns a message when the password is not good enough, otherwise null.
function passwordProblem(password, email) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 128) return 'Password must be at most 128 characters.';
  if (COMMON_PASSWORDS.has(password.toLowerCase()) || new Set(password).size < 4) return 'That password is too easy to guess. Please choose another.';
  if (email && password.toLowerCase() === email) return 'The password cannot be your email.';
  return null;
}

// The owner and admin accounts need a stronger password than residents.
function staffPasswordProblem(password) {
  if (typeof password !== 'string' || password.length < 12) return 'It must have at least 12 characters.';
  if (password.length > 128) return 'It must have at most 128 characters.';
  if (new Set(password).size < 6) return 'It repeats the same few characters. Please mix it more.';
  if (/cleantrack|admin|owner|password|qwerty|123456|resident/i.test(password)) return 'It contains a word that is easy to guess (like admin, owner or password).';
  return null;
}

// An optional Google Maps link. Admins click it, so it must really go to Google Maps:
// https only, only these Google addresses, and no hidden user name or port.
// Returns the link, or null when nothing was given. Phones often share "Place name https://...",
// so the link is taken out of the text.
function cleanMapLink(value) {
  if (value === undefined || value === null || value === '') return null;
  const bad = new HttpError(400, 'Please paste a Google Maps link (for example https://maps.app.goo.gl/...), or leave it empty.');
  if (typeof value !== 'string' || value.length > 2000) throw bad;
  const typed = cleanText(value, 2000);
  if (!typed) return null;
  const links = typed.match(/(?<!\S)https?:\/\/\S+/gi) || [];
  if (links.length > 1 || (!links.length && /\s/.test(typed))) throw bad;
  let url;
  try { url = new URL(links[0] || 'https://' + typed); } catch { throw bad; }
  const host = url.hostname;
  const onMaps = host === 'maps.app.goo.gl' ? /^\/[A-Za-z0-9_-]+$/.test(url.pathname)
    : host === 'goo.gl' ? /^\/maps\/[A-Za-z0-9_-]+$/.test(url.pathname)
    : /^(www\.)?google\.(com|co\.in)$/.test(host) ? /^\/maps(\/|$)/.test(url.pathname)
    : /^maps\.google\.(com|co\.in)$/.test(host) ? /^\/(maps(\/|$)|$)/.test(url.pathname)
    : false;
  if (!onMaps || url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 1500) throw bad;
  return url.href;
}

// A photo is checked by its first bytes, not by what it calls itself.
const IMAGE_KINDS = {
  png: { ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpeg: { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { ext: 'webp', test: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
};
const MAX_PHOTO = 2 * 1024 * 1024;
// Turns the text version of a photo back into bytes, or returns null when there is no photo.
function cleanPhoto(dataUrl) {
  if (dataUrl === undefined || dataUrl === null || dataUrl === '') return null;
  const bad = new HttpError(400, 'Photo must be a real PNG, JPG or WEBP image.');
  if (typeof dataUrl !== 'string') throw bad;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw bad;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_PHOTO) throw new HttpError(400, 'Photo must be smaller than 2 MB.');
  const kind = IMAGE_KINDS[match[1]];
  if (bytes.length < 32 || !kind.test(bytes)) throw bad;
  return { bytes, name: `${crypto.randomBytes(16).toString('hex')}.${kind.ext}` }; // we choose the name, not the user
}

module.exports = {
  HttpError, MINUTE, HOUR, setSecurityHeaders, limit, giveBack, clientIp,
  findSession, passwordStamp, createSession, endSession, clearedCookie, requireSameSite, readBody,
  cleanText, cleanId, cleanEmail, passwordProblem, staffPasswordProblem, cleanMapLink, cleanPhoto,
};
