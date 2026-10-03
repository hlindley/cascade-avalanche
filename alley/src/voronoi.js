// 2.5D pre-fracture for planar infill.
// A rectangle is tessellated into convex Voronoi cells (exact half-plane clipping),
// so each cell extrudes to a convex prism whose convex-hull collider matches the
// rendered shape exactly. Holes are made by removing cells, never by decals.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cheap deterministic 2D value noise in [0,1].
export function hash2(x, y, s = 0) {
  let h = Math.imul((x | 0) ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul((y | 0) + s * 7919, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;
}

export function valueNoise(x, y, s = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s);
  const c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Variable-radius Bridson Poisson-disk sampling. radiusAt(x,y) returns the local spacing.
export function poissonDisk(w, h, rMin, rMax, radiusAt, rng, k = 20) {
  const cell = rMin / Math.SQRT2;
  const gw = Math.ceil(w / cell) + 1, gh = Math.ceil(h / cell) + 1;
  const grid = new Int32Array(gw * gh).fill(-1);
  const pts = [], rad = [], active = [];
  const reach = Math.ceil(rMax / cell) + 1;
  const add = (x, y) => {
    const i = pts.length / 2;
    pts.push(x, y);
    rad.push(radiusAt(x, y));
    grid[Math.floor(y / cell) * gw + Math.floor(x / cell)] = i;
    active.push(i);
  };
  const ok = (x, y, r) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let j = Math.max(0, gy - reach); j <= Math.min(gh - 1, gy + reach); j++) {
      for (let i = Math.max(0, gx - reach); i <= Math.min(gw - 1, gx + reach); i++) {
        const q = grid[j * gw + i];
        if (q < 0) continue;
        const dx = pts[q * 2] - x, dy = pts[q * 2 + 1] - y;
        const rr = (r + rad[q]) * 0.5;
        if (dx * dx + dy * dy < rr * rr) return false;
      }
    }
    return true;
  };
  add(rng() * w, rng() * h);
  while (active.length) {
    const ai = Math.floor(rng() * active.length);
    const p = active[ai];
    const px = pts[p * 2], py = pts[p * 2 + 1], pr = rad[p];
    let placed = false;
    for (let t = 0; t < k; t++) {
      const ang = rng() * Math.PI * 2;
      const dist = pr * (1 + rng());
      const x = px + Math.cos(ang) * dist, y = py + Math.sin(ang) * dist;
      if (ok(x, y, radiusAt(x, y))) { add(x, y); placed = true; break; }
    }
    if (!placed) active.splice(ai, 1);
  }
  return pts;
}

// Clip a labelled convex polygon by the half-plane (p - m)·d <= 0.
// verts: [x0,y0,x1,y1,...], labels[i] labels edge i -> i+1.
function clip(verts, labels, mx, my, dx, dy, newLabel) {
  const n = verts.length / 2;
  const ov = [], ol = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = verts[i * 2], ay = verts[i * 2 + 1], bx = verts[j * 2], by = verts[j * 2 + 1];
    const fa = (ax - mx) * dx + (ay - my) * dy;
    const fb = (bx - mx) * dx + (by - my) * dy;
    const ain = fa <= 0, bin = fb <= 0;
    if (ain) { ov.push(ax, ay); ol.push(labels[i]); }
    if (ain !== bin) {
      const t = fa / (fa - fb);
      ov.push(ax + (bx - ax) * t, ay + (by - ay) * t);
      ol.push(ain ? newLabel : labels[i]);
    }
  }
  // drop near-duplicate vertices
  const fv = [], fl = [];
  const m = ov.length / 2;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ddx = ov[j * 2] - ov[i * 2], ddy = ov[j * 2 + 1] - ov[i * 2 + 1];
    if (ddx * ddx + ddy * ddy < 1e-8 && m > 3) continue;
    fv.push(ov[i * 2], ov[i * 2 + 1]);
    fl.push(ol[i]);
  }
  return [fv, fl];
}

// Boundary edge labels.
export const EDGE_BOTTOM = -1, EDGE_RIGHT = -2, EDGE_TOP = -3, EDGE_LEFT = -4;

/**
 * Fracture a w×h rectangle into convex Voronoi cells.
 * Returns { cells: [{ poly:Float64Array, labels:Int32Array, cx, cy, area, neighbors:number[] }] }.
 */
