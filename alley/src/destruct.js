import * as THREE from 'three';
import { fractureRect, hash2, valueNoise, EDGE_BOTTOM, EDGE_RIGHT, EDGE_TOP, EDGE_LEFT } from './voronoi.js';
import { GROUP_CELL } from './physics.js';

// Destructible infill: a thick planar slab pre-fractured into convex Voronoi prisms.
// Rendering, collision and line of sight all derive from the same per-cell alive mask,
// so a visible hole is always a real hole.

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

let impactSerial = 1;

export class Panel {
  constructor(sys, o) {
    this.sys = sys;
    this.name = o.name;
    this.width = o.width;
    this.height = o.height;
    this.thickness = o.thickness ?? 0.4;
    this.maxHp = o.hp ?? 100;
    this.supportRatio = o.supportRatio ?? 0.09;
    this.kind = o.kind ?? 'masonry';
    this.debrisTint = o.debrisTint ?? new THREE.Color(0xd8d2c4);
    this.u = o.u.clone().normalize();
    this.v = o.v.clone().normalize();
    this.n = new THREE.Vector3().crossVectors(this.u, this.v).normalize();
    this.origin = o.origin.clone();
    this.matrix = new THREE.Matrix4().makeBasis(this.u, this.v, this.n).setPosition(this.origin);
    this.inverse = this.matrix.clone().invert();
    this.quaternion = new THREE.Quaternion().setFromRotationMatrix(_m.makeBasis(this.u, this.v, this.n));
    const anchors = { bottom: 3, right: 1.6, top: 0.7, left: 1.6, ...(o.anchors ?? {}) };
    this.anchorW = { [EDGE_BOTTOM]: anchors.bottom, [EDGE_RIGHT]: anchors.right, [EDGE_TOP]: anchors.top, [EDGE_LEFT]: anchors.left };

    const t0 = performance.now();
    const frac = fractureRect(this.width, this.height, { seed: o.seed ?? 1, rMin: o.rMin ?? 0.3, rMax: o.rMax ?? 0.56 });
    this.cells = frac.cells;
    const N = (this.N = this.cells.length);
    this.hp = new Float32Array(N).fill(this.maxHp);
    this.alive = new Uint8Array(N).fill(1);
    this.scorch = new Float32Array(N);
    this.anchor = new Float32Array(N);
    this.cells.forEach((c, i) => {
      const m = c.labels.length;
      for (let k = 0; k < m; k++) {
        const l = c.labels[k];
        if (l < 0) {
          const k2 = (k + 1) % m;
          const len = Math.hypot(c.poly[k2 * 2] - c.poly[k * 2], c.poly[k2 * 2 + 1] - c.poly[k * 2 + 1]);
          this.anchor[i] += (this.anchorW[l] ?? 0) * len;
        }
      }
    });
    this.materials = o.materials;
    this._buildGeometry();
    this._buildColliders();
    this.buildMs = performance.now() - t0;
    this.attachments = [];
    this.disabled = [];
    // world-space bounding sphere for broad tests
    this.center = new THREE.Vector3(this.width / 2, this.height / 2, -this.thickness / 2).applyMatrix4(this.matrix);
    this.radius = Math.hypot(this.width, this.height) / 2 + 0.5;
  }

  // In-plane jitter applied to the inner face so fracture sides are not perfectly perpendicular.
  _jitter(x, y) {
    const eps = 1e-3;
    if (x < eps || y < eps || x > this.width - eps || y > this.height - eps) return [x, y];
    const qx = Math.round(x * 1000), qy = Math.round(y * 1000);
    const a = hash2(qx, qy, 11) * Math.PI * 2;
    const r = 0.03 + hash2(qx, qy, 23) * 0.06;
    return [x + Math.cos(a) * r, y + Math.sin(a) * r];
  }

