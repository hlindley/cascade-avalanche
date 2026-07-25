import { CascadeScene } from './scene.js';

const originalBuildScene = CascadeScene.prototype.buildScene;

CascadeScene.prototype.buildScene = function buildSceneWithParticleCohortVFX() {
  originalBuildScene.call(this);

  for (const mesh of [this.surfaceMesh, this.coreMesh, this.depositMesh, this.powderMesh]) {
    if (mesh) mesh.setEnabled(false);
  }

  this.particleWave = {
    particles: [],
    mist: [],
    maxParticles: 24000,
    maxMist: 2400,
    capturedEmitters: [],
    captureEnergy: 0,
    cohortTarget: 0,
    cohortSpawned: 0,
    releaseCaptured: false,
    cohortCarry: 0,
    entrainmentCarry: 0,
    mistCarry: 0,
    lastTime: performance.now() * .001
  };

  this.waveParticleMesh = makeParticle.call(this, 'waveParticle056', false);
  this.waveMistMesh = makeParticle.call(this, 'waveMist056', true);

  const sky = this.scene.getMeshByName('sunsetSky');
  const tex = sky?.material?.emissiveTexture;
  if (tex?.getContext) {
    const ctx = tex.getContext();
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, '#6e98c9');
    g.addColorStop(.50, '#b3c8df');
    g.addColorStop(.78, '#f4bea5');
    g.addColorStop(1, '#ffe5aa');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 512);
    tex.update();
  }
  this.scene.clearColor = new BABYLON.Color4(.46, .61, .78, 1);
  this.scene.fogColor = new BABYLON.Color3(.72, .72, .79);
  this.scene.fogDensity = .0019;
  this.scene.imageProcessingConfiguration.exposure = 1.28;
  this.scene.imageProcessingConfiguration.contrast = 1.01;
  this.hemi.intensity = .88;
  this.sun.intensity = 1.82;
  this.sun.diffuse = new BABYLON.Color3(1, .79, .61);
  if (this.shadowGenerator) this.shadowGenerator.darkness = .13;
};

CascadeScene.prototype.updateFlow = function updateParticleCohortVFX() {
  const state = this.particleWave;
  const now = performance.now() * .001;
  const dt = Math.min(.04, Math.max(.006, now - state.lastTime));
  state.lastTime = now;

  const active = collectActiveCells.call(this);

  // Capture the released slab once, near the beginning of the event. Prefer the
  // highest energetic cells so the visible mass starts at the crown and travels.
  if (!state.releaseCaptured && active.length > 4) {
    const maxY = Math.max(...active.map(e => e.world.y));
    const minY = Math.min(...active.map(e => e.world.y));
    const crownCut = minY + (maxY - minY) * .58;
    let crown = active.filter(e => e.world.y >= crownCut);
    if (crown.length < 4) crown = active.slice().sort((a, b) => b.world.y - a.world.y).slice(0, Math.max(4, Math.ceil(active.length * .35)));
    state.capturedEmitters = crown;
    state.captureEnergy = crown.reduce((sum, e) => sum + e.energy, 0);
    state.cohortTarget = Math.min(state.maxParticles, Math.max(12000, Math.floor(14500 + state.captureEnergy * 220)));
    state.releaseCaptured = true;
  }

  // Release the cohort rapidly over about half a second. These grains then live
  // for the full descent rather than being replaced by downstream emitters.
  if (state.releaseCaptured && state.cohortSpawned < state.cohortTarget) {
    const remaining = state.cohortTarget - state.cohortSpawned;
    const rate = state.cohortTarget * 2.4;
    state.cohortCarry += rate * dt;
    let count = Math.min(1800, remaining, Math.floor(state.cohortCarry));
    state.cohortCarry -= count;
    while (count-- > 0 && state.particles.length < state.maxParticles) {
      const emitter = weightedEmitter(state.capturedEmitters, state.captureEnergy);
      if (!emitter) break;
      state.particles.push(spawnParticle.call(this, emitter, false, true));
      state.cohortSpawned++;
    }
  }

  // Entrainment is intentionally tiny: no more than roughly 8% of the primary
  // cohort, and only near energetic leading cells.
  const entrainmentLimit = Math.floor(state.cohortTarget * .08);
  const entrained = Math.max(0, state.cohortSpawned - Math.min(state.cohortSpawned, state.cohortTarget));
  if (state.releaseCaptured && active.length && state.particles.length < state.maxParticles && entrained < entrainmentLimit) {
    const total = active.reduce((sum, e) => sum + e.energy, 0);
    state.entrainmentCarry += Math.min(260, total * 4.5) * dt;
    let count = Math.min(35, Math.floor(state.entrainmentCarry));
    state.entrainmentCarry -= count;
    while (count-- > 0 && state.particles.length < state.maxParticles) {
      const emitter = weightedEmitter(active, total);
      if (!emitter) break;
      state.particles.push(spawnParticle.call(this, emitter, false, false));
    }
  }

  if (active.length) {
    const total = active.reduce((sum, e) => sum + e.powder, 0);
    state.mistCarry += Math.min(320, total * 10) * dt;
    let count = Math.min(28, Math.floor(state.mistCarry));
    state.mistCarry -= count;
    while (count-- > 0 && state.mist.length < state.maxMist) {
      const emitter = weightedEmitter(active, active.reduce((sum, e) => sum + e.energy, 0));
      if (!emitter) break;
      state.mist.push(spawnParticle.call(this, emitter, true, false));
    }
  }

  advect.call(this, state.particles, dt, false);
  advect.call(this, state.mist, dt, true);

  const particleMatrices = [];
  const mistMatrices = [];
  for (const p of state.particles) pushParticle(particleMatrices, p, false);
  for (const p of state.mist) pushParticle(mistMatrices, p, true);
  setInstances(this.waveParticleMesh, particleMatrices);
  setInstances(this.waveMistMesh, mistMatrices);
};

