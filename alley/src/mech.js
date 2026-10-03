import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/RoundedBoxGeometry.js';
import { mulberry32 } from './voronoi.js';

// Original heavy machine: squat, broad, rounded armour, small sensor head, lots of propulsion.
// Legs are driven by procedural stepping + two-bone IK, so gait responds to real motion
// (strafing, knockback, damage) instead of playing canned clips.

const L1 = 1.25; // thigh
const L2 = 1.35; // shin
const ANKLE = 0.34;
const HIP_X = 0.8;
const REST_HIP = 2.55;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

function rbox(w, h, d, r, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2, h / 2, d / 2) * 0.999), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function cyl(rt, rb, h, mat, seg = 16, open = false) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// orient object so its local -Y runs from `from` to `to`, local +Z toward `fwd`
function orientBone(obj, from, to, fwd) {
  const y = _a.subVectors(from, to).normalize();
  const z = _b.copy(fwd).addScaledVector(y, -fwd.dot(y)).normalize();
  const x = _c.crossVectors(y, z);
  _m.makeBasis(x, y, z);
  obj.quaternion.setFromRotationMatrix(_m);
  obj.position.copy(from);
}

export function mechMaterials(p) {
  const std = (color, rough, metal, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
  return {
    main: std(p.main, 0.5, 0.25),
    second: std(p.second, 0.45, 0.3),
    dark: std(p.dark, 0.55, 0.65),
    metal: std(0x8a8f94, 0.35, 0.85),
    accent: std(p.accent, 0.45, 0.2),
    glow: std(0x000000, 1, 0, { emissive: new THREE.Color(p.glow), emissiveIntensity: 3.2 }),
    thrust: std(0x000000, 1, 0, { emissive: new THREE.Color(0xff9a4a), emissiveIntensity: 0.0 }),
    hot: std(0x1a1310, 0.6, 0.4, { emissive: new THREE.Color(0xff5a1a), emissiveIntensity: 0 }),
  };
}

export class Mech {
  constructor(scene, palette, opts = {}) {
    this.scene = scene;
    this.name = opts.name ?? 'mech';
    this.mats = mechMaterials(palette);
    this.rng = mulberry32(opts.seed ?? 5);
    this.root = new THREE.Group();
    this.root.name = this.name;
    scene.add(this.root);
    this._build();
    this.listeners = { footstep: [], scrape: [] };
    this.fx = opts.fx;
    this.reset(new THREE.Vector3(), 0);
  }

  _build() {
    const M = this.mats;
    // --- pelvis -----------------------------------------------------------------
    this.pelvis = new THREE.Group();
    this.root.add(this.pelvis);
    this.pelvis.add(rbox(1.55, 0.62, 1.15, 0.16, M.dark, 0, 0, 0));
    for (const s of [-1, 1]) {
      const cap = cyl(0.34, 0.34, 0.42, M.metal);
      cap.rotation.z = Math.PI / 2;
      cap.position.set(s * HIP_X, -0.05, 0);
      this.pelvis.add(cap);
      const side = rbox(0.22, 0.95, 1.05, 0.08, M.main, s * 1.18, -0.2, 0.0);
      side.rotation.z = s * 0.18;
      this.pelvis.add(side);
      const stripe = rbox(0.05, 0.5, 0.7, 0.02, M.accent, s * 1.3, -0.15, 0.05);
      stripe.rotation.z = s * 0.18;
      this.pelvis.add(stripe);
    }
    const front = rbox(1.25, 0.75, 0.2, 0.08, M.main, 0, -0.32, 0.66);
    front.rotation.x = -0.22;
    this.pelvis.add(front);
    const rear = rbox(1.3, 0.6, 0.2, 0.08, M.main, 0, -0.25, -0.64);
    rear.rotation.x = 0.25;
    this.pelvis.add(rear);

    // --- torso ------------------------------------------------------------------
    this.torso = new THREE.Group();
    this.torso.position.y = 0.42;
    this.pelvis.add(this.torso);
    const T = this.torso;
    T.add(rbox(1.7, 0.55, 1.35, 0.18, M.dark, 0, 0.12, 0));
    T.add(rbox(2.55, 1.35, 1.95, 0.42, M.main, 0, 0.85, -0.05));
    const chest = rbox(2.05, 0.95, 0.55, 0.24, M.second, 0, 0.92, 0.82);
    chest.rotation.x = 0.12;
    T.add(chest);
    T.add(rbox(1.4, 0.12, 0.08, 0.03, M.accent, 0, 1.28, 1.08));
    // intakes
    for (const s of [-1, 1]) T.add(rbox(0.45, 0.32, 0.12, 0.05, M.dark, s * 0.6, 0.62, 1.1));
    // head: small, low sensor package
    const head = new THREE.Group();
    head.position.set(0, 1.62, 0.45);
    T.add(head);
    this.head = head;
    head.add(rbox(0.82, 0.42, 0.78, 0.2, M.main, 0, 0, 0));
    head.add(rbox(0.6, 0.11, 0.08, 0.04, M.glow, 0, 0.02, 0.38));
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 8), M.glow);
    eye.position.set(0.12, 0.02, 0.42);
    head.add(eye);
    const antenna = cyl(0.015, 0.02, 0.6, M.metal, 6);
    antenna.position.set(-0.3, 0.45, -0.15);
    antenna.rotation.z = 0.2;
    head.add(antenna);
    // shoulders
    this.shoulders = [];
    for (const s of [-1, 1]) {
      const sh = new THREE.Group();
      sh.position.set(s * 1.55, 1.12, 0);
      T.add(sh);
      sh.add(rbox(1.05, 1.05, 1.4, 0.38, M.main, s * 0.05, 0.05, 0));
      sh.add(rbox(0.06, 0.55, 0.95, 0.02, M.accent, s * 0.58, 0.05, 0));
      sh.add(rbox(0.7, 0.18, 1.1, 0.06, M.second, s * 0.05, 0.62, 0));
      // vernier
      const vn = cyl(0.1, 0.16, 0.3, M.dark, 10, true);
      vn.position.set(s * 0.2, 0.2, -0.8);
      vn.rotation.x = Math.PI / 2;
      sh.add(vn);
      this.shoulders.push(sh);
    }
    // backpack + main thrusters
    T.add(rbox(1.95, 1.25, 0.85, 0.25, M.dark, 0, 0.95, -1.2));
    T.add(rbox(1.5, 0.3, 0.5, 0.1, M.second, 0, 1.68, -1.25));
    this.nozzles = [];
    for (const [x, y] of [[-0.55, 0.55], [0.55, 0.55], [-0.55, 1.25], [0.55, 1.25]]) {
      const nz = cyl(0.17, 0.3, 0.55, M.metal, 14, true);
      nz.position.set(x, y, -1.7);
      nz.rotation.x = Math.PI / 2 + 0.35;
      T.add(nz);
      const core = new THREE.Mesh(new THREE.CircleGeometry(0.2, 14), M.thrust);
      core.position.set(x, y - 0.09, -1.92);
      core.rotation.x = Math.PI - 0.35;
      T.add(core);
      this.nozzles.push(core);
    }
    // right arm: cannon
    this.armR = new THREE.Group();
    this.armR.position.set(1.62, 0.85, 0.15);
    T.add(this.armR);
    this.armR.add(rbox(0.6, 0.95, 0.65, 0.18, M.dark, 0, -0.35, 0));
    this.cannonBody = new THREE.Group();
    this.cannonBody.position.set(0.05, -0.85, 0.25);
    this.armR.add(this.cannonBody);
    this.cannonBody.add(rbox(0.75, 0.72, 1.55, 0.2, M.main, 0, 0, 0.35));
    this.cannonBody.add(rbox(0.08, 0.4, 1.0, 0.03, M.accent, 0.39, 0, 0.3));
    const barrel = cyl(0.13, 0.15, 2.0, M.dark, 14);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.05, 1.95);
    this.cannonBody.add(barrel);
    this.cannonBody.add(rbox(0.36, 0.36, 0.4, 0.06, M.dark, 0, 0.05, 2.95));
    this.muzzleR = new THREE.Object3D();
    this.muzzleR.position.set(0, 0.05, 3.25);
    this.cannonBody.add(this.muzzleR);
    // left arm: heavy forearm/fist + shoulder rocket pod
    this.armL = new THREE.Group();
    this.armL.position.set(-1.62, 0.85, 0.15);
    T.add(this.armL);
    this.armL.add(rbox(0.6, 0.95, 0.65, 0.18, M.dark, 0, -0.35, 0));
    this.armL.add(rbox(0.85, 0.85, 1.3, 0.25, M.main, -0.05, -0.95, 0.4));
    this.armL.add(rbox(0.7, 0.4, 0.5, 0.15, M.dark, -0.05, -1.05, 1.15));
    this.pod = new THREE.Group();
    this.pod.position.set(-1.55, 1.95, 0.05);
    T.add(this.pod);
    this.pod.add(rbox(0.95, 0.62, 1.2, 0.12, M.second, 0, 0, 0));
    for (let i = 0; i < 6; i++) {
      const tube = new THREE.Mesh(new THREE.CircleGeometry(0.11, 10), M.dark);
      tube.position.set(-0.27 + (i % 3) * 0.27, 0.12 - Math.floor(i / 3) * 0.25, 0.61);
      this.pod.add(tube);
    }
    this.podMuzzle = new THREE.Object3D();
    this.podMuzzle.position.set(0, 0, 0.8);
    this.pod.add(this.podMuzzle);

    // --- legs ---------------------------------------------------------------------
    this.legs = [-1, 1].map((s) => {
      const thigh = new THREE.Group();
      thigh.add(rbox(0.78, L1 + 0.2, 0.9, 0.24, M.main, 0, -L1 / 2, 0));
      thigh.add(rbox(0.1, L1 * 0.6, 0.7, 0.04, M.second, s * 0.42, -L1 * 0.45, 0));
      const shin = new THREE.Group();
      shin.add(rbox(0.86, L2 + 0.1, 0.95, 0.26, M.main, 0, -L2 / 2 + 0.05, -0.05));
      shin.add(rbox(0.6, L2 * 0.7, 0.25, 0.08, M.second, 0, -L2 * 0.5, 0.48));
      shin.add(rbox(0.06, 0.5, 0.5, 0.02, M.accent, s * 0.45, -L2 * 0.62, 0));
      const calfJet = cyl(0.12, 0.2, 0.3, M.dark, 10, true);
      calfJet.position.set(0, -L2 * 0.35, -0.6);
      calfJet.rotation.x = Math.PI / 2 + 0.6;
      shin.add(calfJet);
      const kneeJoint = cyl(0.32, 0.32, 0.72, M.metal);
      kneeJoint.rotation.z = Math.PI / 2;
      const kneeGroup = new THREE.Group();
      kneeGroup.add(kneeJoint);
      const kneeCap = rbox(0.62, 0.7, 0.38, 0.14, M.second, 0, 0.08, 0.42);
      kneeGroup.add(kneeCap);
      const kneeGlow = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), M.hot.clone());
      kneeGlow.position.set(0, 0, 0.12);
      kneeGroup.add(kneeGlow);
      const foot = new THREE.Group();
      foot.add(rbox(0.95, 0.34, 1.6, 0.12, M.dark, 0, -ANKLE / 2, 0.22));
      foot.add(rbox(0.75, 0.22, 0.5, 0.08, M.main, 0, -0.05, 0.85));
      const ankle = cyl(0.24, 0.24, 0.6, M.metal);
      ankle.rotation.z = Math.PI / 2;
      foot.add(ankle);
      const piston = cyl(0.07, 0.07, 1, M.metal, 8);
      const pistonSleeve = cyl(0.12, 0.12, 1, M.dark, 8);
      for (const o of [thigh, shin, kneeGroup, foot, piston, pistonSleeve]) this.root.add(o);
      return {
        side: s, thigh, shin, kneeGroup, kneeCap, kneeGlow, foot, piston, pistonSleeve,
        plant: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(),
        pos: new THREE.Vector3(), swing: false, t: 0, dur: 0.35, lift: 0.4, planted: 0, yaw: 0, footYaw: 0, scrape: 0,
        hip: new THREE.Vector3(), knee: new THREE.Vector3(), ankle: new THREE.Vector3(),
      };
    });
  }

  // ---------------------------------------------------------------------------------
  reset(position, yaw) {
    this.position = position.clone();
    this.velocity = new THREE.Vector3();
    this.yaw = yaw;
    this.aimYaw = yaw;
    this.aimPitch = 0;
    this.kneeHp = [100, 100];
    this.chassisHp = 420;
    this.disabled = false;
    this.bobY = 0; this.bobV = 0;
    this.lean = new THREE.Vector2(); this.leanV = new THREE.Vector2();
    this.roll = 0;
    this.recoil = 0;
    this.buckle = 0;
    this.thrust = 0;
    this.stagger = 0;
    this.prevVel = new THREE.Vector3();
    this.kneeCapLost = [false, false];
    for (const L of this.legs) {
      const p = this._restFoot(L.side, _d);
      L.plant.copy(p); L.pos.copy(p); L.swing = false; L.t = 0; L.planted = 1; L.footYaw = yaw;
      L.kneeCap.visible = true;
      L.kneeGlow.material.emissiveIntensity = 0;
    }
    this.root.visible = true;
  }

  severity(i) { return Math.min(1, Math.max(0, 1 - this.kneeHp[i] / 100)); }

  // speed multiplier a controller should apply this frame (gait-synchronous hitch)
  gaitSpeedFactor() {
    let f = 1;
    for (let i = 0; i < 2; i++) {
      const sev = this.severity(i);
      if (sev <= 0) continue;
      const other = this.legs[1 - i];
      if (other.swing) f = Math.min(f, 1 - 0.6 * sev);
      f *= 1 - 0.22 * sev;
    }
    return f * (1 - this.buckle * 0.5);
  }

  _restFoot(side, out) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    // local +x is right, local +z forward; yaw rotates about +y
    return out.set(this.position.x + side * HIP_X * c, this.position.y, this.position.z - side * HIP_X * s);
  }

  forward(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  // motion: { position, velocity, yaw, aimYaw, aimPitch, thrust }
  update(dt, motion, floorAt) {
    if (motion) {
      this.position.copy(motion.position);
      this.velocity.copy(motion.velocity);
      this.yaw = motion.yaw;
      this.aimYaw = motion.aimYaw ?? motion.yaw;
      this.aimPitch = motion.aimPitch ?? 0;
      this.thrust = motion.thrust ?? 0;
    }
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const accel = _d.subVectors(this.velocity, this.prevVel).divideScalar(Math.max(dt, 1e-3));
    this.prevVel.copy(this.velocity);
    const sev = [this.severity(0), this.severity(1)];
    const fwd = this.forward(new THREE.Vector3());
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);

    // --- procedural stepping ----------------------------------------------------
    const lead = Math.min(0.45, 0.16 + speed * 0.02);
    for (let i = 0; i < 2; i++) {
      const L = this.legs[i];
      const other = this.legs[1 - i];
      const desired = this._restFoot(L.side, new THREE.Vector3()).addScaledVector(this.velocity, lead);
      desired.y = floorAt ? floorAt(desired.x, desired.z, this.position.y + 1) : 0;
      if (L.swing) {
        L.t += dt / L.dur;
        // retarget mid-swing toward where the body is going
        L.to.lerp(desired, Math.min(1, dt * 6));
        const t = Math.min(1, L.t);
        const e = t * t * (3 - 2 * t);
        L.pos.lerpVectors(L.from, L.to, e);
        // stiff damaged knee: low clearance, swing arcs outward (circumduction)
        const s = sev[i];
        const lift = L.lift * (1 - 0.85 * s);
        L.pos.y += Math.sin(Math.PI * t) * lift;
        if (s > 0) L.pos.addScaledVector(right, L.side * Math.sin(Math.PI * t) * 0.38 * s);
        L.footYaw += (this.yaw - L.footYaw) * Math.min(1, dt * 10);
        if (s > 0.25 && lift < 0.12 && t > 0.15 && t < 0.85) L.scrape = s; else L.scrape = 0;
        if (L.t >= 1) {
          L.swing = false;
          L.plant.copy(L.to);
          L.pos.copy(L.to);
          L.planted = 0;
          const strength = Math.min(1.4, 0.45 + speed / 9 + (L.from.distanceTo(L.to) > 1.6 ? 0.3 : 0));
          // landing pushes the chassis down — this is where the mass reads
          this.bobV -= strength * (0.9 + s * 1.4);
          for (const f of this.listeners.footstep) f(this, L, strength, s);
        }
      } else {
        L.planted += dt;
        L.scrape = 0;
        const dist = Math.hypot(desired.x - L.plant.x, desired.z - L.plant.z);
        const yawErr = Math.abs(((this.yaw - L.footYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        let thr = 0.5 + speed * 0.065;
        if (sev[i] > 0) thr *= 1 - 0.35 * sev[i]; // short steps on the bad leg
        const otherBusy = other.swing && other.t < 0.92;
        const emergency = dist > 2.4;
        if ((dist > thr || yawErr > 0.6) && (!otherBusy || emergency) && L.planted > 0.06 && (dist > other._lastDist - 0.05 || other.swing || emergency)) {
          L.swing = true;
          L.t = 0;
          L.from.copy(L.plant);
          let dur = Math.max(0.2, 0.42 - speed * 0.018);
          // hurry off the bad leg: the good leg swings faster, the bad one slower
          const badOther = sev[1 - i];
          dur *= 1 - 0.3 * badOther;
          dur *= 1 + 0.35 * sev[i];
          if (emergency) dur *= 0.75;
          L.dur = dur;
          L.lift = 0.32 + Math.min(0.35, speed * 0.03);
          L.to.copy(desired).addScaledVector(this.velocity, dur * 0.5);
          L.to.y = floorAt ? floorAt(L.to.x, L.to.z, this.position.y + 1) : 0;
        }
        L._lastDist = dist;
      }
    }

    // --- chassis dynamics ---------------------------------------------------------
    const k = 140, c = 16;
    this.bobV += (-k * this.bobY - c * this.bobV) * dt;
    this.bobY += this.bobV * dt;
    // inertia lean from acceleration (body-relative)
    const af = accel.dot(fwd), ar = accel.dot(right);
    const target = new THREE.Vector2(THREE.MathUtils.clamp(af * 0.012, -0.12, 0.12), THREE.MathUtils.clamp(-ar * 0.01, -0.1, 0.1));
    this.leanV.x += ((target.x - this.lean.x) * 90 - this.leanV.x * 12) * dt;
    this.leanV.y += ((target.y - this.lean.y) * 90 - this.leanV.y * 12) * dt;
    this.lean.addScaledVector(this.leanV, dt);

    // limp: weight on the bad leg alone drops and rolls the pelvis toward it
    let dip = 0, roll = 0;
    for (let i = 0; i < 2; i++) {
      const s = sev[i];
      if (s <= 0) continue;
      const other = this.legs[1 - i];
      const L = this.legs[i];
      if (!L.swing && other.swing) {
        const ph = Math.sin(Math.PI * Math.min(1, other.t));
        dip += 0.2 * s * ph;
        roll += L.side * 0.13 * s * ph;
        if (s > 0.55 && this.buckle <= 0 && this.rng() < dt * 0.9 * s) this.buckle = 1;
      }
      if (L.swing) roll -= L.side * 0.07 * s * Math.sin(Math.PI * Math.min(1, L.t)); // hip hike to clear the stiff leg
      roll += L.side * 0.025 * s; // permanent list toward the weak side
    }
    if (this.buckle > 0) {
      this.buckle = Math.max(0, this.buckle - dt * 2.2);
      dip += Math.sin(this.buckle * Math.PI) * 0.32;
    }
    // stagger (after being rammed): damped wobble
    if (this.stagger > 0) {
      this.stagger = Math.max(0, this.stagger - dt * 1.4);
      roll += Math.sin(performance.now() * 0.018) * 0.12 * this.stagger;
    }
    this.roll += (roll - this.roll) * Math.min(1, dt * 10);

    // stance width: lower pelvis when feet are spread
    const spread = this.legs[0].pos.distanceTo(this.legs[1].pos);
    const hipY = REST_HIP - Math.max(0, spread - 1.9) * 0.12 - dip + this.bobY * 0.18 - speed * 0.006;

    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    this.pelvis.position.set(this.position.x, this.position.y + hipY, this.position.z);
    this.pelvis.rotation.set(0, 0, 0, 'YXZ');
    this.pelvis.rotation.y = this.yaw;
    this.pelvis.rotation.x = this.lean.x;
    this.pelvis.rotation.z = this.lean.y + this.roll;
    // torso twists toward aim and counter-leans against the limp
    let twist = this.aimYaw - this.yaw;
    twist = Math.atan2(Math.sin(twist), Math.cos(twist));
    this.torso.rotation.set(THREE.MathUtils.clamp(-this.aimPitch * 0.25, -0.15, 0.2) - this.lean.x * 0.6, twist, -this.roll * 0.55, 'YXZ');
    const armPitch = -this.aimPitch * 0.75;
    this.recoil = Math.max(0, this.recoil - dt * 5);
    this.armR.rotation.x = armPitch - this.recoil * 0.25;
    this.cannonBody.position.z = 0.25 - this.recoil * 0.35;
    this.armL.rotation.x = armPitch * 0.6;
    this.pod.rotation.x = armPitch;
    for (const nz of this.nozzles) nz.material.emissiveIntensity = this.thrust * 6;

    // --- legs: IK -----------------------------------------------------------------
    this.pelvis.updateMatrixWorld(true);
    for (let i = 0; i < 2; i++) {
      const L = this.legs[i];
      const s = sev[i];
      L.hip.set(L.side * HIP_X, -0.05, 0).applyMatrix4(this.pelvis.matrixWorld);
      L.ankle.copy(L.pos);
      L.ankle.y += ANKLE;
      // knee pole: forward, buckling inward when damaged, trembling
      const pole = fwd.clone();
      if (s > 0) {
        pole.addScaledVector(right, -L.side * 0.45 * s);
        pole.y += Math.sin(performance.now() * 0.04 + i) * 0.05 * s;
      }
      const maxBend = THREE.MathUtils.lerp(1.9, L.swing ? 0.55 : 1.45, s);
      this._ik(L.hip, L.ankle, pole, L.knee, maxBend);
      orientBone(L.thigh, L.hip, L.knee, pole);
      orientBone(L.shin, L.knee, L.ankle, pole);
      L.kneeGroup.position.copy(L.knee);
      L.kneeGroup.quaternion.copy(L.shin.quaternion);
      L.foot.position.copy(L.ankle);
      const fyaw = L.swing ? L.footYaw : L.footYaw;
      if (!L.swing) L.footYaw += (this.yaw - L.footYaw) * 0; // planted feet keep their yaw
      L.foot.rotation.set(L.swing ? -0.25 * Math.sin(Math.PI * L.t) : 0, fyaw, 0, 'YXZ');
      // hydraulic piston: thigh rear to shin rear
      _a.set(0, -L1 * 0.3, -0.5).applyQuaternion(L.thigh.quaternion).add(L.hip);
      _b.set(0, -L2 * 0.55, -0.5).applyQuaternion(L.shin.quaternion).add(L.knee);
      const len = _a.distanceTo(_b);
      _c.lerpVectors(_a, _b, 0.5);
      L.piston.position.lerpVectors(_a, _b, 0.65);
      L.pistonSleeve.position.lerpVectors(_a, _b, 0.3);
      _q.setFromUnitVectors(UP, _d.subVectors(_b, _a).normalize());
      L.piston.quaternion.copy(_q);
      L.pistonSleeve.quaternion.copy(_q);
      L.piston.scale.set(1, len * 0.6, 1);
      L.pistonSleeve.scale.set(1, len * 0.55, 1);
      // damaged joint glows and smokes
      L.kneeGlow.material.emissiveIntensity = s > 0 ? (0.6 + 2.2 * s) * (0.7 + 0.3 * Math.sin(performance.now() * 0.03 + i * 2)) : 0;
      if (this.fx && s > 0.2 && this.rng() < dt * 6 * s) this.fx.smoke(L.knee, 0.6 + s * 0.6, true);
      if (this.fx && s > 0.3 && this.rng() < dt * 4 * s) this.fx.sparks(L.knee, 3, null, [1, 0.75, 0.4], 5);
      if (L.scrape > 0) for (const f of this.listeners.scrape) f(this, L, L.scrape, dt);
    }
  }

  _ik(hip, ankle, pole, outKnee, maxBend) {
    const d0 = hip.distanceTo(ankle);
    // the bend limit sets a minimum hip-ankle distance; if the target is closer the leg stays straighter
    const dMin = Math.sqrt(L1 * L1 + L2 * L2 - 2 * L1 * L2 * Math.cos(Math.PI - maxBend));
    const d = THREE.MathUtils.clamp(d0, Math.max(dMin, 0.3), L1 + L2 - 1e-3);
    const dir = _a.subVectors(ankle, hip).normalize();
    if (d !== d0) ankle.copy(hip).addScaledVector(dir, d);
    const cosA = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const perp = _b.copy(pole).addScaledVector(dir, -pole.dot(dir)).normalize();
    outKnee.copy(hip).addScaledVector(dir, L1 * cosA).addScaledVector(perp, L1 * sinA);
  }

  // --- damage ---------------------------------------------------------------------
  // Hit volumes in world space from the current pose.
  hitVolumes() {
    const v = [];
    const P = this.pelvis.matrixWorld;
    const t = new THREE.Vector3();
    this.torso.updateMatrixWorld(true);
    const T = this.torso.matrixWorld;
    v.push({ part: 'torso', p: new THREE.Vector3(0, 0.85, 0).applyMatrix4(T), r: 1.35 });
    v.push({ part: 'torso', p: new THREE.Vector3(1.55, 1.15, 0).applyMatrix4(T), r: 0.7 });
    v.push({ part: 'torso', p: new THREE.Vector3(-1.55, 1.15, 0).applyMatrix4(T), r: 0.7 });
    v.push({ part: 'head', p: new THREE.Vector3(0, 1.62, 0.45).applyMatrix4(T), r: 0.45 });
    v.push({ part: 'pelvis', p: t.set(0, -0.1, 0).applyMatrix4(P).clone(), r: 0.8 });
    this.legs.forEach((L, i) => {
      v.push({ part: 'knee', leg: i, p: L.knee.clone(), r: 0.46 });
      v.push({ part: 'thigh', leg: i, p: new THREE.Vector3().lerpVectors(L.hip, L.knee, 0.45), r: 0.5 });
      v.push({ part: 'shin', leg: i, p: new THREE.Vector3().lerpVectors(L.knee, L.ankle, 0.5), r: 0.52 });
      v.push({ part: 'shin', leg: i, p: new THREE.Vector3().lerpVectors(L.knee, L.ankle, 0.9), r: 0.45 });
      v.push({ part: 'foot', leg: i, p: L.foot.position.clone().add(new THREE.Vector3(0, -0.1, 0)), r: 0.5 });
    });
    return v;
  }

  // Segment test; returns nearest hit {part, leg, point, t}
  raycast(p0, p1) {
    const dir = _c.subVectors(p1, p0);
    const len = dir.length();
    if (len < 1e-6) return null;
    dir.divideScalar(len);
    // coarse reject
    const center = _d.set(this.position.x, this.position.y + 2.6, this.position.z);
    const oc = new THREE.Vector3().subVectors(p0, center);
    const tc = -oc.dot(dir);
    const closest = oc.addScaledVector(dir, THREE.MathUtils.clamp(tc, 0, len));
    if (closest.length() > 3.6) return null;
    let best = null;
    for (const h of this.hitVolumes()) {
      const o = new THREE.Vector3().subVectors(p0, h.p);
      const b = o.dot(dir);
      const cc = o.dot(o) - h.r * h.r;
      const disc = b * b - cc;
      if (disc < 0) continue;
      const t = -b - Math.sqrt(disc);
      if (t < 0 || t > len) continue;
      // knees win ties so precise shots read as knee hits
      const score = t - (h.part === 'knee' ? 0.25 : 0);
      if (!best || score < best.score) best = { ...h, t, score, point: p0.clone().addScaledVector(dir, Math.max(0, t)) };
    }
    return best;
  }

  // Apply damage to the component system. Returns description for HUD/feedback.
  damage(part, leg, amount, point) {
    if (this.disabled) return;
    let knee = 0, chassis = amount * 0.35;
    if (part === 'knee') { knee = amount; chassis = amount * 0.2; }
    else if (part === 'shin' || part === 'thigh') knee = amount * 0.4;
    else if (part === 'foot') knee = amount * 0.15;
    else chassis = amount;
    if (knee > 0 && leg !== undefined) {
      const before = this.kneeHp[leg];
      this.kneeHp[leg] = Math.max(0, this.kneeHp[leg] - knee);
      if (before > 55 && this.kneeHp[leg] <= 55 && !this.kneeCapLost[leg]) this._loseKneeCap(leg, point);
      this.buckle = Math.max(this.buckle, Math.min(1, knee / 40));
    }
    this.chassisHp -= chassis;
    if (this.chassisHp <= 0) this.disabled = true;
  }

  _loseKneeCap(leg, point) {
    this.kneeCapLost[leg] = true;
    const L = this.legs[leg];
    L.kneeCap.visible = false;
    if (this.onPartLost) {
      L.kneeCap.updateWorldMatrix(true, false);
      this.onPartLost(L.kneeCap, point);
    }
  }
}
