/* ════════════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════════════ */
const state = {
  markerMap:    {},   // id → L.Marker
  routeLayer:   null,
  addMode:      false,
  trafficMult:  1.0,
  trafficLabel: 'Free Flow',
  algorithm:    'optimal',   // 'optimal' (Held-Karp) | 'heuristic' (NN + 2-opt)
  token:        localStorage.getItem('token'),
  user:         JSON.parse(localStorage.getItem('user') || 'null')
};

// Server-synced waypoint list (source of truth lives on the server)
let serverWaypoints = [];   // [{ id, lat, lng, name, owner, ownerRole }]
let socket;
let map;

/* Chanthaburi, Thailand */
const DEFAULT_CENTER = [12.6113, 102.1036];
const DEFAULT_ZOOM   = 13;

/* ════════════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  if (!state.token || !state.user) {
    location.href = '/login.html';
    return;
  }
  setupNavbar();
  initMap();
  setupSidebar();
  setupKeyboard();
  initSocket();
});

function setupNavbar() {
  const { username, role } = state.user;
  document.getElementById('userBadge').innerHTML = `
    <span class="role-badge ${role === 'admin' ? 'role-admin' : 'role-guest'}">
      ${role.toUpperCase()}
    </span>
    ${username}
  `;
  if (role === 'admin') {
    document.getElementById('clearAllBtn').classList.remove('hidden');
    setupAdminPanel();
  }
  document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    if (socket) socket.disconnect();
    location.href = '/login.html';
  });
}

/* ════════════════════════════════════════════════════════════════
   ADMIN PANEL  —  create/list/delete guest accounts
════════════════════════════════════════════════════════════════ */
function setupAdminPanel() {
  document.getElementById('adminPanel').classList.remove('hidden');
  document.getElementById('createUserBtn').addEventListener('click', openUserModal);
  document.getElementById('createUserForm').addEventListener('submit', handleCreateUser);

  // Close modal on backdrop click + Esc
  document.getElementById('userModal').addEventListener('click', e => {
    if (e.target.id === 'userModal') closeUserModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape'
        && !document.getElementById('userModal').classList.contains('hidden')) {
      closeUserModal();
    }
  });

  loadGuestUsers();
}

async function loadGuestUsers() {
  try {
    const { users } = await apiCall('GET', '/api/admin/users');
    renderUserList(users);
  } catch (e) {
    console.error('Could not load users:', e);
  }
}

function renderUserList(users) {
  document.getElementById('userCount').textContent = users.length;
  const list = document.getElementById('userList');
  if (users.length === 0) {
    list.innerHTML = '<p class="empty-hint">No guest accounts yet — click <strong>+ New</strong> to create one.</p>';
    return;
  }
  list.innerHTML = users.map(u => `
    <div class="user-item">
      <span class="user-icon">👤</span>
      <span class="user-name">${escapeHtml(u.username)}</span>
      <button class="user-delete" onclick="deleteUser('${escapeAttr(u.username)}')"
              title="Delete this guest account">✕</button>
    </div>
  `).join('');
}

async function deleteUser(username) {
  if (!confirm(`Delete guest account "${username}"?\n\nThe user will be disconnected immediately and won't be able to log in again.`)) return;
  try {
    await apiCall('DELETE', `/api/admin/users/${encodeURIComponent(username)}`);
    loadGuestUsers();
    showToast(`✓ Deleted guest "${username}"`);
  } catch (e) {
    showToast('✗ ' + e.message);
  }
}
window.deleteUser = deleteUser;

function openUserModal() {
  document.getElementById('newUsername').value = '';
  document.getElementById('newPassword').value = '';
  document.getElementById('userModalError').classList.add('hidden');
  document.getElementById('userModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('newUsername').focus(), 60);
}
function closeUserModal() {
  document.getElementById('userModal').classList.add('hidden');
}
window.closeUserModal = closeUserModal;

async function handleCreateUser(e) {
  e.preventDefault();
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  const errorEl  = document.getElementById('userModalError');
  errorEl.classList.add('hidden');

  try {
    await apiCall('POST', '/api/admin/users', { username, password });
    closeUserModal();
    loadGuestUsers();
    showToast(`✓ Created guest "${username}" — share login: ${username} / ${password}`, 6000);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}
function escapeAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }

function initMap() {
  map = L.map('map').setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);
  map.on('click', onMapClick);
}

