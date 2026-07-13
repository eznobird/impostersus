import os
import json
import time
import threading
import urllib.request
import urllib.error
import re
from concurrent.futures import ThreadPoolExecutor
from functools import wraps
from flask import Flask, request, jsonify, g
from flask_socketio import SocketIO, emit
from werkzeug.security import generate_password_hash, check_password_hash
import jwt

app = Flask(__name__, static_folder='public', static_url_path='')

# threading  : default for local `python server.py` (uses Werkzeug dev server)
# eventlet   : production under gunicorn  →  set SOCKETIO_ASYNC_MODE=eventlet
ASYNC_MODE = os.environ.get('SOCKETIO_ASYNC_MODE', 'threading')
socketio   = SocketIO(app, cors_allowed_origins='*', async_mode=ASYNC_MODE)

JWT_SECRET = os.environ.get('JWT_SECRET', 'tsp-dev-secret-change-in-production')
PORT       = int(os.environ.get('PORT', 3000))
OSRM_BASE  = 'http://router.project-osrm.org'

# At or below this many stops we do detailed per-pair routing (alternatives).
# Above it we switch to a single fast /table call to avoid hammering OSRM.
PAIRWISE_MAX_N = 12

# Users — admin is always present; guest accounts start at 0 and are
# created at runtime by the admin. Guests persist in users.json so they
# survive server restarts.
USERS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'users.json')
USERS_LOCK = threading.Lock()
USERNAME_RE = re.compile(r'^[A-Za-z0-9_\-]{3,24}$')


