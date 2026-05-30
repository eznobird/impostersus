/* ════════════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════════════ */
const state = {
  markerMap:    {},   // id → L.Marker
  routeLayer:   null,
  addMode:      false,
  centerMode:   false,         // 🏛️ "place big center" mode (admin only)
  trafficMult:  1.0,
  trafficLabel: 'Free Flow',
  trafficReason:'',
  autoTraffic:  true,           // 🛰️ live mode is the default
  algorithm:    'optimal',
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

/* Thailand bounding box (rough — verified with Nominatim country code) */
const THAILAND_BBOX = { south: 5.5, north: 20.5, west: 97.3, east: 105.7 };
function isInThailandBBox(lat, lng) {
  return lat >= THAILAND_BBOX.south && lat <= THAILAND_BBOX.north
      && lng >= THAILAND_BBOX.west  && lng <= THAILAND_BBOX.east;
}

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
  document.getElementById('setCenterBtn').addEventListener('click', toggleCenterMode);

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
  document.getElementById('cancelOptimizeBtn').addEventListener('click', cancelOptimize);

  document.querySelectorAll('.traffic-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.traffic-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (btn.dataset.mult === 'auto') {
        state.autoTraffic = true;
        applyLiveTraffic();
      } else {
        state.autoTraffic   = false;
        state.trafficMult   = parseFloat(btn.dataset.mult);
        const labels = {
          '1.0': ['Free Flow',       'No delays — best-case travel times'],
          '1.3': ['Light Traffic',   'Minor slowdowns — ~30% longer than free flow'],
          '1.7': ['Moderate Traffic','Noticeable congestion — ~70% longer travel time'],
          '2.5': ['Heavy Traffic',   'Severe congestion — routes take 2.5× longer']
        };
        const [label, desc] = labels[btn.dataset.mult];
        state.trafficLabel  = label;
        state.trafficReason = 'manual override';
        document.getElementById('trafficDesc').textContent = desc;
      }
    });
  });

  // Auto-refresh live traffic every 60s while Auto mode is active
  applyLiveTraffic();
  setInterval(() => { if (state.autoTraffic) applyLiveTraffic(); }, 60_000);

  // Benchmark this machine's Held-Karp speed now, and re-check every minute
  scheduleCalibration();

  // Algorithm picker
  document.querySelectorAll('.algo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('disabled')) {     // Held-Karp blocked past the cap
        showToast(`Held-Karp is disabled above ${HELDKARP_MAX_N} stops — heuristic only.`);
        return;
      }
      document.querySelectorAll('.algo-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.algorithm = btn.dataset.algo;
      updateAlgoDesc();         // shows correct copy incl. the n>15 fallback note
    });
  });
}

function setupKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (state.addMode)    toggleAddMode();
      if (state.centerMode) toggleCenterMode();
    }
  });
}