function setupSidebar() {
  document.getElementById('addModeBtn').addEventListener('click', toggleAddMode);
  document.getElementById('clearAllBtn').addEventListener('click', clearAll);
  document.getElementById('optimizeBtn').addEventListener('click', optimize);
  document.getElementById('clearRouteBtn').addEventListener('click', clearRoute);

  document.querySelectorAll('.traffic-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.traffic-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.trafficMult = parseFloat(btn.dataset.mult);
      const labels = {
        '1.0': ['Free Flow',       'No delays expected — best-case travel times'],
        '1.3': ['Light Traffic',   'Minor slowdowns — ~30% longer than free flow'],
        '1.7': ['Moderate Traffic','Noticeable congestion — ~70% longer travel time'],
        '2.5': ['Heavy Traffic',   'Severe congestion — routes take 2.5× longer']
      };
      const [label, desc] = labels[btn.dataset.mult];
      state.trafficLabel = label;
      document.getElementById('trafficDesc').textContent = desc;
    });
  });

  // Algorithm picker
  document.querySelectorAll('.algo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.algo-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.algorithm = btn.dataset.algo;
      const descs = {
        'optimal':   'Finds the shortest possible loop — slower for many stops.',
        'heuristic': 'Fast greedy search — usually within a few percent of the best loop.'
      };
      document.getElementById('algoDesc').textContent = descs[state.algorithm];
    });
  });
}

function setupKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.addMode) toggleAddMode();
  });
}

/* ════════════════════════════════════════════════════════════════
   SOCKET.IO  —  real-time sync
════════════════════════════════════════════════════════════════ */
function initSocket() {
  socket = io({ auth: { token: state.token } });

  socket.on('connect',    () => updateSync(true));
  socket.on('disconnect', () => updateSync(false));
  socket.on('connect_error', err => {
    console.error('Socket connect error:', err.message);
    updateSync(false);
  });

  socket.on('presence', ({ count }) => {
    const el = document.getElementById('presenceCount');
    el.textContent = `${count} online`;
  });

  socket.on('init', ({ waypoints }) => {
    // Wipe everything
    Object.values(state.markerMap).forEach(m => map.removeLayer(m));
    state.markerMap = {};
    serverWaypoints = [];
    clearRouteLocal();

    // Load fresh state
    waypoints.forEach(addWaypointLocal);
    updateWaypointList();
  });

  socket.on('waypoint_added', wp => {
    if (state.markerMap[wp.id]) return;   // dedupe
    addWaypointLocal(wp);
    updateWaypointList();
    clearRouteLocal();
  });

  socket.on('waypoint_removed', ({ id }) => {
    removeWaypointLocal(id);
    updateWaypointList();
    clearRouteLocal();
  });

  socket.on('waypoint_moved', ({ id, lat, lng }) => {
    const wp = serverWaypoints.find(w => w.id === id);
    if (!wp) return;
    wp.lat = lat; wp.lng = lng;
    const marker = state.markerMap[id];
    if (marker) marker.setLatLng([lat, lng]);
    updateWaypointList();
    clearRouteLocal();
  });

  socket.on('all_cleared', () => {
    Object.values(state.markerMap).forEach(m => map.removeLayer(m));
    state.markerMap = {};
    serverWaypoints = [];
    clearRouteLocal();
    updateWaypointList();
  });

  socket.on('action_denied', ({ reason }) => {
    showToast(reason || 'Action not allowed');
  });
}

