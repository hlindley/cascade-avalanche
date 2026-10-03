import * as THREE from 'three';
import { MechActor, MECH_RADIUS, CENTER_Y } from './actor.js';
import { CANNON, ROCKET } from './weapons.js';

export const MOVE = {
  forward: 9.0, strafe: 7.6, back: 6.0,
  accel: 26, // m/s^2 toward input: responsive
  decel: 19, // letting go: the machine settles rather than snapping still
  turnFollow: 5.5, // legs/hips follow the view
};
export const BOOST = { speed: 27, rise: 0.06, hold: 0.3, fade: 0.28, cost: 42, regen: 26, delay: 0.7, steer: 0.8, dodgeSpeed: 20 };
export const RAM = { minSpeed: 13, transfer: 0.92, wallMin: 9.5 };

const _v = new THREE.Vector3();

export class Player extends MechActor {
  constructor(game, o) {
    super(game, { main: 0xe9e4d8, second: 0xc9c2b2, dark: 0x2b2f35, accent: 0xff5b1f, glow: 0x9ff6ff }, { name: 'player', seed: 3, ...o });
  }

  reset() {
    super.reset();
    this.viewYaw = this.spawn.yaw;
    this.viewPitch = 0;
    this.energy = 100;
    this.energyDelay = 0;
    this.dashing = false;
    this.dashT = 0;
    this.dashVel = new THREE.Vector3();
    this.dashDir = new THREE.Vector3();
    this.isRam = false;
    this.rammedThisDash = false;
    this.cannonCd = 0;
    this.salvo = null;
    this.salvoCd = 0;
    this.moveVel = new THREE.Vector3();
    this.localAccel = new THREE.Vector2();
    this.hitFlash = 0;
    this.lastRam = null;
  }

