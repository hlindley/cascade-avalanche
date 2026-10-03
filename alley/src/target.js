import * as THREE from 'three';
import { MechActor, CENTER_Y } from './actor.js';
import { mulberry32 } from './voronoi.js';

const rng = mulberry32(777);

// Deliberately simple opponent: patrols across the player's firing line, can take cover,
// fires back occasionally. Its knee damage changes how it walks, not just how fast.
export class Target extends MechActor {
  constructor(game, o) {
    super(game, { main: 0x5b6977, second: 0x26323f, dark: 0x16191d, accent: 0x2fd1c4, glow: 0xff6a2a }, { name: 'target', seed: 9, ...o });
    this.routes = o.routes;
    this.mode = 'strafe';
    this.autoCycle = false;
    this.fireEnabled = true;
  }

  reset() {
    super.reset();
    this.wp = 0;
    this.wait = 0.6;
    this.fireT = 2.5;
    this.moveVel = new THREE.Vector3();
    this.ramGrace = 0;
    this.modeT = 0;
    this.speedScale = 1;
    this.stuck = 0;
  }

  setMode(m) {
    if (m === this.mode) return;
    this.mode = m;
    this.wp = 0;
    this.modeT = 0;
    this.wait = 0;
  }

  route() {
    return this.routes[this.mode] ?? this.routes.strafe;
  }

  fixedUpdate(dt) {
    if (this.disabledBody) return;
    const g = this.g;
    this.modeT += dt;
    this.ramGrace = Math.max(0, this.ramGrace - dt);
    const player = g.player;
    const toPlayer = new THREE.Vector3().subVectors(player.position, this.position).setY(0);
    const facePlayer = Math.atan2(toPlayer.x, toPlayer.z);
    // --- navigation -------------------------------------------------------------------
    const want = new THREE.Vector3();
    const knocked = this.knock.length() > 2.0;
    const r = this.route();
    if (!knocked && r.length) {
      if (this.wait > 0) this.wait -= dt;
      else {
        const target = r[this.wp % r.length];
        const d = new THREE.Vector3(target.x - this.position.x, 0, target.z - this.position.z);
        const dist = d.length();
        if (dist < 0.6) {
          if (this.mode === 'strafe') { this.wp = (this.wp + 1) % r.length; this.wait = 0.35 + rng() * 0.5; }
          else if (this.wp < r.length - 1) this.wp++;
          else this.wait = 1;
        } else {
          let base = 7.2 * this.speedScale;
          // weakened leg: moving toward the bad side is worse than away from it
          const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
          d.normalize();
          for (let i = 0; i < 2; i++) {
            const s = this.rig.severity(i);
            if (s <= 0) continue;
            const towardBad = d.dot(right) * this.rig.legs[i].side;
            if (towardBad > 0) base *= 1 - 0.3 * s * towardBad;
          }
          const slow = Math.min(1, dist / 1.6);
          want.copy(d).multiplyScalar(base * slow);
        }
      }
    }
    // accelerate like a heavy machine
    const diff = want.clone().sub(this.moveVel);
    const rate = 16 * dt;
    if (diff.length() > rate) diff.setLength(rate);
    this.moveVel.add(diff);
    const v = this.moveVel.clone().multiplyScalar(this.rig.gaitSpeedFactor());
    const knockBefore = this.knock.clone();
    const contacts = this.move(dt, v, { knockDrag: 9 });
    // driven into infill by a ram: weakened facade gives way, healthy facade stops it hard
    const ks = knockBefore.length();
    if (ks > 6) {
      const res = this.wallImpacts(contacts, knockBefore, 6);
      for (const w of res) {
        if (w.breached) this.knock.multiplyScalar(0.7);
        else {
          const dmg = ks * ks * 0.12;
          this.rig.damage('torso', undefined, dmg, this.centerPoint());
          this.rig.stagger = 1;
          this.knock.multiplyScalar(0.1);
          if (this.rig.disabled) this.disable(knockBefore.clone().multiplyScalar(0.2));
        }
      }
      // slamming into the permanent skeleton also hurts
      if (!res.length && contacts.some((c) => c.owner && c.owner.kind === 'static' && Math.abs(c.normal.y) < 0.5)) {
        const into = Math.max(0, ks - this.velocity.length());
        if (into > 5) {
          this.rig.damage('torso', undefined, into * into * 0.1, this.centerPoint());
          this.rig.stagger = 1;
          g.camera.impulse(0.3);
          g.audio?.crash(this.centerPoint(), 0.8);
          this.knock.multiplyScalar(0.15);
          if (this.rig.disabled) this.disable();
        }
      }
    }
    // stuck detection: skip waypoint
    if (want.lengthSq() > 1 && this.velocity.lengthSq() < 0.5 && !knocked) {
      this.stuck += dt;
      if (this.stuck > 1.5) { this.wp++; this.stuck = 0; }
    } else this.stuck = 0;
    // facing: torso tracks the player; legs face the player while strafing, else the path
    this.aimYaw = facePlayer;
    const legGoal = this.mode === 'strafe' || this.moveVel.length() < 1 ? facePlayer : Math.atan2(this.moveVel.x, this.moveVel.z);
    let dy = legGoal - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * Math.min(1, dt * 3.5);
    const head = this.centerPoint().add(new THREE.Vector3(0, 1.5, 0));
    const pc = player.centerPoint();
    this.aimPitch = Math.atan2(pc.y - head.y, toPlayer.length());

    // --- fire back --------------------------------------------------------------------
    this.fireT -= dt;
    if (this.fireEnabled && this.fireT <= 0 && !knocked) {
      this.fireT = 2.6 + rng() * 2;
      const dir = new THREE.Vector3().subVectors(pc, head).normalize();
      const los = g.physics.castRay(head, dir, head.distanceTo(pc), this.collider);
      if (los && los.owner && los.owner.kind === 'mech' && los.owner.actor === player) {
        this.rig.cannonBody.updateWorldMatrix(true, true);
        const muzzle = new THREE.Vector3().setFromMatrixPosition(this.rig.muzzleR.matrixWorld);
        const miss = new THREE.Vector3((rng() - 0.5) * 7, (rng() - 0.3) * 3, (rng() - 0.5) * 7);
        g.weapons.fireCannon(this, muzzle, pc.clone().add(miss));
        this.rig.recoil = 1;
      }
    }
  }
}