function updateSync(connected) {
  const dot  = document.getElementById('syncDot');
  const text = document.getElementById('syncText');
  if (connected) {
    dot.className = 'sync-dot connected';
    text.textContent = 'Live';
  } else {
    dot.className = 'sync-dot disconnected';
    text.textContent = 'Reconnecting…';
  }
}

/* ════════════════════════════════════════════════════════════════
   ADD MODE
════════════════════════════════════════════════════════════════ */
function toggleAddMode() {
  state.addMode = !state.addMode;
  const btn    = document.getElementById('addModeBtn');
  const banner = document.getElementById('addBanner');
  const mapEl  = document.getElementById('map');
  if (state.addMode) {
    btn.textContent = '✕ Cancel';
    btn.classList.replace('btn-outline', 'btn-danger');
    banner.classList.remove('hidden');
    mapEl.classList.add('add-mode');
  } else {
    btn.textContent = '+ Add';
    btn.classList.replace('btn-danger', 'btn-outline');
    banner.classList.add('hidden');
    mapEl.classList.remove('add-mode');
  }
}

/* ════════════════════════════════════════════════════════════════
   WAYPOINT FLOW  —  emit to server, listen for echo
════════════════════════════════════════════════════════════════ */
async function onMapClick(e) {
  if (!state.addMode) return;
  const { lat, lng } = e.latlng;
  const id   = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const name = await reverseGeocode(lat, lng);
  socket.emit('add_waypoint', { id, lat, lng, name });
}

function deleteWaypoint(id) {
  socket.emit('remove_waypoint', { id });
}
window.deleteWaypoint = deleteWaypoint;   // accessible from inline onclick

function clearAll() {
  if (state.user.role !== 'admin') return;
  if (!confirm('Remove ALL waypoints (everyone\'s pins)?')) return;
  socket.emit('clear_all');
}

/* Local-only helpers used by socket handlers */
function addWaypointLocal(wp) {
  serverWaypoints.push(wp);
  const marker = createMarker(wp, serverWaypoints.length);
  state.markerMap[wp.id] = marker;
}

function removeWaypointLocal(id) {
  serverWaypoints = serverWaypoints.filter(w => w.id !== id);
  if (state.markerMap[id]) {
    map.removeLayer(state.markerMap[id]);
    delete state.markerMap[id];
  }
  rebuildMarkerNumbers();
}

function clearRouteLocal() {
  if (state.routeLayer) {
    map.removeLayer(state.routeLayer);
    state.routeLayer = null;
  }
  document.getElementById('resultsSection').classList.add('hidden');
}

function clearRoute() { clearRouteLocal(); }   // public alias

function rebuildMarkerNumbers() {
  serverWaypoints.forEach((wp, idx) => {
    const m = state.markerMap[wp.id];
    if (m) m.setIcon(makeIcon(idx + 1, wp.ownerRole));
  });
}

/* ════════════════════════════════════════════════════════════════
   PERMISSIONS
════════════════════════════════════════════════════════════════ */
function canRemove(wp) {
  const { role, username } = state.user;
  if (role === 'admin') return true;
  if (wp.ownerRole === 'admin') return false;
  return wp.owner === username;
}

function canMove(wp) {
  const { role, username } = state.user;
  if (role === 'admin') return true;
  return wp.owner === username;
}

/* ════════════════════════════════════════════════════════════════
   WAYPOINT LIST UI
════════════════════════════════════════════════════════════════ */
function updateWaypointList() {
  const list  = document.getElementById('waypointList');
  const count = serverWaypoints.length;
  document.getElementById('wpCount').textContent = count;

  if (count === 0) {
    list.innerHTML = '<p class="empty-hint">Click "+ Add" then tap the map</p>';
    return;
  }

  list.innerHTML = serverWaypoints.map((wp, i) => {
    const isAdmin   = wp.ownerRole === 'admin';
    const canDel    = canRemove(wp);
    const deleteBtn = canDel
      ? `<button class="wp-delete" onclick="deleteWaypoint('${wp.id}')" title="Remove">✕</button>`
      : `<span class="wp-locked" title="Admin pin — guests can't remove">🔒</span>`;

    return `
      <div class="waypoint-item${isAdmin ? ' admin-owned' : ''}">
        <div class="wp-number${isAdmin ? ' admin-num' : ''}">
          ${isAdmin ? '★' : i + 1}
        </div>
        <div class="wp-info">
          <div class="wp-name" title="${wp.name}">${wp.name}</div>
          <div class="wp-meta">
            <span class="wp-owner ${isAdmin ? 'admin-owner' : 'guest-owner'}">
              ${isAdmin ? '👑 ' : ''}${wp.owner}
            </span>
          </div>
        </div>
        ${deleteBtn}
      </div>
    `;
  }).join('');
}

