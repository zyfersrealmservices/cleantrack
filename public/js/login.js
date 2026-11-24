// login.js — handles the Log in and Create account forms.

const message = document.getElementById('message');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');

function show(text, type = 'error') {
  message.innerHTML = `<div class="msg ${type}">${escapeHtml(text)}</div>`;
}

// After logging in, send residents and admins to their own dashboard.
function goToDashboard(user) {
  location.href = user.role === 'admin' ? '/admin.html' : '/resident.html';
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault(); // stop the page from reloading
  try {
    const { user } = await api('/api/login', {
      method: 'POST',
      body: { email: document.getElementById('email').value, password: document.getElementById('password').value },
    });
    goToDashboard(user);
  } catch (err) { show(err.message); }
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { user } = await api('/api/register', {
      method: 'POST',
      body: {
        name: document.getElementById('rName').value,
        email: document.getElementById('rEmail').value,
        password: document.getElementById('rPassword').value,
        area_id: document.getElementById('rArea').value,
      },
    });
    goToDashboard(user);
  } catch (err) { show(err.message); }
});

// Switch between the two forms.
document.getElementById('showRegister').onclick = (e) => {
  e.preventDefault(); loginForm.classList.add('hidden'); registerForm.classList.remove('hidden');
  document.getElementById('formTitle').textContent = 'Create a resident account'; message.innerHTML = '';
};
document.getElementById('showLogin').onclick = (e) => {
  e.preventDefault(); registerForm.classList.add('hidden'); loginForm.classList.remove('hidden');
  document.getElementById('formTitle').textContent = 'Log in'; message.innerHTML = '';
};

// Demo buttons fill in the login form for you.
document.querySelectorAll('[data-email]').forEach((btn) => {
  btn.onclick = () => {
    registerForm.classList.add('hidden'); loginForm.classList.remove('hidden');
    document.getElementById('email').value = btn.dataset.email;
    document.getElementById('password').value = btn.dataset.pass;
  };
});

// Fill the "Your area" dropdown from the server.
(async () => {
  renderTopbar();
  const { areas } = await api('/api/meta');
  document.getElementById('rArea').innerHTML = areas.filter((a) => a.name !== 'Other').map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
})();
