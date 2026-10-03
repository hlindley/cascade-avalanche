import * as THREE from 'three';
import { mulberry32 } from './voronoi.js';

const rng = mulberry32(4242);
const _d = new THREE.Vector3();

export const CANNON = { speed: 125, damage: 46, cooldown: 0.55, maxPen: 2 };
export const ROCKET = { count: 6, interval: 0.075, speed0: 32, speed1: 82, accel: 140, radius: 2.5, power: 190, mechRadius: 3.4, mechDamage: 34, cooldown: 3.6, spread: 0.032 };

// Projectiles are swept segments tested against mech hit volumes, glass and the Rapier world.
export class Weapons {
  constructor(game) {
    this.g = game;
    this.list = [];
    const tracerGeo = new THREE.CylinderGeometry(0.06, 0.02, 1, 6, 1, true).translate(0, -0.5, 0).rotateX(-Math.PI / 2);
    this.tracerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.6, 1.3), transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    this.tracerGeo = tracerGeo;
    const rocketGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.9, 8).rotateX(Math.PI / 2);
    this.rocketGeo = rocketGeo;
    this.rocketMat = new THREE.MeshStandardMaterial({ color: 0xd9d4c8, roughness: 0.5, metalness: 0.3 });
    this.pool = [];
  }

  _mesh(type) {
    const m = type === 'cannon' ? new THREE.Mesh(this.tracerGeo, this.tracerMat) : new THREE.Mesh(this.rocketGeo, this.rocketMat);
    m.frustumCulled = false;
    this.g.scene.add(m);
    return m;
  }

  fireCannon(owner, muzzle, aimPoint) {
    const dir = new THREE.Vector3().subVectors(aimPoint, muzzle).normalize();
    const p = { type: 'cannon', owner, pos: muzzle.clone(), vel: dir.clone().multiplyScalar(CANNON.speed), energy: 1, pen: 0, life: 2.2, age: 0, mesh: this._mesh('cannon') };
    p.mesh.position.copy(p.pos);
    this.list.push(p);
    this.g.fx.muzzle(muzzle, dir, true);
    this.g.audio?.cannon(muzzle, owner === this.g.player ? 1 : 0.7);
    this.g.perf?.event('cannon');
    return p;
  }

  fireRocket(owner, muzzle, aimPoint, idx) {
    // ring pattern around the aim point: a deliberate spread that still clusters
    const dir = new THREE.Vector3().subVectors(aimPoint, muzzle).normalize();
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(side, dir);
    const a = (idx / ROCKET.count) * Math.PI * 2 + rng() * 0.5;
    const r = ROCKET.spread * (0.4 + rng() * 0.8);
    dir.addScaledVector(side, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r * 0.8).normalize();
    const p = { type: 'rocket', owner, pos: muzzle.clone(), dir: dir.clone(), speed: ROCKET.speed0, vel: dir.clone().multiplyScalar(ROCKET.speed0), life: 3, age: 0, wob: rng() * 10, mesh: this._mesh('rocket') };
    p.mesh.position.copy(p.pos);
    p.mesh.lookAt(_d.copy(p.pos).add(dir));
    this.list.push(p);
    this.g.fx.muzzle(muzzle, dir, false);
    this.g.audio?.rocket(muzzle);
    this.g.perf?.event('rocket-launch');
  }

  _excludeFor(owner) {
    return owner?.collider;
  }

  update(dt) {
    const g = this.g;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.age += dt;
      if (p.type === 'rocket') {
        p.speed = Math.min(ROCKET.speed1, p.speed + ROCKET.accel * dt);
        const w = Math.sin(p.age * 23 + p.wob) * 0.6 * Math.max(0, 1 - p.age * 1.5);
        const side = _d.set(-p.dir.z, 0, p.dir.x);
        p.vel.copy(p.dir).multiplyScalar(p.speed).addScaledVector(side, w);
        if (rng() < 0.8) g.fx.dust.emit(p.pos.x, p.pos.y, p.pos.z, (rng() - 0.5), rng() * 0.6, (rng() - 0.5), 1.2 + rng() * 0.8, 0.25, 1.4, 0.82, 0.8, 0.76, 0.35, -0.2, 1.2);
        g.fx.glow.emit(p.pos.x, p.pos.y, p.pos.z, -p.vel.x * 0.05, -p.vel.y * 0.05, -p.vel.z * 0.05, 0.05, 0.45, 0.2, 1, 0.65, 0.3, 0.9, 0, 0);
      }
      const p0 = p.pos.clone();
      const p1 = p.pos.clone().addScaledVector(p.vel, dt);
      if (this._sweep(p, p0, p1)) {
        g.scene.remove(p.mesh);
        this.list.splice(i, 1);
        continue;
      }
      if (p.age > p.life) {
        if (p.type === 'rocket') this._explode(p, p.pos.clone(), p.dir);
        g.scene.remove(p.mesh);
        this.list.splice(i, 1);
        continue;
      }
      if (p.type === 'cannon') {
        // tracer trails the head; length grows over the first metres so it never pokes out of the barrel backwards
        const len = Math.min(5.5, p.age * CANNON.speed * 0.9);
        p.mesh.position.copy(p.pos);
        p.mesh.lookAt(_d.copy(p.pos).add(p.vel));
        p.mesh.scale.set(1, 1, len);
      } else {
        p.mesh.position.copy(p.pos);
        p.mesh.lookAt(_d.copy(p.pos).add(p.vel));
      }
    }
  }

  // returns true if projectile is consumed
  _sweep(p, p0, p1) {
    const g = this.g;
    const seg = new THREE.Vector3().subVectors(p1, p0);
    const len = seg.length();
    const dir = seg.clone().divideScalar(len);
    // mechs
    let mechHit = null, mechT = Infinity;
    for (const m of g.mechs) {
      if (m === p.owner || m.disabledBody) continue;
      const h = m.rig.raycast(p0, p1);
      if (h && h.t < mechT) { mechHit = { m, h }; mechT = h.t; }
    }
    // world
    const hit = g.physics.castRay(p0, dir, len, this._excludeFor(p.owner), (c) => {
      const o = g.physics.ownerOf(c);
      return !(o && o.kind === 'mech');
    });
    const worldT = hit ? hit.toi : Infinity;
    // glass shatters and does not stop rounds
    for (const gl of g.destruction.glass) {
      const gh = gl.intersect(p0, p1);
      if (gh && gh.t * len < Math.min(mechT, worldT)) {
        gl.shatter(gh.point, dir);
        g.audio?.glass(gh.point);
      }
    }
    if (mechHit && mechT <= worldT) {
      const { m, h } = mechHit;
      if (p.type === 'cannon') {
        m.onHit(h, CANNON.damage * p.energy, dir, p.owner);
        g.fx.sparks(h.point, 18, dir.clone().negate(), [1, 0.78, 0.45], 10);
        g.fx.flash(h.point, 0xffb070, 70, 0.08, 10);
        g.audio?.metalHit(h.point);
      } else {
        this._explode(p, h.point, dir);
      }
      return true;
    }
    if (!hit) {
      p.pos.copy(p1);
      return false;
    }
    const point = p0.clone().addScaledVector(dir, hit.toi);
    const owner = hit.owner;
    if (p.type === 'rocket') {
      this._explode(p, point.addScaledVector(dir, -0.15), dir);
      return true;
    }
    // cannon
    if (owner && owner.kind === 'cell') {
      const removed = owner.panel.cannonHit(owner.cell, point, dir, p.energy);
      g.audio?.wallHit(point, 1);
      g.fx.flash(point, 0xffc890, 40, 0.06, 8);
      g.perf?.event('cannon-hole');
      if (removed > 0 && p.pen < CANNON.maxPen) {
        // the round punches through and keeps going with less energy
        p.pen++;
        p.energy *= 0.62;
        p.vel.multiplyScalar(0.8);
        p.pos.copy(point).addScaledVector(dir, owner.panel.thickness + 0.25);
        return false;
      }
      return true;
    }
    if (owner && owner.kind === 'debris') {
      const b = owner.hero.body;
      if (b.isDynamic()) b.applyImpulseAtPoint({ x: dir.x * 900, y: dir.y * 900 + 200, z: dir.z * 900 }, point, true);
      g.fx.impactDust(point, dir, 0.4);
      return true;
    }
    // permanent skeleton / ground: sparks, dust, a few chips; collision is unchanged
    const n = hit.normal;
    const nn = new THREE.Vector3(n.x, n.y, n.z);
    if (point.y < 0.05) {
      g.fx.impactDust(point, nn, 0.7, { r: 0.6, g: 0.58, b: 0.55 });
    } else {
      g.fx.sparks(point, 14, nn, [1, 0.8, 0.5], 9);
      g.fx.impactDust(point, nn, 0.35, { r: 0.75, g: 0.73, b: 0.7 });
    }
    for (let k = 0; k < 4; k++) g.debris.spawnCosmetic(point.clone().addScaledVector(nn, 0.1), nn.clone().multiplyScalar(3 + rng() * 4).add(new THREE.Vector3((rng() - 0.5) * 3, rng() * 3, (rng() - 0.5) * 3)), 0.07 + rng() * 0.06, new THREE.Color(0x8f8a82));
    g.audio?.wallHit(point, 0.6);
    return true;
  }

  _explode(p, point, dir) {
    const g = this.g;
    const t0 = performance.now();
    g.destruction.explosion(point, ROCKET.radius, ROCKET.power);
    g.fx.explosion(point, 1);
    g.audio?.explosion(point);
    // distributed component damage: every hit volume in range takes its share; clustering stacks
    for (const m of g.mechs) {
      if (m.disabledBody) continue;
      const best = new Map();
      for (const h of m.rig.hitVolumes()) {
        const d = Math.max(0, h.p.distanceTo(point) - h.r);
        if (d > ROCKET.mechRadius) continue;
        const dmg = ROCKET.mechDamage * (1 - d / ROCKET.mechRadius);
        const key = h.part + (h.leg ?? '');
        if (!best.has(key) || best.get(key).dmg < dmg) best.set(key, { h, dmg });
      }
      for (const { h, dmg } of best.values()) m.onHit(h, dmg * (h.part === 'torso' ? 0.6 : 1), dir, p.owner, true);
      if (best.size) {
        const away = new THREE.Vector3().subVectors(m.position, point).setY(0);
        const d = away.length();
        if (d < ROCKET.mechRadius + 1.5) m.push(away.normalize().multiplyScalar(3.5 * (1 - d / (ROCKET.mechRadius + 1.5))));
      }
    }
    // shove loose debris
    const { R, world } = g.physics;
    const shape = new R.Ball(ROCKET.radius * 1.4);
    world.intersectionsWithShape(point, { x: 0, y: 0, z: 0, w: 1 }, shape, (c) => {
      const o = g.physics.ownerOf(c);
      if (o && o.kind === 'debris') {
        const b = o.hero.body;
        if (b.isDynamic()) {
          const t = b.translation();
          const v = new THREE.Vector3(t.x - point.x, t.y - point.y, t.z - point.z);
          const d = Math.max(0.5, v.length());
          v.normalize().multiplyScalar(b.mass() * 6 / d);
          b.applyImpulse({ x: v.x, y: v.y + b.mass() * 1.5, z: v.z }, true);
        }
      }
      return true;
    });
    g.perf?.event('rocket-explosion', performance.now() - t0);
  }

  reset() {
    for (const p of this.list) this.g.scene.remove(p.mesh);
    this.list.length = 0;
  }
}