/* ════════════════════════════════════════════════════════════════
   MARKERS  —  admin pins are SPECIAL
════════════════════════════════════════════════════════════════ */
function makeIcon(number, ownerRole) {
  const isAdmin = ownerRole === 'admin';
  const html = isAdmin
    ? `<div class="map-marker admin-pin">
         <span class="pin-crown">★</span>
         <span class="pin-num">${number}</span>
       </div>`
    : `<div class="map-marker">${number}</div>`;
  return L.divIcon({
    html,
    className: '',
    iconSize:   isAdmin ? [42, 42] : [32, 32],
    iconAnchor: isAdmin ? [21, 21] : [16, 16],
    popupAnchor:[0, -22]
  });
}

function createMarker(wp, number) {
  const marker = L.marker([wp.lat, wp.lng], {
    icon:      makeIcon(number, wp.ownerRole),
    draggable: canMove(wp)
  });

  marker.on('dragend', e => {
    const { lat, lng } = e.target.getLatLng();
    socket.emit('move_waypoint', { id: wp.id, lat, lng });
  });

  const ownerLabel = wp.ownerRole === 'admin'
    ? `<span style="color:#b45309">👑 ${wp.owner} (ADMIN)</span>`
    : `${wp.owner}`;
  marker.bindTooltip(`<strong>${wp.name}</strong><br><small>by ${ownerLabel}</small>`,
                     { direction: 'top' });
  marker.addTo(map);
  return marker;
}

/* ════════════════════════════════════════════════════════════════
   TSP ALGORITHM
   • Held-Karp dynamic programming   →  PROVABLY OPTIMAL tour
                                        O(n²·2ⁿ) time, O(n·2ⁿ) space
                                        Fast for n ≤ 15 (~7M ops).
   • Nearest-neighbour + 2-opt       →  heuristic kept as a fallback
                                        and as a comparison baseline.
════════════════════════════════════════════════════════════════ */
function routeCost(route, matrix) {
  let cost = 0;
  const n = route.length;
  for (let i = 0; i < n; i++) cost += matrix[route[i]][route[(i + 1) % n]];
  return cost;
}

function nearestNeighbor(matrix, start) {
  const n       = matrix.length;
  const visited = new Set([start]);
  const route   = [start];
  while (route.length < n) {
    const last = route[route.length - 1];
    let best = -1, bestDist = Infinity;
    for (let j = 0; j < n; j++) {
      if (!visited.has(j) && matrix[last][j] < bestDist) { bestDist = matrix[last][j]; best = j; }
    }
    if (best === -1) break;
    visited.add(best);
    route.push(best);
  }
  return route;
}

function twoOpt(route, matrix) {
  const n = route.length;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const a = route[i],       b = route[i + 1];
        const c = route[j],       d = route[(j + 1) % n];
        const delta = (matrix[a][c] + matrix[b][d]) - (matrix[a][b] + matrix[c][d]);
        if (delta < -1e-10) {
          let l = i + 1, r = j;
          while (l < r) { [route[l], route[r]] = [route[r], route[l]]; l++; r--; }
          improved = true;
        }
      }
    }
  }
  return route;
}