/* ════════════════════════════════════════════════════════════════
   LIVE TRAFFIC  —  time-of-day / day-of-week model
   Public OSRM doesn't expose real-time traffic, so we estimate
   the current level from local time using realistic urban patterns
   for Chanthaburi-sized cities. Auto-refreshes every minute.
════════════════════════════════════════════════════════════════ */
function detectLiveTraffic() {
  const now    = new Date();
  const day    = now.getDay();              // 0 = Sun … 6 = Sat
  const hour   = now.getHours();
  const minute = now.getMinutes();
  const dow    = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day];
  const timeStr = `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
  const weekend = (day === 0 || day === 6);

  let mult, label, reason;
  if (weekend) {
    if      (hour >= 11 && hour < 14) { mult = 1.4; label = 'Moderate';  reason = 'weekend lunch hours'; }
    else if (hour >=  9 && hour < 19) { mult = 1.2; label = 'Light';     reason = 'weekend daytime'; }
    else                              { mult = 1.0; label = 'Free Flow'; reason = 'weekend off-peak'; }
  } else {
    if      (hour >=  7 && hour < 10) { mult = 2.5; label = 'Heavy';     reason = 'morning rush hour'; }
    else if (hour >= 16 && hour < 19) { mult = 2.5; label = 'Heavy';     reason = 'evening rush hour'; }
    else if (hour >= 11 && hour < 13) { mult = 1.4; label = 'Moderate';  reason = 'lunch hour'; }
    else if (hour >=  6 && hour < 22) { mult = 1.2; label = 'Light';     reason = 'weekday daytime'; }
    else                              { mult = 1.0; label = 'Free Flow'; reason = 'weekday overnight'; }
  }
  return { mult, label, reason, dow, timeStr };
}

function applyLiveTraffic() {
  const live = detectLiveTraffic();
  state.trafficMult   = live.mult;
  state.trafficLabel  = live.label;
  state.trafficReason = live.reason;
  const desc = `🛰️ Live: ${live.label} · ${live.reason} (${live.dow} ${live.timeStr})`;
  const el = document.getElementById('trafficDesc');
  if (el) el.textContent = desc;
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
   ADD MODE  /  CENTER MODE
════════════════════════════════════════════════════════════════ */
function toggleAddMode() {
  if (state.centerMode) toggleCenterMode();   // mutually exclusive
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

function toggleCenterMode() {
  if (state.addMode) toggleAddMode();          // mutually exclusive
  state.centerMode = !state.centerMode;
  const btn    = document.getElementById('setCenterBtn');
  const banner = document.getElementById('addBanner');
  const mapEl  = document.getElementById('map');
  if (state.centerMode) {
    btn.textContent = '✕ Cancel';
    btn.classList.replace('btn-outline', 'btn-danger');
    banner.querySelector('span, *') || (banner.innerHTML =
      '🏛️ Click on the map to place the BIG CENTER &nbsp;·&nbsp;' +
      '<button class="banner-cancel" onclick="document.getElementById(\'setCenterBtn\').click()">Cancel (Esc)</button>'
    );
    banner.innerHTML =
      '🏛️ Click on the map to place the BIG CENTER &nbsp;·&nbsp;' +
      '<button class="banner-cancel" onclick="document.getElementById(\'setCenterBtn\').click()">Cancel (Esc)</button>';
    banner.classList.remove('hidden');
    banner.classList.add('center-banner');
    mapEl.classList.add('add-mode');
  } else {
    btn.textContent = 'Set Big Center on map';
    btn.classList.replace('btn-danger', 'btn-outline');
    banner.classList.add('hidden');
    banner.classList.remove('center-banner');
    // Restore the normal banner contents for next add-mode session
    banner.innerHTML =
      '📍 Click on the map to add a waypoint &nbsp;·&nbsp;' +
      '<button onclick="document.getElementById(\'addModeBtn\').click()" class="banner-cancel">Cancel (Esc)</button>';
    mapEl.classList.remove('add-mode');
  }
}

/* ════════════════════════════════════════════════════════════════
   WAYPOINT FLOW  —  emit to server, listen for echo
════════════════════════════════════════════════════════════════ */
async function onMapClick(e) {
  if (!state.addMode && !state.centerMode) return;
  const { lat, lng } = e.latlng;

  if (!isInThailandBBox(lat, lng)) {
    showToast('🚫 Pin must be inside Thailand');
    return;
  }
  const geo = await reverseGeocodeWithCountry(lat, lng);
  if (geo.countryCode && geo.countryCode !== 'th') {
    showToast(`🚫 That spot is in ${geo.country || 'another country'} — only Thailand is allowed`);
    return;
  }

  const isCenter = state.centerMode;
  const id = isCenter
    ? `center-${Date.now()}`
    : `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  socket.emit('add_waypoint', {
    id,
    lat,
    lng,
    name: isCenter ? `🏛️ ${geo.name}` : geo.name,
    type: isCenter ? 'center' : 'normal'
  });

  // Auto-exit center mode after one placement (only one center allowed)
  if (isCenter) toggleCenterMode();
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
    if (m) m.setIcon(makeIcon(idx + 1, wp.ownerRole, wp.type));
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
  updateAlgoEstimates();
  updateBigCenterStatus();

  if (count === 0) {
    list.innerHTML = '<p class="empty-hint">Click "+ Add" then tap the map</p>';
    return;
  }

  list.innerHTML = serverWaypoints.map((wp, i) => {
    const isCenter  = wp.type === 'center';
    const isAdmin   = wp.ownerRole === 'admin';
    const canDel    = canRemove(wp);
    const deleteBtn = canDel
      ? `<button class="wp-delete" onclick="deleteWaypoint('${wp.id}')" title="Remove">✕</button>`
      : `<span class="wp-locked" title="Admin pin — guests can't remove">🔒</span>`;

    const itemClass = isCenter ? ' center-owned' : (isAdmin ? ' admin-owned' : '');
    const numContent = isCenter ? '🏛️' : (isAdmin ? '★' : i + 1);
    const numClass   = isCenter ? ' center-num' : (isAdmin ? ' admin-num' : '');

    return `
      <div class="waypoint-item${itemClass}">
        <div class="wp-number${numClass}">${numContent}</div>
        <div class="wp-info">
          <div class="wp-name" title="${wp.name}">
            ${isCenter ? '<span class="big-center-tag">BIG CENTER</span> ' : ''}${wp.name}
          </div>
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

function updateBigCenterStatus() {
  const el = document.getElementById('bigCenterState');
  if (!el) return;
  const center = serverWaypoints.find(w => w.type === 'center');
  if (center) {
    el.textContent = `Active: ${center.name.replace(/^🏛️\s*/, '')}`;
    el.classList.add('active');
  } else {
    el.textContent = 'Not set';
    el.classList.remove('active');
  }
}

/* ════════════════════════════════════════════════════════════════
   MARKERS  —  admin pins are SPECIAL
════════════════════════════════════════════════════════════════ */
function makeIcon(number, ownerRole, type) {
  // Big Center pin — unique, must stand out hard
  if (type === 'center') {
    return L.divIcon({
      html: `<div class="map-marker center-pin">
               <span class="pin-crown-big">🏛️</span>
               <span class="pin-num">${number}</span>
             </div>`,
      className: '',
      iconSize:    [56, 56],
      iconAnchor:  [28, 28],
      popupAnchor: [0, -30]
    });
  }
  // Regular admin pin
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
    icon:      makeIcon(number, wp.ownerRole, wp.type),
    draggable: canMove(wp)
  });

  marker.on('dragend', async e => {
    const { lat, lng } = e.target.getLatLng();
    // Snap back if the user dragged the pin out of Thailand
    if (!isInThailandBBox(lat, lng)) {
      e.target.setLatLng([wp.lat, wp.lng]);
      showToast('🚫 Pins can only be inside Thailand');
      return;
    }
    const geo = await reverseGeocodeWithCountry(lat, lng);
    if (geo.countryCode && geo.countryCode !== 'th') {
      e.target.setLatLng([wp.lat, wp.lng]);
      showToast(`🚫 That spot is in ${geo.country} — only Thailand is allowed`);
      return;
    }
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

// Heuristic baseline — multi-start nearest-neighbour + 2-opt.
// (Proven, no pathological loops. 2-opt alone is typically within a few % of
//  optimum, and for n ≤ 20 the exact Held-Karp result is used anyway.)
function heuristicTSP(matrix) {
  const n = matrix.length;
  let bestRoute = null, bestCost = Infinity;
  // For very large n, sampling a subset of starts keeps it snappy.
  const starts = (n > 30)
    ? Array.from({ length: 12 }, (_, k) => Math.floor(k * n / 12))
    : Array.from({ length: n }, (_, k) => k);

  for (const start of starts) {
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
// Async so it can YIELD to the event loop periodically — otherwise n≈18-20
// freezes the whole tab for tens of seconds. `onProgress(fraction)` (0..1)
// lets the caller animate a real compute progress bar.
async function heldKarp(matrix, onProgress) {
  const n = matrix.length;
  if (n === 1) return { route: [0], cost: 0 };
  if (n === 2) return { route: [0, 1], cost: matrix[0][1] + matrix[1][0] };

  const FULL = (1 << n) - 1;
  const SIZE = (1 << n) * n;
  // Float32Array halves memory vs Float64Array; precision is plenty for seconds.
  const dp     = new Float32Array(SIZE);
  const parent = new Int16Array(SIZE);
  dp.fill(Infinity);
  parent.fill(-1);

  dp[(1 << 0) * n + 0] = 0;

  let lastYield = performance.now();
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
    // Every ~40 ms, hand the thread back so the UI (progress bar, clicks) breathes
    if (performance.now() - lastYield > 40) {
      if (onProgress) onProgress(mask / FULL);
      await new Promise(r => setTimeout(r, 0));
      lastYield = performance.now();
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

// Solve TSP in a Web Worker so the main UI thread NEVER freezes and the
// progress bar can update smoothly. Falls back to the in-page algorithm
// only if Workers aren't available.
function solveTSPInWorker(rawMatrix, multiplier, mode, onProgress) {
  const matrix = rawMatrix.map(row =>
    row.map(d => (d === null || d === undefined ? 1e9 : d * multiplier))
  );

  if (typeof Worker === 'undefined') {
    // Extremely unlikely in modern browsers, but fall back gracefully
    return solveTSPFallback(matrix, mode, onProgress);
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker('/js/tsp-worker.js');
    _activeWorker = worker;                      // exposed so Cancel can terminate it
    const requestId = Math.random().toString(36).slice(2);

    const cleanup = () => { worker.terminate(); if (_activeWorker === worker) _activeWorker = null; };

    worker.onmessage = (e) => {
      const m = e.data;
      if (m.requestId !== requestId) return;
      if (m.type === 'progress') {
        if (onProgress) onProgress(m.fraction);
      } else if (m.type === 'done') {
        cleanup();
        const r = m.result;
        resolve({
          route:         r?.route || [],
          cost:          r?.cost ?? Infinity,
          algorithm:     m.algorithm,
          mode:          m.mode,
          heuristicCost: m.heuristicCost
        });
      } else if (m.type === 'error') {
        cleanup();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (err) => {
      cleanup();
      reject(new Error('TSP worker crashed: ' + (err.message || 'unknown')));
    };

    worker.postMessage({ matrix, mode, requestId });
  });
}

// Cancellation handles shared across the optimize flow
let _activeWorker   = null;   // current TSP worker, if any
let _optimizeAbort  = null;   // AbortController for in-flight fetches
let _optimizeCanceled = false;

function cancelOptimize() {
  _optimizeCanceled = true;
  if (_activeWorker)  { _activeWorker.terminate(); _activeWorker = null; }
  if (_optimizeAbort) { try { _optimizeAbort.abort(); } catch {} }
  cancelProgressAnimation();
  stopStageTicker();
  hideProgressUI();
  showToast('Optimization canceled');
}

// Non-worker fallback (uses in-page async heldKarp + heuristicTSP)
async function solveTSPFallback(matrix, mode, onProgress) {
  const n = matrix.length;
  if (mode === 'heuristic' || n > HELDKARP_MAX_N) {
    const h = heuristicTSP(matrix);
    return {
      route:     h?.route || [], cost: h?.cost ?? Infinity,
      algorithm: 'NN + 2-opt', mode: 'heuristic', heuristicCost: null
    };
  }
  const heur  = heuristicTSP(matrix);
  const exact = await heldKarp(matrix, onProgress);
  return exact
    ? { route: exact.route, cost: exact.cost,
        algorithm: 'Held-Karp DP', mode: 'optimal',
        heuristicCost: heur ? heur.cost : null }
    : { route: heur?.route || [], cost: heur?.cost ?? Infinity,
        algorithm: 'NN + 2-opt', mode: 'heuristic', heuristicCost: null };
}

// Public entry point
const solveTSP = solveTSPInWorker;

/* ════════════════════════════════════════════════════════════════
   OPTIMIZE FLOW
════════════════════════════════════════════════════════════════ */
async function optimize() {
  if (serverWaypoints.length < 2) {
    showToast('Add at least 2 waypoints before optimizing.');
    return;
  }

  const n        = serverWaypoints.length;
  const pairs    = n * (n - 1) / 2;
  const estMs    = estimateAlgoTimeMs(state.algorithm, n) || 3000;
  const fetchMs  = Math.ceil(pairs / 8) * 250;

  // If it's going to take a while, give the user a chance to bail
  if (estMs > 30_000 &&
      !confirm(`Optimizing ${n} waypoints will take about ${fmtEstimate(estMs)} ` +
               `(${pairs} road pairs to fetch). Continue?`)) {
    return;
  }

  // Fresh cancellation state for this run
  _optimizeCanceled = false;
  _optimizeAbort = new AbortController();
  const signal = _optimizeAbort.signal;

  showProgressUI('Optimizing route…');
  setProgressStage('fetch', 5,
    `Fetching ${pairs} road pair${pairs === 1 ? '' : 's'} from OSRM (live traffic = ${state.trafficLabel})…`);
  // Asymptotic creep toward 88% — never sticks even if the fetch runs long
  animateProgressAsymptotic(88, Math.max(2000, fetchMs * 0.8),
    `Fetching ${pairs} road pairs from OSRM`);

  try {
    // Time-aware pairwise matrix: each [i][j] is the FASTEST possible time
    // from i to j under current traffic, considering route alternatives.
    const data = await apiPost('/api/pairwise-matrix', {
      locations:    serverWaypoints,
      trafficLevel: state.trafficMult
    }, signal);
    if (_optimizeCanceled) return;

    const durations  = data.durations;
    const distances  = data.distances;
    const geometries = data.geometries;

    // ── Stage 2: solve ───────────────────────────────────────────
    cancelProgressAnimation();
    const willBeExact = (state.algorithm === 'optimal' && n <= HELDKARP_MAX_N);
    setProgressStage('solve', 90,
      willBeExact
        ? 'Running Held-Karp DP (exact shortest-time tour)…'
        : 'Running multi-start NN + 2-opt heuristic…');

    // Smoothly sweep 90→98 over the estimated compute time, with a floor so the
    // phase is always visible (never a jarring instant snap). The solve runs in
    // a Web Worker, so we wait for BOTH the result AND the minimum sweep time —
    // whichever is longer — keeping the bar's motion smooth and unhurried.
    const estComputeMs = estimateComputeMs(state.algorithm, n);
    const sweepMs = Math.max(1200, Math.round(estComputeMs));
    animateProgressTo(98, sweepMs);

    const [tspResult] = await Promise.all([
      solveTSP(durations, 1.0, state.algorithm),
      new Promise(res => setTimeout(res, sweepMs))
    ]);
    if (_optimizeCanceled) return;
    cancelProgressAnimation();
    const { algorithm, mode, heuristicCost } = tspResult;
    let order = tspResult.route;

    // If a Big Center pin exists, rotate the loop so it STARTS (and ends) there.
    // A TSP loop's total cost is rotation-invariant, so this changes only the
    // starting point, not the optimality.
    const centerWpIdx = serverWaypoints.findIndex(w => w.type === 'center');
    const hasCenterStart = centerWpIdx >= 0 && order.includes(centerWpIdx);
    if (hasCenterStart) {
      const pos = order.indexOf(centerWpIdx);
      if (pos > 0) order = [...order.slice(pos), ...order.slice(0, pos)];
    }

    const totalSec = order.reduce(
      (s, v, i) => s + durations[v][order[(i + 1) % order.length]], 0);
    const totalDist = order.reduce(
      (s, v, i) => s + (distances[v][order[(i + 1) % order.length]] || 0), 0);

    // ── Stage 3: draw ────────────────────────────────────────────
    cancelProgressAnimation();
    let tourLatLngs;
    if (geometries && Object.keys(geometries).length > 0) {
      // Quality path: stitch the per-leg geometries we already have
      setProgressStage('draw', 92, 'Stitching per-leg geometry onto the map…');
      tourLatLngs = stitchTourGeometry(geometries, order);
    } else {
      // Fast/table path: fetch the whole ordered tour geometry in one /route call
      setProgressStage('draw', 92, 'Fetching tour geometry…');
      const orderedLocs = [...order.map(i => serverWaypoints[i]), serverWaypoints[order[0]]];
      try {
        const routeData = await apiPost('/api/route', { locations: orderedLocs }, signal);
        if (_optimizeCanceled) return;
        if (routeData.code === 'Ok' && routeData.routes?.[0]) {
          tourLatLngs = routeData.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        }
      } catch { /* fall through to straight-line fallback */ }
      if (!tourLatLngs) {
        // Last-ditch: straight segments between stops
        tourLatLngs = [...order, order[0]].map(i => [serverWaypoints[i].lat, serverWaypoints[i].lng]);
      }
    }
    drawStitchedRoute(tourLatLngs, order);

    showResults(order, totalSec, totalDist, {
      algorithm, mode, heuristicCost,
      trafficLabel:  state.trafficLabel,
      trafficMult:   state.trafficMult,
      trafficReason: state.trafficReason,
      isLive:        state.autoTraffic,
      durations,                       // for per-stop cumulative travel times
      startIsCenter: hasCenterStart
    });

    markAllStagesDone();
    document.getElementById('progressDetail').textContent =
      `Done! (~${(estMs / 1000).toFixed(1)}s estimated)`;
    setTimeout(hideProgressUI, 450);
  } catch (err) {
    if (_optimizeCanceled || err.name === 'AbortError') return;  // canceled — already handled
    hideProgressUI();
    showToast('Optimization failed: ' + err.message);
  } finally {
    _optimizeAbort = null;
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
    if (marker) marker.setIcon(makeIcon(visitOrder + 1, wp.ownerRole, wp.type));
  });
}

function showResults(order, totalSec, totalMeters, meta = {}) {
  const orderStr = order.map(i => i + 1).join(' → ') + ' → ' + (order[0] + 1);

  // Per-LEG travel time (under current traffic): each row shows how long it takes
  // to drive FROM the previous stop TO this one. The first stop is the start.
  const dur = meta.durations;
  const stopRows = order.map((idx, k) => {
    const legSec   = (k > 0 && dur) ? (dur[order[k - 1]][idx] || 0) : 0;
    const wp       = serverWaypoints[idx];
    const short    = wp.name.split(',')[0].replace(/^🏛️\s*/, '');
    const isCenter = wp.type === 'center';
    const icon     = isCenter ? '🏛️' : (wp.ownerRole === 'admin' ? '👑' : '');
    const timeTxt  = (k === 0)
      ? '<span class="stop-time start">start</span>'
      : `<span class="stop-time">${fmtLeg(legSec)}</span>`;
    return `
      <div class="stop-row${isCenter ? ' center' : ''}">
        <span class="stop-num${isCenter ? ' center' : ''}">${isCenter ? '★' : k + 1}</span>
        <span class="stop-name">${icon ? icon + ' ' : ''}${short}</span>
        ${timeTxt}
      </div>`;
  }).join('');
  // Closing leg back to the start — its own travel time, not the cumulative total
  const returnLegSec = dur ? (dur[order[order.length - 1]][order[0]] || 0) : 0;
  const startWp   = serverWaypoints[order[0]];
  const startName = startWp.name.split(',')[0].replace(/^🏛️\s*/, '');
  const returnRow = `
    <div class="stop-row return">
      <span class="stop-num return">↩</span>
      <span class="stop-name">back to ${meta.startIsCenter ? '🏛️ ' : ''}${startName}</span>
      <span class="stop-time">${fmtLeg(returnLegSec)}</span>
    </div>`;

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
  const livePrefix = meta.isLive ? '🛰️ live ' : '';
  const reasonNote = meta.isLive && meta.trafficReason
    ? `<div class="total-time-reason">${meta.trafficReason}</div>` : '';
  const trafficNote = meta.trafficMult && meta.trafficMult > 1
    ? `with ${livePrefix}<strong>${cleanLabel || meta.trafficLabel}</strong> traffic`
    : `at ${livePrefix}<strong>free flow</strong>`;

  document.getElementById('routeResults').innerHTML = `
    <div class="total-time-card${meta.isLive ? ' live' : ''}">
      <div class="total-time-label">
        Total Travel Time
        ${meta.isLive ? '<span class="live-pill">LIVE</span>' : ''}
      </div>
      <div class="total-time-value">${fmtTime(totalSec)}</div>
      <div class="total-time-sub">${trafficNote}</div>
      ${reasonNote}
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
      <div class="route-order-label">
        Stops &amp; travel time per leg
        ${meta.startIsCenter ? '<span class="center-start-tag">starts at 🏛️ Big Center</span>' : ''}
      </div>
      <div class="stop-list">${stopRows}${returnRow}</div>
    </div>
    ${algoLine}
  `;
  document.getElementById('resultsSection').classList.remove('hidden');
}

/* ════════════════════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════════════════════ */
async function reverseGeocodeWithCountry(lat, lng) {
  try {
    const res  = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=14`,
      { headers: { 'Accept-Language': 'en' } }
    );
    const data = await res.json();
    const parts = data.display_name?.split(',') || [];
    const name  = parts.slice(0, 2).map(s => s.trim()).join(', ')
                  || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    const countryCode = (data.address?.country_code || '').toLowerCase();
    const country     = data.address?.country || '';
    return { name, country, countryCode };
  } catch {
    return { name: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, country: '', countryCode: '' };
  }
}
// Back-compat shim
async function reverseGeocode(lat, lng) {
  return (await reverseGeocodeWithCountry(lat, lng)).name;
}

