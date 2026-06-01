/* ════════════════════════════════════════════════════════════════
   TSP Web Worker
   - Runs Held-Karp DP and the heuristic on its OWN thread.
   - Main page stays responsive (no freezing) and can show smooth
     progress because it's not being CPU-blocked.
   - On out-of-memory or excessive size, gracefully falls back
     to the heuristic and tells the caller what was actually run.
════════════════════════════════════════════════════════════════ */

/* ── small helpers ─────────────────────────────────────────────── */
function routeCost(route, matrix) {
  let c = 0; const n = route.length;
  for (let i = 0; i < n; i++) c += matrix[route[i]][route[(i + 1) % n]];
  return c;
}

function nearestNeighbor(matrix, start) {
  const n = matrix.length;
  const visited = new Set([start]);
  const route = [start];
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
        const a = route[i], b = route[i + 1];
        const c = route[j], d = route[(j + 1) % n];
        if ((matrix[a][c] + matrix[b][d]) < (matrix[a][b] + matrix[c][d]) - 1e-10) {
          let l = i + 1, r = j;
          while (l < r) { [route[l], route[r]] = [route[r], route[l]]; l++; r--; }
          improved = true;
        }
      }
    }
  }
  return route;
}

function heuristicTSP(matrix) {
  const n = matrix.length;
  let best = null, bestCost = Infinity;
  const starts = (n > 30)
    ? Array.from({ length: 12 }, (_, k) => Math.floor(k * n / 12))
    : Array.from({ length: n }, (_, k) => k);
  for (const start of starts) {
    const r = nearestNeighbor(matrix, start);
    if (r.length !== n) continue;
    twoOpt(r, matrix);
    const c = routeCost(r, matrix);
    if (c < bestCost) { bestCost = c; best = [...r]; }
  }
  return { route: best, cost: bestCost };
}

/* ── Held-Karp DP (synchronous — we have our own thread) ───────── */
function heldKarp(matrix, postProgress) {
  const n = matrix.length;
  if (n === 1) return { route: [0], cost: 0 };
  if (n === 2) return { route: [0, 1], cost: matrix[0][1] + matrix[1][0] };

  const FULL = (1 << n) - 1;
  const SIZE = (1 << n) * n;
  const dp     = new Float32Array(SIZE);
  const parent = new Int16Array(SIZE);
  dp.fill(Infinity);
  parent.fill(-1);
  dp[(1 << 0) * n + 0] = 0;

  let lastTick = Date.now();
  for (let mask = 1; mask <= FULL; mask++) {
    if (!(mask & 1)) continue;
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      const cur = dp[mask * n + i];
      if (cur === Infinity) continue;
      for (let j = 1; j < n; j++) {
        if (mask & (1 << j)) continue;
        const next = mask | (1 << j);
        const cand = cur + matrix[i][j];
        const idx  = next * n + j;
        if (cand < dp[idx]) { dp[idx] = cand; parent[idx] = i; }
      }
    }
    // Report progress every ~120 ms — the main thread updates the bar smoothly
    if (postProgress && Date.now() - lastTick > 120) {
      postProgress(mask / FULL);
      lastTick = Date.now();
    }
  }

  let bestCost = Infinity, bestEnd = -1;
  for (let i = 1; i < n; i++) {
    const total = dp[FULL * n + i] + matrix[i][0];
    if (total < bestCost) { bestCost = total; bestEnd = i; }
  }
  if (bestEnd === -1) return null;

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

/* ── Message handler ───────────────────────────────────────────── */
const MAX_HELDKARP_N = 22;   // worker memory cap (≈550 MB peak)

self.onmessage = (e) => {
  const { matrix, mode, requestId } = e.data;
  const n = matrix.length;

  const post = (msg) => self.postMessage({ ...msg, requestId });

  function runHeuristic(label) {
    const h = heuristicTSP(matrix);
    post({
      type: 'done',
      result: h,
      algorithm: label,
      mode: 'heuristic',
      heuristicCost: null
    });
  }

  try {
    if (mode === 'optimal' && n <= MAX_HELDKARP_N) {
      // Compute the heuristic too (for the comparison "saved Xs" line)
      const heur = heuristicTSP(matrix);
      const exact = heldKarp(matrix, (frac) =>
        post({ type: 'progress', fraction: frac })
      );
      if (exact) {
        post({
          type:          'done',
          result:        exact,
          algorithm:     'Held-Karp DP',
          mode:          'optimal',
          heuristicCost: heur ? heur.cost : null
        });
        return;
      }
      // Held-Karp gave up (disconnected graph) → heuristic
      runHeuristic('Nearest-Neighbour + 2-opt');
      return;
    }
    // Either explicit heuristic mode, or n past the Held-Karp ceiling
    runHeuristic(
      (mode === 'optimal' && n > MAX_HELDKARP_N)
        ? 'Multi-start NN + 2-opt'
        : 'Nearest-Neighbour + 2-opt'
    );
  } catch (err) {
    // Out of memory or other failure → heuristic last-ditch
    try {
      const h = heuristicTSP(matrix);
      post({
        type:          'done',
        result:        h,
        algorithm:     'NN + 2-opt (Held-Karp out of memory)',
        mode:          'heuristic',
        heuristicCost: null
      });
    } catch (err2) {
      post({ type: 'error', message: String(err) });
    }
  }
};
