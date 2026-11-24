// resident.js — the resident dashboard: submit a report and see your own reports.

const formMsg = document.getElementById('formMsg');

// Turns the chosen photo file into text ("data URL") so we can send it as JSON.
function readPhoto(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    if (file.size > 2 * 1024 * 1024) return reject(new Error('Photo must be smaller than 2 MB'));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the photo'));
    reader.readAsDataURL(file);
  });
}

// Shows the list of this resident's complaints as cards.
async function loadMyReports() {
  const { complaints } = await api('/api/complaints');
  const list = document.getElementById('myList');
  if (!complaints.length) {
    list.innerHTML = '<div class="card hint">You have not reported anything yet. Use the form to report your first problem.</div>';
    return;
  }
  list.innerHTML = complaints.map((c) => `
    <article class="card complaint" data-id="${c.id}" tabindex="0">
      <div class="icon">${escapeHtml(c.category_icon)}</div>
      <div>
        <h3>${escapeHtml(c.title)}</h3>
        <div class="meta">#${c.id} · ${escapeHtml(c.category)} · ${escapeHtml(c.area)} · ${formatDate(c.created_at)}</div>
        <div class="meta">🚛 ${c.team ? escapeHtml(c.team) : 'Waiting for a team'}</div>
      </div>
      ${badge(c.status)}
    </article>`).join('');
  // Clicking a card (or pressing Enter on it) opens the details pop-up.
  list.querySelectorAll('.complaint').forEach((el) => {
    el.onclick = () => openComplaint(el.dataset.id);
    el.onkeydown = (e) => { if (e.key === 'Enter') openComplaint(el.dataset.id); };
  });
}

// ---------- "Other" in the Category and Area dropdowns ----------
// Choosing "Other" shows a text box underneath, and the box must then be filled in.
const CUSTOM_FIELDS = [
  { select: 'category', box: 'customCategoryBox', input: 'customCategory' },
  { select: 'area', box: 'customAreaBox', input: 'customArea' },
];

function showCustomBoxes() {
  CUSTOM_FIELDS.forEach((f) => {
    const option = document.getElementById(f.select).selectedOptions[0];
    const isOther = !!option && option.dataset.other === '1';
    document.getElementById(f.box).hidden = !isOther;
    document.getElementById(f.input).required = isOther;
    if (!isOther) document.getElementById(f.input).value = '';
  });
}

CUSTOM_FIELDS.forEach((f) => {
  document.getElementById(f.select).addEventListener('change', () => {
    showCustomBoxes();
    if (!document.getElementById(f.box).hidden) document.getElementById(f.input).focus();
  });
});

document.getElementById('reportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  formMsg.innerHTML = '';
  try {
    const image = await readPhoto(document.getElementById('photo').files[0]);
    const { id } = await api('/api/complaints', {
      method: 'POST',
      body: {
        title: document.getElementById('title').value,
        category_id: document.getElementById('category').value,
        area_id: document.getElementById('area').value,
        custom_category: document.getElementById('customCategory').value,
        custom_area: document.getElementById('customArea').value,
        location: document.getElementById('location').value,
        map_link: document.getElementById('mapLink').value,
        description: document.getElementById('description').value,
        image,
      },
    });
    e.target.reset();
    showCustomBoxes();   // the dropdowns are back to normal, so hide the text boxes again
    formMsg.innerHTML = `<div class="msg ok">Thank you! Your report #${id} was submitted. Track it in <a href="#reports">My reports</a>.</div>`;
    loadMyReports();
  } catch (err) {
    formMsg.innerHTML = `<div class="msg error">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Inbox ----------
// "Seen" is remembered in the browser (localStorage), so the badge shows only updates
// that arrived since you last opened the Inbox.
let me = null;
const seenKey = () => `ct_inbox_seen_${me.id}`;

async function loadInbox(markSeen) {
  const { items } = await api('/api/inbox');
  const seen = localStorage.getItem(seenKey()) || '';
  const isNew = (it) => it.created_at > seen;   // dates are "YYYY-MM-DD HH:MM:SS", so text order = time order
  setInboxBadge(items.filter(isNew).length);

  if (markSeen) {
    document.getElementById('inboxList').innerHTML = items.length
      ? items.map((it) => `
          <button type="button" class="card inbox-row${isNew(it) ? ' is-new' : ''}" data-id="${it.complaint_id}">
            ${badge(it.status)}
            <span class="inbox-text"><b>${escapeHtml(it.title)}</b><span>${escapeHtml(it.note || '')} · by ${escapeHtml(it.by_name)}</span></span>
            <time datetime="${sqlToIso(it.created_at)}">${formatDate(it.created_at)}</time>
          </button>`).join('')
      : '<div class="card hint">No updates yet. When the collection team changes one of your reports, it shows up here.</div>';
    document.querySelectorAll('.inbox-row').forEach((row) => { row.onclick = () => openComplaint(row.dataset.id); });
    if (items[0]) localStorage.setItem(seenKey(), items[0].created_at);   // newest one is now "seen"
    setInboxBadge(0);
  }
}

// Start: check login, build the tab bar, fill dropdowns, then show the right screen.
(async () => {
  me = await requireRole('resident');
  if (!me) return;
  renderTabBar([
    { id: 'report', label: 'Report', icon: 'report' },
    { id: 'reports', label: 'My reports', icon: 'list' },
    { id: 'inbox', label: 'Inbox', icon: 'inbox' },
    { id: 'profile', label: 'Profile', icon: 'user' },
  ]);
  const { categories, areas } = await api('/api/meta');
  document.getElementById('category').innerHTML = categories
    .map((c) => `<option value="${c.id}" ${c.name === 'Other' ? 'data-other="1"' : ''}>${escapeHtml(c.icon)} ${c.name === 'Other' ? 'Other (type my own)' : escapeHtml(c.name)}</option>`).join('');
  document.getElementById('area').innerHTML = areas
    .map((a) => `<option value="${a.id}" ${a.name === 'Other' ? 'data-other="1"' : ''} ${a.id === me.area_id ? 'selected' : ''}>${a.name === 'Other' ? 'Other (type my own)' : escapeHtml(a.name)}</option>`).join('');
  showCustomBoxes();

  setupScreens('report', (screen) => {
    if (screen === 'reports') loadMyReports();
    if (screen === 'inbox') loadInbox(true);
    if (screen === 'profile') renderProfile(me);
  });
  if (location.hash !== '#inbox') loadInbox(false);   // just update the badge number
})();
