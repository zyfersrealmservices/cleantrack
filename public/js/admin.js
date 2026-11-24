// admin.js — the admin dashboard: see all complaints, filter them,
// change status and assign a collection team.

let meta = null; // areas, categories, teams, statuses (loaded once)

async function loadStats() {
  const s = await api('/api/stats');
  const cards = [
    ['Total reports', s.total, ''],
    ['New (Submitted)', s.byStatus['Submitted'], 'var(--blue)'],
    ['In progress', s.byStatus['In Progress'], 'var(--amber)'],
    ['Resolved', s.byStatus['Resolved'], 'var(--green)'],
  ];
  document.getElementById('stats').innerHTML = cards.map(([label, n, color]) => `
    <div class="card stat"><div class="num" style="color:${color}">${n}</div><div class="label">${label}</div></div>`).join('');
  document.getElementById('areaTable').innerHTML = s.byArea.map((a) =>
    `<tr><td>${escapeHtml(a.area)}</td><td>${a.total}</td><td>${a.open}</td><td>${a.resolved}</td></tr>`).join('');
}

// Builds the URL with the chosen filters, e.g. /api/complaints?status=Submitted&area_id=2
async function loadTable() {
  const params = new URLSearchParams();
  const pairs = [['status', 'fStatus'], ['area_id', 'fArea'], ['category_id', 'fCategory'], ['q', 'fSearch']];
  pairs.forEach(([key, id]) => { const v = document.getElementById(id).value.trim(); if (v) params.set(key, v); });

  const { complaints } = await api('/api/complaints?' + params);
  document.getElementById('table').innerHTML = complaints.map((c) => `
    <tr class="clickable" data-id="${c.id}" tabindex="0">
      <td>${c.id}</td>
      <td>${escapeHtml(c.category_icon)} <b>${escapeHtml(c.title)}</b><br><span class="hint">${escapeHtml(c.location)}</span></td>
      <td>${escapeHtml(c.area)}</td>
      <td>${escapeHtml(c.reporter)}</td>
      <td>${c.team ? escapeHtml(c.team) : '<span class="hint">—</span>'}</td>
      <td>${badge(c.status)}</td>
      <td class="hint">${formatDate(c.created_at)}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="hint">No complaints match these filters.</td></tr>';
  document.getElementById('count').textContent = `${complaints.length} complaint(s) shown. Click a row to manage it.`;

  document.querySelectorAll('tr.clickable').forEach((row) => {
    row.onclick = () => openManage(row.dataset.id);
    row.onkeydown = (e) => { if (e.key === 'Enter') openManage(row.dataset.id); };
  });
}

// Opens the details pop-up and adds an "Update" form at the bottom.
function openManage(id) {
  const form = `
    <form id="updateForm" style="border-top:1px solid var(--line);margin-top:12px;padding-top:12px">
      <h3 style="margin:0">Update this complaint</h3>
      <div class="row">
        <div><label for="uStatus">Status</label><select id="uStatus">
          ${meta.statuses.map((s) => `<option>${s}</option>`).join('')}</select></div>
        <div><label for="uTeam">Assign team</label><select id="uTeam"><option value="">Not assigned</option>
          ${meta.teams.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}</select></div>
      </div>
      <label for="uNote">Note for the resident (optional)</label>
      <input id="uNote" maxlength="300" placeholder="e.g. Team will visit tomorrow morning">
      <div style="margin-top:12px"><button class="btn" type="submit">Save update</button></div>
      <div id="uMsg"></div>
    </form>`;

  openComplaint(id, form, (modal, c, close) => {
    // Pre-select the current values.
    modal.querySelector('#uStatus').value = c.status;
    modal.querySelector('#uTeam').value = c.team_id || '';
    modal.querySelector('#updateForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const result = await api(`/api/complaints/${id}`, {
          method: 'PATCH',
          body: {
            status: modal.querySelector('#uStatus').value,
            team_id: modal.querySelector('#uTeam').value,
            note: modal.querySelector('#uNote').value,
          },
        });
        modal.querySelector('#uMsg').innerHTML = `<div class="msg ok">Saved. <span class="sim-label">SIMULATED</span> ${escapeHtml(result.simulatedNotification)}</div>`;
        loadTable();
        loadStats();
        loadInbox(location.hash === '#inbox');
        setTimeout(() => { close(); openManage(id); }, 1200); // reopen to show the new history
      } catch (err) {
        modal.querySelector('#uMsg').innerHTML = `<div class="msg error">${escapeHtml(err.message)}</div>`;
      }
    };
  });
}

// Inbox = complaints still "Submitted". The badge shows how many are waiting.
async function loadInbox(render) {
  const { items } = await api('/api/inbox');
  setInboxBadge(items.length);
  if (!render) return;
  document.getElementById('inboxList').innerHTML = items.length
    ? items.map((c) => `
        <button type="button" class="card inbox-row is-new" data-id="${c.id}">
          <span class="inbox-icon" aria-hidden="true">${escapeHtml(c.category_icon)}</span>
          <span class="inbox-text"><b>${escapeHtml(c.title)}</b><span>${escapeHtml(c.area)} · reported by ${escapeHtml(c.reporter)}</span></span>
          <time datetime="${sqlToIso(c.created_at)}">${formatDate(c.created_at)}</time>
        </button>`).join('')
    : '<div class="card hint">All caught up. No new reports are waiting for review.</div>';
  document.querySelectorAll('.inbox-row').forEach((row) => { row.onclick = () => openManage(row.dataset.id); });
}

// ---------- Accounts (owner only) ----------
async function loadUsers() {
  const { users } = await api('/api/users');
  const roleName = (u) => (u.is_owner ? 'owner' : u.role);
  document.getElementById('usersTable').innerHTML = users.map((u) => `
    <tr>
      <td><b>${escapeHtml(u.name)}</b>${u.demo ? ' <span class="sim-label">DEMO</span>' : ''}<br><span class="hint">${escapeHtml(u.email)}</span></td>
      <td><span class="badge role-${roleName(u)}">${roleName(u)}</span></td>
      <td>${u.reports}</td>
      <td>${u.suspended ? '<span class="badge off">suspended</span>' : u.locked ? '<span class="badge off">no password yet</span>' : '<span class="hint">active</span>'}</td>
      <td>${u.is_owner ? '<span class="hint">you</span>' : `<div class="user-actions">
        ${u.demo ? '' : `<button type="button" class="btn ghost small" data-user="${u.id}" data-change="${u.role === 'admin' ? 'resident' : 'admin'}">${u.role === 'admin' ? 'Make resident' : 'Make admin'}</button>`}
        <button type="button" class="btn ghost small" data-user="${u.id}" data-change="${u.suspended ? 'restore' : 'suspend'}">${u.suspended ? 'Restore' : 'Suspend'}</button></div>`}</td>
    </tr>`).join('');

  document.querySelectorAll('[data-user]').forEach((btn) => {
    btn.onclick = async () => {
      const u = users.find((x) => x.id === Number(btn.dataset.user));
      const change = btn.dataset.change;
      const body = change === 'suspend' || change === 'restore' ? { suspended: change === 'suspend' } : { role: change };
      const question = { admin: 'Let this person see and change ALL reports?', resident: 'Remove admin rights?', suspend: 'Stop this person from logging in?', restore: 'Let this person log in again?' }[change];
      if (!confirm(`${u.name} (${u.email})\n\n${question}`)) return;
      const msg = document.getElementById('usersMsg');
      try {
        await api(`/api/users/${u.id}`, { method: 'PATCH', body });
        msg.innerHTML = '<div class="msg ok">Saved.</div>';
        loadUsers();
      } catch (err) { msg.innerHTML = `<div class="msg error">${escapeHtml(err.message)}</div>`; }
    };
  });
}

// Start: check the user is an admin, build the tab bar, fill filter dropdowns, load everything.
(async () => {
  const user = await requireRole('admin');
  if (!user) return;
  if (!user.is_owner) document.querySelector('[data-view="users"]').remove();
  renderTabBar([
    { id: 'overview', label: 'Overview', icon: 'grid' },
    { id: 'complaints', label: 'Complaints', icon: 'list' },
    { id: 'inbox', label: 'Inbox', icon: 'inbox' },
    ...(user.is_owner ? [{ id: 'users', label: 'Accounts', icon: 'users' }] : []),
    { id: 'profile', label: 'Profile', icon: 'user' },
  ]);
  meta = await api('/api/meta');
  const addOptions = (id, items, label = (x) => x.name, value = (x) => x.id) => {
    document.getElementById(id).insertAdjacentHTML('beforeend',
      items.map((x) => `<option value="${escapeHtml(value(x))}">${escapeHtml(label(x))}</option>`).join(''));
  };
  addOptions('fStatus', meta.statuses, (s) => s, (s) => s);
  addOptions('fArea', meta.areas);
  addOptions('fCategory', meta.categories, (c) => `${c.icon} ${c.name}`);

  ['fStatus', 'fArea', 'fCategory'].forEach((id) => { document.getElementById(id).onchange = loadTable; });
  let timer;
  document.getElementById('fSearch').oninput = () => { clearTimeout(timer); timer = setTimeout(loadTable, 300); };

  loadStats();
  loadTable();
  setupScreens('overview', (screen) => {
    if (screen === 'overview') loadStats();
    if (screen === 'complaints') loadTable();
    if (screen === 'inbox') loadInbox(true);
    if (screen === 'users') loadUsers();
    if (screen === 'profile') renderProfile(user);
  });
  loadInbox(false);   // badge number
})();