function collectActiveCells() {
  const result = [];
  for (let z = 1; z < this.sim.size - 1; z++) {
    for (let x = 1; x < this.sim.size - 1; x++) {
      const i = this.sim.index(x, z);
      const moving = this.sim.moving[i];
      const core = this.sim.core[i];
      const powder = this.sim.powder[i];
      const energy = moving + core * .82;
      if (energy < .014) continue;
      result.push({ x, z, i, energy, powder, world: this.sim.worldPosition(x, z) });
    }
  }
  return result;
}

function spawnParticle(emitter, mist, primaryCohort) {
  const world = emitter.world || this.sim.worldPosition(emitter.x, emitter.z);
  const dir = downhill.call(this, emitter.x, emitter.z);
  const sideX = -dir.z, sideZ = dir.x;
  const lane = Math.floor(Math.random() * 3);
  const laneSpeed = lane === 0 ? 1.22 : lane === 1 ? 1 : .82;
  const baseSpeed = (mist ? 2.3 : primaryCohort ? 4.3 : 4.8) + Math.min(5.8, Math.sqrt(emitter.energy) * 3.2);
  const lateral = (Math.random() - .5) * (mist ? 2.5 : primaryCohort ? 2.6 : 1.4);
  const forward = primaryCohort ? (Math.random() - .65) * 3.4 : (Math.random() - .45) * 1.1;
  const ground = this.sim.sampleWorldHeight(world.x, world.z);
  return {
    x: world.x + dir.x * forward + sideX * lateral,
    y: ground + (mist ? .7 + Math.random() * 1.7 : .045 + Math.random() * .16),
    z: world.z + dir.z * forward + sideZ * lateral,
    vx: dir.x * baseSpeed * laneSpeed + sideX * (Math.random() - .5) * .58,
    vy: mist ? .14 + Math.random() * .55 : .02 + Math.random() * .18,
    vz: dir.z * baseSpeed * laneSpeed + sideZ * (Math.random() - .5) * .58,
    age: 0,
    life: mist ? 2.8 + Math.random() * 3.8 : primaryCohort ? 9.5 + Math.random() * 5.5 : 7 + Math.random() * 4,
    size: mist ? .08 + Math.random() * .10 : .018 + Math.random() * .024,
    lane,
    spin: Math.random() * Math.PI * 2,
    primaryCohort
  };
}

