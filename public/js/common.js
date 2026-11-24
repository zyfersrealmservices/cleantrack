// common.js — small helper functions shared by every page.

// Talk to our server's API. Sends/receives JSON and throws an error with the
// server's message if something goes wrong.
async function api(url, options = {}) {
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// VERY IMPORTANT for safety: turns characters like < and > into harmless text,
// so if someone types <script> in a complaint it is shown, not run (stops XSS).
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Button "ripple": when you press any button, a soft circle spreads out from where you clicked.
// One listener on the whole page handles every button, even ones added later by JavaScript.
document.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('.btn, .demo-steps button');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const ink = document.createElement('span');
  ink.className = 'ripple';
  const size = Math.max(rect.width, rect.height) * 2;
  ink.style.width = ink.style.height = size + 'px';
  ink.style.left = (e.clientX - rect.left - size / 2) + 'px';
  ink.style.top = (e.clientY - rect.top - size / 2) + 'px';
  btn.appendChild(ink);
  ink.addEventListener('animationend', () => ink.remove());
});

// Cursor spotlight: while the mouse moves over a dark card, tell the card where the
// mouse is (--x and --y, measured from the card's top-left corner). The CSS draws the light there.
document.addEventListener('pointermove', (e) => {
  const card = e.target.closest('.card, .float-card, .story-card');
  if (!card) return;
  const rect = card.getBoundingClientRect();
  card.style.setProperty('--x', (e.clientX - rect.left) + 'px');
  card.style.setProperty('--y', (e.clientY - rect.top) + 'px');
});

// 3D TILT: small cards lean toward the mouse, like a glass tile you push with a finger.
// How: we measure where the mouse is inside the card (-0.5 … +0.5 across and down) and turn
// that into two angles. rotateY leans left/right, rotateX leans up/down. "perspective" makes
// the far side look smaller, which is what makes it look 3D. Only for a real mouse.
const TILT_CARDS = '.tip, .stat, .complaint, .demo-card, .story-card, .inbox-row, .profile-card';
const MAX_TILT = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 4 : 10; // degrees
let tiltedCard = null;

function tiltReset(card) {
  card.classList.remove('is-tilting');
  card.style.transform = '';            // CSS eases it back to flat
}

document.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  const card = e.target.closest(TILT_CARDS);
  if (tiltedCard && tiltedCard !== card) { tiltReset(tiltedCard); tiltedCard = null; }
  if (!card) return;
  tiltedCard = card;
  const rect = card.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width - 0.5;    // -0.5 (left edge) … +0.5 (right edge)
  const y = (e.clientY - rect.top) / rect.height - 0.5;    // -0.5 (top) … +0.5 (bottom)
  const pressed = card.dataset.pressed === '1' ? 0.98 : 1.02;
  card.classList.add('is-tilting');
  card.style.transform =
    `perspective(900px) rotateX(${(-y * 2 * MAX_TILT).toFixed(2)}deg) rotateY(${(x * 2 * MAX_TILT).toFixed(2)}deg) scale(${pressed})`;
});
// mouse left the window: flatten whatever was tilted
document.addEventListener('mouseout', (e) => {
  if (!e.relatedTarget && tiltedCard) { tiltReset(tiltedCard); tiltedCard = null; }
});
// pressing a card pushes it in a little; letting go pops it back
document.addEventListener('pointerdown', (e) => {
  const card = e.target.closest(TILT_CARDS);
  if (card && e.pointerType === 'mouse') card.dataset.pressed = '1';
});
document.addEventListener('pointerup', () => {
  document.querySelectorAll('[data-pressed="1"]').forEach((c) => { delete c.dataset.pressed; });
});

// ---------- Magnetic buttons ----------
// When the mouse is over a button, the button slides a little toward it
// (25% of the distance from its centre, at most a few pixels) and springs back when you leave.
// It uses the separate "translate" property so it adds to the hover lift instead of replacing it.
const MAGNETIC = '.btn, .avatar-btn';
let magnetBtn = null;
document.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  const btn = e.target.closest(MAGNETIC);
  if (magnetBtn && magnetBtn !== btn) { magnetBtn.style.translate = ''; magnetBtn = null; }
  if (!btn) return;
  magnetBtn = btn;
  const r = btn.getBoundingClientRect();
  const limit = (v, max) => Math.max(-max, Math.min(max, v));   // never more than a few pixels
  const dx = limit((e.clientX - (r.left + r.width / 2)) * 0.25, 8);
  const dy = limit((e.clientY - (r.top + r.height / 2)) * 0.35, 5);
  btn.style.translate = `${dx.toFixed(1)}px ${dy.toFixed(1)}px`;
});

