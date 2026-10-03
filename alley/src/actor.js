import * as THREE from 'three';
import { Mech } from './mech.js';
import { GROUP_MECH, GROUP_DEBRIS } from './physics.js';

export const MECH_RADIUS = 1.3;
export const MECH_HALF = 1.0;
export const CENTER_Y = MECH_HALF + MECH_RADIUS + 0.05;
export const MECH_MASS = 34000;

// A mech in the world: authored, responsive kinematic movement that still collides,
// pushes debris, and converts heavy contacts into physical consequences.
export class MechActor {
  constructor(game, palette, o) {
    this.g = game;
    this.name = o.name;
    this.rig = new Mech(game.scene, palette, { name: o.name, fx: game.fx, seed: o.seed });
    this.spawn = { p: o.position.clone(), yaw: o.yaw };
    const { R, world } = game.physics;
    this.body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(o.position.x, o.position.y + CENTER_Y, o.position.z));
    this.collider = world.createCollider(R.ColliderDesc.capsule(MECH_HALF, MECH_RADIUS).setCollisionGroups(GROUP_MECH).setFriction(0.2), this.body);
    game.physics.setOwner(this.collider, { kind: 'mech', actor: this });
    this.controller = world.createCharacterController(0.06);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setSlideEnabled(true);
    this.controller.enableSnapToGround(0.6);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.controller.enableAutostep(0.45, 0.4, false);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(MECH_MASS);
    this.rig.listeners.footstep.push((rig, leg, strength, sev) => this._footstep(leg, strength, sev));
    this.rig.listeners.scrape.push((rig, leg, s, dt) => this._scrape(leg, s, dt));
    this.rig.onPartLost = (mesh, point) => game.debris.spawnPart(mesh, point);
    this.wallCooldown = new Map();
    this.reset();
  }

  reset() {
    this.position = this.spawn.p.clone();
    this.velocity = new THREE.Vector3();
    this.knock = new THREE.Vector3();
    this.vy = 0;
    this.yaw = this.spawn.yaw;
    this.aimYaw = this.spawn.yaw;
    this.aimPitch = 0;
    this.grounded = true;
    this.thrust = 0;
    this.wallCooldown.clear();
    if (this.disabledBody) {
      this.g.physics.world.removeRigidBody(this.disabledBody);
      this.disabledBody = null;
      this.rig.root.matrixAutoUpdate = true;
    }
    this.collider.setEnabled(true);
    this.body.setTranslation({ x: this.position.x, y: this.position.y + CENTER_Y, z: this.position.z }, true);
    this.body.setNextKinematicTranslation({ x: this.position.x, y: this.position.y + CENTER_Y, z: this.position.z });
    this.rig.reset(this.position, this.yaw);
    this.rig.update(0.016, this._motion(), this.g.floorAt);
  }

  get disabled() { return this.rig.disabled; }

  _motion() {
    return { position: this.position, velocity: this.velocity, yaw: this.yaw, aimYaw: this.aimYaw, aimPitch: this.aimPitch, thrust: this.thrust };
  }

  push(v) {
    this.knock.add(v);
    this.rig.stagger = Math.min(1, this.rig.stagger + v.length() * 0.08);
  }

  centerPoint(out = new THREE.Vector3()) {
    return out.set(this.position.x, this.position.y + CENTER_Y, this.position.z);
  }

  // Move with the character controller. Returns contacts this step.
  move(dt, wantVel, opts = {}) {
    const g = this.g;
    const v = wantVel.clone().add(this.knock);
    this.vy = this.grounded ? -2 : this.vy - 9.81 * 1.6 * dt;
    const desired = { x: v.x * dt, y: this.vy * dt, z: v.z * dt };
    const pred = (c) => {
      if (c.handle === this.collider.handle) return false;
      const o = g.physics.ownerOf(c);
      return !(o && o.kind === 'debris');
    };
    this.controller.computeColliderMovement(this.collider, desired, undefined, undefined, pred);
    const mv = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded();
    const contacts = [];
    const n = this.controller.numComputedCollisions();
    for (let i = 0; i < n; i++) {
      const c = this.controller.computedCollision(i);
      if (!c || !c.collider) continue;
      const owner = g.physics.ownerOf(c.collider);
      contacts.push({ owner, collider: c.collider, normal: new THREE.Vector3(c.normal1.x, c.normal1.y, c.normal1.z) });
    }
    this.position.x += mv.x;
    this.position.y += mv.y;
    this.position.z += mv.z;
    if (this.position.y < 0) this.position.y = 0;
    this.body.setNextKinematicTranslation({ x: this.position.x, y: this.position.y + CENTER_Y, z: this.position.z });
    this.velocity.set(mv.x / dt, 0, mv.z / dt);
    this._intendedVel = v;
    // knockback bleeds off quickly: mechs are heavy and dig in
    const kd = this.knock.length();
    if (kd > 0) this.knock.multiplyScalar(Math.max(0, kd - (opts.knockDrag ?? 14) * dt) / kd);
    // decay cooldowns
    for (const [k, t] of this.wallCooldown) { if (t - dt <= 0) this.wallCooldown.delete(k); else this.wallCooldown.set(k, t - dt); }
    return contacts;
  }

  // Heavy contact with infill: may breach it (weakened) or be stopped by it (healthy).
  wallImpacts(contacts, vel, minSpeed) {
    const results = [];
    const handled = new Set();
    for (const c of contacts) {
      if (!c.owner || c.owner.kind !== 'cell') continue;
      const panel = c.owner.panel;
      if (handled.has(panel) || this.wallCooldown.has(panel)) continue;
      const dir = vel.clone().setY(0);
      // only the velocity component driving into the slab counts
      const speed = Math.abs(dir.dot(panel.n));
      if (speed < minSpeed) continue;
      dir.normalize();
      handled.add(panel);
      this.wallCooldown.set(panel, 0.35);
      const point = this.centerPoint().addScaledVector(dir, MECH_RADIUS + 0.1);
      const res = panel.ramImpact(point, dir, speed, MECH_RADIUS + 0.35, CENTER_Y + 0.35, this.position.y + CENTER_Y);
      this.g.perf?.event(res.breached ? 'wall-breach' : 'wall-stop');
      this.g.fx.impactDust(point, dir, res.breached ? 2.4 : 1.2, panel.debrisTint);
      this.g.audio?.crash(point, res.breached ? 1.2 : 0.8);
      this.g.camera?.impulse(this === this.g.player ? 1 : 0.35);
      results.push({ panel, ...res, speed, dir });
    }
    return results;
  }

  onHit(h, dmg, dir, attacker, splash) {
    if (this.disabledBody) return;
    this.rig.damage(h.part, h.leg, dmg, h.point ?? this.centerPoint());
    if (!splash) this.push(dir.clone().setY(0).multiplyScalar(0.8));
    if (this.rig.disabled) this.disable(dir.clone().multiplyScalar(4));
    this.g.perf?.event(`hit-${h.part}`);
  }

  disable(extraVel = new THREE.Vector3()) {
    if (this.disabledBody) return;
    const { R, world } = this.g.physics;
    this.collider.setEnabled(false);
    const c = this.centerPoint();
    const v = this.velocity.clone().add(this.knock).add(extraVel);
    const body = world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(c.x, c.y, c.z).setLinvel(v.x, 1.5, v.z)
        .setAngvel({ x: (Math.random() - 0.5) * 1.5 + v.z * 0.15, y: (Math.random() - 0.5), z: -v.x * 0.15 + (Math.random() - 0.5) })
        .setAngularDamping(0.6)
    );
    const cd = R.ColliderDesc.cuboid(1.35, CENTER_Y, 1.1).setMass(MECH_MASS).setFriction(1.0).setCollisionGroups(GROUP_DEBRIS);
    const col = world.createCollider(cd, body);
    this.g.physics.setOwner(col, { kind: 'wreck', actor: this });
    this.disabledBody = body;
    this.disabledOrigin = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z);
    this.disabledInv = this.disabledOrigin.clone().invert();
    this.rig.root.matrixAutoUpdate = false;
    this.g.fx.explosion(c.clone().add(new THREE.Vector3(0, 0.8, 0)), 0.6);
    this.g.perf?.event('mech-disabled');
  }

  _updateWreck(dt) {
    const t = this.disabledBody.translation(), r = this.disabledBody.rotation();
    const m = new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(r.x, r.y, r.z, r.w), new THREE.Vector3(1, 1, 1));
    this.rig.root.matrix.multiplyMatrices(m, this.disabledInv);
    this.rig.root.matrixWorldNeedsUpdate = true;
    this.position.set(t.x, t.y - CENTER_Y, t.z);
    if (Math.random() < dt * 8) this.g.fx.smoke(new THREE.Vector3(t.x, t.y + 1.5, t.z), 1.4, true);
  }

  // Secondary damage from substantial falling debris.
  debrisContacts(dt) {
    if (this.disabledBody) return;
    const g = this.g;
    g.physics.world.contactPairsWith(this.collider, (other) => {
      const o = g.physics.ownerOf(other);
      if (!o || o.kind !== 'debris') return;
      const h = o.hero;
      if (h.hitCooldown > 0 || !h.body.isDynamic()) return;
      const v = h.body.linvel();
      const rel = Math.hypot(v.x - this.velocity.x, v.y, v.z - this.velocity.z);
      if (rel < 3.5 || h.mass < 250) return;
      h.hitCooldown = 0.6;
      const energy = 0.5 * h.mass * rel * rel;
      const dmg = Math.min(90, energy / 2600);
      const t = h.body.translation();
      const height = t.y - this.position.y;
      const part = height > 3.4 ? 'head' : height > 2.4 ? 'torso' : height > 1.5 ? 'thigh' : 'knee';
      const leg = new THREE.Vector3(t.x - this.position.x, 0, t.z - this.position.z).dot(new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw))) > 0 ? 1 : 0;
      this.rig.damage(part, leg, dmg, new THREE.Vector3(t.x, t.y, t.z));
      this.rig.bobV -= Math.min(2, dmg / 25);
      this.rig.stagger = Math.min(1, this.rig.stagger + dmg / 60);
      g.fx.sparks(new THREE.Vector3(t.x, t.y, t.z), 10, null, [1, 0.75, 0.4], 6);
      g.audio?.metalHit(new THREE.Vector3(t.x, t.y, t.z), 0.8);
      g.perf?.event('debris-damage', 0, Math.round(dmg));
      this.lastDebrisHit = { dmg, part, t: performance.now() };
      if (this.rig.disabled) this.disable(new THREE.Vector3(v.x, 0, v.z).multiplyScalar(0.1));
    });
  }

  _footstep(leg, strength, sev) {
    const p = leg.pos;
    this.g.fx.footDust(p, strength);
    this.g.audio?.footstep(p, strength, sev, this === this.g.player);
    if (this === this.g.player) this.g.camera?.footstep(strength);
  }

  _scrape(leg, s, dt) {
    if (Math.random() < dt * 30 * s) this.g.fx.sparks(leg.pos.clone().setY(leg.pos.y + 0.05), 2, null, [1, 0.7, 0.35], 4);
    this.g.audio?.scrape(leg.pos, s);
  }

  updateRig(dt) {
    if (this.disabledBody) { this._updateWreck(dt); return; }
    this.rig.update(dt, this._motion(), this.g.floorAt);
  }
}
