import * as THREE from 'three';
import { GROUP_DEBRIS } from './physics.js';
import { mulberry32 } from './voronoi.js';

// Debris hierarchy:
//  hero      — few real rigid bodies built from the removed cells themselves (exact shape),
//              can hit mechs and deal secondary damage
//  frozen    — settled heroes switched to fixed bodies (zero simulation cost, still solid)
//  cosmetic  — instanced ballistic fragments with no physics; settle into persistent rubble
//  (dust / sparks live in fx.js)

const MAX_DYNAMIC = 70;
const MAX_HEROES = 240;
const MAX_COSMETIC = 2400;
const DENSITY = 2300; // kg/m^3

const rng = mulberry32(99);
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();

export class Debris {
  constructor(scene, physics, fx, floorAt) {
    this.scene = scene;
    this.physics = physics;
    this.fx = fx;
    this.floorAt = floorAt;
    this.heroes = [];
    this.damageListeners = [];
    this._initCosmetic();
    this.stats = { heroSpawned: 0, cosmeticSpawned: 0, retired: 0 };
  }

  _initCosmetic() {
    const geo = new THREE.IcosahedronGeometry(0.5, 0);
    const pos = geo.attributes.position;
    const r = mulberry32(7);
    // irregular rock: jitter shared vertex positions consistently
    const key = (x, y, z) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    const jit = new Map();
    for (let i = 0; i < pos.count; i++) {
      const k = key(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (!jit.has(k)) jit.set(k, 0.65 + r() * 0.6);
      const s = jit.get(k);
      pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * s * 0.7, pos.getZ(i) * s);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0.0 });
    this.rubble = new THREE.InstancedMesh(geo, mat, MAX_COSMETIC);
    this.rubble.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rubble.setColorAt(0, new THREE.Color());
    this.rubble.count = 0;
    this.rubble.castShadow = true;
    this.rubble.receiveShadow = true;
    this.rubble.frustumCulled = false;
    this.rubble.name = 'rubble';
    this.scene.add(this.rubble);
    const n = MAX_COSMETIC;
    this.c = {
      p: new Float32Array(n * 3), v: new Float32Array(n * 3), rot: new Float32Array(n * 3), w: new Float32Array(n * 3),
      s: new Float32Array(n * 3), state: new Uint8Array(n), age: new Float32Array(n),
    };
    this.cNext = 0;
    this.cUsed = 0;
  }

  spawnCosmetic(pos, vel, size, color) {
    const i = this.cNext;
    this.cNext = (this.cNext + 1) % MAX_COSMETIC;
    this.cUsed = Math.min(MAX_COSMETIC, this.cUsed + 1);
    const c = this.c;
    c.p.set([pos.x, pos.y, pos.z], i * 3);
    c.v.set([vel.x, vel.y, vel.z], i * 3);
    c.rot.set([rng() * 6, rng() * 6, rng() * 6], i * 3);
    c.w.set([(rng() - 0.5) * 16, (rng() - 0.5) * 16, (rng() - 0.5) * 16], i * 3);
    c.s.set([size * (0.6 + rng() * 0.8), size * (0.5 + rng() * 0.7), size * (0.6 + rng() * 0.8)], i * 3);
    c.state[i] = 1;
    c.age[i] = 0;
    this.rubble.setColorAt(i, color);
    this.rubble.instanceColor.needsUpdate = true;
    this.rubble.count = this.cUsed;
    this.stats.cosmeticSpawned++;
    this._writeCosmetic(i);
  }

  _writeCosmetic(i) {
    const c = this.c;
    _e.set(c.rot[i * 3], c.rot[i * 3 + 1], c.rot[i * 3 + 2]);
    _q.setFromEuler(_e);
    _p.set(c.p[i * 3], c.p[i * 3 + 1], c.p[i * 3 + 2]);
    _s.set(c.s[i * 3], c.s[i * 3 + 1], c.s[i * 3 + 2]);
    _m.compose(_p, _q, _s);
    this.rubble.setMatrixAt(i, _m);
  }

  _updateCosmetic(dt) {
    const c = this.c;
    let dirty = false;
    const g = 9.81 * 1.25;
    for (let i = 0; i < this.cUsed; i++) {
      if (c.state[i] !== 1) continue;
      dirty = true;
      c.age[i] += dt;
      const o = i * 3;
      c.v[o + 1] -= g * dt;
      c.p[o] += c.v[o] * dt; c.p[o + 1] += c.v[o + 1] * dt; c.p[o + 2] += c.v[o + 2] * dt;
      c.rot[o] += c.w[o] * dt; c.rot[o + 1] += c.w[o + 1] * dt; c.rot[o + 2] += c.w[o + 2] * dt;
      const floor = this.floorAt(c.p[o], c.p[o + 2], c.p[o + 1] + 0.3) + c.s[o + 1] * 0.32;
      if (c.p[o + 1] < floor) {
        c.p[o + 1] = floor;
        const sp = Math.hypot(c.v[o], c.v[o + 1], c.v[o + 2]);
        if (sp < 2.2 || c.age[i] > 4) {
          c.state[i] = 2;
          // settle flat-ish
          c.rot[o] *= 0.2; c.rot[o + 2] *= 0.2;
        } else {
          c.v[o + 1] = -c.v[o + 1] * 0.28;
          c.v[o] *= 0.55; c.v[o + 2] *= 0.55;
          c.w[o] *= 0.5; c.w[o + 1] *= 0.5; c.w[o + 2] *= 0.5;
        }
      }
      this._writeCosmetic(i);
    }
    if (dirty) this.rubble.instanceMatrix.needsUpdate = true;
  }

  // Build a render mesh + compound collider from a set of panel cells.
  _chunkFromCells(panel, cells) {
    // centroid in panel-local coordinates (area weighted, mid-depth)
    let ax = 0, ay = 0, at = 0;
    for (const c of cells) { const cl = panel.cells[c]; ax += cl.cx * cl.area; ay += cl.cy * cl.area; at += cl.area; }
    const cen = new THREE.Vector3(ax / at, ay / at, -panel.thickness / 2);
    const src = panel.geometry.attributes;
    const pos = [], nor = [], uv = [], col = [];
    const groups = [[], [], []];
    for (const c of cells) {
      const vs = panel.vStart[c], vc = panel.vCount[c];
      const base = pos.length / 3;
      for (let k = 0; k < vc; k++) {
        const vi = vs + k;
        pos.push(src.position.array[vi * 3] - cen.x, src.position.array[vi * 3 + 1] - cen.y, src.position.array[vi * 3 + 2] - cen.z);
        nor.push(src.normal.array[vi * 3], src.normal.array[vi * 3 + 1], src.normal.array[vi * 3 + 2]);
        uv.push(src.uv.array[vi * 2], src.uv.array[vi * 2 + 1]);
        col.push(src.color.array[vi * 3], src.color.array[vi * 3 + 1], src.color.array[vi * 3 + 2]);
      }
      const ranges = [[panel.oStart[c], panel.oCount[c]], [panel.iStart[c], panel.iCount[c]], [panel.sStart[c], panel.sCount[c]]];
      ranges.forEach(([st, ct], g) => {
        for (let k = 0; k < ct; k++) groups[g].push(panel.origIndex[st + k] - vs + base);
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const idx = [...groups[0], ...groups[1], ...groups[2]];
    geo.setIndex(idx);
    geo.addGroup(0, groups[0].length, 0);
    geo.addGroup(groups[0].length, groups[1].length, 1);
    geo.addGroup(groups[0].length + groups[1].length, groups[2].length, 2);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, panel.materials);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    const worldPos = panel.toWorld(cen);
    return { mesh, cen, worldPos, area: at };
  }

  _spawnHero(panel, cells, linvel, angvel, ccd) {
    if (this.heroes.length >= MAX_HEROES) this._retireOldest();
    const { R, world } = this.physics;
    const { mesh, cen, worldPos, area } = this._chunkFromCells(panel, cells);
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(worldPos.x, worldPos.y, worldPos.z)
      .setRotation(panel.quaternion)
      .setLinvel(linvel.x, linvel.y, linvel.z)
      .setAngvel(angvel)
      .setLinearDamping(0.05)
      .setAngularDamping(0.4)
      .setCcdEnabled(!!ccd);
    const body = world.createRigidBody(desc);
    const colliders = [];
    for (const c of cells.slice(0, 18)) {
      const cd = R.ColliderDesc.convexHull(panel.cellHullPoints(c, cen));
      if (!cd) continue;
      cd.setDensity(DENSITY).setFriction(0.9).setRestitution(0.05).setCollisionGroups(GROUP_DEBRIS);
      const col = world.createCollider(cd, body);
      colliders.push(col);
    }
    const mass = body.mass();
    const hero = { body, mesh, colliders, mass, born: performance.now(), frozen: false, still: 0, hitCooldown: 0, area };
    for (const col of colliders) this.physics.setOwner(col, { kind: 'debris', hero });
    this.scene.add(mesh);
    this._syncHero(hero);
    this.heroes.push(hero);
    this.stats.heroSpawned++;
    return hero;
  }

  _syncHero(h) {
    const t = h.body.translation(), r = h.body.rotation();
    _p.set(t.x, t.y, t.z); _q.set(r.x, r.y, r.z, r.w); _s.set(1, 1, 1);
    h.mesh.matrix.compose(_p, _q, _s);
    h.mesh.matrixWorldNeedsUpdate = true;
  }

  dynamicCount() {
    let n = 0;
    for (const h of this.heroes) if (!h.frozen) n++;
    return n;
  }

  _retireOldest() {
    const h = this.heroes.shift();
    if (!h) return;
    this._removeHero(h);
    this.stats.retired++;
  }

  _removeHero(h) {
    for (const col of h.colliders) this.physics.owners.delete(col.handle);
    this.physics.world.removeRigidBody(h.body);
    if (h.attachment) { h.attachment.body = null; h.mesh = null; return; }
    this.scene.remove(h.mesh);
    h.mesh.geometry.dispose();
  }

  _freeze(h) {
    h.frozen = true;
    h.body.setBodyType(this.physics.R.RigidBodyType.Fixed, false);
  }

  // Split a set of cells into adjacent clusters of at most `size` cells.
  _clusters(panel, cells, size) {
    const set = new Set(cells);
    const out = [];
    const order = [...cells].sort(() => rng() - 0.5);
    for (const s of order) {
      if (!set.has(s)) continue;
      const cl = [s];
      set.delete(s);
      for (let i = 0; i < cl.length && cl.length < size; i++) {
        for (const nb of panel.cells[cl[i]].neighbors) {
          if (set.has(nb) && cl.length < size) { cl.push(nb); set.delete(nb); }
        }
      }
      out.push(cl);
    }
    return out;
  }

  // Cells removed by an impact: a few hero chunks, the rest cosmetic fragments + dust.
  fromCells(panel, cells, ctx) {
    const kind = ctx.kind;
    const dir = ctx.dir ?? panel.n.clone().negate();
    const point = ctx.point ?? panel.center;
    let clusterSize = kind === 'cannon' ? 2 : kind === 'rocket' ? 4 : kind === 'ram' ? 5 : 3;
    let heroBudget = kind === 'cannon' ? 3 : kind === 'rocket' ? 5 : kind === 'ram' ? 6 : 4;
    if (this.dynamicCount() > MAX_DYNAMIC) heroBudget = Math.min(heroBudget, 1);
    const clusters = this._clusters(panel, cells, clusterSize).sort((a, b) => b.length - a.length);
    const tint = panel.debrisTint;
    const core = new THREE.Color(0x8d857a);
    const wp = new THREE.Vector3();
    clusters.forEach((cl, idx) => {
      const asHero = idx < heroBudget && cl.length >= 1;
      if (asHero) {
        const v = this._launchVelocity(panel, cl, kind, point, dir, ctx.speed ?? 10);
        const w = { x: (rng() - 0.5) * 9, y: (rng() - 0.5) * 9, z: (rng() - 0.5) * 9 };
        this._spawnHero(panel, cl, v, w, v.length() > 9);
      } else {
        for (const c of cl) {
          const cell = panel.cells[c];
          panel.toWorld(wp.set(cell.cx, cell.cy, -panel.thickness / 2), wp);
          const pieces = kind === 'rocket' ? 3 : 4;
          const sz = Math.sqrt(cell.area) * 0.42;
          for (let k = 0; k < pieces; k++) {
            const v = this._launchVelocity(panel, [c], kind, point, dir, ctx.speed ?? 10);
            v.multiplyScalar(0.7 + rng() * 0.9);
            this.spawnCosmetic(wp, v, sz * (0.6 + rng() * 0.7), rng() < 0.45 ? tint : core);
          }
        }
      }
    });
    // dust at the impact
    this.fx.impactDust(point, dir, kind === 'rocket' ? 1.6 : kind === 'ram' ? 2.0 : 1.0, panel.debrisTint);
  }

  _launchVelocity(panel, cells, kind, point, dir, speed) {
    const c = panel.cells[cells[0]];
    const wp = panel.toWorld(new THREE.Vector3(c.cx, c.cy, -panel.thickness / 2));
    const v = new THREE.Vector3();
    if (kind === 'rocket') {
      v.subVectors(wp, point);
      v.y = Math.max(v.y, -0.2);
      v.normalize().multiplyScalar(speed * (0.5 + rng() * 0.8));
      v.addScaledVector(panel.n, speed * (0.3 + rng() * 0.6));
      v.y += 2 + rng() * 3;
    } else if (kind === 'release') {
      v.set((rng() - 0.5) * 1.2, -rng() * 0.5, (rng() - 0.5) * 1.2).addScaledVector(dir, speed * 0.5);
    } else {
      // most of the bore exits along the shot; some spall flies back toward the shooter
      const back = kind === 'cannon' && rng() < 0.3;
      v.copy(dir).multiplyScalar(back ? -speed * 0.35 : speed * (0.5 + rng() * 0.8));
      v.x += (rng() - 0.5) * speed * 0.5;
      v.y += (rng() - 0.3) * speed * 0.4;
      v.z += (rng() - 0.5) * speed * 0.5;
    }
    return v;
  }

  // Structurally released island: becomes one or more large falling hero chunks.
  releaseCluster(panel, cells, ctx) {
    const parts = cells.length > 14 ? this._clusters(panel, cells, 14) : [cells];
    for (const cl of parts) {
      if (cl.length <= 1 && parts.length > 3) {
        const c = panel.cells[cl[0]];
        const wp = panel.toWorld(new THREE.Vector3(c.cx, c.cy, -panel.thickness / 2));
        this.spawnCosmetic(wp, new THREE.Vector3(0, -1, 0), Math.sqrt(c.area) * 0.5, panel.debrisTint);
        continue;
      }
      const v = new THREE.Vector3((rng() - 0.5) * 0.8, -0.5, (rng() - 0.5) * 0.8);
      if (ctx.dir) v.addScaledVector(ctx.dir, (ctx.speed ?? 0) * 0.4);
      v.addScaledVector(panel.n, (rng() - 0.3) * 1.2);
      this._spawnHero(panel, cl, v, { x: (rng() - 0.5) * 1.5, y: (rng() - 0.5) * 1.5, z: (rng() - 0.5) * 1.5 }, false);
    }
    const c0 = panel.cells[cells[0]];
    this.fx.impactDust(panel.toWorld(new THREE.Vector3(c0.cx, c0.cy, 0)), panel.n.clone().negate(), 0.8, panel.debrisTint);
  }

  // Attachment (AC unit, sign...) loses its mounts and becomes a rigid body.
  attachBody(att, p, q) {
    const { R, world } = this.physics;
    const body = world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation(q)
        .setLinvel((rng() - 0.5) * 1.5, 0.5, (rng() - 0.5) * 1.5)
        .setAngvel({ x: (rng() - 0.5) * 2, y: (rng() - 0.5) * 2, z: (rng() - 0.5) * 2 })
    );
    const h = att.half;
    const cd = R.ColliderDesc.cuboid(h.x, h.y, h.z).setCollisionGroups(GROUP_DEBRIS).setFriction(0.8);
    cd.setMass(att.mass);
    const col = world.createCollider(cd, body);
    const hero = { body, mesh: att.object, colliders: [col], mass: att.mass, born: performance.now(), frozen: false, still: 0, hitCooldown: 0, attachment: att };
    att.body = body;
    att.hero = hero;
    att.object.matrixAutoUpdate = false;
    this.physics.setOwner(col, { kind: 'debris', hero });
    this.heroes.push(hero);
  }

  // A component knocked off a mech (e.g. knee armour) becomes a real body.
  spawnPart(mesh, point) {
    const { R, world } = this.physics;
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    mesh.matrixWorld.decompose(p, q, s);
    const clone = mesh.clone();
    clone.matrixAutoUpdate = false;
    clone.visible = true;
    this.scene.add(clone);
    const body = world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation(q)
        .setLinvel((rng() - 0.5) * 4, 3 + rng() * 2, (rng() - 0.5) * 4)
        .setAngvel({ x: (rng() - 0.5) * 10, y: (rng() - 0.5) * 10, z: (rng() - 0.5) * 10 })
    );
    const cd = R.ColliderDesc.cuboid(0.3, 0.34, 0.18).setMass(220).setCollisionGroups(GROUP_DEBRIS);
    const col = world.createCollider(cd, body);
    const hero = { body, mesh: clone, colliders: [col], mass: 220, born: performance.now(), frozen: false, still: 0, hitCooldown: 1, part: true };
    this.physics.setOwner(col, { kind: 'debris', hero });
    this.heroes.push(hero);
    this._syncHero(hero);
    this.fx.sparks(p, 24, null, [1, 0.75, 0.4], 8);
  }

  update(dt) {
    for (let i = this.heroes.length - 1; i >= 0; i--) {
      const h = this.heroes[i];
      if (h.frozen) continue;
      h.hitCooldown = Math.max(0, h.hitCooldown - dt);
      const t = h.body.translation();
      if (t.y < -10) { this._removeHero(h); this.heroes.splice(i, 1); continue; }
      const v = h.body.linvel(), w = h.body.angvel();
      const sp = Math.hypot(v.x, v.y, v.z), ws = Math.hypot(w.x, w.y, w.z);
      h.speed = sp;
      if (h.body.isSleeping() || (sp < 0.25 && ws < 0.4)) h.still += dt; else h.still = 0;
      const age = (performance.now() - h.born) / 1000;
      if (h.still > 0.6 || (age > 9 && sp < 1.0)) this._freeze(h);
      if (h.mesh) {
        if (h.attachment) {
          const r = h.body.rotation();
          h.mesh.matrix.compose(_p.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), _s.set(1, 1, 1));
          h.mesh.matrixWorldNeedsUpdate = true;
        } else this._syncHero(h);
      }
      // landing thuds
      if (h.lastVy !== undefined && h.lastVy < -4 && v.y > h.lastVy + 3) this.fx.landingDust(t, h.mass);
      h.lastVy = v.y;
    }
    // keep the number of simulated bodies bounded
    let dyn = this.dynamicCount();
    for (const h of this.heroes) {
      if (dyn <= MAX_DYNAMIC) break;
      if (!h.frozen && (performance.now() - h.born) > 2500) { this._freeze(h); dyn--; }
    }
    this._updateCosmetic(dt);
  }

  counts() {
    let dyn = 0, sleeping = 0, frozen = 0;
    for (const h of this.heroes) {
      if (h.frozen) frozen++;
      else if (h.body.isSleeping()) sleeping++;
      else dyn++;
    }
    let flying = 0, settled = 0;
    for (let i = 0; i < this.cUsed; i++) { if (this.c.state[i] === 1) flying++; else if (this.c.state[i] === 2) settled++; }
    return { heroActive: dyn, heroSleeping: sleeping, heroFrozen: frozen, cosmeticFlying: flying, cosmeticSettled: settled };
  }

  reset() {
    for (const h of this.heroes) {
      if (h.attachment) {
        for (const col of h.colliders) this.physics.owners.delete(col.handle);
        this.physics.world.removeRigidBody(h.body);
        h.attachment.object.matrixAutoUpdate = true;
        h.attachment.body = null;
      } else this._removeHero(h);
    }
    this.heroes.length = 0;
    this.c.state.fill(0);
    this.cNext = 0;
    this.cUsed = 0;
    this.rubble.count = 0;
  }
}