def _load_guest_users():
    if not os.path.exists(USERS_FILE):
        return []
    try:
        with open(USERS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        # Only keep records that look like guest entries
        return [u for u in data
                if isinstance(u, dict)
                and u.get('role') == 'guest'
                and 'username' in u and 'hash' in u and 'id' in u]
    except (json.JSONDecodeError, OSError):
        return []


def _save_guest_users():
    """Persist the current guest list. Caller must hold USERS_LOCK."""
    guests = [u for u in USERS if u['role'] == 'guest']
    try:
        with open(USERS_FILE, 'w', encoding='utf-8') as f:
            json.dump(guests, f, indent=2)
    except OSError as e:
        print(f'Warning: could not save users.json: {e}')


USERS = [
    {'id': 1, 'username': 'admin', 'hash': generate_password_hash('admin123'), 'role': 'admin'},
]
USERS.extend(_load_guest_users())


def _next_user_id():
    return max([u['id'] for u in USERS] + [0]) + 1

# ── Shared, in-memory state (lost on restart) ─────────────────────────────────
waypoints_db    = {}   # id -> {id, lat, lng, name, owner, ownerRole}
connected_users = {}   # socket sid -> {id, username, role}


# ── HTTP auth middleware ──────────────────────────────────────────────────────
def auth_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        header = request.headers.get('Authorization', '')
        if not header.startswith('Bearer '):
            return jsonify({'error': 'Authentication required'}), 401
        try:
            g.user = jwt.decode(header[7:], JWT_SECRET, algorithms=['HS256'])
        except jwt.ExpiredSignatureError:
            return jsonify({'error': 'Session expired — please log in again'}), 401
        except jwt.InvalidTokenError:
            return jsonify({'error': 'Invalid token'}), 401
        return f(*args, **kwargs)
    return decorated


def osrm_get(path):
    req = urllib.request.Request(
        f'{OSRM_BASE}{path}',
        headers={'User-Agent': 'TSP-Optimizer/1.0'}
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.URLError as e:
        raise RuntimeError(f'Routing service unreachable: {e.reason}')


# ── Static & auth endpoints ───────────────────────────────────────────────────
@app.route('/')
def index():
    return app.send_static_file('login.html')


@app.route('/api/auth/login', methods=['POST'])
def login():
    data     = request.get_json() or {}
    username = data.get('username', '')
    password = data.get('password', '')

    user = next((u for u in USERS if u['username'] == username), None)
    if not user or not check_password_hash(user['hash'], password):
        return jsonify({'error': 'Invalid username or password'}), 401

    payload = {
        'id':       user['id'],
        'username': user['username'],
        'role':     user['role'],
        'exp':      int(time.time()) + 86400
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm='HS256')
    if isinstance(token, bytes):
        token = token.decode()

    return jsonify({
        'token': token,
        'user':  {'id': user['id'], 'username': user['username'], 'role': user['role']}
    })


@app.route('/api/auth/me', methods=['GET'])
@auth_required
def me():
    return jsonify(g.user)


# ── Admin: user management ────────────────────────────────────────────────────
def _admin_only():
    """Raise 403 unless the authenticated user is admin. Returns None on success."""
    if g.user.get('role') != 'admin':
        return jsonify({'error': 'Admin access required'}), 403
    return None


@app.route('/api/admin/users', methods=['GET'])
@auth_required
def list_users():
    deny = _admin_only()
    if deny:
        return deny
    return jsonify({
        'users': [
            {'id': u['id'], 'username': u['username'], 'role': u['role']}
            for u in USERS if u['role'] == 'guest'
        ]
    })


@app.route('/api/admin/users', methods=['POST'])
@auth_required
def create_user():
    deny = _admin_only()
    if deny:
        return deny

    data     = request.get_json() or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''

    if not USERNAME_RE.match(username):
        return jsonify({
            'error': 'Username must be 3–24 chars (letters, digits, _ or -)'
        }), 400
    if len(password) < 4:
        return jsonify({'error': 'Password must be at least 4 characters'}), 400

    with USERS_LOCK:
        if any(u['username'].lower() == username.lower() for u in USERS):
            return jsonify({'error': 'Username already exists'}), 400

        new_user = {
            'id':       _next_user_id(),
            'username': username,
            'hash':     generate_password_hash(password),
            'role':     'guest',
        }
        USERS.append(new_user)
        _save_guest_users()

    return jsonify({
        'id': new_user['id'], 'username': new_user['username'], 'role': 'guest'
    }), 201


@app.route('/api/admin/users/<username>', methods=['DELETE'])
@auth_required
def delete_user(username):
    deny = _admin_only()
    if deny:
        return deny

    global USERS
    with USERS_LOCK:
        target = next((u for u in USERS if u['username'] == username), None)
        if not target:
            return jsonify({'error': 'User not found'}), 404
        if target['role'] == 'admin':
            return jsonify({'error': 'Cannot delete admin user'}), 400

        USERS = [u for u in USERS if u['username'] != username]
        _save_guest_users()

    # Kick any active socket sessions for this user
    sids = [sid for sid, u in connected_users.items() if u['username'] == username]
    for sid in sids:
        try:
            socketio.server.disconnect(sid)
        except Exception:
            pass

    return jsonify({'message': f'User "{username}" deleted'})


# ── Routing proxy endpoints ───────────────────────────────────────────────────
@app.route('/api/matrix', methods=['POST'])
@auth_required
def matrix():
    data      = request.get_json() or {}
    locations = data.get('locations', [])
    n = len(locations)
    if n < 2:
        return jsonify({'error': 'Provide at least 2 locations'}), 400
    if n > 100:
        return jsonify({'error': f'{n} is too many — please use ≤ 100.'}), 400

    coords = ';'.join(f"{l['lng']},{l['lat']}" for l in locations)
    try:
        return jsonify(osrm_get(f'/table/v1/driving/{coords}?annotations=duration,distance'))
    except RuntimeError as e:
        return jsonify({'error': str(e)}), 503


@app.route('/api/route', methods=['POST'])
@auth_required
def route_handler():
    data      = request.get_json() or {}
    locations = data.get('locations', [])
    if len(locations) < 2:
        return jsonify({'error': 'Provide at least 2 locations'}), 400

    coords = ';'.join(f"{l['lng']},{l['lat']}" for l in locations)
    try:
        return jsonify(osrm_get(
            f'/route/v1/driving/{coords}?overview=full&geometries=geojson'
        ))
    except RuntimeError as e:
        return jsonify({'error': str(e)}), 503


# ── Pairwise time-optimal routing (traffic-aware) ────────────────────────────
def _score_alternative(route, traffic_level):
    """
    Apply a per-route traffic impact based on the route's average speed
    (a proxy for road class — highways suffer more from traffic than urban
    streets). Returns the traffic-adjusted travel time in seconds.

      road_factor = clamp(avg_speed / 30 m/s, 0.3 .. 1.5)
                    (~1.5 for motorway-heavy, ~0.3 for backstreet-heavy)
      eff_dur     = dur * (1 + (traffic_level - 1) * road_factor)
    """
    dist_m = route.get('distance', 0.0)
    dur_s  = route.get('duration', 0.0)
    if dur_s <= 0:
        return None
    avg_speed   = dist_m / dur_s                    # m/s
    road_factor = max(0.3, min(1.5, avg_speed / 30.0))
    traffic_imp = 1.0 + (traffic_level - 1.0) * road_factor
    return dur_s * traffic_imp, dist_m, route['geometry']['coordinates']


def _route_pair(i, j, locations, traffic_level):
    """Fetch alternatives for one pair and return the time-optimal one."""
    a, b = locations[i], locations[j]
    coords = f"{a['lng']},{a['lat']};{b['lng']},{b['lat']}"
    try:
        data = osrm_get(
            f'/route/v1/driving/{coords}'
            f'?alternatives=true&overview=full&geometries=geojson'
        )
    except RuntimeError:
        return (i, j, None)

    if data.get('code') != 'Ok' or not data.get('routes'):
        return (i, j, None)

    best = None
    for r in data['routes']:
        scored = _score_alternative(r, traffic_level)
        if scored is None:
            continue
        eff_dur, dist, geom = scored
        if best is None or eff_dur < best[0]:
            best = (eff_dur, dist, geom)
    return (i, j, best)


@app.route('/api/pairwise-matrix', methods=['POST'])
@auth_required
def pairwise_matrix():
    """
    For every pair (i, j) of waypoints, fetch up to 3 alternative routes
    from OSRM and pick the one with the lowest *traffic-adjusted* travel
    time. Returns:
      - durations [n][n]  — traffic-adjusted seconds (symmetric)
      - distances [n][n]  — metres of the chosen route
      - geometries {"i-j": [[lng,lat], ...]}  — chosen sub-route for each leg

    This guarantees that the TSP solver works with TIME under live traffic,
    AND that the actual path between any two stops is the fastest available
    one — not just the order of visits.
    """
    data = request.get_json() or {}
    locations = data.get('locations', [])
    try:
        traffic_level = float(data.get('trafficLevel', 1.0))
    except (TypeError, ValueError):
        traffic_level = 1.0

    n = len(locations)
    if n < 2:
        return jsonify({'error': 'Provide at least 2 locations'}), 400
    if n > 100:
        return jsonify({
            'error': f'{n} is too many — OSRM demo server can\'t handle that many in one batch. Please use ≤ 100.'
        }), 400

    INF = 1e15

    # ── FAST BULK PATH (n > PAIRWISE_MAX_N) ────────────────────────────────────
    # For many stops, n²/2 separate /route calls hammer the OSRM demo server and
    # take minutes. Instead, fetch the entire duration/distance matrix in ONE
    # /table call. We lose per-pair alternative-route selection, but a uniform
    # traffic multiplier is applied and the tour geometry is fetched afterward.
    if n > PAIRWISE_MAX_N:
        coords = ';'.join(f"{l['lng']},{l['lat']}" for l in locations)
        try:
            tbl = osrm_get(f'/table/v1/driving/{coords}?annotations=duration,distance')
        except RuntimeError as e:
            return jsonify({'error': str(e)}), 503
        if tbl.get('code') != 'Ok':
            return jsonify({'error': 'Routing table unavailable'}), 503

        raw_dur  = tbl.get('durations') or []
        raw_dist = tbl.get('distances') or []
        durations = [[0.0 if i == j else INF for j in range(n)] for i in range(n)]
        distances = [[0.0 if i == j else INF for j in range(n)] for i in range(n)]
        for i in range(n):
            for j in range(n):
                if i == j:
                    continue
                d  = raw_dur[i][j]  if i < len(raw_dur)  and j < len(raw_dur[i])  else None
                ds = raw_dist[i][j] if i < len(raw_dist) and j < len(raw_dist[i]) else None
                durations[i][j] = (d * traffic_level) if d is not None else INF
                distances[i][j] = ds if ds is not None else INF
        return jsonify({
            'durations':    durations,
            'distances':    distances,
            'geometries':   {},        # client fetches the final tour geometry once
            'trafficLevel': traffic_level,
            'n':            n,
            'mode':         'table'
        })

    # ── QUALITY PATH (small n) ─────────────────────────────────────────────────
    # Per-pair /route?alternatives so each leg uses its time-optimal path.
    durations  = [[0.0 if i == j else INF for j in range(n)] for i in range(n)]
    distances  = [[0.0 if i == j else INF for j in range(n)] for i in range(n)]
    geometries = {}
    pairs = [(i, j) for i in range(n) for j in range(i + 1, n)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        for i, j, best in pool.map(
            lambda p: _route_pair(p[0], p[1], locations, traffic_level), pairs
        ):
            if best is None:
                continue
            eff_dur, dist, geom = best
            durations[i][j] = durations[j][i] = eff_dur
            distances[i][j] = distances[j][i] = dist
            geometries[f'{i}-{j}'] = geom
            geometries[f'{j}-{i}'] = list(reversed(geom))

    return jsonify({
        'durations':    durations,
        'distances':    distances,
        'geometries':   geometries,
        'trafficLevel': traffic_level,
        'n':            n,
        'mode':         'pairwise'
    })


# ── Socket.IO real-time sync ──────────────────────────────────────────────────
def _can_remove(user, wp):
    """Admin can remove anything; guest can remove only their own non-admin pins."""
    if user['role'] == 'admin':
        return True
    return wp['owner'] == user['username'] and wp['ownerRole'] != 'admin'


def _can_move(user, wp):
    """Admin can move anything; everyone else can only move their own pins."""
    if user['role'] == 'admin':
        return True
    return wp['owner'] == user['username']


@socketio.on('connect')
def on_connect(auth):
    token = (auth or {}).get('token') if isinstance(auth, dict) else None
    if not token:
        return False
    try:
        user = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])
    except jwt.InvalidTokenError:
        return False

    connected_users[request.sid] = {
        'id':       user['id'],
        'username': user['username'],
        'role':     user['role']
    }
    # Send the current waypoint set to the newly-connected client
    emit('init', {'waypoints': list(waypoints_db.values())})
    # Announce updated user count to everyone
    emit('presence', {'count': len(connected_users)}, broadcast=True)


@socketio.on('disconnect')
def on_disconnect():
    connected_users.pop(request.sid, None)
    emit('presence', {'count': len(connected_users)}, broadcast=True)


def _in_thailand_bbox(lat, lng):
    return 5.5 <= lat <= 20.5 and 97.3 <= lng <= 105.7


@socketio.on('add_waypoint')
def on_add_waypoint(data):
    user = connected_users.get(request.sid)
    if not user:
        return

    try:
        lat     = float(data['lat'])
        lng     = float(data['lng'])
        wp_type = data.get('type', 'normal')   # 'normal' | 'center'
        if wp_type not in ('normal', 'center'):
            wp_type = 'normal'
        wp = {
            'id':        str(data['id']),
            'lat':       lat,
            'lng':       lng,
            'name':      str(data.get('name', '')),
            'owner':     user['username'],
            'ownerRole': user['role'],
            'type':      wp_type
        }
    except (KeyError, ValueError, TypeError):
        return

    # Big Center: only one allowed, only admin can set
    if wp_type == 'center':
        if user['role'] != 'admin':
            emit('action_denied', {'reason': 'Only the admin can set the Big Center.'})
            return
        # Replace any existing center
        for old_id in [wid for wid, w in waypoints_db.items() if w.get('type') == 'center']:
            del waypoints_db[old_id]
            emit('waypoint_removed', {'id': old_id}, broadcast=True)

    # Defence-in-depth: bbox enforcement
    if not _in_thailand_bbox(lat, lng):
        emit('action_denied', {'reason': 'Pins must be inside Thailand'})
        return

    waypoints_db[wp['id']] = wp
    emit('waypoint_added', wp, broadcast=True)


@socketio.on('remove_waypoint')
def on_remove_waypoint(data):
    user = connected_users.get(request.sid)
    if not user:
        return

    wp_id = str(data.get('id', ''))
    wp    = waypoints_db.get(wp_id)
    if not wp:
        return

    if _can_remove(user, wp):
        del waypoints_db[wp_id]
        emit('waypoint_removed', {'id': wp_id}, broadcast=True)
    else:
        emit('action_denied', {'reason': 'You cannot remove an admin pin.'})


@socketio.on('move_waypoint')
def on_move_waypoint(data):
    user = connected_users.get(request.sid)
    if not user:
        return

    wp_id = str(data.get('id', ''))
    wp    = waypoints_db.get(wp_id)
    if not wp or not _can_move(user, wp):
        return

    try:
        new_lat = float(data['lat'])
        new_lng = float(data['lng'])
    except (KeyError, ValueError, TypeError):
        return

    if not _in_thailand_bbox(new_lat, new_lng):
        emit('action_denied', {'reason': 'Pins must be inside Thailand'})
        return

    wp['lat'] = new_lat
    wp['lng'] = new_lng
    emit('waypoint_moved',
         {'id': wp_id, 'lat': wp['lat'], 'lng': wp['lng']},
         broadcast=True)


@socketio.on('clear_all')
def on_clear_all():
    user = connected_users.get(request.sid)
    if not user or user['role'] != 'admin':
        return
    waypoints_db.clear()
    emit('all_cleared', {}, broadcast=True)


# ── Start ─────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print(f'\n  TSP Route Optimizer: http://localhost:{PORT}')
    print('  Credentials: admin / admin123   |   guest / guest123')
    print('  Real-time sync enabled (Socket.IO)\n')
    # Note: using werkzeug directly because Flask-SocketIO 5.6's run() helper
    # has a bug where /socket.io/* routes return 404 in threading mode.
    from werkzeug.serving import run_simple
    run_simple('0.0.0.0', PORT, app, threaded=True, use_reloader=False)