function advect(list, dt, mist) {
  const next = [];
  for (const p of list) {
    p.age += dt;
    if (p.age >= p.life) continue;

    const gx = Math.round(p.x / this.sim.cellSize + this.sim.size / 2);
    const gz = Math.round(p.z / this.sim.cellSize + this.sim.size / 2);
    if (!this.sim.inBounds(gx, gz)) continue;

    const dir = downhill.call(this, gx, gz);
    const speed = Math.hypot(p.vx, p.vz);
    const laneTarget = p.lane === 0 ? 8.8 : p.lane === 1 ? 7.1 : 5.7;
    const desired = mist ? Math.max(2.2, speed) : Math.max(laneTarget, speed + .35 * dt);
    const steer = mist ? 1.0 : 2.65;
    p.vx += (dir.x * desired - p.vx) * Math.min(1, steer * dt);
    p.vz += (dir.z * desired - p.vz) * Math.min(1, steer * dt);

    const sideX = -dir.z, sideZ = dir.x;
    const wobble = Math.sin(p.age * (5.8 + p.lane * 1.1) + p.spin) * (mist ? .28 : .12);
    p.vx += sideX * wobble * dt;
    p.vz += sideZ * wobble * dt;

    p.vx *= mist ? .989 : .996;
    p.vz *= mist ? .989 : .996;
    p.vy += (mist ? .09 : -.42) * dt;
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    p.y += p.vy * dt;

    const ground = this.sim.sampleWorldHeight(p.x, p.z);
    const hover = mist ? .48 : .035;
    if (p.y < ground + hover) {
      p.y = ground + hover;
      p.vy = mist ? Math.abs(p.vy) * .18 : Math.abs(p.vy) * .10;
    }

    // Primary grains are never culled because local simulation activity faded.
    // They survive from crown to runout unless they age out or leave the map.
    next.push(p);
  }
  list.length = 0;
  list.push(...next);
}

function weightedEmitter(emitters, total) {
  if (!emitters.length || total <= 0) return emitters[0] || null;
  let r = Math.random() * total;
  for (const e of emitters) {
    r -= e.energy;
    if (r <= 0) return e;
  }
  return emitters[emitters.length - 1];
}

function pushParticle(arr, p, mist) {
  const speed = Math.hypot(p.vx, p.vz) || 1;
  const angle = Math.atan2(p.vx, p.vz);
  const endFade = Math.min(1, (p.life - p.age) / 1.2);
  const startFade = Math.min(1, p.age / .12);
  const fade = Math.max(.15, Math.min(startFade, endFade));
  const width = p.size * (mist ? 2.1 : .72) * fade;
  const height = p.size * (mist ? 1.25 : .46) * fade;
  const length = p.size * (mist ? 2.6 : 3.0 + Math.min(5.5, speed * .42)) * fade;
  const matrix = BABYLON.Matrix.Compose(
    new BABYLON.Vector3(width, height, length),
    BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Y, angle),
    new BABYLON.Vector3(p.x, p.y, p.z)
  );
  arr.push(...matrix.toArray());
}

function makeParticle(name, mist) {
  const mesh = BABYLON.MeshBuilder.CreateIcoSphere(name, { radius: 1, subdivisions: 0 }, this.scene);
  const material = this.mat(`${name}Mat`, new BABYLON.Color3(1, .99, 1), .99);
  material.emissiveColor = new BABYLON.Color3(.065, .058, .068);
  if (mist) {
    material.alpha = .13;
    material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  }
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function downhill(x, z) {
  x = Math.max(1, Math.min(this.sim.size - 2, Math.round(x)));
  z = Math.max(1, Math.min(this.sim.size - 2, Math.round(z)));
  const left = this.sim.height[this.sim.index(x - 1, z)];
  const right = this.sim.height[this.sim.index(x + 1, z)];
  const up = this.sim.height[this.sim.index(x, z - 1)];
  const down = this.sim.height[this.sim.index(x, z + 1)];
  const dx = left - right, dz = up - down;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

function setInstances(mesh, matrices) {
  mesh.thinInstanceSetBuffer('matrix', new Float32Array(matrices), 16, true);
}
