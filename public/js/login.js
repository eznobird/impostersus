// Redirect if already logged in
if (localStorage.getItem('token')) {
  location.href = '/app.html';
}

function fillDemo(username, password) {
  document.getElementById('username').value = username;
  document.getElementById('password').value = password;
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errorEl  = document.getElementById('loginError');
  const btnText  = document.getElementById('loginBtnText');
  const spinner  = document.getElementById('loginSpinner');
  const btn      = document.getElementById('loginBtn');

  errorEl.classList.add('hidden');
  btn.disabled = true;
  btnText.textContent = 'Signing in…';
  spinner.classList.remove('hidden');

  try {
    const res  = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Login failed');
    }

    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    location.href = '/app.html';

  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
    btn.disabled = false;
    btnText.textContent = 'Sign In';
    spinner.classList.add('hidden');
  }
});
