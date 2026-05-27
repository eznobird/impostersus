# Deploying to Render (free tier)

This guide walks you through getting your TSP Route Optimizer onto the public
internet in ~10 minutes using **Render.com**'s free tier.

The end result: a permanent URL like `https://tsp-route-optimizer.onrender.com`
that auto-redeploys every time you push to GitHub.

---

## Prerequisites

- Git installed (you already have Git Bash on Windows ✓)
- A free [GitHub](https://github.com) account
- A free [Render](https://render.com) account (sign up with GitHub for one-click)

---

## Step 1 — Push the code to GitHub

Open Git Bash (or any terminal) in this folder and run:

```bash
cd "/c/Users/ASUS/Desktop/vibecoding"

# Initialise repo
git init
git add .
git commit -m "Initial commit — TSP route optimizer"

# Create an empty repo on github.com first (no README, no .gitignore — we have them).
# Then copy the SSH or HTTPS URL it shows and run:
git branch -M main
git remote add origin https://github.com/<your-username>/tsp-route-optimizer.git
git push -u origin main
```

After this, your code lives on GitHub.

---

## Step 2 — Connect Render to your GitHub repo

1. Go to <https://dashboard.render.com>
2. Click **New +** → **Blueprint**
3. Pick the repo you just pushed
4. Render detects `render.yaml` and shows you a preview — **Apply**
5. First build takes ~2–3 minutes. Watch the logs in the Render dashboard.

When you see `Your service is live 🎉`, click the URL at the top of the
service page. That's your website.

---

## What `render.yaml` does for you

| Field | Value | Why |
|---|---|---|
| `runtime` | python | Tells Render to use Python (version from `runtime.txt`) |
| `buildCommand` | `pip install -r requirements.txt` | Installs Flask, gunicorn, eventlet, etc. |
| `startCommand` | `gunicorn --worker-class geventwebsocket.gunicorn.workers.GeventWebSocketWorker …` | Production WSGI server with WebSocket support |
| `PYTHON_VERSION` | 3.11.9 | Stable Python release |
| `SOCKETIO_ASYNC_MODE` | gevent | Switches Flask-SocketIO to its production mode |
| `JWT_SECRET` | auto-generated | Render injects a long random string — no hard-coded secret |
| `plan` | free | $0/month, sleeps after 15 min idle |

---

## Step 3 — Use your live site

Open the Render URL. You can log in as **admin / admin123** and start using it.

**Heads up — initial admin password:**
The admin password is hard-coded as `admin123` in `server.py`. **Change it
before sharing the URL.** Edit the line:

```python
{'id': 1, 'username': 'admin', 'hash': generate_password_hash('admin123'), 'role': 'admin'},
```

then `git commit && git push`. Render auto-redeploys in ~1 minute.

---

## Known caveats of the free tier

| | Free | Paid ($7/mo) |
|---|---|---|
| Always-on | ❌ Sleeps after 15 min idle (cold-start ~30 s) | ✅ Always on |
| RAM | 512 MB | 2 GB |
| Build minutes | 500/month | unlimited |
| Custom domain | ✅ Supported, free | ✅ Supported, free |
| Persistent disk | ❌ Files wiped on every deploy → `users.json` resets | ✅ Optional persistent disk |

**Practical impact for this app:**
- Guest accounts created via the admin panel are **lost on every redeploy**
  (because the free tier filesystem is ephemeral). For a permanent user
  database, attach Render Postgres or upgrade to the paid plan with a disk.
- Cold-start: if nobody's used the site for 15 min, the next visitor waits
  ~30 s for it to wake up.

---

## Custom domain (optional, free)

Once your service is live:

1. Render dashboard → your service → **Settings** → **Custom Domain**
2. Add `tsp.yourdomain.com` (any domain you own)
3. Render gives you a DNS record (`CNAME` → `tsp-route-optimizer.onrender.com`)
4. Add that to your DNS provider — done in a few minutes, HTTPS auto-issued

---

## Routing dependency disclaimer

This app uses the free, public **OSRM demo server**
(`router.project-osrm.org`) for road-network routing. That server:

- Has no uptime SLA — occasional 503s during heavy global usage
- Rate-limits aggressive clients

For real production traffic you'd swap it for:

- A self-hosted OSRM instance (free, ~1 GB RAM per region)
- Or a paid traffic-aware API (Mapbox, Google Maps, HERE)

The swap is a single-file change — replace `OSRM_BASE` in `server.py`.

---

## Local development is unchanged

Running `python server.py` on your laptop still works exactly as before. The
production tweaks (eventlet, gunicorn) are only activated by env vars Render
sets — locally those env vars are unset, so it falls back to Werkzeug +
threading mode just like during development.