// Heuristic baseline — used for comparison vs the optimum
function heuristicTSP(matrix) {
  const n = matrix.length;
  let bestRoute = null, bestCost = Infinity;
  for (let start = 0; start < n; start++) {
    const r = nearestNeighbor(matrix, start);
    if (r.length !== n) continue;
    twoOpt(r, matrix);
    const c = routeCost(r, matrix);
    if (c < bestCost) { bestCost = c; bestRoute = [...r]; }
  }
  return { route: bestRoute, cost: bestCost };
}

/**
 * Held-Karp dynamic programming.
 *
 *   dp[mask][i]  = shortest path that starts at city 0, visits exactly the
 *                  set of cities encoded by `mask`, and ends at city `i`.
 *   parent[mask][i] = which city precedes `i` on that best path.
 *
 * Base   : dp[{0}][0] = 0
 * Step   : dp[mask ∪ {j}][j] = min over i ∈ mask of (dp[mask][i] + d(i,j))
 * Result : min over i of (dp[FULL][i] + d(i,0))   — close the tour
 *
 * Returns the provably-optimal Hamiltonian cycle starting and ending at 0.
 */
function heldKarp(matrix) {
  const n = matrix.length;
  if (n === 1) return { route: [0], cost: 0 };
  if (n === 2) return { route: [0, 1], cost: matrix[0][1] + matrix[1][0] };

  const FULL = (1 << n) - 1;
  const SIZE = (1 << n) * n;
  const dp     = new Float64Array(SIZE);
  const parent = new Int16Array(SIZE);
  dp.fill(Infinity);
  parent.fill(-1);

  dp[(1 << 0) * n + 0] = 0;

  for (let mask = 1; mask <= FULL; mask++) {
    if (!(mask & 1)) continue;                   // every state must include city 0
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      const cur = dp[mask * n + i];
      if (cur === Infinity) continue;

      for (let j = 1; j < n; j++) {              // can't revisit city 0 mid-tour
        if (mask & (1 << j)) continue;
        const next   = mask | (1 << j);
        const cand   = cur + matrix[i][j];
        const idx    = next * n + j;
        if (cand < dp[idx]) {
          dp[idx]     = cand;
          parent[idx] = i;
        }
      }
    }
  }

  // Close the loop back to city 0
  let bestCost = Infinity, bestEnd = -1;
  for (let i = 1; i < n; i++) {
    const total = dp[FULL * n + i] + matrix[i][0];
    if (total < bestCost) { bestCost = total; bestEnd = i; }
  }
  if (bestEnd === -1) return null;               // graph disconnected

  // Reconstruct
  const route = [];
  let mask = FULL, cur = bestEnd;
  while (cur !== -1) {
    route.push(cur);
    const prev = parent[mask * n + cur];
    mask ^= (1 << cur);
    cur = prev;
  }
  route.reverse();
  return { route, cost: bestCost };
}

function solveTSP(rawMatrix, multiplier, mode = 'optimal') {
  const n   = rawMatrix.length;
  const BIG = 1e9;
  const matrix = rawMatrix.map(row =>
    row.map(d => (d === null || d === undefined ? BIG : d * multiplier))
  );

  // Heuristic-only mode
  if (mode === 'heuristic' || n > 15) {
    const h = heuristicTSP(matrix);
    return {
      route:     h?.route || Array.from({ length: n }, (_, i) => i),
      cost:      h?.cost ?? Infinity,
      algorithm: 'Nearest-Neighbour + 2-opt',
      mode:      'heuristic',
      exactCost: null
    };
  }

  // Optimal mode — also runs heuristic so we can show the gap.
  const heur  = heuristicTSP(matrix);
  const exact = heldKarp(matrix);
  if (exact) {
    return {
      route:         exact.route,
      cost:          exact.cost,
      algorithm:     'Held-Karp DP',
      mode:          'optimal',
      heuristicCost: heur ? heur.cost : null
    };
  }

  // Last-ditch fallback if Held-Karp can't reach all cities
  return {
    route:     heur?.route || Array.from({ length: n }, (_, i) => i),
    cost:      heur?.cost ?? Infinity,
    algorithm: 'Nearest-Neighbour + 2-opt',
    mode:      'heuristic',
    exactCost: null
  };
}

