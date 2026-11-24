// Attacks a throwaway copy of CleanTrack and checks that every attack fails.
//   npm test
// Your real database is never touched: the project is copied to a temporary folder first,
// and the copy makes its own fresh sample data.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const SOURCE = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const PORT = 3977;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const made = [];
let failed = 0, passed = 0, server, dir;

function check(name, good, detail = '') {
  if (good) passed++; else failed++;
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${name}${good || detail === '' ? '' : '   -> ' + JSON.stringify(detail).slice(0, 160)}`);
}
const section = (s) => console.log('\n' + s);

// ---------- start and stop a copy ----------
function copyProject() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cleantrack-test-'));
  made.push(d);
  fs.readdirSync(SOURCE).filter((f) => /\.(js|json)$/.test(f)).forEach((f) => fs.copyFileSync(path.join(SOURCE, f), path.join(d, f)));
  fs.cpSync(path.join(SOURCE, 'scripts'), path.join(d, 'scripts'), { recursive: true });
  fs.cpSync(path.join(SOURCE, 'public'), path.join(d, 'public'), { recursive: true });
  return d;
}
async function start(env = {}, d = copyProject()) {
  await stop();
  dir = d;
  server = spawn(process.execPath, ['server.js'], { cwd: d, env: { ...process.env, PORT, CLIENT_IP_HEADER: 'x-test-ip', OWNER_PASSWORD: OWNER_PW, ADMIN_PASSWORD: ADMIN_PW, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.log = '';
  server.stdout.on('data', (x) => { server.log += x; });
  server.stderr.on('data', (x) => { server.log += x; });
  for (let i = 0; i < 60; i++) { await sleep(150); if (!running()) return false; if ((await req('GET', '/api/meta')).status === 200) return true; }
  return false;
}
const running = () => !!server && server.exitCode === null && server.signalCode === null;
async function stop() { if (running()) { const gone = new Promise((r) => server.once('exit', r)); server.kill(); await gone; } }
const alive = async () => running() && (await req('GET', '/api/meta')).status === 200;

// ---------- talk to it exactly as written (nothing is tidied up, unlike a browser) ----------
let ip = 1;
function req(method, p, { headers = {}, body, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, agent: false, timeout: 15000,
      headers: { 'x-test-ip': '10.0.0.' + ip, ...(data !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
      res.on('end', () => { const raw = Buffer.concat(parts); let json = null; try { json = JSON.parse(raw); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, body: raw.toString(), raw, json }); });
    });
    r.on('timeout', () => r.destroy());
    r.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    if (data !== null) r.write(data);
    r.end();
  });
}
const raw = (textToSend) => new Promise((resolve) => {
  const s = net.connect(PORT, '127.0.0.1', () => s.write(textToSend)); let got = '';
  s.on('data', (d) => { got += d; }); s.on('error', () => resolve(got)); s.on('close', () => resolve(got)); setTimeout(() => { s.destroy(); resolve(got); }, 1200);
});
async function login(email, password) { const r = await req('POST', '/api/login', { body: { email, password } }); return (r.headers['set-cookie'] || [''])[0].split(';')[0]; }
const riya = () => login('riya@cleantrack.test', 'resident123');
const arjun = () => login('arjun@cleantrack.test', 'resident123');
const OWNER_PW = 'Owl-' + crypto.randomBytes(9).toString('hex'), ADMIN_PW = 'Elk-' + crypto.randomBytes(9).toString('hex'); // new for every run
const admin = () => login('admin@cleantrack.test', ADMIN_PW);
const owner = () => login('owner@cleantrack.test', OWNER_PW);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const dataUrl = (type, buf) => `data:image/${type};base64,${buf.toString('base64')}`;
const report = (cookie, extra = {}) => req('POST', '/api/complaints', { cookie, body: { title: 'T', description: 'D', location: 'L', category_id: 1, area_id: 1, ...extra } });
function query(sql, ...args) { const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite'); const d = new DatabaseSync(path.join(dir, 'data', 'cleantrack.db'), { readOnly: true }); const r = d.prepare(sql).all(...args); d.close(); return r; }

try {
  section('1, 2, 18  Secrets, environment, Git');
  const git = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: SOURCE, encoding: 'utf8' });
  const tracked = git.status === 0 ? git.stdout.split('\n').filter((name) => name && fs.existsSync(path.join(SOURCE, name))) : [];
  if (tracked.length) {
    check('no database, upload, key or .env file would be committed', !tracked.some((f) => /(^|\/)(data|uploads|node_modules)\/|\.(db|sqlite|pem|key)$|(^|\/)\.env/.test(f)), tracked.filter((f) => /\.(db|pem|key)$|\.env/.test(f)));
    const SECRET = /AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30}|sk-[A-Za-z0-9_-]{20}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10}|BEGIN [A-Z ]*PRIVATE KEY|[0-9a-f]{32}:[0-9a-f]{128}|scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}/;
    check('no secret in any file', !tracked.some((f) => SECRET.test(fs.readFileSync(path.join(SOURCE, f), 'latin1'))));
    const all = spawnSync('git', ['cat-file', '--batch-all-objects', '--batch-check'], { cwd: SOURCE, encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(' blob '));
    const bad = all.filter((l) => { const b = spawnSync('git', ['cat-file', 'blob', l.split(' ')[0]], { cwd: SOURCE, maxBuffer: 1e9 }).stdout; return b.subarray(0, 15).toString() === 'SQLite format 3' || SECRET.test(b.toString('latin1')); });
    check(`no secret or database in Git's whole storage (${all.length} files, including old versions)`, all.length > 0 && bad.length === 0, bad);
  }
  const used = new Set(fs.readdirSync(SOURCE).filter((f) => f.endsWith('.js')).flatMap((f) => [...fs.readFileSync(path.join(SOURCE, f), 'utf8').matchAll(/process\.env\.(\w+)/g)].map((m) => m[1])));
  check('environment settings are only the documented ones', [...used].every((v) => ['PORT', 'OWNER_PASSWORD', 'ADMIN_PASSWORD', 'CLIENT_IP_HEADER'].includes(v)), [...used]);
  const pub = fs.readdirSync(path.join(SOURCE, 'public'), { recursive: true }).filter((f) => /\.(js|html)$/.test(f));
  check('nothing secret is sent to the browser', !pub.some((f) => /process\.env|password_hash|require\(['"]node:/.test(fs.readFileSync(path.join(SOURCE, 'public', f), 'utf8').slice(0, 400000)) && !/three\.min/.test(f)));

  await start();
  section('3, 5  Admin pages and who may see what');
  const R = await riya(), A = await arjun(), X = await admin();
  for (const p of ['/admin.html', '/resident.html']) { const r = await req('GET', p); check(`${p} is not given to a visitor`, r.status === 302 && r.headers.location === '/login.html', r.status); }
  check('a resident cannot get the admin page', (await req('GET', '/admin.html', { cookie: R })).status === 302);
  check('an admin cannot get the resident page', (await req('GET', '/resident.html', { cookie: X })).status === 302);
  check('each role gets its own page', (await req('GET', '/admin.html', { cookie: X })).status === 200 && (await req('GET', '/resident.html', { cookie: R })).status === 200);
  let leaks = 0;
  for (const p of ['/ADMIN.HTML', '/Admin.html', '/admin.html.', '/admin.html%20', '/admin.html::$DATA', '/admin.html%3A%3A%24DATA', '/./admin.html', '/x/../admin.html', '//admin.html', '/%61dmin.html', '/admin.html/', '/admin.html%00', '/css/..%2fadmin.html', '/css\\..\\admin.html', '/css/..%5cadmin.html', '/ADMIN~1.HTM', '/admin%2ehtml'])
    if ((await req('GET', p)).body.includes('/js/admin.js')) { leaks++; console.log('        leaked by', p); }
  check('no spelling trick reaches the admin page', leaks === 0);
  const api = [['GET', '/api/complaints'], ['GET', '/api/complaints/1'], ['GET', '/api/inbox'], ['PATCH', '/api/complaints/1'], ['PATCH', '/api/me'], ['POST', '/api/complaints']];
  for (const [m, p] of api) { const r = await req(m, p, m === 'GET' ? {} : { body: {} }); check(`${m} ${p} needs a login`, r.status === 401, r.status); }
  check("a resident cannot read another's report", [403, 404].includes((await req('GET', '/api/complaints/1', { cookie: A })).status));
  check('a resident sees only their own list', (await req('GET', '/api/complaints?area_id=1', { cookie: A })).json.complaints.every((c) => c.reporter === 'Arjun Mehta'));
  check('a resident cannot change a status', (await req('PATCH', '/api/complaints/1', { cookie: R, body: { status: 'Rejected' } })).status === 403 && query('SELECT status FROM complaints WHERE id=1')[0].status === 'Resolved');
  const up = await req('PATCH', '/api/me', { cookie: R, body: { name: 'Riya Sharma', area_id: 1, role: 'admin', email: 'x@x.test', id: 3, password_hash: 'x' } });
  check('settings cannot change role, email or id', up.status === 200 && query("SELECT role,email FROM users WHERE id=1")[0].role === 'resident' && query('SELECT email FROM users WHERE id=1')[0].email === 'riya@cleantrack.test');
  const own = await report(R, { image: dataUrl('png', PNG), user_id: 2, status: 'Resolved', team_id: 1 });
  const row = query('SELECT * FROM complaints ORDER BY id DESC LIMIT 1')[0];
  check('a new report cannot choose its owner, status or team', own.status === 201 && row.user_id === 1 && row.status === 'Submitted' && row.team_id === null);
  const photo = row.image_path;
  check('a photo is not shown to a visitor', [401, 403, 404].includes((await req('GET', photo)).status));
  check('a photo is not shown to another resident', [401, 403, 404].includes((await req('GET', photo, { cookie: A })).status));
  const ph = await req('GET', photo, { cookie: R });
  check('a photo is shown to its owner and the admin', ph.status === 200 && ph.raw.equals(PNG) && (await req('GET', photo, { cookie: X })).status === 200);
  check('no answer contains a password hash', !JSON.stringify([(await req('GET', '/api/me', { cookie: R })).body, (await req('GET', '/api/complaints', { cookie: X })).body, up.body]).match(/password|scrypt|hash/i));

  section('4  Login and sessions');
  const lr = await req('POST', '/api/login', { body: { email: 'riya@cleantrack.test', password: 'resident123' } });
  const sc = (lr.headers['set-cookie'] || [''])[0];
  check('cookie is HttpOnly and SameSite', /HttpOnly/i.test(sc) && /SameSite=(Lax|Strict)/i.test(sc));
  check('cookie is Secure on https', /Secure/i.test((await req('POST', '/api/login', { headers: { 'x-forwarded-proto': 'https' }, body: { email: 'riya@cleantrack.test', password: 'resident123' } })).headers['set-cookie']?.[0] || ''));
  check('session id is long and random', /=[0-9a-f]{48,}/.test(sc));
  const c1 = sc.split(';')[0];
  const again = (await req('POST', '/api/login', { cookie: c1, body: { email: 'riya@cleantrack.test', password: 'resident123' } })).headers['set-cookie'][0].split(';')[0];
  check('logging in gives a new session and ends the old one', again !== c1 && (await req('GET', '/api/me', { cookie: c1 })).json.user === null);
  check('a made-up session is refused', (await req('GET', '/api/me', { cookie: 'ct_session=' + 'a'.repeat(64) })).json.user === null && (await req('GET', '/api/me', { cookie: 'ct_session=__proto__' })).json.user === null);
  await req('POST', '/api/logout', { cookie: again });
  check('logging out ends the session on the server', (await req('GET', '/api/me', { cookie: again })).json.user === null);
  const w1 = await req('POST', '/api/login', { body: { email: 'riya@cleantrack.test', password: 'wrong-one' } }), w2 = await req('POST', '/api/login', { body: { email: 'nobody@x.test', password: 'wrong-one' } });
  check('wrong password and unknown email look the same', w1.status === 401 && w1.body === w2.body);
  const time = async (email) => { const t = []; for (let i = 0; i < 4; i++) { ip = 200 + Math.floor(Math.random() * 50); const a = performance.now(); await req('POST', '/api/login', { headers: { 'x-test-ip': 'time' + Math.random() }, body: { email, password: 'wrong-one' } }); t.push(performance.now() - a); } return t.sort((a, b) => a - b)[1]; };
  ip = 1; const known = await time('arjun@cleantrack.test'), unknown = await time('nobody' + Math.random() + '@x.test'); ip = 1;
  check('both take a similar time (so emails cannot be guessed by timing)', unknown > known * 0.5, { known, unknown });
  const reg = (b) => req('POST', '/api/register', { headers: { 'x-test-ip': 'reg' + Math.random() }, body: { name: 'New', email: `n${crypto.randomUUID()}@x.test`, password: 'long-enough-1', area_id: 1, ...b } });
  check('sign-up is always a resident', (await reg({ role: 'admin' })).json.user.role === 'resident');
  check('short and common passwords refused', (await reg({ password: 'abc1234' })).status === 400 && (await reg({ password: 'password' })).status === 400 && (await reg({ password: '12345678' })).status === 400);
  check('a huge password is refused', (await reg({ password: 'x'.repeat(5000) })).status === 400);
  check('same email in capitals refused', (await reg({ email: 'RIYA@cleantrack.test' })).status === 409);
  const twin = `twin${Date.now()}@x.test`; const two = await Promise.all([reg({ email: twin }), reg({ email: twin })]);
  check('two sign-ups at once make one account', two.map((r) => r.status).sort().join() === '200,409' && query('SELECT COUNT(*) n FROM users WHERE email=?', twin)[0].n === 1, two.map((r) => r.status));

  section('6, 7  Forms and XSS');
  const evil = '<img src=x onerror=alert(1)>"\'><script>alert(1)</script>';
  for (const [n, b] of Object.entries({ null: 'null', array: '[]', number: '5', text: '"x"', broken: '{"a":', empty: '', deep: '['.repeat(15000) })) {
    const r = await req('POST', '/api/login', { body: b }); check(`login with ${n} body is a clean 400`, r.status === 400 || (n === 'empty' && r.status === 401), r.status);
  }
  for (const [n, b] of Object.entries({ objects: { title: {}, description: [], location: 5 }, 'area as object': { area_id: {} }, 'area as text': { area_id: "1 OR 1=1" }, 'area missing': { area_id: 99999 }, 'area too big': { area_id: 1e300 }, 'negative': { category_id: -1 }, 'decimal': { category_id: 1.5 } })) {
    const r = await report(R, b); check(`report with ${n} is a clean 400`, r.status === 400, r.status);
  }
  check('sign-up with a bad area is a clean 400', (await reg({ area_id: 9999 })).status === 400 && (await reg({ area_id: 'x' })).status === 400);
  check('sign-up refuses code in the email', (await reg({ email: '<script>@x.test' })).status === 400);
  check('settings with a bad area is a clean 400', (await req('PATCH', '/api/me', { cookie: R, body: { area_id: 'abc' } })).status === 400);
  const ev = await report(R, { title: evil, description: evil + '\u0000\u0007\u202Etxt', location: 'a\r\nb' });
  const er = query('SELECT * FROM complaints ORDER BY id DESC LIMIT 1')[0];
  check('invisible control characters are removed', ev.status === 201 && !/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(er.title + er.description) && !/[\r\n]/.test(er.location), er.description);
  check('long text is cut', (await report(R, { title: 'x'.repeat(5000) })).status === 201 && query('SELECT title FROM complaints ORDER BY id DESC LIMIT 1')[0].title.length === 100);
  const before = fs.readdirSync(path.join(dir, 'data', 'uploads')).length;
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  for (const [n, v] of Object.entries({ 'a web page named png': dataUrl('png', html), 'a web page named jpeg': dataUrl('jpeg', html), 'a web page named webp': dataUrl('webp', html), svg: dataUrl('svg+xml', Buffer.from('<svg onload=alert(1)>')), 'a png named jpeg': dataUrl('jpeg', PNG), 'a path': '../../x.png', 'an object': { a: 1 }, 'bad base64': 'data:image/png;base64,====' }))
    { const r = await report(R, { image: v }); check(`photo that is ${n} is refused`, r.status === 400, r.status); }
  check('refused photos leave no file behind', fs.readdirSync(path.join(dir, 'data', 'uploads')).length === before);
  check('photo over 2 MB refused', (await report(R, { image: dataUrl('png', Buffer.concat([PNG, Buffer.alloc(2.1e6)])) })).status === 400);
  check('photo answer cannot run as a page', /nosniff/.test(ph.headers['x-content-type-options']) && ph.headers['content-type'] === 'image/png' && /default-src 'none'/.test(ph.headers['content-security-policy'] || ''));

  section('Google Maps link');
  ip = 80; const linkUser = (await reg({})).headers['set-cookie'][0].split(';')[0];
  const GOOD = { 'https://maps.app.goo.gl/AbC123xyz': 1, 'https://www.google.com/maps/place/City+Park/@28.6,77.2,17z': 1, 'https://www.google.com/maps?q=28.6139,77.2090': 1, 'https://google.co.in/maps/place/X': 1, 'https://maps.google.com/?q=28.6,77.2': 1, 'https://goo.gl/maps/abc123': 1, 'maps.app.goo.gl/AbC123xyz': 'https://maps.app.goo.gl/AbC123xyz', 'City Park, Sector 12 https://maps.app.goo.gl/AbC123xyz': 'https://maps.app.goo.gl/AbC123xyz', '  https://maps.app.goo.gl/AbC123xyz  ': 'https://maps.app.goo.gl/AbC123xyz' };
  const lost = []; let gi = 0;
  for (const [v, want] of Object.entries(GOOD)) { if (gi++ % 8 === 0) await sleep(1); const r = await report(linkUser, { map_link: v }); const got = query('SELECT map_link m FROM complaints ORDER BY id DESC LIMIT 1')[0].m; if (r.status !== 201 || got !== (want === 1 ? v : want)) lost.push([v, r.status, got]); }
  check('real Google Maps links are saved', lost.length === 0, lost);
  const BAD = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)//https://maps.app.goo.gl/a', 'data:text/html,<script>alert(1)</script>', 'http://maps.app.goo.gl/abc', 'https://evil.example/maps', 'https://maps.app.goo.gl.evil.example/abc', 'https://evil.example/https://maps.app.goo.gl/abc', 'https://google.com.evil.example/maps', 'https://notgoogle.com/maps', 'https://maps.app.goo.gl@evil.example/abc', 'https://user:pw@www.google.com/maps', 'https://www.google.com:8443/maps', 'https://www.google.com/url?q=https://evil.example', 'https://www.google.com/mapsevil', 'https://www.google.com/maps/../url?q=https://evil.example', 'https://maps.google.com/url?q=https://evil.example', 'https://goo.gl/abc', 'https://goo.gl/maps/../abc', 'https://maps.app.goo.gl/', 'https://maps.app.goo.gl/a https://evil.example/b', 'https://maps.app.goo.gl\\@evil.example', '//evil.example', 'https://sites.google.com/maps', 'https://googIe.com/maps', 'https://www.g\u043eogle.com/maps', 'not a link at all', 'ftp://www.google.com/maps', 'https://maps.app.goo.gl/' + 'a'.repeat(1600)];
  const before2 = query('SELECT COUNT(*) n FROM complaints')[0].n, taken = [];
  for (const v of [...BAD, { a: 1 }, ['https://maps.app.goo.gl/a'], 5, true]) { const r = await report(linkUser, { map_link: v }); if (r.status !== 400) taken.push([v, r.status]); }
  check(`${BAD.length + 4} fake or harmful links are refused`, taken.length === 0 && query('SELECT COUNT(*) n FROM complaints')[0].n === before2, taken);
  check('the link is optional', (await report(linkUser, { map_link: '' })).status === 201 && (await report(linkUser)).status === 201 && (await report(linkUser, { map_link: '   ' })).status === 201 && query('SELECT map_link m FROM complaints ORDER BY id DESC LIMIT 1')[0].m === null);
  ip = 1;

  section('8  Rate limiting');
  let codes = []; ip = 2; for (let i = 0; i < 14; i++) codes.push((await req('POST', '/api/login', { body: { email: 'admin@cleantrack.test', password: 'guess' + i } })).status);
  const limited = await req('POST', '/api/login', { body: { email: 'admin@cleantrack.test', password: ADMIN_PW } });
  check('password guessing is stopped', codes.includes(429) && limited.status === 429 && Number(limited.headers['retry-after']) > 0, codes);
  ip = 3; check('other people can still log in', (await admin()).length > 20);
  ip = 4; const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => req('POST', '/api/login', { body: { email: 'arjun@cleantrack.test', password: 'p' + i } })));
  check('guessing many at the same moment is stopped too', burst.filter((r) => r.status === 401).length <= 10, burst.filter((r) => r.status === 401).length);
  ip = 5; codes = []; for (let i = 0; i < 60; i++) codes.push((await req('POST', '/api/login', { body: { email: `u${i}@x.test`, password: 'x' } })).status);
  check('trying many emails from one place is stopped', codes.includes(429));
  ip = 6; codes = []; for (let i = 0; i < 16; i++) codes.push((await req('POST', '/api/register', { body: { name: 'N', email: `m${i}@x.test`, password: 'long-enough-1', area_id: 1 } })).status);
  check('mass sign-up is stopped', codes.includes(429), codes);
  ip = 7; codes = []; for (let i = 0; i < 30; i++) codes.push((await report(A)).status);
  check('flooding reports is stopped', codes.includes(429), codes.slice(-3));
  ip = 8; const flood = []; for (let i = 0; i < 8; i++) flood.push(...await Promise.all(Array.from({ length: 100 }, () => req('GET', '/api/stats'))));
  check('flooding the API is stopped', flood.some((r) => r.status === 429) && await (async () => { ip = 9; return alive(); })());

  section('9  Attacks on the endpoints');
  ip = 10;
  for (const p of ['//', '///', '/\\', '/%', '/%zz', '/%00', '/api/complaints/%', '/api/complaints/99999999999999999999', '/?' + 'a'.repeat(7000), 'http://', '*']) { const r = await req(p === '*' ? 'OPTIONS' : 'GET', p); if (!(await alive())) { check(`odd address ${p.slice(0, 20)} does not crash the server`, false, server.log.slice(-200)); await start({}, dir); } else check(`odd address ${p.slice(0, 20)} does not crash the server`, r.status < 500, r.status); }
  await raw('GET // HTTP/1.1\r\nHost: x\r\n\r\n'); await raw('GARBAGE\r\n\r\n'); await raw('GET / HTTP/1.1\r\nHost: x\r\nContent-Length: abc\r\n\r\n'); await raw('POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 10\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n');
  check('broken requests do not crash the server', await alive()); if (!(await alive())) await start({}, dir);
  const R2 = await riya(), X2 = await admin();
  for (const q of ["' OR 1=1 --", "'; DROP TABLE users; --", '%', '"', "\\'"]) await req('GET', '/api/complaints?q=' + encodeURIComponent(q) + '&status=' + encodeURIComponent(q) + '&area_id=' + encodeURIComponent(q), { cookie: X2 });
  check('SQL injection does nothing', query('SELECT COUNT(*) n FROM users')[0].n >= 3 && (await req('GET', '/api/complaints?q=' + encodeURIComponent("' OR 1=1 --"), { cookie: R2 })).json.complaints.length === 0);
  check('SQL injection in login does nothing', (await req('POST', '/api/login', { body: { email: "admin@cleantrack.test' --", password: 'x' } })).status === 401);
  check('sending a form type other than JSON is refused', [400, 415].includes((await req('POST', '/api/login', { headers: { 'content-type': 'text/plain' }, body: '{"email":"a","password":"b"}' })).status));
  const big = await req('POST', '/api/login', { body: '{"email":"' + 'a'.repeat(200000) + '"}' }); check('a huge login is refused', [0, 413].includes(big.status) && await alive(), big.status);
  const huge = await report(R2, { image: 'data:image/png;base64,' + 'A'.repeat(6e6) }); check('a huge report is refused', [0, 413].includes(huge.status) && await alive(), huge.status);
  for (const m of ['PUT', 'DELETE', 'POST', 'PATCH']) { const r = await req(m, '/index.html', { body: {} }); check(`${m} on a page is refused`, [403, 404, 405].includes(r.status), r.status); }
  check('an admin cannot assign a team that does not exist', (await req('PATCH', '/api/complaints/1', { cookie: X2, body: { status: 'Resolved', team_id: 99 } })).status === 400 && (await req('PATCH', '/api/complaints/1', { cookie: X2, body: { status: 'Resolved', team_id: { a: 1 } } })).status === 400);
  check('an unknown status is refused', (await req('PATCH', '/api/complaints/1', { cookie: X2, body: { status: 'Hacked', team_id: 1 } })).status === 400);

  section('10  CORS and requests from other websites');
  for (const o of ['https://evil.example', 'null', 'http://localhost:9999']) { const r = await req('GET', '/api/me', { cookie: R2, headers: { origin: o } }); check(`no CORS permission for ${o}`, !r.headers['access-control-allow-origin'] && !r.headers['access-control-allow-credentials']); }
  check('preflight gives no permission', !(await req('OPTIONS', '/api/complaints', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'PATCH' } })).headers['access-control-allow-origin']);
  for (const h of [{ origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }])
    { const r = await req('PATCH', '/api/me', { cookie: R2, headers: h, body: { name: 'Hacked' } }); check(`change from another site refused ${JSON.stringify(h)}`, r.status === 403 && query('SELECT name FROM users WHERE id=1')[0].name === 'Riya Sharma', r.status); await req('PATCH', '/api/me', { cookie: R2, body: { name: 'Riya Sharma', area_id: 1 } }); }
  check('the site itself still works', (await req('PATCH', '/api/me', { cookie: R2, headers: { origin: `http://127.0.0.1:${PORT}`, host: `127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin' }, body: { name: 'Riya Sharma', area_id: 1 } })).status === 200);

  section('11  Security headers');
  for (const p of ['/', '/login.html', '/js/common.js', '/api/meta', '/nothing', '/forest/forest.html']) {
    const h = (await req('GET', p)).headers; const miss = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy'].filter((k) => !h[k]);
    check(`${p} has every header`, miss.length === 0, miss);
  }
  const csp = (await req('GET', '/')).headers['content-security-policy'] || '';
  const scripts = /script-src ([^;]+)/.exec(csp)?.[1].trim();
  check('only our own script files may run (no inline, no eval)', scripts === "'self'", csp);
  check('other sites cannot put the site in a frame', /frame-ancestors 'none'/.test(csp) && (await req('GET', '/')).headers['x-frame-options'] === 'DENY');
  check('https is enforced when on https', /max-age=\d{7,}/.test((await req('GET', '/', { headers: { 'x-forwarded-proto': 'https' } })).headers['strict-transport-security'] || ''));
  check('private answers are never stored', /no-store/.test((await req('GET', '/api/me', { cookie: R2 })).headers['cache-control'] || '') && /no-store/.test((await req('GET', '/resident.html', { cookie: R2 })).headers['cache-control'] || ''));

  section('12  Debug information');
  const five = []; for (const b of ['null', '{"email":{}}', '{"email":["a"],"password":{}}']) five.push((await req('POST', '/api/login', { body: b })).body, (await req('POST', '/api/register', { headers: { 'x-test-ip': 'dbg' + b.length }, body: b })).body);
  check('errors never show code, paths or SQL', !five.join().match(/at .*\.js|node:|C:\\|\/home|SQLITE|TypeError|stack/i));
  check('no header tells which software is used', !(await req('GET', '/')).headers['x-powered-by'] && !(await req('GET', '/')).headers.server);

  section('13, 14, 15  Dependencies and exposed files');
  const pkg = JSON.parse(fs.readFileSync(path.join(SOURCE, 'package.json'))); check('no npm packages to be hacked through', !pkg.dependencies && !pkg.devDependencies && !fs.existsSync(path.join(SOURCE, 'node_modules')));
  const exposed = [];
  for (const p of ['/server.js', '/db.js', '/security.js', '/package.json', '/README.md', '/.gitignore', '/.git/config', '/.git/HEAD', '/.env', '/.node-version', '/data/cleantrack.db', '/cleantrack.db', '/data/cleantrack-backup.db', '/scripts/reset.js', '/uploads/', '/uploads', '/js/', '/css/', '/forest/', '/backup.zip', '/.DS_Store', '/uploads/../cleantrack.db', '/uploads/..%2fcleantrack.db', '/uploads/..%5ccleantrack.db', '/..%2fserver.js', '/%2e%2e/server.js', '/..%5cserver.js', '/..%252fserver.js', '/js/..%2f..%2fserver.js', '/js/%2e%2e/%2e%2e/db.js', '//server.js', '/\\..\\server.js', '/C:/Windows/win.ini', '/file:///etc/passwd', '/css/style.css::$DATA', '/index.html::$DATA', '/con', '/nul', '/aux.js'])
    { const r = await req('GET', p); if (r.status === 200 || /require\(|SQLite format|\[core\]/.test(r.body)) exposed.push(p); if (!(await alive())) { exposed.push('CRASH ' + p); await start({}, dir); } }
  check('server code, database, Git and folders are not exposed', exposed.length === 0, exposed);
  const okay = []; for (const p of ['/', '/index.html', '/login.html', '/css/style.css', '/js/common.js', '/img/overflowing-bin.webp', '/video/story.mp4', '/forest/forest.html', '/forest/THREEUI-LICENSE.txt']) if ((await req('GET', p)).status !== 200) okay.push(p);
  check('the real site files still open', okay.length === 0, okay);
  const part = await req('GET', '/video/story.mp4', { headers: { range: 'bytes=10-19' } }); check('video parts still work', part.status === 206 && part.raw.length === 10);

  section('16, 17  Database and passwords');
  const users = query('SELECT password_hash FROM users');
  check('every password is hashed with strong scrypt', users.every((u) => { const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([0-9a-f]{32,})\$([0-9a-f]{64,})$/.exec(u.password_hash); return m && Number(m[1]) * Number(m[3]) >= 16384 * 5; }), users[0]);
  check('every password has its own salt', new Set(users.map((u) => u.password_hash)).size === users.length);
  check('no plain password anywhere in the database', !new RegExp(['resident123', 'admin123', 'long-enough-1', OWNER_PW, ADMIN_PW].join('|')).test(fs.readFileSync(path.join(dir, 'data', 'cleantrack.db'), 'latin1')));
  check('links between tables are enforced', query('PRAGMA foreign_key_check').length === 0 && query('PRAGMA integrity_check')[0].integrity_check === 'ok');
  check('session ids are not in the database or the log', !server.log.match(/[0-9a-f]{48,}/) && ![OWNER_PW, ADMIN_PW, 'resident123'].some((p) => server.log.includes(p)));
  await stop();
  // an old database (old hash style) must keep working and be upgraded quietly
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite'); let d = new DatabaseSync(path.join(dir, 'data', 'cleantrack.db'));
  const salt = crypto.randomBytes(16).toString('hex'); d.prepare('UPDATE users SET password_hash=? WHERE id=1').run(salt + ':' + crypto.scryptSync('resident123', salt, 64).toString('hex')); d.close();
  await start({}, dir); ip = 60; check('an old account can still log in', (await riya()).length > 20);
  check('its password is upgraded to the stronger hash', query('SELECT password_hash h FROM users WHERE id=1')[0].h.startsWith('scrypt$'));
  check('a wrong password still fails after the upgrade', (await req('POST', '/api/login', { body: { email: 'riya@cleantrack.test', password: 'resident124' } })).status === 401);
  await stop(); d = new DatabaseSync(path.join(dir, 'data', 'cleantrack.db')); d.prepare("UPDATE users SET password_hash='broken' WHERE id=2").run(); d.close(); await start({}, dir); ip = 61;
  check('a damaged hash is a clean refusal', (await req('POST', '/api/login', { body: { email: 'arjun@cleantrack.test', password: 'resident123' } })).status === 401 && await alive());
  section('Owner and admin accounts');
  const unset = { OWNER_PASSWORD: undefined, ADMIN_PASSWORD: undefined };
  await start(unset); ip = 62;
  check('without passwords both staff accounts are locked', query("SELECT COUNT(*) n FROM users WHERE role='admin' AND password_hash='!locked'")[0].n === 2);
  const tries = []; for (const [i, e] of ['admin@cleantrack.test', 'owner@cleantrack.test'].entries()) for (const p of ['admin123', '', '!locked', 'owner123', 'password']) { ip = 63 + i; tries.push((await req('POST', '/api/login', { body: { email: e, password: p } })).status); }
  check('the old public admin password and other guesses fail', tries.every((s) => s === 401), tries);
  check('the login page offers no staff login', !/admin@|owner@|admin123/.test((await req('GET', '/login.html')).body + (await req('GET', '/js/login.js')).body));
  // an existing database that still has the public password
  await stop(); let e1 = new DatabaseSync(path.join(dir, 'data', 'cleantrack.db')); const s1 = crypto.randomBytes(16).toString('hex');
  e1.prepare("UPDATE users SET password_hash=? WHERE email='admin@cleantrack.test'").run(s1 + ':' + crypto.scryptSync('admin123', s1, 64).toString('hex')); e1.close();
  await start(unset, dir); ip = 66; check('an old database with the public admin password is locked at the start', query("SELECT password_hash h FROM users WHERE email='admin@cleantrack.test'")[0].h === '!locked' && (await login('admin@cleantrack.test', 'admin123')) === '');
  for (const [n, p] of Object.entries({ short: 'Zq7!xW2', 'with admin in it': 'my-admin-Zq7!xW2', 'repeating': 'aaaaaaaaaaaaaa' })) { const s = await start({ ADMIN_PASSWORD: p }); check(`a weak password (${n}) stops the start, without printing it`, s === false && !server.log.includes(p)); }
  check('the same password for both stops the start', (await start({ ADMIN_PASSWORD: OWNER_PW })) === false);

  await start(); ip = 70;
  const O = await owner(), M = await admin(), V = await riya();
  check('owner and admin can log in with their own passwords only', O.length > 20 && M.length > 20 && (await login('owner@cleantrack.test', ADMIN_PW)) === '' && (await login('admin@cleantrack.test', OWNER_PW)) === '');
  check('owner can do everything an admin can', (await req('GET', '/admin.html', { cookie: O })).status === 200 && (await req('GET', '/api/complaints', { cookie: O })).json.complaints.length === 5 && (await req('PATCH', '/api/complaints/3', { cookie: O, body: { status: 'In Progress', team_id: 1 } })).status === 200);
  const list = (await req('GET', '/api/users', { cookie: O })).json;
  check('owner sees all accounts, without hashes', list.users.length === 4 && !/scrypt|password_hash|!locked/.test(JSON.stringify(list)));
  const uid = (e) => query('SELECT id FROM users WHERE email=?', e)[0].id, change = (id, body, cookie = O) => req('PATCH', '/api/users/' + id, { cookie, body });
  const oid = uid('owner@cleantrack.test'), aid = uid('admin@cleantrack.test'), rid = uid('riya@cleantrack.test');
  for (const [n, c] of [['an admin', M], ['a resident', V], ['a visitor', undefined]]) {
    const st = [(await req('GET', '/api/users', { cookie: c })).status, (await change(aid, { role: 'admin' }, c ?? '')).status, (await change(oid, { suspended: true }, c ?? '')).status, (await change(rid, { role: 'admin' }, c ?? '')).status];
    check(`${n} cannot see or change accounts`, st.every((s) => s === (c ? 403 : 401)), st);
  }
  check('an admin cannot make themselves owner', (await req('PATCH', '/api/me', { cookie: M, body: { name: 'City Admin', is_owner: 1, role: 'owner', suspended: false } })).status === 200 && query('SELECT is_owner o FROM users WHERE id=?', aid)[0].o === 0);
  check('sign-up cannot make an owner or take a staff ID', (await reg({ is_owner: 1, role: 'admin' })).json.user.is_owner === 0 && (await reg({ email: 'Owner@cleantrack.test' })).status === 409);
  check('nobody can change the owner account', (await change(oid, { suspended: true })).status === 403 && (await change(oid, { role: 'resident' })).status === 403);
  check('a demo account cannot become an admin', (await change(rid, { role: 'admin' })).status === 400);
  const badBodies = []; for (const b of [{}, { role: 'owner' }, { role: 'x' }, { role: {} }, { suspended: 'yes' }, { suspended: 1 }, { is_owner: 1 }]) badBodies.push((await change(aid, b)).status);
  check('odd changes are a clean 400', badBodies.every((s) => s === 400), badBodies);
  check('an account that does not exist is a clean 404', (await change(9999, { suspended: true })).status === 404 && (await req('PATCH', '/api/users/abc', { cookie: O, body: { suspended: true } })).status === 404);
  const person = `p${Date.now()}@x.test`, pc = (await reg({ email: person })).headers['set-cookie'][0].split(';')[0], pid = uid(person);
  check('owner can make an admin, at once', (await change(pid, { role: 'admin' })).status === 200 && (await req('GET', '/api/complaints', { cookie: pc })).json.complaints.length === 5 && (await req('GET', '/api/users', { cookie: pc })).status === 403);
  check('owner can take admin rights away, at once', (await change(pid, { role: 'resident' })).status === 200 && (await req('GET', '/admin.html', { cookie: pc })).status === 302 && (await req('PATCH', '/api/complaints/3', { cookie: pc, body: { status: 'Resolved' } })).status === 403);
  check('suspending ends the login at once', (await change(aid, { suspended: true })).status === 200 && (await req('GET', '/api/me', { cookie: M })).json.user === null && (await req('GET', '/api/complaints', { cookie: M })).status === 401);
  const su = await req('POST', '/api/login', { body: { email: 'admin@cleantrack.test', password: ADMIN_PW } }); check('a suspended account cannot log in', su.status === 403 && !su.headers['set-cookie']);
  check('a wrong password does not reveal that it is suspended', (await req('POST', '/api/login', { body: { email: 'admin@cleantrack.test', password: 'x' } })).status === 401);
  check('restoring works', (await change(aid, { suspended: false })).status === 200 && (await admin()).length > 20);
  let second = false; const e2 = new DatabaseSync(path.join(dir, 'data', 'cleantrack.db')); try { e2.prepare('UPDATE users SET is_owner=1 WHERE id=?').run(aid); second = true; } catch { /* refused */ } e2.close();
  check('the database itself refuses a second owner', second === false);

  // the password prompt, with typed keys played back (the copy, not your project)
  const runPrompt = (keys) => spawnSync(process.execPath, ['-e', `
    const { PassThrough } = require('node:stream'); const { setOne } = require('./scripts/set-passwords.js'); const { OWNER_ID, ADMIN_ID } = require('./db');
    const keys = JSON.parse(process.env.KEYS); const input = new PassThrough(); input.setRawMode = () => {}; let shown = '';
    const output = { write(s) { shown += s; if (/: $/.test(s)) setImmediate(() => input.write(keys.shift() ?? String.fromCharCode(3))); return true; } };
    setOne('T', ADMIN_ID, OWNER_ID, { input, output }).then((r) => console.log(JSON.stringify({ r, shown })), (e) => console.log(JSON.stringify({ e: e.message, shown }))).finally(() => process.exit(0));`],
    { cwd: dir, env: { ...process.env, OWNER_PASSWORD: undefined, ADMIN_PASSWORD: undefined, KEYS: JSON.stringify(keys) }, encoding: 'utf8', timeout: 30000 });
  const NEW = 'Yak-' + crypto.randomBytes(8).toString('hex'); ip = 75; const oldLogin = await admin();
  const pr = JSON.parse(runPrompt(['short\r', OWNER_PW + '\r', NEW + '\r', 'different\r', NEW + 'x\u007f\r', NEW + '\r']).stdout.trim().split('\n').at(-1));
  check('prompt: refuses weak, reused and mistyped passwords, then saves', pr.r === true && /at least 12/.test(pr.shown) && /different from the other/.test(pr.shown) && /not the same/.test(pr.shown), pr);
  check('prompt: never shows what you type', !pr.shown.includes(NEW) && !pr.shown.includes('short') && pr.shown.includes('****'));
  check('prompt: the new password works without a restart', (await login('admin@cleantrack.test', NEW)).length > 20 && (await admin()) === '');
  check('prompt: changing the password ends old logins', (await req('GET', '/api/me', { cookie: oldLogin })).json.user === null);
  const skip = JSON.parse(runPrompt(['\r']).stdout.trim().split('\n').at(-1)), stopIt = JSON.parse(runPrompt(['abc\u0003']).stdout.trim().split('\n').at(-1));
  check('prompt: Enter skips and Ctrl+C stops, changing nothing', skip.r === false && /Stopped/.test(stopIt.e) && (await login('admin@cleantrack.test', NEW)).length > 20);
} catch (err) {
  failed++;
  console.log('\n  FAIL  the test itself stopped:', err.stack);
} finally {
  await stop();
  await sleep(400);
  made.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* Windows may hold a file for a moment */ } });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
