// home.js — the home page: live numbers and the interactive parts.
//   1. Reveal:  sections fade in when they come into view (IntersectionObserver).
//   2. Steps:   the "How it works" video plays, and the four steps follow its time.
//   3. Counter: the numbers count up from 0 when you first see them.

// ---------- 1. Reveal on scroll ----------
// IntersectionObserver tells us when an element enters the screen.
// We then add the class "in", and the CSS transition does the sliding.
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('in');
      revealObserver.unobserve(entry.target); // only animate once
    }
  });
}, { threshold: 0.15 });
document.querySelectorAll('[data-reveal]').forEach((el) => revealObserver.observe(el));

// ---------- 2. "How it works": the steps follow the video ----------
// The video is 20 seconds long and each step is 5 seconds of it. We read how far the video
// has played, work out the step number (0–3), and write it into data-step on the section.
// The CSS then shows the right badge and lights up the right step.
const story = document.getElementById('story');
const video = document.getElementById('storyVideo');
const videoToggle = document.getElementById('videoToggle');
const storyLine = document.getElementById('storyLine');
const stepButtons = [...story.querySelectorAll('.step-btn')];
const STEP_SECONDS = 5;
const lines = [
  'Riya reported it with a photo.',
  'New report on the admin dashboard: Sector 12.',
  'Team Alpha assigned. Truck on the way.',
  'Cleaned! Riya sees the full history.',
];
let currentStep = -1;
let videoBroken = false;

function showStep(step) {
  if (step === currentStep) return;
  currentStep = step;
  story.dataset.step = step;
  storyLine.textContent = lines[step];
  stepButtons.forEach((btn, i) => btn.setAttribute('aria-pressed', String(i === step)));
}

// "seconds" is the time in the 20-second story. --sp (0 to 1) fills the thin line in the step.
function showTime(seconds) {
  const step = Math.min(lines.length - 1, Math.floor(seconds / STEP_SECONDS));
  showStep(step);
  stepButtons[step].style.setProperty('--sp', Math.min(1, seconds / STEP_SECONDS - step));
}

function followVideo() {
  if (videoBroken) return;
  showTime(video.currentTime);
  if (!video.paused) requestAnimationFrame(followVideo);   // keep checking while it plays
}

function updateToggle() {
  videoToggle.textContent = video.paused ? '▶' : '❚❚';
  videoToggle.setAttribute('aria-label', video.paused ? 'Play animation' : 'Pause animation');
}
// play() can be refused by the browser; then the play button simply stays visible
const playVideo = () => { if (!videoBroken) video.play().catch(() => {}); };

video.addEventListener('play', () => { updateToggle(); followVideo(); });
video.addEventListener('pause', updateToggle);
video.addEventListener('seeked', () => showTime(video.currentTime));

// It plays by itself while it is on screen. The button stops it, and then it stays stopped.
// For people who turned off animations it waits for them to press play.
let wantsToPlay = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let onScreen = false;
videoToggle.addEventListener('click', () => {
  wantsToPlay = video.paused;
  if (wantsToPlay) playVideo(); else video.pause();
});
new IntersectionObserver(([entry]) => {
  onScreen = entry.isIntersecting;
  if (onScreen && wantsToPlay) playVideo(); else video.pause();
}, { threshold: 0.25 }).observe(video);

// Clicking a step is optional: it jumps to that part of the video.
stepButtons.forEach((btn, i) => {
  btn.addEventListener('click', () => { video.currentTime = i * STEP_SECONDS + 0.05; });
});

// If the video cannot load, the poster picture stays and the steps still switch by themselves.
function useStepsOnly() {
  if (videoBroken) return;
  videoBroken = true;
  videoToggle.hidden = true;
  if (!wantsToPlay) return;
  setInterval(() => { if (onScreen) showTime((performance.now() / 1000) % (lines.length * STEP_SECONDS)); }, 100);
}
showTime(0);
video.addEventListener('error', useStepsOnly);
if (video.error) useStepsOnly();   // it may have failed before this script ran

