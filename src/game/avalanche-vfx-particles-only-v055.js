import { CascadeScene } from './scene.js';

const originalBuildScene = CascadeScene.prototype.buildScene;

CascadeScene.prototype.buildScene = function buildSceneWithParticlesOnlyVFX() {
  originalBuildScene.call(this);

  for (const mesh of [this.surfaceMesh, this.coreMesh, this.depositMesh, this.powderMesh]) {
    if (mesh) mesh.setEnabled(false);
  }

  this.particleWave = {
    particles: [],
    mist: [],
    maxParticles: 9000,
    maxMist: 1800,
    spawnCarry: 0,
    mistCarry: 0,
    lastTime: performance.now() * .001
  };

  this.waveParticleMesh = makeParticle.call(this, 'waveParticle055', false);
  this.waveMistMesh = makeParticle.call(this, 'waveMist055', true);

  // Earlier sunset, brighter and cleaner than the restored v0.5.4 scene.
  const sky = this.scene.getMeshByName('sunsetSky');
  const tex = sky?.material?.emissiveTexture;
  if (tex?.getContext) {
    const ctx = tex.getContext();
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, '#628ac1');
    g.addColorStop(.48, '#a8bedb');
    g.addColorStop(.76, '#f0b7a1');
    g.addColorStop(1, '#ffe0a2');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 512);
    tex.update();
  }
  this.scene.clearColor = new BABYLON.Color4(.42, .56, .74, 1);
  this.scene.fogColor = new BABYLON.Color3(.68, .67, .75);
  this.scene.fogDensity = .0022;
  this.scene.imageProcessingConfiguration.exposure = 1.22;
  this.scene.imageProcessingConfiguration.contrast = 1.03;
  this.hemi.intensity = .82;
  this.sun.intensity = 1.78;
  this.sun.diffuse = new BABYLON.Color3(1, .76, .57);
  if (this.shadowGenerator) this.shadowGenerator.darkness = .16;
};