// ---------- Floating orbs ----------
// Four big, very blurred circles of colour that drift slowly behind the page content.
// They are pure decoration (CSS animation in style.css).
(function addOrbs() {
  const orbs = document.createElement('div');
  orbs.className = 'orbs';
  orbs.setAttribute('aria-hidden', 'true');
  orbs.innerHTML = '<span class="orb orb-1"></span><span class="orb orb-2"></span><span class="orb orb-3"></span><span class="orb orb-4"></span>';
  document.body.prepend(orbs);
})();

// The 3D forest: ONE fixed background behind the whole page, on every page. Because it
// stays still while the page scrolls over it, it looks like one continuous picture.
// If the browser cannot do 3D (no WebGL2), a plain green gradient background shows instead.
(function addForestBackdrop() {
  const box = document.createElement('div');
  box.className = 'page-forest';
  box.setAttribute('aria-hidden', 'true');
  document.body.prepend(box);
  if (!document.createElement('canvas').getContext('webgl2')) return;
  window.addEventListener('load', () => {                     // load it after the page itself
    const frame = document.createElement('iframe');
    frame.src = '/forest/forest.html';
    frame.title = 'Decorative 3D forest';
    frame.tabIndex = -1;
    frame.setAttribute('scrolling', 'no');
    frame.onload = () => box.classList.add('ready');
    box.appendChild(frame);
    // stop drawing while this browser tab is hidden, to save battery
    document.addEventListener('visibilitychange', () => {
      if (frame.contentWindow) frame.contentWindow.ctPaused = document.hidden;
    });
  });
})();

// SQLite stores time in UTC like "2026-11-24 10:30:00". Show it in local time.
function formatDate(sqlDate) {
  const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function badge(status) {
  return `<span class="badge ${status.replace(' ', '-')}">${escapeHtml(status)}</span>`;
}

// "Riya Sharma" -> "RS". Used in the round avatar.
function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

async function signOut() {
  await api('/api/logout', { method: 'POST' });
  location.href = '/';
}

// Builds the top bar: logo on the left; on the right either "Log in"
// or the account menu (round avatar button that opens a small menu).
async function renderTopbar() {
  const bar = document.getElementById('topbar');
  let user = null;
  try { user = (await api('/api/me')).user; } catch { /* not logged in */ }
  const dashLink = user ? (user.role === 'admin' ? '/admin.html' : '/resident.html') : null;
  const onDashboard = dashLink && location.pathname === dashLink;
  bar.innerHTML = `
    <div class="inner">
      <a class="brand" href="/"><span class="logo">♻</span> CleanTrack</a>
      <nav>
        ${user
          ? `${onDashboard ? '' : `<a class="btn ghost small" href="${dashLink}">My dashboard</a>`}
             <div class="account">
               <button class="avatar-btn" id="accountBtn" type="button"
                       aria-haspopup="menu" aria-expanded="false" aria-controls="accountMenu"
                       aria-label="Account menu for ${escapeHtml(user.name)}">${escapeHtml(initials(user.name))}</button>
               <div class="account-menu" id="accountMenu" role="menu" aria-labelledby="accountBtn" hidden>
                 <div class="menu-label" role="none">
                   <b>${escapeHtml(user.name)}</b>
                   <span>${escapeHtml(user.email)}</span>
                 </div>
                 <a role="menuitem" tabindex="-1" href="${dashLink}#profile">Profile</a>
                 <a role="menuitem" tabindex="-1" href="${dashLink}#settings">Settings</a>
                 <div role="separator" class="menu-sep"></div>
                 <button role="menuitem" tabindex="-1" type="button" id="signOutItem">Sign out</button>
               </div>
             </div>`
          : `<a class="btn small" href="/login.html">Log in</a>`}
      </nav>
    </div>`;
  if (user) setupAccountMenu();
  return user;
}

// The account menu: opens on click (never on hover), works with the keyboard
// (arrow keys move, Escape closes) and closes when you click anywhere else.
function setupAccountMenu() {
  const btn = document.getElementById('accountBtn');
  const menu = document.getElementById('accountMenu');
  const items = () => [...menu.querySelectorAll('[role="menuitem"]')];

  function open(focusFirst) {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    if (focusFirst) items()[0].focus();
  }
  function close(returnFocus) {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (returnFocus) btn.focus();
  }

  btn.addEventListener('click', () => (menu.hidden ? open(false) : close(false)));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) { e.preventDefault(); close(true); }
    else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(true); }
  });
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') { close(false); }
  });
  // a click on Profile / Settings closes the menu (the page then switches screen)
  menu.addEventListener('click', (e) => { if (e.target.closest('a[role="menuitem"]')) close(false); });
  document.getElementById('signOutItem').addEventListener('click', signOut);
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !e.target.closest('.account')) close(false);
  });
}

