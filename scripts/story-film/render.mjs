// Turns film.html into public/video/story.mp4. You only need this if you change the film.
// It opens the film in a hidden Microsoft Edge, asks for 30 pictures per second, and gives
// them to ffmpeg (which must be installed), which joins them into a video.
//   node scripts/story-film/render.mjs            makes the video and its poster picture
//   node scripts/story-film/render.mjs check DIR  only saves a few test pictures into DIR
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const FPS = 30, LENGTH = 20, PORT = 9351;
const [mode, dir] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'story-film-'));
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank']);

let target;
for (let i = 0; i < 30 && !target; i++) {
  await sleep(500);
  try { target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { /* not ready yet */ }
}
if (!target) { edge.kill(); throw new Error('Edge did not start'); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const waiting = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');
await send('Page.navigate', { url: pathToFileURL(path.join(here, 'film.html')).href + '#render' });
await sleep(1500);
async function picture(t) {
  const r = await send('Runtime.evaluate', { expression: `draw(${t}); canvas.toDataURL('image/jpeg', 0.97)`, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception.description);
  return Buffer.from(r.result.result.value.split(',')[1], 'base64');
}

try {
  if (mode === 'check') {
    fs.mkdirSync(dir, { recursive: true });
    for (const t of [0, 1.2, 2.7, 3.4, 4.7, 6.0, 7.9, 9.0, 11.2, 12.5, 14.5, 15.8, 17.0, 17.9, 19.0, 19.8]) {
      fs.writeFileSync(path.join(dir, `t${String(t.toFixed(1)).padStart(4, '0')}.jpg`), await picture(t));
    }
  } else {
    const video = path.join(root, 'public', 'video');
    fs.mkdirSync(video, { recursive: true });
    fs.writeFileSync(path.join(video, 'story-poster.jpg'), await picture(0));
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-vf', 'scale=out_range=tv,format=yuv420p', '-color_range', 'tv', '-g', String(FPS), '-movflags', '+faststart',
      path.join(video, 'story.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((resolve, reject) => ff.on('close', (code) => (code ? reject(new Error('ffmpeg failed')) : resolve())));
    for (let f = 0; f < LENGTH * FPS; f++) {
      if (!ff.stdin.write(await picture(f / FPS))) await new Promise((r) => ff.stdin.once('drain', r));
    }
    ff.stdin.end();
    await done;
    console.log('made', path.join(video, 'story.mp4'), Math.round(fs.statSync(path.join(video, 'story.mp4')).size / 1024) + ' KB');
  }
} finally {
  ws.close(); edge.kill();
  await sleep(800);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Edge may still hold a file; Windows cleans temp later */ }
}