  _buildGeometry() {
    const W = this.width, H = this.height, T = this.thickness;
    const pos = [], nor = [], uv = [], col = [];
    const io = [], ii = [], is = [];
    const N = this.N;
    this.vStart = new Int32Array(N);
    this.vCount = new Int32Array(N);
    this.oStart = new Int32Array(N); this.oCount = new Int32Array(N);
    this.iStart = new Int32Array(N); this.iCount = new Int32Array(N);
    this.sStart = new Int32Array(N); this.sCount = new Int32Array(N);
    this.innerPoly = [];
    for (let c = 0; c < N; c++) {
      const P = this.cells[c].poly;
      const n = P.length / 2;
      const Q = new Float64Array(P.length);
      for (let k = 0; k < n; k++) {
        const [x, y] = this._jitter(P[k * 2], P[k * 2 + 1]);
        Q[k * 2] = x; Q[k * 2 + 1] = y;
      }
      this.innerPoly.push(Q);
      const base = pos.length / 3;
      this.vStart[c] = base;
      // outer cap
      for (let k = 0; k < n; k++) {
        pos.push(P[k * 2], P[k * 2 + 1], 0);
        nor.push(0, 0, 1);
        uv.push(P[k * 2] / W, P[k * 2 + 1] / H);
        col.push(1, 1, 1);
      }
      // inner cap
      for (let k = 0; k < n; k++) {
        pos.push(Q[k * 2], Q[k * 2 + 1], -T);
        nor.push(0, 0, -1);
        uv.push(Q[k * 2] * 0.35, Q[k * 2 + 1] * 0.35);
        col.push(1, 1, 1);
      }
      // sides
      let s = hash2(c, 3, 5) * 4;
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        const ax = P[k * 2], ay = P[k * 2 + 1], bx = P[k2 * 2], by = P[k2 * 2 + 1];
        const cx = Q[k2 * 2], cy = Q[k2 * 2 + 1], dx = Q[k * 2], dy = Q[k * 2 + 1];
        // normal of (a, d, b)
        const e1x = dx - ax, e1y = dy - ay, e1z = -T;
        const e2x = bx - ax, e2y = by - ay, e2z = 0;
        let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        const len = Math.hypot(bx - ax, by - ay);
        pos.push(ax, ay, 0, bx, by, 0, cx, cy, -T, dx, dy, -T);
        for (let q = 0; q < 4; q++) nor.push(nx, ny, nz);
        uv.push(s, 0, s + len, 0, s + len, T, s, T);
        // fracture faces get slightly darker toward the core
        col.push(1, 1, 1, 1, 1, 1, 0.78, 0.78, 0.78, 0.78, 0.78, 0.78);
        s += len;
      }
      this.vCount[c] = pos.length / 3 - base;
      const oc = base, ic = base + n, sc = base + 2 * n;
      this.oStart[c] = io.length;
      for (let k = 1; k < n - 1; k++) io.push(oc, oc + k, oc + k + 1);
      this.oCount[c] = io.length - this.oStart[c];
      this.iStart[c] = ii.length;
      for (let k = 1; k < n - 1; k++) ii.push(ic, ic + k + 1, ic + k);
      this.iCount[c] = ii.length - this.iStart[c];
      this.sStart[c] = is.length;
      for (let k = 0; k < n; k++) {
        const q = sc + k * 4;
        is.push(q, q + 3, q + 1, q + 1, q + 3, q + 2);
      }
      this.sCount[c] = is.length - this.sStart[c];
    }
    const oT = io.length, iT = ii.length;
    for (let c = 0; c < N; c++) { this.iStart[c] += oT; this.sStart[c] += oT + iT; }
    const index = new Uint32Array(io.length + ii.length + is.length);
    index.set(io, 0); index.set(ii, oT); index.set(is, oT + iT);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.addGroup(0, oT, 0);
    geo.addGroup(oT, iT, 1);
    geo.addGroup(oT + iT, is.length, 2);
    geo.computeBoundingSphere();
    this.geometry = geo;
    this.origIndex = index.slice();
    this.origPos = geo.attributes.position.array.slice();
    this.origCol = geo.attributes.color.array.slice();
    this.mesh = new THREE.Mesh(geo, this.materials);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrix.copy(this.matrix);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = `panel:${this.name}`;
    this.sys.scene.add(this.mesh);
    this.triangles = index.length / 3;
  }

  cellHullPoints(c, offset = null) {
    const P = this.cells[c].poly, Q = this.innerPoly[c];
    const n = P.length / 2;
    const pts = new Float32Array(n * 6);
    const ox = offset ? offset.x : 0, oy = offset ? offset.y : 0, oz = offset ? offset.z : 0;
    for (let k = 0; k < n; k++) {
      pts[k * 3] = P[k * 2] - ox; pts[k * 3 + 1] = P[k * 2 + 1] - oy; pts[k * 3 + 2] = -oz;
      pts[(n + k) * 3] = Q[k * 2] - ox; pts[(n + k) * 3 + 1] = Q[k * 2 + 1] - oy; pts[(n + k) * 3 + 2] = -this.thickness - oz;
    }
    return pts;
  }

  _buildColliders() {
    const { R, world } = this.sys.physics;
    this.body = world.createRigidBody(
      R.RigidBodyDesc.fixed().setTranslation(this.origin.x, this.origin.y, this.origin.z).setRotation(this.quaternion)
    );
    this.colliders = new Array(this.N);
    for (let c = 0; c < this.N; c++) {
      const desc = R.ColliderDesc.convexHull(this.cellHullPoints(c));
      if (!desc) continue;
      desc.setCollisionGroups(GROUP_CELL);
      const col = world.createCollider(desc, this.body);
      this.colliders[c] = col;
      this.sys.physics.setOwner(col, { kind: 'cell', panel: this, cell: c });
    }
  }

  toLocal(p, out = new THREE.Vector3()) {
    return out.copy(p).applyMatrix4(this.inverse);
  }

  toWorld(p, out = new THREE.Vector3()) {
    return out.copy(p).applyMatrix4(this.matrix);
  }

  aliveCount() {
    let n = 0;
    for (let i = 0; i < this.N; i++) n += this.alive[i];
    return n;
  }

  // --- visual damage state ---------------------------------------------------------
  _refreshCellLook(c) {
    const posA = this.geometry.attributes.position.array;
    const colA = this.geometry.attributes.color.array;
    const dmg = 1 - Math.max(0, this.hp[c]) / this.maxHp;
    const sc = Math.min(1, this.scorch[c]);
    const n = this.cells[c].poly.length / 2;
    const v0 = this.vStart[c];
    // recess cracked cells so neighbouring fracture faces show as crack lines
    const recess = dmg > 0.05 ? (0.015 + dmg * 0.07) * (0.6 + hash2(c, 9, 1) * 0.8) : 0;
    const tiltX = (hash2(c, 4, 2) - 0.5) * dmg * 0.08, tiltY = (hash2(c, 6, 3) - 0.5) * dmg * 0.08;
    const cx = this.cells[c].cx, cy = this.cells[c].cy;
    const shade = (1 - dmg * 0.22) * (1 - sc * 0.72);
    for (let k = 0; k < n; k++) {
      const vi = v0 + k;
      const x = posA[vi * 3], y = posA[vi * 3 + 1];
      posA[vi * 3 + 2] = -recess + (x - cx) * tiltX + (y - cy) * tiltY;
      const g = shade * (0.97 + hash2(c, 0, 7) * 0.03);
      colA[vi * 3] = g; colA[vi * 3 + 1] = g * 0.97; colA[vi * 3 + 2] = g * 0.94;
    }
    for (let k = 0; k < n; k++) {
      const q = v0 + 2 * n + k * 4;
      posA[q * 3 + 2] = posA[(v0 + k) * 3 + 2];
      posA[(q + 1) * 3 + 2] = posA[(v0 + (k + 1) % n) * 3 + 2];
    }
    this._dirtyPos = true;
    this._dirtyCol = true;
  }

  flush() {
    const g = this.geometry;
    if (this._dirtyIndex) { g.index.needsUpdate = true; this._dirtyIndex = false; }
    if (this._dirtyPos) { g.attributes.position.needsUpdate = true; this._dirtyPos = false; }
    if (this._dirtyCol) { g.attributes.color.needsUpdate = true; this._dirtyCol = false; }
  }

  damageCell(c, amount, out) {
    if (!this.alive[c]) return;
    this.hp[c] -= amount;
    if (this.hp[c] <= 0) out.push(c);
    else this._refreshCellLook(c);
  }

  addScorch(c, s) {
    if (!this.alive[c]) return;
    this.scorch[c] = Math.min(1, this.scorch[c] + s);
    this._refreshCellLook(c);
  }

  _kill(c) {
    if (!this.alive[c]) return false;
    this.alive[c] = 0;
    const idx = this.geometry.index.array;
    idx.fill(0, this.oStart[c], this.oStart[c] + this.oCount[c]);
    idx.fill(0, this.iStart[c], this.iStart[c] + this.iCount[c]);
    idx.fill(0, this.sStart[c], this.sStart[c] + this.sCount[c]);
    this._dirtyIndex = true;
    const col = this.colliders[c];
    if (col) { col.setEnabled(false); this.disabled.push(c); }
    return true;
  }

  // Remove cells, emit debris, then evaluate support. ctx: { kind, point, dir, speed }
  removeCells(list, ctx) {
    const removed = [];
    for (const c of list) if (this._kill(c)) removed.push(c);
    if (!removed.length) return removed;
    this.sys.debris.fromCells(this, removed, ctx);
    this.sys.stats.cellsRemoved += removed.length;
    this._checkSupport(ctx);
    this._checkAttachments();
    this.flush();
    return removed;
  }

  // Connected components of alive cells; components without enough anchoring fall.
  _checkSupport(ctx) {
    const N = this.N;
    const comp = new Int32Array(N).fill(-1);
    const stack = [];
    let id = 0;
    const releases = [];
    for (let s = 0; s < N; s++) {
      if (!this.alive[s] || comp[s] >= 0) continue;
      const members = [];
      let support = 0;
      comp[s] = id;
      stack.push(s);
      while (stack.length) {
        const c = stack.pop();
        members.push(c);
        support += this.anchor[c] * Math.max(0.15, this.hp[c] / this.maxHp);
        for (const nb of this.cells[c].neighbors) if (this.alive[nb] && comp[nb] < 0) { comp[nb] = id; stack.push(nb); }
      }
      const need = members.length <= 3 ? 0.01 : members.length * this.supportRatio;
      if (support < need) releases.push(members);
      id++;
    }
    for (const members of releases) {
      for (const c of members) this._kill(c);
      this.sys.stats.cellsReleased += members.length;
      this.sys.debris.releaseCluster(this, members, { ...ctx, kind: 'release' });
      this.sys.events.push({ type: 'release', panel: this.name, cells: members.length });
    }
  }

  _checkAttachments() {
    for (const a of this.attachments) {
      if (a.released) continue;
      let alive = 0;
      for (const c of a.mounts) alive += this.alive[c];
      if (alive < a.minMounts) a.release();
    }
  }

  // cells whose centroid lies within radius r of local point (x, y)
  cellsNear(x, y, r, aliveOnly = true) {
    const out = [];
    const r2 = r * r;
    for (let c = 0; c < this.N; c++) {
      if (aliveOnly && !this.alive[c]) continue;
      const dx = this.cells[c].cx - x, dy = this.cells[c].cy - y;
      if (dx * dx + dy * dy < r2) out.push(c);
    }
    return out;
  }

  cellAt(x, y) {
    let best = -1, bd = Infinity;
    for (let c = 0; c < this.N; c++) {
      const dx = this.cells[c].cx - x, dy = this.cells[c].cy - y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  // Concentrated kinetic damage: a clean, substantial bore with a cracked ring.
  cannonHit(hitCell, worldPoint, dir, energy = 1) {
    const t0 = performance.now();
    const lp = this.toLocal(worldPoint, _v);
    const seed = impactSerial++;
    const R = 1.2 * Math.sqrt(energy);
    const ang = hash2(seed, 1, 3) * Math.PI;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const squash = 0.7 + hash2(seed, 2, 3) * 0.3;
    const kill = [], ring = [];
    if (hitCell >= 0 && this.alive[hitCell]) kill.push(hitCell);
    for (let c = 0; c < this.N; c++) {
      if (!this.alive[c] || c === hitCell) continue;
      const dx = this.cells[c].cx - lp.x, dy = this.cells[c].cy - lp.y;
      const ex = dx * ca + dy * sa, ey = (-dx * sa + dy * ca) / squash;
      const d = Math.hypot(ex, ey);
      const jr = R * (0.8 + 0.45 * valueNoise(this.cells[c].cx * 2.3, this.cells[c].cy * 2.3, seed));
      if (d < jr) kill.push(c);
      else if (d < R * 2.3) ring.push([c, d]);
      if (d < R * 2.9) this.addScorch(c, 0.55 * (1 - d / (R * 2.9)));
    }
    for (const [c, d] of ring) {
      const f = 1 - (d - R) / (R * 1.3);
      this.damageCell(c, Math.max(0, f) * (42 + hash2(c, seed, 5) * 40) * energy, kill);
    }
    const removed = this.removeCells(kill, { kind: 'cannon', point: worldPoint.clone(), dir: dir.clone(), speed: 13 * energy });
    this.flush();
    this.sys.recordOp('cannon-fracture', performance.now() - t0, removed.length);
    return removed.length;
  }

  // Distributed explosive damage: coherent-noise falloff gives irregular broad loss.
  explode(worldPoint, radius, power, seed) {
    const lp = this.toLocal(worldPoint, _v);
    const kill = [];
    const T = this.thickness;
    for (let c = 0; c < this.N; c++) {
      if (!this.alive[c]) continue;
      const dx = this.cells[c].cx - lp.x, dy = this.cells[c].cy - lp.y, dz = -T / 2 - lp.z;
      const d = Math.hypot(dx, dy, dz * 0.6);
      if (d > radius * 1.7) continue;
      this.addScorch(c, 0.7 * Math.max(0, 1 - d / (radius * 1.7)));
      if (d > radius) continue;
      const noise = 0.45 + 1.1 * valueNoise(this.cells[c].cx * 1.4 + seed, this.cells[c].cy * 1.4, seed);
      const dmg = power * Math.pow(1 - d / radius, 0.7) * noise;
      this.damageCell(c, dmg, kill);
    }
    if (!kill.length) { this.flush(); return 0; }
    const removed = this.removeCells(kill, { kind: 'rocket', point: worldPoint.clone(), dir: this.n.clone().negate(), speed: 12 });
    this.flush();
    return removed.length;
  }

  // A heavy body hits the panel. Weakened infill inside the silhouette fails as a unit.
  ramImpact(worldPoint, dir, speed, halfW, halfH, centerY) {
    const t0 = performance.now();
    const lp = this.toLocal(worldPoint, _v);
    const cy = centerY !== undefined ? this.toLocal(new THREE.Vector3(worldPoint.x, centerY, worldPoint.z)).y : lp.y;
    const x0 = lp.x, y0 = Math.max(halfH * 0.6, cy);
    const dmg = speed * 3.3;
    const seed = impactSerial++;
    let regionArea = 0, weakArea = 0;
    const region = [];
    for (let c = 0; c < this.N; c++) {
      const cell = this.cells[c];
      const dx = (cell.cx - x0) / halfW, dy = (cell.cy - y0) / halfH;
      const wob = 0.85 + 0.3 * valueNoise(cell.cx * 1.7, cell.cy * 1.7, seed);
      if (dx ** 4 + dy ** 4 > wob) continue;
      regionArea += cell.area;
      if (!this.alive[c] || this.hp[c] <= dmg) weakArea += cell.area;
      if (this.alive[c]) region.push(c);
    }
    const frac = regionArea > 0 ? weakArea / regionArea : 0;
    const breached = frac >= 0.42;
    const kill = [];
    if (breached) {
      kill.push(...region);
      // dislodge the band directly above the breach: it has lost the material it sat on
      const top = y0 + halfH;
      for (let c = 0; c < this.N; c++) {
        if (!this.alive[c] || kill.includes(c)) continue;
        const cell = this.cells[c];
        if (cell.cy < top - 0.2 || cell.cy > top + 1.7 || Math.abs(cell.cx - x0) > halfW * 1.15) continue;
        const p = 0.3 + (1 - this.hp[c] / this.maxHp) * 0.7;
        if (hash2(c, seed, 13) < p) this.hp[c] = Math.min(this.hp[c], 1 + hash2(c, seed, 3) * 10);
      }
      // cracked ring around the breach
      for (let c = 0; c < this.N; c++) {
        if (!this.alive[c] || kill.includes(c)) continue;
        const cell = this.cells[c];
        const dx = (cell.cx - x0) / (halfW * 1.6), dy = (cell.cy - y0) / (halfH * 1.35);
        const d = Math.hypot(dx, dy);
        if (d < 1) this.damageCell(c, (1 - d) * 60, kill);
      }
    } else {
      for (const c of region) this.damageCell(c, dmg * 0.75, kill);
    }
    const removed = this.removeCells(kill, { kind: 'ram', point: worldPoint.clone(), dir: dir.clone(), speed: speed * 0.6 });
    if (breached) {
      // material left hanging above the breach with almost no strength gives way now
      const weak = [];
      for (let c = 0; c < this.N; c++) if (this.alive[c] && this.hp[c] < 12) weak.push(c);
      if (weak.length) {
        for (const c of weak) this._kill(c);
        this.sys.debris.releaseCluster(this, weak, { kind: 'release', point: worldPoint.clone(), dir: dir.clone(), speed: 1.5 });
        this.sys.stats.cellsReleased += weak.length;
        this._checkSupport({ kind: 'release', point: worldPoint.clone(), dir: dir.clone(), speed: 0 });
        this._checkAttachments();
      }
    }
    this.flush();
    this.sys.recordOp('ram-impact', performance.now() - t0, removed.length);
    return { breached, removed: removed.length, weakFraction: frac };
  }

  reset() {
    const g = this.geometry;
    g.index.array.set(this.origIndex);
    g.attributes.position.array.set(this.origPos);
    g.attributes.color.array.set(this.origCol);
    g.index.needsUpdate = g.attributes.position.needsUpdate = g.attributes.color.needsUpdate = true;
    this.hp.fill(this.maxHp);
    this.alive.fill(1);
    this.scorch.fill(0);
    for (const c of this.disabled) this.colliders[c]?.setEnabled(true);
    this.disabled.length = 0;
  }
}

// Detail objects mounted on infill. When their mounting cells are gone they become rigid bodies.
export class Attachment {
  constructor(sys, panel, object, o) {
    this.sys = sys;
    this.panel = panel;
    this.object = object;
    this.home = { p: object.position.clone(), q: object.quaternion.clone(), parent: object.parent };
    this.half = o.half;
    this.mass = o.mass ?? 400;
    this.minMounts = o.minMounts ?? 1;
    this.mounts = [];
    for (const m of o.mountsLocal) {
      const c = panel.cellAt(m.x, m.y);
      if (c >= 0 && !this.mounts.includes(c)) this.mounts.push(c);
      for (const nb of panel.cellsNear(m.x, m.y, 0.45, false)) if (!this.mounts.includes(nb)) this.mounts.push(nb);
    }
    this.minMounts = Math.min(this.minMounts, this.mounts.length);
    this.released = false;
    panel.attachments.push(this);
    sys.attachments.push(this);
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.object.updateWorldMatrix(true, false);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    this.object.matrixWorld.decompose(p, q, s);
    this.sys.scene.attach(this.object);
    this.sys.debris.attachBody(this, p, q);
    this.sys.events.push({ type: 'attachment', name: this.object.name });
  }

  reset() {
    this.released = false;
    this.home.parent.add(this.object);
    this.object.position.copy(this.home.p);
    this.object.quaternion.copy(this.home.q);
  }
}

// Window glass: thin panes that shatter on any projectile or heavy contact; no collision.
export class GlassPane {
  constructor(sys, center, u, v, hw, hh, material) {
    this.sys = sys;
    this.center = center.clone();
    this.u = u.clone().normalize();
    this.v = v.clone().normalize();
    this.n = new THREE.Vector3().crossVectors(this.u, this.v);
    this.hw = hw; this.hh = hh;
    const geo = new THREE.PlaneGeometry(hw * 2, hh * 2);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.position.copy(center);
    this.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(this.u, this.v, this.n));
    sys.scene.add(this.mesh);
    this.alive = true;
  }

  // segment intersection test
  intersect(p0, p1) {
    if (!this.alive) return null;
    const d0 = _v.copy(p0).sub(this.center).dot(this.n);
    const d1 = new THREE.Vector3().copy(p1).sub(this.center).dot(this.n);
    if (d0 * d1 > 0) return null;
    const t = d0 / (d0 - d1);
    const hit = new THREE.Vector3().lerpVectors(p0, p1, t);
    const rel = hit.clone().sub(this.center);
    if (Math.abs(rel.dot(this.u)) > this.hw || Math.abs(rel.dot(this.v)) > this.hh) return null;
    return { t, point: hit };
  }

  shatter(point, dir) {
    if (!this.alive) return;
    this.alive = false;
    this.mesh.visible = false;
    this.sys.fx.glassBurst(this, point, dir);
    this.sys.events.push({ type: 'glass' });
  }

  reset() {
    this.alive = true;
    this.mesh.visible = true;
  }
}