async function apiCall(method, endpoint, body, signal) {
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${state.token}` }
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (signal) opts.signal = signal;
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
const apiPost = (e, b, signal) => apiCall('POST', e, b, signal);

/* ════════════════════════════════════════════════════════════════
   PROGRESS UI  —  staged progress bar in the loading overlay
════════════════════════════════════════════════════════════════ */
const STAGES = ['fetch', 'solve', 'draw'];
let _progressAnim = null;

// Per-stage timing
let _stageStart  = {};     // stage → performance.now() when it became active
let _stageDone   = {};     // stage → frozen elapsed ms once finished
let _activeStage = null;
let _stageTicker = null;

function fmtStageTime(ms) {
  if (ms == null) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function startStageTicker() {
  stopStageTicker();
  _stageTicker = setInterval(() => {
    if (!_activeStage || _stageStart[_activeStage] == null) return;
    const el = document.getElementById('time-' + _activeStage);
    if (el) el.textContent = fmtStageTime(performance.now() - _stageStart[_activeStage]);
  }, 100);
}
function stopStageTicker() {
  if (_stageTicker) { clearInterval(_stageTicker); _stageTicker = null; }
}

function showProgressUI(title) {
  document.getElementById('loadingTitle').textContent = title || 'Optimizing route…';
  STAGES.forEach(s => {
    const el = document.getElementById('stage-' + s);
    el.classList.remove('active', 'done');
    el.querySelector('.stage-status').textContent = '';
    const tEl = document.getElementById('time-' + s);
    if (tEl) tEl.textContent = '';
  });
  // Reset timers
  _stageStart = {}; _stageDone = {}; _activeStage = null;
  stopStageTicker();

  document.getElementById('progressBarFill').style.width = '0%';
  document.getElementById('progressPercent').textContent = '0%';
  document.getElementById('progressDetail').textContent = 'Starting…';
  document.getElementById('loadingOverlay').classList.remove('hidden');
  document.getElementById('optimizeBtn').disabled = true;
}

function setProgressStage(stage, percent, detail) {
  const ix  = STAGES.indexOf(stage);
  const now = performance.now();
  STAGES.forEach((s, i) => {
    const el  = document.getElementById('stage-' + s);
    const tEl = document.getElementById('time-' + s);
    if (i < ix) {
      el.classList.add('done');    el.classList.remove('active');
      el.querySelector('.stage-status').textContent = '✓';
      // Freeze this finished stage's elapsed time
      if (_stageStart[s] != null && _stageDone[s] == null) _stageDone[s] = now - _stageStart[s];
      if (tEl && _stageDone[s] != null) tEl.textContent = fmtStageTime(_stageDone[s]);
    } else if (i === ix) {
      el.classList.add('active');  el.classList.remove('done');
      el.querySelector('.stage-status').textContent = '⏳';
      if (_stageStart[s] == null) _stageStart[s] = now;   // start this stage's clock
    } else {
      el.classList.remove('active', 'done');
      el.querySelector('.stage-status').textContent = '';
      if (tEl) tEl.textContent = '';
    }
  });
  _activeStage = stage;
  startStageTicker();

  if (percent != null) {
    const fill = document.getElementById('progressBarFill');
    // A discrete jump — animate it smoothly with a short CSS transition
    fill.style.transition = 'width .3s ease';
    fill.style.width = percent + '%';
    document.getElementById('progressPercent').textContent = Math.round(percent) + '%';
  }
  if (detail) document.getElementById('progressDetail').textContent = detail;
}

function markAllStagesDone() {
  const now = performance.now();
  // Freeze whatever stage was still running
  if (_activeStage && _stageStart[_activeStage] != null && _stageDone[_activeStage] == null) {
    _stageDone[_activeStage] = now - _stageStart[_activeStage];
  }
  STAGES.forEach(s => {
    const el = document.getElementById('stage-' + s);
    el.classList.add('done'); el.classList.remove('active');
    el.querySelector('.stage-status').textContent = '✓';
    const tEl = document.getElementById('time-' + s);
    if (tEl && _stageDone[s] != null) tEl.textContent = fmtStageTime(_stageDone[s]);
  });
  stopStageTicker();
  _activeStage = null;
  document.getElementById('progressBarFill').style.width = '100%';
  document.getElementById('progressPercent').textContent = '100%';
}

function animateProgressTo(targetPercent, durationMs) {
  cancelProgressAnimation();
  const fill = document.getElementById('progressBarFill');
  const pctEl = document.getElementById('progressPercent');
  fill.style.transition = 'none';   // rAF drives smoothness
  const start = parseFloat(fill.style.width) || 0;
  const t0 = performance.now();
  const id = { canceled: false };
  _progressAnim = id;
  function tick(now) {
    if (id.canceled) return;
    const t = Math.min(1, (now - t0) / durationMs);
    const cur = start + (targetPercent - start) * t;
    fill.style.width = cur + '%';
    pctEl.textContent = Math.round(cur) + '%';
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return id;
}

// Asymptotic creep — approaches `ceiling` but never reaches it, fast then slow.
// Keeps the bar visibly alive while we wait for an unpredictable-length fetch.
function animateProgressAsymptotic(ceiling, tauMs, detailPrefix) {
  cancelProgressAnimation();
  const fill  = document.getElementById('progressBarFill');
  const pctEl = document.getElementById('progressPercent');
  const detEl = document.getElementById('progressDetail');
  fill.style.transition = 'none';   // rAF drives smoothness; CSS transition would stutter
  const start = parseFloat(fill.style.width) || 0;
  const t0 = performance.now();
  const id = { canceled: false };
  _progressAnim = id;
  function tick(now) {
    if (id.canceled) return;
    const elapsed = now - t0;
    const cur = start + (ceiling - start) * (1 - Math.exp(-elapsed / tauMs));
    fill.style.width = cur + '%';
    pctEl.textContent = Math.round(cur) + '%';
    if (detailPrefix && elapsed > 1500) {
      detEl.textContent = `${detailPrefix} (${Math.round(elapsed / 1000)}s)`;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return id;
}

function cancelProgressAnimation() {
  if (_progressAnim) { _progressAnim.canceled = true; _progressAnim = null; }
}

function hideProgressUI() {
  cancelProgressAnimation();
  stopStageTicker();
  document.getElementById('loadingOverlay').classList.add('hidden');
  document.getElementById('optimizeBtn').disabled = false;
}

// Back-compat shims for any leftover callers
function showLoading(t) { showProgressUI(t); }
function setLoadingText(t) { document.getElementById('progressDetail').textContent = t; }
function hideLoading() { hideProgressUI(); }

/* ════════════════════════════════════════════════════════════════
   ALGORITHM TIME ESTIMATOR  —  refreshes as waypoints change
════════════════════════════════════════════════════════════════ */
// Practical Held-Karp ceiling (matches MAX_HELDKARP_N in tsp-worker.js).
// In a Web Worker we comfortably reach n=22 (~550 MB peak Float32+Int16).
// Above this the worker transparently runs the heuristic instead.
const HELDKARP_MAX_N = 22;

// Above this, the server switches to a single fast /table call (must match server)
const PAIRWISE_MAX_N = 12;

// Network fetch — SHARED by both algorithms (this is what dominates total time)
function estimateFetchMs(n) {
  if (n < 2) return 0;
  if (n <= PAIRWISE_MAX_N) {
    // Per-pair /route?alternatives — OSRM demo throttles, so ~700 ms effective
    // per call through ~6 usable parallel slots.
    const pairs = n * (n - 1) / 2;
    return Math.ceil(pairs / 6) * 700;
  }
  // Fast bulk path: one /table call + one /route call for the tour geometry.
  // Roughly constant regardless of n (a little more for very large matrices).
  return 2500 + n * 60;
}

// Pure algorithm compute — this is what DIFFERS between the two.
// Throughput constants are calibrated against measured worker performance:
//   Held-Karp inner loop runs ~500k (n²·2ⁿ)-proxy-ops/ms; we use 350k to stay
//   slightly conservative (estimate ≥ actual, since per-op speed drops as the
//   DP table grows past CPU cache near n=22).  Measured: n20≈0.8s, n21≈1.7s.
let   HELDKARP_OPS_PER_MS  = 350_000;   // auto-recalibrated every 60s (see below)
const HEURISTIC_OPS_PER_MS = 30_000;
function estimateComputeMs(algo, n) {
  if (n < 2) return 0;
  const useExact = (algo === 'optimal' && n <= HELDKARP_MAX_N);
  return useExact
    ? (n * n * Math.pow(2, n)) / HELDKARP_OPS_PER_MS   // Held-Karp: n²·2ⁿ ops
    : (10 * n * n * n)         / HEURISTIC_OPS_PER_MS;  // NN·n starts + 2-opt: ~10·n³ ops
}

// Total (fetch + compute) — used for the long-run confirmation dialog
function estimateAlgoTimeMs(algo, n) {
  if (n < 2) return null;
  return estimateFetchMs(n) + estimateComputeMs(algo, n);
}

// ── Auto-calibration of the Held-Karp speed constant ──────────────────────────
// Re-benchmarks the actual machine every 60s so the estimate tracks reality
// (thermal throttling, other tabs, battery-saver, etc. all shift throughput).
// Runs a tiny n=17 DP (~13 MB, ~60 ms) during idle time so it never janks.
function calibrateHeldKarpSpeed() {
  const nb = 17;
  const m = Array.from({ length: nb }, (_, i) =>
    Array.from({ length: nb }, (_, j) => (i === j ? 0 : 100 + ((i * 73 + j * 97) % 211))));
  const FULL = (1 << nb) - 1, SIZE = (1 << nb) * nb;
  const dp = new Float32Array(SIZE);
  dp.fill(Infinity);
  dp[nb] = 0;                               // dp[(1<<0)*nb + 0]
  const t0 = performance.now();
  for (let mask = 1; mask <= FULL; mask++) {
    if (!(mask & 1)) continue;
    for (let i = 0; i < nb; i++) {
      if (!(mask & (1 << i))) continue;
      const cur = dp[mask * nb + i];
      if (cur === Infinity) continue;
      for (let j = 1; j < nb; j++) {
        if (mask & (1 << j)) continue;
        const idx = (mask | (1 << j)) * nb + j;
        const cand = cur + m[i][j];
        if (cand < dp[idx]) dp[idx] = cand;
      }
    }
  }
  const ms = performance.now() - t0;
  if (ms <= 0) return;
  const measured   = (nb * nb * Math.pow(2, nb)) / ms;   // proxy-ops per ms
  // Stay ~30% conservative (estimate ≥ actual); clamp to a sane band.
  HELDKARP_OPS_PER_MS = Math.round(Math.max(100_000, Math.min(2_000_000, measured * 0.7)));
}

function scheduleCalibration() {
  const run = () => {
    if ('requestIdleCallback' in window) requestIdleCallback(calibrateHeldKarpSpeed);
    else calibrateHeldKarpSpeed();
    updateAlgoEstimates();   // refresh the chips with the new figure
  };
  run();                       // calibrate once on load
  setInterval(run, 60_000);    // …and every minute thereafter
}

function fmtEstimate(ms) {
  if (ms == null) return '—';
  if (ms < 1000)        return `~${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000)      return `~${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) { // < 1 hour
    const m = Math.round(ms / 60_000);
    return `~${m}m`;
  }
  // >= 1 hour
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
}

// Compute is often sub-second — show it with finer granularity than fmtEstimate
function fmtCompute(ms) {
  if (ms == null) return '—';
  if (ms < 10)    return '<0.01s';
  if (ms < 1000)  return `${Math.round(ms)} ms`;
  return fmtEstimate(ms).replace('~', '');
}

function updateAlgoEstimates() {
  const n = serverWaypoints.length;
  const blocked = n > HELDKARP_MAX_N;   // Held-Karp not allowed past the cap

  // Past the cap, force-select the heuristic and disable the Optimal button.
  const optimalBtn = document.querySelector('.algo-btn[data-algo="optimal"]');
  const heurBtn    = document.querySelector('.algo-btn[data-algo="heuristic"]');
  if (optimalBtn && heurBtn) {
    optimalBtn.classList.toggle('disabled', blocked);
    optimalBtn.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    if (blocked && state.algorithm === 'optimal') {
      state.algorithm = 'heuristic';
      optimalBtn.classList.remove('active');
      heurBtn.classList.add('active');
    }
  }

  // Chips show COMPUTE time — the part that actually differs between algorithms
  document.querySelectorAll('.algo-est').forEach(el => {
    if (n < 2) { el.textContent = '—'; return; }
    if (el.dataset.algo === 'optimal' && blocked) { el.textContent = 'off'; return; }
    el.textContent = fmtCompute(estimateComputeMs(el.dataset.algo, n));
  });

  // Method label under "Optimal"
  const methodEl = document.getElementById('optimalMethod');
  if (methodEl) {
    methodEl.textContent = blocked ? 'disabled' : 'Held-Karp';
    methodEl.classList.toggle('method-fallback', blocked);
  }

  // Fetch time is shared — show it once, separately
  const fetchEl = document.getElementById('fetchEst');
  if (fetchEl) {
    if (n < 2) {
      fetchEl.textContent = '';
    } else if (n > PAIRWISE_MAX_N) {
      fetchEl.textContent =
        `⏱ + ${fmtEstimate(estimateFetchMs(n))} to fetch road data (fast bulk mode for ${n} stops)`;
    } else {
      fetchEl.textContent =
        `⏱ + ${fmtEstimate(estimateFetchMs(n))} to fetch road data from OSRM (shared by both)`;
    }
  }

  updateAlgoDesc();
}

function updateAlgoDesc() {
  const el = document.getElementById('algoDesc');
  if (!el) return;
  const n = serverWaypoints.length;

  if (n > HELDKARP_MAX_N) {
    el.innerHTML = `Over ${HELDKARP_MAX_N} stops: Held-Karp needs &gt;1&nbsp;GB RAM, so it's disabled. Using the heuristic (within a few % of optimum).`;
    el.classList.add('warn');
  } else if (state.algorithm === 'optimal') {
    el.textContent = 'Finds the shortest possible loop — slower for many stops.';
    el.classList.remove('warn');
  } else {
    el.textContent = 'Fast greedy search — usually within a few percent of the best loop.';
    el.classList.remove('warn');
  }
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
// Per-leg formatter: rounds to the nearest minute (so legs sum close to the
// total) and shows seconds for sub-minute legs (city hops can be < 1 min).
function fmtLeg(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtDist(meters) {
  if (!meters) return '—';
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}