/* ════════════════════════════════════════════════════════════════
   OPTIMIZE FLOW
════════════════════════════════════════════════════════════════ */
async function optimize() {
  if (serverWaypoints.length < 2) {
    showToast('Add at least 2 waypoints before optimizing.');
    return;
  }

  const pairCount = serverWaypoints.length * (serverWaypoints.length - 1) / 2;
  showLoading(`Fetching time-optimal routes for ${pairCount} pairs (live traffic = ${state.trafficLabel})…`);

  try {
    // Time-aware pairwise matrix: each entry [i][j] is the FASTEST possible
    // time from i to j under current traffic, considering route alternatives.
    const data = await apiPost('/api/pairwise-matrix', {
      locations:    serverWaypoints,
      trafficLevel: state.trafficMult
    });

    const durations  = data.durations;
    const distances  = data.distances;
    const geometries = data.geometries;

    setLoadingText(
      state.algorithm === 'optimal'
        ? 'Searching the shortest-time tour (Held-Karp DP)…'
        : 'Searching a fast tour (heuristic)…'
    );

    // Matrix is already traffic-adjusted → pass multiplier = 1
    const tspResult = solveTSP(durations, 1.0, state.algorithm);
    const { route: order, algorithm, mode, heuristicCost } = tspResult;

    const totalSec  = order.reduce(
      (s, v, i) => s + durations[v][order[(i + 1) % order.length]], 0);
    const totalDist = order.reduce(
      (s, v, i) => s + (distances[v][order[(i + 1) % order.length]] || 0), 0);

    // Stitch the chosen sub-routes (one per leg) into the full tour polyline
    const tourLatLngs = stitchTourGeometry(geometries, order);
    drawStitchedRoute(tourLatLngs, order);

    showResults(order, totalSec, totalDist, {
      algorithm, mode, heuristicCost,
      trafficLabel: state.trafficLabel,
      trafficMult:  state.trafficMult
    });
  } catch (err) {
    showToast('Optimization failed: ' + err.message);
  } finally {
    hideLoading();
  }
}

function stitchTourGeometry(geometries, order) {
  const out = [];
  for (let i = 0; i < order.length; i++) {
    const a = order[i], b = order[(i + 1) % order.length];
    const seg = geometries[`${a}-${b}`];
    if (!seg || seg.length === 0) continue;

    let start = 0;
    if (out.length > 0) {
      const last = out[out.length - 1];
      const first = seg[0];
      // Skip duplicate junction point if both endpoints coincide
      if (Math.abs(last[1] - first[0]) < 1e-6 && Math.abs(last[0] - first[1]) < 1e-6) {
        start = 1;
      }
    }
    for (let k = start; k < seg.length; k++) {
      const [lng, lat] = seg[k];
      out.push([lat, lng]);
    }
  }
  return out;
}

function drawStitchedRoute(latlngs, order) {
  clearRouteLocal();
  if (latlngs.length === 0) return;

  state.routeLayer = L.polyline(latlngs, {
    color: '#2563eb', weight: 5, opacity: 0.8, lineJoin: 'round'
  }).addTo(map);
  map.fitBounds(state.routeLayer.getBounds(), { padding: [40, 40] });

  // Re-number markers in visit order
  order.forEach((wpIdx, visitOrder) => {
    const wp     = serverWaypoints[wpIdx];
    const marker = state.markerMap[wp.id];
    if (marker) marker.setIcon(makeIcon(visitOrder + 1, wp.ownerRole));
  });
}

