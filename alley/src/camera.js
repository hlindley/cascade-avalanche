import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/RoundedBoxGeometry.js';

// Cockpit / chase camera. Aim is always exact; mass is felt through the chassis around
// the eye (frame lag, footstep dip, recoil, impact jolts), not through input lag.
export class CameraRig {
  constructor(game, camera) {
    this.g = game;
    this.camera = camera;
    this.mode = 'cockpit';
    this.baseFov = 78;
    this.bob = 0; this.bobV = 0;
    this.kick = 0; this.kickV = 0;
    this.shake = 0;
    this.fovKick = 0;
    this.roll = 0;
    this.frameOff = new THREE.Vector3(); this.frameVel = new THREE.Vector3();
    this.frameRot = new THREE.Vector2(); this.frameRotV = new THREE.Vector2();
    this.lastYaw = 0; this.lastPitch = 0;
    this._buildCockpit();
    this.t = 0;
  }

  _buildCockpit() {
    const g = new THREE.Group();
    const frame = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.55, metalness: 0.6 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x3a4047, roughness: 0.4, metalness: 0.7 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xff5b1f, roughness: 0.5, metalness: 0.2 });
    const screenA = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 1.4, 1.3) });
    const screenB = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.6, 0.2) });
    const rb = (w, h, d, r, m) => new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, r), m);
    // top hood
    const hood = rb(2.6, 0.1, 0.35, 0.04, frame);
    hood.position.set(0, 0.6, -0.62);
    hood.rotation.x = -0.35;
    g.add(hood);
    // A-pillars
    for (const s of [-1, 1]) {
      const p = rb(0.07, 1.3, 0.08, 0.03, frame);
      p.position.set(s * 0.98, 0.05, -0.66);
      p.rotation.z = s * 0.38;
      p.rotation.y = s * -0.25;
      g.add(p);
      const side = rb(0.3, 0.4, 0.9, 0.06, trim);
      side.position.set(s * 1.08, -0.56, -0.5);
      side.rotation.z = s * 0.35;
      g.add(side);
      const stripe = rb(0.02, 0.4, 0.04, 0.01, accent);
      stripe.position.set(s * 0.93, -0.05, -0.6);
      stripe.rotation.z = s * 0.38;
      stripe.rotation.y = s * -0.25;
      g.add(stripe);
    }
    // dash
    const dash = rb(1.9, 0.22, 0.42, 0.06, frame);
    dash.position.set(0, -0.6, -0.62);
    dash.rotation.x = 0.35;
    g.add(dash);
    const lip = rb(1.2, 0.05, 0.08, 0.02, trim);
    lip.position.set(0, -0.5, -0.48);
    g.add(lip);
    // screens
    const sGeo = new THREE.PlaneGeometry(0.22, 0.09);
    [[-0.5, screenA], [-0.22, screenB], [0.25, screenA], [0.52, screenA]].forEach(([x, m], i) => {
      const s = new THREE.Mesh(sGeo, m);
      s.position.set(x, -0.525 + (i % 2) * 0.004, -0.52);
      s.rotation.x = -0.95;
      g.add(s);
    });
    g.traverse((o) => { o.renderOrder = 20; if (o.material) { o.material.depthTest = true; } });
    this.cockpit = g;
    this.camera.add(g);
  }

  setMode(m) {
    this.mode = m;
    this.cockpit.visible = m === 'cockpit';
  }

  // inspection camera (debug / automated captures)
  setFree(pos, look, fov = 60) {
    this.mode = 'free';
    this.cockpit.visible = false;
    this.camera.position.copy(pos);
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(look);
    this.camera.updateMatrixWorld(true);
  }

  footstep(strength) { this.bobV -= strength * 0.55; this.frameVel.y -= strength * 0.06; }
  impulse(s) { this.shake = Math.min(1.4, this.shake + s); this.frameVel.z += s * 0.25; }
  recoil(a) { this.kickV += a; this.frameVel.z += a * 0.6; }

  update(dt, player) {
    this.t += dt;
    const cam = this.camera;
    // springs
    this.bobV += (-120 * this.bob - 14 * this.bobV) * dt; this.bob += this.bobV * dt;
    this.kickV += (-220 * this.kick - 24 * this.kickV) * dt; this.kick += this.kickV * dt;
    this.shake = Math.max(0, this.shake - dt * 3.2);
    this.fovKick += ((player.dashing ? 9 : 0) - this.fovKick) * Math.min(1, dt * (player.dashing ? 10 : 4));
    const yawRate = (player.viewYaw - this.lastYaw) / Math.max(dt, 1e-3);
    const pitchRate = (player.viewPitch - this.lastPitch) / Math.max(dt, 1e-3);
    this.lastYaw = player.viewYaw; this.lastPitch = player.viewPitch;
    // chassis around the eye lags rotation and dips with weight transfer
    const acc = player.localAccel ?? new THREE.Vector2();
    const tgt = new THREE.Vector3(-acc.x * 0.0016, 0, acc.y * 0.002);
    this.frameVel.x += ((tgt.x - this.frameOff.x) * 160 - this.frameVel.x * 16) * dt;
    this.frameVel.y += ((tgt.y - this.frameOff.y) * 160 - this.frameVel.y * 16) * dt;
    this.frameVel.z += ((tgt.z - this.frameOff.z) * 160 - this.frameVel.z * 16) * dt;
    this.frameOff.addScaledVector(this.frameVel, dt);
    const rt = new THREE.Vector2(THREE.MathUtils.clamp(yawRate * 0.006, -0.05, 0.05), THREE.MathUtils.clamp(pitchRate * 0.005, -0.04, 0.04));
    this.frameRotV.x += ((rt.x - this.frameRot.x) * 140 - this.frameRotV.x * 15) * dt;
    this.frameRotV.y += ((rt.y - this.frameRot.y) * 140 - this.frameRotV.y * 15) * dt;
    this.frameRot.addScaledVector(this.frameRotV, dt);
    this.roll += ((-(acc.x ?? 0) * 0.0018 + player.rig.roll * 0.25) - this.roll) * Math.min(1, dt * 6);
    const sh = this.shake * this.shake;
    const shx = (Math.sin(this.t * 61) + Math.sin(this.t * 37.3)) * 0.004 * sh;
    const shy = (Math.sin(this.t * 53.1) + Math.sin(this.t * 29.7)) * 0.004 * sh;

    if (this.mode === 'free') { player.rig.root.visible = true; return; }
    cam.fov = this.baseFov + this.fovKick;
    cam.updateProjectionMatrix();
    const yaw = player.viewYaw, pitch = player.viewPitch;
    if (this.mode === 'cockpit') {
      player.rig.head.updateWorldMatrix(true, false);
      const head = new THREE.Vector3().setFromMatrixPosition(player.rig.head.matrixWorld);
      const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      cam.position.copy(head).addScaledVector(fwd, 0.55);
      cam.position.y += 0.12 + this.bob * 0.08;
      cam.rotation.set(pitch + this.kick + shy, yaw + Math.PI + shx, this.roll, 'YXZ');
      this.cockpit.position.copy(this.frameOff);
      this.cockpit.rotation.set(this.frameRot.y + this.kick * 0.4, this.frameRot.x, 0);
      player.rig.root.visible = this.g.showOwnMech ?? false;
    } else {
      const c = player.centerPoint();
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * 0.6, yaw + Math.PI, 0, 'YXZ'));
      const off = new THREE.Vector3(-2.2, 2.2, 10.5).applyQuaternion(q);
      const want = c.clone().add(new THREE.Vector3(0, 1.6, 0)).add(off);
      // keep the chase camera out of walls
      const dir = want.clone().sub(c).normalize();
      const hit = this.g.physics.castRay(c, dir, want.distanceTo(c), player.collider, (col) => {
        const o = this.g.physics.ownerOf(col);
        return !(o && (o.kind === 'debris' || o.kind === 'mech'));
      });
      if (hit) want.copy(c).addScaledVector(dir, Math.max(1.5, hit.toi - 0.4));
      cam.position.copy(want);
      cam.position.y += this.bob * 0.05;
      cam.rotation.set(pitch + this.kick * 0.5 + shy, yaw + Math.PI + shx, this.roll * 0.5, 'YXZ');
      player.rig.root.visible = true;
    }
    cam.updateMatrixWorld(true);
  }

  aimRay() {
    const o = new THREE.Vector3(), d = new THREE.Vector3();
    this.camera.getWorldPosition(o);
    this.camera.getWorldDirection(d);
    return { origin: o, dir: d };
  }
}