// ---------- 3. Count-up numbers ----------
function countUp(el, target) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || target === 0) { el.textContent = target; return; }
  const start = performance.now();
  const duration = 1000; // 1 second
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = Math.round(target * (1 - Math.pow(1 - t, 3))); // ease-out
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ---------- 5. The example complaint card in the hero ----------
// It shows how a complaint moves through the 3 statuses. It plays by itself every
// few seconds; as soon as someone clicks a status button, it stops and shows that one.
const demoCard = document.getElementById('demoCard');
const demoLine = document.getElementById('demoLine');
const demoButtons = demoCard.querySelectorAll('[data-set]');
const demoLines = [
  '📍 Sector 12 · Waiting for the admin to review',
  '🚛 Team Alpha assigned · On the way',
  '✅ Cleaned by Team Alpha in 2 hours',
];

function showDemoStatus(status) {
  demoCard.dataset.status = status;              // CSS reads this to change badge, photo and colours
  demoLine.textContent = demoLines[status];
  demoButtons.forEach((btn, i) => {
    btn.classList.toggle('done', i <= status);   // green for every step reached so far
    btn.setAttribute('aria-pressed', String(i === status));
  });
}

let demoStatus = 0;
let demoTimer = null;
let demoHovered = false;
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function startDemoAutoplay() {
  if (prefersReducedMotion) return;              // no automatic movement for people who turned it off
  demoTimer = setInterval(() => {
    if (demoHovered) return;                     // hold still while the mouse is on the card
    demoStatus = (demoStatus + 1) % 3;
    showDemoStatus(demoStatus);
  }, 2800);
}

demoButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    clearInterval(demoTimer);                    // the visitor is in control now
    demoStatus = Number(btn.dataset.set);
    showDemoStatus(demoStatus);
  });
});
demoCard.addEventListener('mouseenter', () => { demoHovered = true; });
demoCard.addEventListener('mouseleave', () => { demoHovered = false; });
showDemoStatus(0);
startDemoAutoplay();

// ---------- 4. The 3D forest ----------
// The forest background is added by common.js (addForestBackdrop), the same way as on
// every other page: one fixed picture behind the whole page, so it looks continuous.

// ---------- Load the real numbers from the server ----------
async function loadHome() {
  renderTopbar();
  const s = await api('/api/stats');

  document.getElementById('factTotal').textContent = s.total;
  document.getElementById('factResolved').textContent = s.byStatus['Resolved'];

  const cards = [
    ['Total reports', s.total, 'var(--ink)'],
    ['Submitted', s.byStatus['Submitted'], 'var(--blue)'],
    ['In progress', s.byStatus['In Progress'], 'var(--amber)'],
    ['Resolved', s.byStatus['Resolved'], 'var(--green)'],
  ];
  const statsBox = document.getElementById('stats');
  statsBox.innerHTML = cards.map(([label, n, color]) => `
    <div class="card stat"><div class="num" style="color:${color}" data-count="${n}">0</div><div class="label">${label}</div></div>`).join('');

  // Bars start at 0 width and grow to their real width when the table is seen.
  document.getElementById('areaTable').innerHTML = s.byArea.map((a) => {
    const pct = a.total ? Math.round((a.resolved / a.total) * 100) : 0;
    return `<tr><td>${escapeHtml(a.area)}</td><td>${a.open}</td><td>${a.resolved}</td>
      <td><div style="display:flex;align-items:center;gap:10px"><div class="bar" style="flex:1"><span style="width:0" data-width="${pct}%"></span></div>${pct}%</div></td></tr>`;
  }).join('');

  // Start counting and growing only when the numbers section is on screen.
  const numbersObserver = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting) return;
    statsBox.querySelectorAll('[data-count]').forEach((el) => countUp(el, Number(el.dataset.count)));
    document.querySelectorAll('#areaTable [data-width]').forEach((bar) => { bar.style.width = bar.dataset.width; });
    numbersObserver.disconnect();
  }, { threshold: 0.3 });
  numbersObserver.observe(document.getElementById('numbers'));
}

loadHome();