export class DestructionSystem {
  constructor(scene, physics, debris, fx) {
    this.scene = scene;
    this.physics = physics;
    this.debris = debris;
    this.fx = fx;
    this.panels = [];
    this.attachments = [];
    this.glass = [];
    this.events = [];
    this.ops = [];
    this.stats = { cellsRemoved: 0, cellsReleased: 0 };
  }

  addPanel(o) {
    const p = new Panel(this, o);
    this.panels.push(p);
    return p;
  }

  addGlass(center, u, v, hw, hh, material) {
    const g = new GlassPane(this, center, u, v, hw, hh, material);
    this.glass.push(g);
    return g;
  }

  recordOp(name, ms, count) {
    this.ops.push({ name, ms, count, t: performance.now() });
    if (this.ops.length > 200) this.ops.shift();
  }

  explosion(point, radius, power) {
    const t0 = performance.now();
    const seed = (impactSerial++ % 997) + 1;
    let removed = 0;
    for (const p of this.panels) {
      if (p.center.distanceTo(point) > p.radius + radius * 1.7) continue;
      removed += p.explode(point, radius, power, seed);
    }
    for (const g of this.glass) if (g.alive && g.center.distanceTo(point) < radius * 1.6 + Math.max(g.hw, g.hh)) g.shatter(g.center, new THREE.Vector3().subVectors(g.center, point).normalize());
    this.recordOp('rocket-fracture', performance.now() - t0, removed);
    return removed;
  }

  totalCells() {
    let alive = 0, total = 0;
    for (const p of this.panels) { alive += p.aliveCount(); total += p.N; }
    return { alive, total };
  }

  reset() {
    for (const p of this.panels) p.reset();
    for (const a of this.attachments) a.reset();
    for (const g of this.glass) g.reset();
    this.stats.cellsRemoved = 0;
    this.stats.cellsReleased = 0;
    this.events.length = 0;
  }
}