  // input: { move:{x,z} local, look:{dx,dy}, fire, salvo, boost }
  fixedUpdate(dt, input) {
    const g = this.g;
    this.viewYaw -= input.look.dx;
    this.viewPitch = THREE.MathUtils.clamp(this.viewPitch - input.look.dy, -0.75, 0.6);
    this.aimYaw = this.viewYaw;
    this.aimPitch = this.viewPitch;
    const fwd = new THREE.Vector3(Math.sin(this.viewYaw), 0, Math.cos(this.viewYaw));
    const right = new THREE.Vector3(Math.cos(this.viewYaw), 0, -Math.sin(this.viewYaw));

    // --- boost / ram ---------------------------------------------------------------
    this.energyDelay = Math.max(0, this.energyDelay - dt);
    if (!this.dashing && this.energyDelay <= 0) this.energy = Math.min(100, this.energy + BOOST.regen * dt);
    if (input.boost && !this.dashing && this.energy >= BOOST.cost * 0.6) {
      const dir = new THREE.Vector3().addScaledVector(fwd, input.move.z).addScaledVector(right, input.move.x);
      if (dir.lengthSq() < 0.01) dir.copy(fwd);
      dir.normalize();
      this.isRam = dir.dot(fwd) > 0.55;
      this.dashDir.copy(dir);
      this.dashing = true;
      this.dashT = 0;
      this.rammedThisDash = false;
      this.energy -= BOOST.cost;
      this.energyDelay = BOOST.delay;
      this.dashStartVel = this.moveVel.clone();
      g.audio?.boost(this.isRam);
      g.perf?.event(this.isRam ? 'ram-start' : 'dodge');
    }
    const want = new THREE.Vector3();
    if (this.dashing) {
      this.dashT += dt;
      const peak = this.isRam ? BOOST.speed : BOOST.dodgeSpeed;
      // committed: steering is limited during the dash
      if (this.isRam) {
        const ang = Math.atan2(this.dashDir.x, this.dashDir.z);
        const tgt = Math.atan2(fwd.x, fwd.z);
        let d = Math.atan2(Math.sin(tgt - ang), Math.cos(tgt - ang));
        d = THREE.MathUtils.clamp(d, -BOOST.steer * dt, BOOST.steer * dt);
        this.dashDir.set(Math.sin(ang + d), 0, Math.cos(ang + d));
      }
      let k;
      if (this.dashT < BOOST.rise) k = this.dashT / BOOST.rise;
      else if (this.dashT < BOOST.rise + BOOST.hold) k = 1;
      else k = Math.max(0, 1 - (this.dashT - BOOST.rise - BOOST.hold) / BOOST.fade);
      const dashV = this.dashDir.clone().multiplyScalar(peak);
      want.lerpVectors(this.dashStartVel, dashV, k > 0 && this.dashT < BOOST.rise ? k : 1);
      if (this.dashT >= BOOST.rise + BOOST.hold) {
        // fade back into normal locomotion
        const normal = this._locomotion(dt, input, fwd, right);
        want.copy(dashV).lerp(normal, 1 - k);
      }
      this.thrust = Math.max(0.15, k);
      if (this.dashT > BOOST.rise + BOOST.hold + BOOST.fade) this.dashing = false;
      this.moveVel.copy(want);
    } else {
      want.copy(this._locomotion(dt, input, fwd, right));
      this.thrust = Math.max(0, this.thrust - dt * 3);
    }
    // a damaged leg costs the player too
    want.multiplyScalar(this.rig.gaitSpeedFactor());

    const before = this.velocity.clone();
    const contacts = this.move(dt, want);
    // --- contacts: ram target, ram walls -------------------------------------------
    const speed = Math.hypot(want.x, want.z);
    if (this.dashing && this.isRam && !this.rammedThisDash) {
      for (const t of g.mechs) {
        if (t === this || t.disabledBody) continue;
        const d = _v.subVectors(t.position, this.position).setY(0);
        const dist = d.length();
        const touching = contacts.some((c) => c.owner && c.owner.kind === 'mech' && c.owner.actor === t) || dist < MECH_RADIUS * 2 + 0.45;
        const closing = want.dot(d.normalize());
        if (touching && closing > RAM.minSpeed * 0.7) this._ramMech(t, d.clone(), closing);
      }
    }
    if (speed > RAM.wallMin) {
      const res = this.wallImpacts(contacts, want, RAM.wallMin);
      for (const r of res) {
        if (r.breached) {
          this.moveVel.multiplyScalar(0.65);
          this.dashStartVel?.multiplyScalar(0.65);
        } else {
          // healthy wall: the machine is stopped hard
          this.dashing = false;
          this.moveVel.multiplyScalar(-0.1);
          this.velocity.multiplyScalar(0.1);
        }
      }
    }
    // body-relative acceleration for chassis/camera inertia
    const acc = this.velocity.clone().sub(before).divideScalar(dt);
    this.localAccel.set(acc.dot(right), acc.dot(fwd));
    // legs follow view direction (torso twist covers the difference)
    let dy = this.viewYaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * Math.min(1, MOVE.turnFollow * dt);

    // --- weapons --------------------------------------------------------------------
    this.cannonCd = Math.max(0, this.cannonCd - dt);
    this.salvoCd = Math.max(0, this.salvoCd - dt);
    if (input.fire && this.cannonCd <= 0) this.fireCannon(input.aimPoint);
    if (input.salvo && this.salvoCd <= 0 && !this.salvo) {
      this.salvo = { n: 0, t: 0, aim: input.aimPoint.clone() };
      this.salvoCd = ROCKET.cooldown;
    }
    if (this.salvo) {
      this.salvo.t -= dt;
      if (this.salvo.t <= 0) {
        this.rig.pod.updateWorldMatrix(true, true);
        const m = new THREE.Vector3().setFromMatrixPosition(this.rig.podMuzzle.matrixWorld);
        g.weapons.fireRocket(this, m, input.aimPoint ?? this.salvo.aim, this.salvo.n);
        g.camera.recoil(0.006);
        this.salvo.n++;
        this.salvo.t = ROCKET.interval;
        if (this.salvo.n >= ROCKET.count) this.salvo = null;
      }
    }
    this.hitFlash = Math.max(0, this.hitFlash - dt * 2);
  }