export function fractureRect(w, h, opts = {}) {
  const rng = mulberry32(opts.seed ?? 1);
  const rMin = opts.rMin ?? 0.36, rMax = opts.rMax ?? 0.62;
  const radiusAt = opts.radiusAt ?? ((x, y) => {
    const n = valueNoise(x * 0.55, y * 0.55, opts.seed ?? 1);
    return rMin + (rMax - rMin) * n * n;
  });
  const seeds = poissonDisk(w, h, rMin, rMax, radiusAt, rng);
  const n = seeds.length / 2;
  // bucket seeds for neighbour search
  const bs = rMax * 1.5;
  const bw = Math.ceil(w / bs) + 1, bh = Math.ceil(h / bs) + 1;
  const buckets = Array.from({ length: bw * bh }, () => []);
  for (let i = 0; i < n; i++) buckets[Math.floor(seeds[i * 2 + 1] / bs) * bw + Math.floor(seeds[i * 2] / bs)].push(i);

  const cells = [];
  for (let i = 0; i < n; i++) {
    const sx = seeds[i * 2], sy = seeds[i * 2 + 1];
    const bx = Math.floor(sx / bs), by = Math.floor(sy / bs);
    const cand = [];
    for (let y = Math.max(0, by - 3); y <= Math.min(bh - 1, by + 3); y++)
      for (let x = Math.max(0, bx - 3); x <= Math.min(bw - 1, bx + 3); x++)
        for (const j of buckets[y * bw + x]) if (j !== i) {
          const dx = seeds[j * 2] - sx, dy = seeds[j * 2 + 1] - sy;
          cand.push([dx * dx + dy * dy, j]);
        }
    cand.sort((a, b) => a[0] - b[0]);
    let verts = [0, 0, w, 0, w, h, 0, h];
    let labels = [EDGE_BOTTOM, EDGE_RIGHT, EDGE_TOP, EDGE_LEFT];
    for (const [d2, j] of cand) {
      // stop once no remaining neighbour can cut this cell
      let maxR2 = 0;
      for (let k = 0; k < verts.length; k += 2) {
        const dx = verts[k] - sx, dy = verts[k + 1] - sy;
        maxR2 = Math.max(maxR2, dx * dx + dy * dy);
      }
      if (d2 > 4 * maxR2) break;
      const ox = seeds[j * 2], oy = seeds[j * 2 + 1];
      [verts, labels] = clip(verts, labels, (sx + ox) / 2, (sy + oy) / 2, ox - sx, oy - sy, j);
      if (verts.length < 6) break;
    }
    if (verts.length < 6) continue;
    // weld: shared Voronoi vertices are computed independently per cell; snapping them
    // to a common grid makes neighbouring edges bit-identical so the intact slab is watertight
    {
      const q = 1e4;
      const wv = [], wl = [];
      const m0 = verts.length / 2;
      for (let k = 0; k < m0; k++) {
        const x = Math.round(verts[k * 2] * q) / q, y = Math.round(verts[k * 2 + 1] * q) / q;
        const px = wv.length ? wv[wv.length - 2] : NaN, py = wv.length ? wv[wv.length - 1] : NaN;
        if (x === px && y === py) { wl[wl.length - 1] = labels[k]; continue; }
        wv.push(x, y); wl.push(labels[k]);
      }
      if (wv.length >= 6 && wv[0] === wv[wv.length - 2] && wv[1] === wv[wv.length - 1]) { wv.length -= 2; wl.pop(); }
      verts = wv; labels = wl;
    }
    if (verts.length < 6) continue;
    // centroid / area
    let a = 0, cx = 0, cy = 0;
    const m = verts.length / 2;
    for (let k = 0; k < m; k++) {
      const x0 = verts[k * 2], y0 = verts[k * 2 + 1];
      const x1 = verts[((k + 1) % m) * 2], y1 = verts[((k + 1) % m) * 2 + 1];
      const c = x0 * y1 - x1 * y0;
      a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
    }
    a *= 0.5;
    if (a < 1e-4) continue;
    cells.push({ seed: i, poly: Float64Array.from(verts), labels: Int32Array.from(labels), cx: cx / (6 * a), cy: cy / (6 * a), area: a });
  }
  // map seed index -> cell index, build symmetric adjacency
  const seedToCell = new Int32Array(n).fill(-1);
  cells.forEach((c, ci) => (seedToCell[c.seed] = ci));
  const adj = cells.map(() => new Set());
  cells.forEach((c, ci) => {
    for (const l of c.labels) if (l >= 0 && seedToCell[l] >= 0) {
      adj[ci].add(seedToCell[l]);
      adj[seedToCell[l]].add(ci);
    }
  });
  cells.forEach((c, ci) => (c.neighbors = [...adj[ci]]));
  return { cells, width: w, height: h };
}