function showResults(order, totalSec, totalMeters, meta = {}) {
  const orderStr = order.map(i => i + 1).join(' → ') + ' → ' + (order[0] + 1);
  const names = order.map(i => {
    const wp = serverWaypoints[i];
    const short = wp.name.split(',')[0];
    const tag = wp.ownerRole === 'admin' ? ' 👑' : '';
    return `<strong>${i + 1}</strong>. ${short}${tag}`;
  }).join('<br>');

  // Heuristic-vs-exact comparison (only meaningful in optimal mode)
  let comparison = '';
  if (meta.mode === 'optimal' && meta.heuristicCost && meta.heuristicCost > 0) {
    const savedSec = meta.heuristicCost - totalSec;
    if (savedSec > 1) {
      const pct = ((savedSec / meta.heuristicCost) * 100).toFixed(1);
      comparison = `
        <div class="comparison-box">
          <div class="comparison-label">vs. greedy heuristic</div>
          <div class="comparison-saved">−${fmtTime(savedSec)} <span class="comparison-pct">(${pct}% shorter)</span></div>
        </div>`;
    } else {
      comparison = `
        <div class="comparison-box ok">
          <div class="comparison-label">vs. greedy heuristic</div>
          <div class="comparison-saved">Same tour — heuristic matched the exact answer ✓</div>
        </div>`;
    }
  }

  const algoLine = meta.algorithm
    ? `<div class="algo-line">Solved with <strong>${meta.algorithm}</strong></div>`
    : '';

  // Strip a trailing "Traffic" from the label so we don't get "Heavy Traffic traffic"
  const cleanLabel = (meta.trafficLabel || '').replace(/\s*traffic$/i, '').trim();
  const trafficNote = meta.trafficMult && meta.trafficMult > 1
    ? `with <strong>${cleanLabel || meta.trafficLabel}</strong> traffic`
    : `at <strong>free flow</strong>`;

  document.getElementById('routeResults').innerHTML = `
    <div class="total-time-card">
      <div class="total-time-label">Total Travel Time</div>
      <div class="total-time-value">${fmtTime(totalSec)}</div>
      <div class="total-time-sub">${trafficNote}</div>
    </div>

    <div class="result-row">
      <span class="result-label">Total Distance</span>
      <span class="result-value">${fmtDist(totalMeters)}</span>
    </div>

    <div class="leg-note">
      ↳ Each leg uses the time-optimal path under current traffic
    </div>

    ${comparison}

    <div>
      <div class="route-order-label">Visit Order</div>
      <div class="route-order">${orderStr}</div>
    </div>
    <div>
      <div class="route-order-label">Stops</div>
      <div style="font-size:12px;color:var(--text-muted);line-height:1.9">${names}</div>
    </div>
    ${algoLine}
  `;
  document.getElementById('resultsSection').classList.remove('hidden');
}

/* ════════════════════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════════════════════ */
async function reverseGeocode(lat, lng) {
  try {
    const res  = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      { headers: { 'Accept-Language': 'en' } }
    );
    const data = await res.json();
    const parts = data.display_name?.split(',') || [];
    return parts.slice(0, 2).map(s => s.trim()).join(', ') || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } catch {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}

async function apiCall(method, endpoint, body) {
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${state.token}` }
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(endpoint, opts);
  if (res.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    location.href = '/login.html';
    throw new Error('Session expired');
  }
  let data = {};
  const text = await res.text();
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON response */ }
  if (!res.ok) throw new Error(data.error || `${method} ${endpoint} failed (${res.status})`);
  return data;
}
// Back-compat alias
const apiPost = (e, b) => apiCall('POST', e, b);

function showLoading(text) {
  document.getElementById('loadingText').textContent = text;
  document.getElementById('loadingOverlay').classList.remove('hidden');
  document.getElementById('optimizeBtn').disabled = true;
}
function setLoadingText(text) { document.getElementById('loadingText').textContent = text; }
function hideLoading() {
  document.getElementById('loadingOverlay').classList.add('hidden');
  document.getElementById('optimizeBtn').disabled = false;
}

/* Toast notifications */
function showToast(msg, duration = 3000) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('visible'), duration);
}

function fmtTime(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function fmtDist(meters) {
  if (!meters) return '—';
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}