// ---------- Vertical timeline ----------
// An <ol> of events, oldest first. Each event: time on the left, a dot joined to the
// next dot by a line, and the title + detail on the right. The newest event shows a
// spinning "in progress" dot while the complaint is still open; finished ones are solid.
function sqlToIso(sqlDate) { return sqlDate.replace(' ', 'T') + 'Z'; }

function timeline(history, currentStatus) {
  const stillOpen = currentStatus === 'Submitted' || currentStatus === 'In Progress';
  return `<ol class="tl">${history.map((h, i) => {
    const isLast = i === history.length - 1;
    const loading = isLast && stillOpen;
    return `
      <li class="tl-item${loading ? ' is-loading' : ''}">
        <div class="tl-opposite"><time datetime="${sqlToIso(h.created_at)}">${formatDate(h.created_at)}</time></div>
        <div class="tl-separator" aria-hidden="true"><span class="tl-dot tl-${h.status.replace(' ', '-')}"></span><span class="tl-connector"></span></div>
        <div class="tl-content">
          <div class="tl-title">${escapeHtml(h.status)}${loading ? ' <span class="tl-now">current</span>' : ''}</div>
          <div class="tl-detail">${escapeHtml(h.note || '')}${h.by_name ? ` · by ${escapeHtml(h.by_name)}` : ''}</div>
        </div>
      </li>`;
  }).join('')}</ol>`;
}

// ---------- Bottom tab bar + screens ----------
// The dashboards have 4 "screens" (sections with data-view). The tab bar at the bottom
// is a <nav> of links like #inbox. When the # part of the address changes, we hide every
// screen and show the one asked for. No sliding or pushing: it just switches.
const TAB_ICONS = {
  report: '<path d="M12 5v14M5 12h14"/><circle cx="12" cy="12" r="10"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 3-5.5 6.5-5.5s6.5 1.9 6.5 5.5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18 15c2.2.7 3.5 2.4 3.5 5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
};

function renderTabBar(tabs) {
  const nav = document.createElement('nav');
  nav.className = 'tabbar';
  nav.setAttribute('aria-label', 'Main');
  nav.innerHTML = `<div class="tabbar-inner">${tabs.map((t) => `
    <a href="#${t.id}" data-tab="${t.id}">
      <span class="tab-icon">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TAB_ICONS[t.icon]}</svg>
        ${t.id === 'inbox' ? '<span class="tab-badge" id="inboxBadge" hidden></span>' : ''}
      </span>
      <span class="tab-label">${t.label}</span>
    </a>`).join('')}</div>`;
  document.body.appendChild(nav);
  document.body.classList.add('has-tabbar');
}

