import * as THREE from 'three';
import { Physics } from './physics.js';
import { FX } from './fx.js';
import { Debris } from './debris.js';
import { DestructionSystem } from './destruct.js';
import { buildEnvironment } from './env.js';
import { buildAlley } from './alley.js';
import { Weapons } from './weapons.js';
import { Player } from './player.js';
import { Target } from './target.js';
import { CameraRig } from './camera.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { Perf } from './perf.js';
import { installDebug } from './debug.js';

const DT = 1 / 60;
const $ = (id) => document.getElementById(id);

class Game {
  async init() {
    const t0 = performance.now();
    this.canvas = $('view');
    const params = new URLSearchParams(location.search);
    this.params = params;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, params.has('dpr') ? Number(params.get('dpr')) : 1.5));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.info.autoReset = true;
    this.scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.05, 1500);
    this.scene.add(cam);

    this.physics = await Physics.create();
    this.env = buildEnvironment(this);
    this.fx = new FX(this.scene, (x, z, y) => this.floorAt(x, z, y));
    this.fx.setFog(this.scene.fog);
    this.debris = new Debris(this.scene, this.physics, this.fx, (x, z, y) => this.floorAt(x, z, y));
    this.destruction = new DestructionSystem(this.scene, this.physics, this.debris, this.fx);
    const tA = performance.now();
    this.alley = buildAlley(this);
    this.buildMs = { alley: performance.now() - tA, panels: this.destruction.panels.reduce((s, p) => s + p.buildMs, 0) };
    this.floorAt = this.alley.floorAt;
    this.weapons = new Weapons(this);
    this.camera = new CameraRig(this, cam);
    this.player = new Player(this, { position: this.alley.spawns.player.p, yaw: this.alley.spawns.player.yaw });
    this.target = new Target(this, { position: this.alley.spawns.target.p, yaw: this.alley.spawns.target.yaw, routes: this.alley.routes });
    this.mechs = [this.player, this.target];
    this.input = new Input(this.canvas);
    this.audio = new Audio(this);
    this.perf = new Perf(this);
    this.acc = 0;
    this.time = 0;
    this.paused = false;
    this.timeScale = 1;
    this.manual = params.has('manual');
    this.aimPoint = new THREE.Vector3();
    this._hud();
    addEventListener('resize', () => this._resize());
    this.physics.world.step();
    this.initMs = performance.now() - t0;
    installDebug(this);
    $('loading').hidden = true;
    if (!this.manual) requestAnimationFrame((t) => this._frame(t));
  }

  _resize() {
    const c = this.camera.camera;
    c.aspect = innerWidth / innerHeight;
    c.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  reset() {
    const t0 = performance.now();
    this.weapons.reset();
    this.debris.reset();
    this.destruction.reset();
    this.fx.reset();
    for (const m of this.mechs) m.reset();
    this.camera.setMode(this.camera.mode);
    this.perf.resetStats();
    this.lastResetMs = performance.now() - t0;
    this.perf.event('reset', this.lastResetMs);
    this._flashBanner(`RESET · ${this.lastResetMs.toFixed(1)} ms`);
  }

  // one fixed simulation step
  step(dt, inputState) {
    this.player.fixedUpdate(dt, inputState);
    this.target.fixedUpdate(dt);
    this.weapons.update(dt);
    this.physics.step();
    this.debris.update(dt);
    for (const m of this.mechs) m.debrisContacts(dt);
    for (const m of this.mechs) m.updateRig(dt);
    this.time += dt;
  }

  _gatherInput() {
    const I = this.input;
    const look = { dx: I.mouse.dx * I.sensitivity, dy: I.mouse.dy * I.sensitivity };
    // aim point from the camera ray, ignoring own collider
    const ray = this.camera.aimRay();
    const hit = this.physics.castRay(ray.origin, ray.dir, 400, this.player.collider);
    this.aimPoint.copy(ray.origin).addScaledVector(ray.dir, hit ? hit.toi : 400);
    // aim at mechs too
    const far = ray.origin.clone().addScaledVector(ray.dir, hit ? hit.toi : 400);
    const mh = this.target.disabledBody ? null : this.target.rig.raycast(ray.origin, far);
    if (mh) this.aimPoint.copy(mh.point);
    this.aimTarget = mh;
    return {
      move: { x: I.axis('KeyA', 'KeyD'), z: I.axis('KeyS', 'KeyW') },
      look,
      fire: I.mouse.left || I.down.has('KeyF'),
      salvo: I.mouse.right || I.down.has('KeyQ'),
      boost: I.wasPressed('ShiftLeft') || I.wasPressed('ShiftRight') || I.wasPressed('Space'),
      aimPoint: this.aimPoint.clone(),
    };
  }

  _keys() {
    const I = this.input;
    if (I.wasPressed('KeyR')) this.reset();
    if (I.wasPressed('KeyV')) this.camera.setMode(this.camera.mode === 'cockpit' ? 'chase' : 'cockpit');
    if (I.wasPressed('Backquote') || I.wasPressed('F3')) this.perf.toggle();
    if (I.wasPressed('KeyH')) $('help').hidden = !$('help').hidden;
    if (I.wasPressed('KeyP')) this.paused = !this.paused;
    if (I.wasPressed('KeyT')) this.timeScale = this.timeScale === 1 ? 0.25 : 1;
    if (I.wasPressed('KeyM')) { this.audio.enabled = !this.audio.enabled; }
    const modes = { Digit1: 'strafe', Digit2: 'cover', Digit3: 'inside', Digit4: 'hold' };
    for (const [k, m] of Object.entries(modes)) if (I.wasPressed(k)) { this.target.setMode(m); this._flashBanner(`TARGET · ${m.toUpperCase()}`); }
    if (I.wasPressed('Digit0')) { this.target.fireEnabled = !this.target.fireEnabled; this._flashBanner(`TARGET FIRE ${this.target.fireEnabled ? 'ON' : 'OFF'}`); }
    if (I.wasPressed('F5')) this.debugApi.scenario('A');
  }

  _frame(now) {
    requestAnimationFrame((t) => this._frame(t));
    this.perf.beginFrame(now);
    this._keys();
    const frameDt = Math.min(0.1, (now - (this.lastNow ?? now)) / 1000);
    this.lastNow = now;
    if (!this.paused) {
      this.acc += frameDt * this.timeScale;
      const inputState = this._gatherInput();
      let steps = 0;
      while (this.acc >= DT && steps < 4) {
        this.step(DT, inputState);
        // look/presses apply once per frame
        inputState.look = { dx: 0, dy: 0 };
        inputState.boost = false;
        this.acc -= DT;
        steps++;
      }
      if (steps === 4) this.acc = 0;
      this.fx.update(frameDt * this.timeScale);
    }
    this.camera.update(frameDt, this.player);
    for (const p of this.destruction.panels) p.flush();
    this.perf.markUpdate();
    this.perf.beginGpu();
    this.renderer.render(this.scene, this.camera.camera);
    this.perf.endGpu();
    this.perf.endFrame();
    this._updateHud(frameDt);
    this.input.endFrame();
  }

  // deterministic stepping for automated inspection (no rAF)
  advance(seconds, inputState) {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      this.perf.beginFrame(t0);
      const inp = inputState ? inputState(i) : { move: { x: 0, z: 0 }, look: { dx: 0, dy: 0 }, fire: false, salvo: false, boost: false, aimPoint: this.aimPoint.clone() };
      this.step(DT, inp);
      this.fx.update(DT);
      this.camera.update(DT, this.player);
      for (const p of this.destruction.panels) p.flush();
      this.perf.markUpdate();
      this.perf.endFrame();
    }
  }

  render() {
    this.camera.update(0.0001, this.player);
    this.renderer.render(this.scene, this.camera.camera);
  }

  // ------------------------------------------------------------------ HUD
  _hud() {
    const start = $('start');
    start.addEventListener('click', () => { this.input.lock(); this.audio.start(); });
    this.input.onLockChange = (locked) => { start.hidden = locked; };
    $('btnReset').addEventListener('click', (e) => { e.stopPropagation(); this.reset(); });
    for (const s of ['A', 'B', 'C']) $(`btn${s}`).addEventListener('click', (e) => { e.stopPropagation(); this.debugApi.scenario(s); this.input.lock(); this.audio.start(); });
  }

  _flashBanner(text) {
    const b = $('banner');
    b.textContent = text;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
  }

  _updateHud() {
    const p = this.player, t = this.target;
    $('boostFill').style.width = `${p.energy}%`;
    $('boostFill').classList.toggle('low', p.energy < 42 * 0.6);
    $('cannonFill').style.width = `${(1 - p.cannonCd / 0.55) * 100}%`;
    $('salvoFill').style.width = `${(1 - p.salvoCd / 3.6) * 100}%`;
    const k0 = t.rig.kneeHp[0], k1 = t.rig.kneeHp[1];
    $('kneeL').style.width = `${k0}%`;
    $('kneeR').style.width = `${k1}%`;
    $('kneeL').classList.toggle('bad', k0 < 60);
    $('kneeR').classList.toggle('bad', k1 < 60);
    $('chassis').style.width = `${Math.max(0, t.rig.chassisHp / 420) * 100}%`;
    const sev = Math.max(t.rig.severity(0), t.rig.severity(1));
    $('tstate').textContent = t.disabledBody ? 'DISABLED' : sev > 0.75 ? 'CRIPPLED' : sev > 0.3 ? 'LIMPING' : t.rig.stagger > 0.4 ? 'STAGGERED' : 'NOMINAL';
    $('tmode').textContent = t.mode.toUpperCase();
    $('reticle').classList.toggle('onTarget', !!this.aimTarget);
    $('reticle').classList.toggle('onKnee', this.aimTarget?.part === 'knee');
    $('hitflash').style.opacity = (p.hitFlash * 0.5).toFixed(2);
    $('speed').textContent = `${Math.round(Math.hypot(p.velocity.x, p.velocity.z) * 3.6)} km/h`;
    $('modeTag').textContent = this.camera.mode === 'cockpit' ? 'COCKPIT' : 'CHASE';
  }
}

const game = new Game();
window.alley = game;
game.init().catch((e) => {
  console.error(e);
  $('loading').textContent = `Failed to start: ${e.message}`;
});
