require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const http = require('http');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'tsp-dev-secret-change-in-production';
const PORT = process.env.PORT || 3000;
const OSRM_HOST = 'router.project-osrm.org';

const USERS = [
  { id: 1, username: 'admin', hash: bcrypt.hashSync('admin123', 10), role: 'admin' },
  { id: 2, username: 'guest', hash: bcrypt.hashSync('guest123', 10), role: 'guest' }
];

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function osrmGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: OSRM_HOST, path: urlPath }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid response from routing service'));
        }
      });
    });
    req.on('error', () => reject(new Error('Routing service unreachable')));
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error('Routing service timed out'));
    });
  });
}

// Login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = USERS.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password || '', user.hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// Verify token
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json(req.user);
});

// Duration/distance matrix via OSRM
app.post('/api/matrix', authMiddleware, async (req, res) => {
  const { locations } = req.body;
  if (!Array.isArray(locations) || locations.length < 2 || locations.length > 15) {
    return res.status(400).json({ error: 'Provide 2–15 locations' });
  }
  const coords = locations.map(l => `${l.lng},${l.lat}`).join(';');
  try {
    const data = await osrmGet(`/table/v1/driving/${coords}?annotations=duration,distance`);
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// Full route geometry via OSRM
app.post('/api/route', authMiddleware, async (req, res) => {
  const { locations } = req.body;
  if (!Array.isArray(locations) || locations.length < 2) {
    return res.status(400).json({ error: 'Provide at least 2 locations' });
  }
  const coords = locations.map(l => `${l.lng},${l.lat}`).join(';');
  try {
    const data = await osrmGet(`/route/v1/driving/${coords}?overview=full&geometries=geojson`);
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  TSP Route Optimizer: http://localhost:${PORT}`);
  console.log('  Credentials: admin/admin123  |  guest/guest123\n');
});