// Shows one screen. "#settings" is the Profile screen, scrolled to the settings card.
function setupScreens(defaultView, onShow) {
  function show() {
    let id = location.hash.slice(1) || defaultView;
    const focusSettings = id === 'settings';
    if (focusSettings) id = 'profile';
    if (!document.querySelector(`[data-view="${id}"]`)) id = defaultView;
    document.querySelectorAll('.modal-bg').forEach((m) => m.remove());   // close any open pop-up
    document.querySelectorAll('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== id; });
    document.querySelectorAll('.tabbar a').forEach((a) => {
      if (a.dataset.tab === id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
    onShow(id);
    if (focusSettings) document.getElementById('settings')?.scrollIntoView({ block: 'start' });
  }
  window.addEventListener('hashchange', show);
  show();
}

// Puts a number on the Inbox tab (hidden when it is 0).
function setInboxBadge(count) {
  const b = document.getElementById('inboxBadge');
  if (!b) return;
  b.hidden = count === 0;
  b.textContent = count > 99 ? '99+' : String(count);
  b.closest('a').setAttribute('aria-label', count ? `Inbox, ${count} new` : 'Inbox');
}

// ---------- Profile + Settings screen (same on both dashboards) ----------
async function renderProfile(user) {
  const { areas } = await api('/api/meta');
  const area = areas.find((a) => a.id === user.area_id);
  document.getElementById('profileBox').innerHTML = `
    <div class="card profile-card">
      <div class="avatar-big" aria-hidden="true">${escapeHtml(initials(user.name))}</div>
      <div>
        <h2 style="margin:0">${escapeHtml(user.name)}</h2>
        <div class="hint">${escapeHtml(user.email)}</div>
        <div class="hint" style="margin-top:6px">${user.is_owner ? 'Owner · highest access' : user.role === 'admin' ? 'Administrator · collection team' : 'Resident'}${area ? ' · ' + escapeHtml(area.name) : ''}</div>
      </div>
    </div>
    <form class="card" id="settings">
      <h2 style="margin-top:0">Settings</h2>
      <label for="setName">Display name</label>
      <input id="setName" maxlength="60" required value="${escapeHtml(user.name)}">
      <label for="setArea">Default area for new reports</label>
      <select id="setArea"><option value="">No default</option>
        ${areas.filter((a) => a.name !== 'Other').map((a) => `<option value="${a.id}" ${a.id === user.area_id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
      </select>
      <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" type="submit">Save settings</button>
        <button class="btn ghost" type="button" id="profileSignOut">Sign out</button>
      </div>
      <div id="settingsMsg"></div>
    </form>`;
  document.getElementById('profileSignOut').onclick = signOut;
  document.getElementById('settings').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { user: updated } = await api('/api/me', {
        method: 'PATCH',
        body: { name: document.getElementById('setName').value, area_id: document.getElementById('setArea').value },
      });
      Object.assign(user, updated);
      document.getElementById('settingsMsg').innerHTML = '<div class="msg ok">Saved.</div>';
      renderTopbar();   // the avatar initials may have changed
    } catch (err) {
      document.getElementById('settingsMsg').innerHTML = `<div class="msg error">${escapeHtml(err.message)}</div>`;
    }
  };
}

// Pages that need a certain role call this. Wrong role or not logged in -> go to login.
async function requireRole(role) {
  const user = await renderTopbar();
  if (!user || user.role !== role) { location.href = '/login.html'; return null; }
  return user;
}

// The coloured progress strip: Submitted -> In Progress -> Resolved
function tracker(status) {
  if (status === 'Rejected') return `<div class="tracker"><div class="done" style="background:var(--red)">Rejected</div></div>`;
  const steps = ['Submitted', 'In Progress', 'Resolved'];
  const reached = steps.indexOf(status);
  return `<div class="tracker">${steps.map((s, i) => `<div class="${i <= reached ? 'done' : ''}">${s}</div>`).join('')}</div>`;
}

// "Open in Google Maps", if the resident gave a link. The server already checked it; here we
// check again that it is a Google https address. noopener and noreferrer mean the new tab
// cannot reach back into our page or see its address.
function mapButton(link) {
  if (!/^https:\/\/(maps\.app\.goo\.gl|goo\.gl|(www\.|maps\.)?google\.(com|co\.in))\//.test(link || '')) return '';
  return `<p><a class="btn ghost small" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">🗺️ Open in Google Maps</a></p>`;
}

// Opens a pop-up with all the details and history of one complaint.
// "extraHtml" lets the admin page add its update form at the bottom.
async function openComplaint(id, extraHtml = '', afterOpen = () => {}) {
  const { complaint: c, history } = await api(`/api/complaints/${id}`);
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal card" role="dialog" aria-modal="true" aria-label="Complaint details">
      <button class="btn ghost small close" aria-label="Close">✕</button>
      <div class="hint">Complaint #${c.id} · ${escapeHtml(c.category_icon)} ${escapeHtml(c.category)}</div>
      <h2 style="margin:4px 0 6px">${escapeHtml(c.title)}</h2>
      ${badge(c.status)}
      ${tracker(c.status)}
      <p>${escapeHtml(c.description)}</p>
      <p class="hint">📍 ${escapeHtml(c.location)} — <b>${escapeHtml(c.area)}</b><br>
         👤 Reported by ${escapeHtml(c.reporter)} on ${formatDate(c.created_at)}<br>
         🚛 Team: ${c.team ? escapeHtml(c.team) : 'Not assigned yet'}</p>
      ${mapButton(c.map_link)}
      ${c.image_path ? `<img class="photo" src="${escapeHtml(c.image_path)}" alt="Photo of the issue">` : ''}
      <h3>History</h3>
      ${timeline(history, c.status)}
      ${extraHtml}
    </div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  bg.querySelector('.close').onclick = close;
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  document.body.appendChild(bg);
  afterOpen(bg, c, close);
}