CascadeScene.prototype.updateFlow = function updateParticlesOnlyVFX() {
  const state = this.particleWave;
  const now = performance.now() * .001;
  const dt = Math.min(.045, Math.max(.006, now - state.lastTime));
  state.lastTime = now;

  const emitters = [];
  let totalEnergy = 0;
  for (let z = 1; z < this.sim.size - 1; z++) {
    for (let x = 1; x < this.sim.size - 1; x++) {
      const i = this.sim.index(x, z);
      const moving = this.sim.moving[i];
      const core = this.sim.core[i];
      const powder = this.sim.powder[i];
      const energy = moving + core * .75;
      if (energy < .018) continue;
      emitters.push({ x, z, i, energy, powder });
      totalEnergy += energy;
    }
  }

  // Emit a coherent traveling wave rather than rebuilding particles from the grid.
  if (emitters.length) {
    const targetRate = Math.min(5200, 900 + totalEnergy * 155);
    state.spawnCarry += targetRate * dt;
    let spawnCount = Math.min(700, Math.floor(state.spawnCarry));
    state.spawnCarry -= spawnCount;

    while (spawnCount-- > 0 && state.particles.length < state.maxParticles) {
      const e = weightedEmitter(emitters, totalEnergy);
      if (!e) break;
      state.particles.push(spawnParticle.call(this, e, false));
    }

    const mistRate = Math.min(750, totalEnergy * 18);
    state.mistCarry += mistRate * dt;
    let mistCount = Math.min(90, Math.floor(state.mistCarry));
    state.mistCarry -= mistCount;
    while (mistCount-- > 0 && state.mist.length < state.maxMist) {
      const e = weightedEmitter(emitters, totalEnergy);
      if (!e) break;
      state.mist.push(spawnParticle.call(this, e, true));
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

function spawnParticle(emitter, mist) {
  const world = this.sim.worldPosition(emitter.x, emitter.z);
  const dir = downhill.call(this, emitter.x, emitter.z);
  const sideX = -dir.z, sideZ = dir.x;
  const lane = Math.floor(Math.random() * 3);
  const laneSpeed = lane === 0 ? 1.28 : lane === 1 ? 1 : .76;
  const baseSpeed = (mist ? 2.2 : 5.8) + Math.min(6.5, Math.sqrt(emitter.energy) * 3.7);
  const lateral = (Math.random() - .5) * (mist ? 2.2 : 1.35);
  const forward = (Math.random() - .4) * 1.15;
  const ground = this.sim.sampleWorldHeight(world.x, world.z);
  return {
    x: world.x + dir.x * forward + sideX * lateral,
    y: ground + (mist ? .75 + Math.random() * 1.8 : .08 + Math.random() * .30),
    z: world.z + dir.z * forward + sideZ * lateral,
    vx: dir.x * baseSpeed * laneSpeed + sideX * (Math.random() - .5) * .65,
    vy: mist ? .18 + Math.random() * .75 : .05 + Math.random() * .32,
    vz: dir.z * baseSpeed * laneSpeed + sideZ * (Math.random() - .5) * .65,
    age: 0,
    life: mist ? 1.5 + Math.random() * 2.2 : 1.1 + Math.random() * 2.0,
    size: mist ? .16 + Math.random() * .22 : .055 + Math.random() * .075,
    lane,
    spin: (Math.random() - .5) * .4
  };
}

function advect(list, dt, mist) {
  const drag = mist ? .985 : .992;
  const steer = mist ? 1.2 : 3.8;
  const next = [];
  for (const p of list) {
    p.age += dt;
    if (p.age >= p.life) continue;

    const gx = Math.round(p.x / this.sim.cellSize + this.sim.size / 2);
    const gz = Math.round(p.z / this.sim.cellSize + this.sim.size / 2);
    if (!this.sim.inBounds(gx, gz)) continue;

    const dir = downhill.call(this, gx, gz);
    const speed = Math.hypot(p.vx, p.vz);
    const desired = mist ? Math.max(2.2, speed) : Math.max(5.0, speed + .8 * dt);
    p.vx += (dir.x * desired - p.vx) * Math.min(1, steer * dt);
    p.vz += (dir.z * desired - p.vz) * Math.min(1, steer * dt);

    const sideX = -dir.z, sideZ = dir.x;
    const wobble = Math.sin((p.age * 8.2) + p.spin * 13) * (mist ? .32 : .16);
    p.vx += sideX * wobble * dt;
    p.vz += sideZ * wobble * dt;

    p.vx *= drag;
    p.vz *= drag;
    p.vy += (mist ? .12 : -.55) * dt;

    p.x += p.vx * dt;
    p.z += p.vz * dt;
    p.y += p.vy * dt;

    const ground = this.sim.sampleWorldHeight(p.x, p.z);
    const hover = mist ? .55 : .055;
    if (p.y < ground + hover) {
      p.y = ground + hover;
      p.vy = mist ? Math.abs(p.vy) * .22 : Math.abs(p.vy) * .16;
    }

    // Keep particles only while they remain near active or recently moving snow.
    const i = this.sim.index(gx, gz);
    const local = this.sim.moving[i] + this.sim.core[i] + this.sim.deposit[i] * .18;
    if (local < .0015 && p.age > p.life * .58) continue;
    next.push(p);
  }
  list.length = 0;
  list.push(...next);
}

function weightedEmitter(emitters, total) {
  if (!emitters.length || total <= 0) return null;
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
  const fade = Math.max(.18, 1 - p.age / p.life);
  const width = p.size * (mist ? 2.0 : 1.0) * fade;
  const height = p.size * (mist ? 1.3 : .62) * fade;
  const length = p.size * (mist ? 2.8 : 2.5 + Math.min(4.5, speed * .32)) * fade;
  const matrix = BABYLON.Matrix.Compose(
    new BABYLON.Vector3(width, height, length),
    BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Y, angle),
    new BABYLON.Vector3(p.x, p.y, p.z)
  );
  arr.push(...matrix.toArray());
}

function makeParticle(name, mist) {
  const mesh = BABYLON.MeshBuilder.CreateIcoSphere(name, {
    radius: 1,
    subdivisions: mist ? 1 : 0
  }, this.scene);
  const material = this.mat(`${name}Mat`, new BABYLON.Color3(1, .985, 1), .99);
  material.emissiveColor = new BABYLON.Color3(.05, .045, .055);
  if (mist) {
    material.alpha = .16;
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