  _locomotion(dt, input, fwd, right) {
    const mz = input.move.z, mx = input.move.x;
    const target = new THREE.Vector3()
      .addScaledVector(fwd, mz * (mz >= 0 ? MOVE.forward : MOVE.back))
      .addScaledVector(right, mx * MOVE.strafe);
    if (target.length() > MOVE.forward) target.setLength(MOVE.forward);
    const diff = target.clone().sub(this.moveVel);
    const pushing = target.lengthSq() > 0.01 && target.dot(this.moveVel) >= -0.1;
    const rate = (pushing ? MOVE.accel : MOVE.decel) * dt;
    if (diff.length() > rate) diff.setLength(rate);
    this.moveVel.add(diff);
    return this.moveVel.clone();
  }

  fireCannon(aimPoint) {
    const g = this.g;
    this.cannonCd = CANNON.cooldown;
    this.rig.cannonBody.updateWorldMatrix(true, true);
    const muzzle = new THREE.Vector3().setFromMatrixPosition(this.rig.muzzleR.matrixWorld);
    // in cockpit view the round leaves just right of the eye so what you aim at is what you hit
    if (g.camera.mode === 'cockpit') {
      const ray = g.camera.aimRay();
      const r = new THREE.Vector3(Math.cos(this.viewYaw), 0, -Math.sin(this.viewYaw));
      muzzle.copy(ray.origin).addScaledVector(r, 0.9).addScaledVector(ray.dir, 1.4).add(new THREE.Vector3(0, -0.55, 0));
    }
    g.weapons.fireCannon(this, muzzle, aimPoint);
    this.rig.recoil = 1;
    g.camera.recoil(0.022);
    this.moveVel.addScaledVector(new THREE.Vector3(Math.sin(this.viewYaw), 0, Math.cos(this.viewYaw)), -1.2);
  }

  _ramMech(t, dirToTarget, closing) {
    const g = this.g;
    this.rammedThisDash = true;
    const n = dirToTarget.setY(0).normalize();
    const rel = closing;
    // momentum transfer: the target is physically driven along the ram line
    t.push(n.clone().multiplyScalar(rel * RAM.transfer).add(this.dashDir.clone().multiplyScalar(1.5)));
    t.rig.stagger = 1;
    t.rig.bobV -= 2.5;
    t.ramGrace = 0.9;
    const dmg = rel * rel * 0.16;
    t.rig.damage('torso', undefined, dmg, t.centerPoint());
    const contact = this.centerPoint().addScaledVector(n, MECH_RADIUS);
    g.fx.sparks(contact, 40, n.clone().negate(), [1, 0.8, 0.5], 12);
    g.fx.impactDust(contact.setY(0.5), n, 1.2);
    g.fx.flash(contact, 0xffd2a0, 120, 0.12, 14);
    g.audio?.crash(contact, 1.4);
    g.camera.impulse(1.1);
    // the rammer is stopped hard
    this.moveVel.copy(n).multiplyScalar(rel * 0.12);
    this.dashStartVel = this.moveVel.clone();
    this.dashT = Math.max(this.dashT, BOOST.rise + BOOST.hold);
    this.lastRam = { t: performance.now(), speed: rel, dmg };
    g.perf?.event('ram-hit', 0, Math.round(rel));
    if (t.rig.disabled) t.disable(n.clone().multiplyScalar(rel * 0.5));
  }

  onHit(h, dmg, dir, attacker, splash) {
    // the player is not killable in M1: hits are felt, not scored
    this.hitFlash = 1;
    this.g.camera.impulse(splash ? 0.7 : 0.5);
    this.push(dir.clone().setY(0).multiplyScalar(0.6));
  }
}
