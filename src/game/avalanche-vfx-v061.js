import { CascadeScene } from './scene.js';

const originalBuildScene = CascadeScene.prototype.buildScene;

CascadeScene.prototype.buildScene = function buildSceneWithAdvectedParticles() {
  originalBuildScene.call(this);
  for (const mesh of [this.surfaceMesh, this.coreMesh, this.depositMesh, this.powderMesh]) {
    if (mesh) mesh.setEnabled(false);
  }

  const n = this.sim.size * this.sim.size;
  this.vfxDensity = new Float32Array(n);
  this.vfxDensityNext = new Float32Array(n);
  this.vfxDepositDensity = new Float32Array(n);
  this.vfxPowderDensity = new Float32Array(n);
  this.vfxParticles = [];
  this.vfxParticleCursor = 0;
  this.vfxLastTime = performance.now() * .001;
  this.vfxSpawnCarry = 0;
  this.vfxMaxParticles = 12000;

  this.vfxGrainMesh = makeGrain.call(this);
  this.vfxDepositMesh = makeDeposit.call(this);
  this.vfxPowderMesh = makePowder.call(this);

  const sky = this.scene.getMeshByName('sunsetSky');
  const skyTexture = sky?.material?.emissiveTexture;
  if (skyTexture?.getContext) {
    const ctx = skyTexture.getContext();
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, '#77a5d6');
    g.addColorStop(.45, '#b8cbe4');
    g.addColorStop(.76, '#f3c3b0');
    g.addColorStop(1, '#ffe7ae');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 512);
    skyTexture.update();
  }

  this.scene.clearColor = new BABYLON.Color4(.48, .65, .82, 1);
  this.scene.fogColor = new BABYLON.Color3(.74, .76, .84);
  this.scene.fogDensity = .0018;
  this.scene.imageProcessingConfiguration.exposure = 1.34;
  this.scene.imageProcessingConfiguration.contrast = 1.0;
  this.hemi.intensity = .94;
  this.hemi.diffuse = new BABYLON.Color3(.84, .90, 1);
  this.hemi.groundColor = new BABYLON.Color3(.52, .46, .52);
  this.sun.intensity = 1.82;
  this.sun.diffuse = new BABYLON.Color3(1, .79, .61);
  this.sun.direction = new BABYLON.Vector3(-.70, -.39, .42);
  if (this.shadowGenerator) this.shadowGenerator.darkness = .11;
};

CascadeScene.prototype.updateFlow = function updateAdvectedParticleVFX() {
  const now = performance.now() * .001;
  const dt = Math.min(.05, Math.max(.001, now - this.vfxLastTime));
  this.vfxLastTime = now;
  const size = this.sim.size;
  const grains = [];
  const deposits = [];
  const powder = [];

  for (let i = 0; i < this.vfxDensity.length; i++) {
    const live = this.sim.moving[i] + this.sim.core[i] * .45;
    this.vfxDensity[i] = Math.max(live, this.vfxDensity[i] * .965);
    this.vfxDepositDensity[i] = Math.max(this.sim.deposit[i], this.vfxDepositDensity[i] * .9999);
    this.vfxPowderDensity[i] = Math.max(this.sim.powder[i], this.vfxPowderDensity[i] * .935);
  }
  blur.call(this, this.vfxDensity, this.vfxDensityNext);
  [this.vfxDensity, this.vfxDensityNext] = [this.vfxDensityNext, this.vfxDensity];

  // Emit from live density. These grains persist and travel instead of being reconstructed in place.
  let totalDensity = 0;
  for (let i = 0; i < this.vfxDensity.length; i++) totalDensity += this.vfxDensity[i];
  this.vfxSpawnCarry += Math.min(9000, totalDensity * 145) * dt;
  let spawnBudget = Math.min(520, Math.floor(this.vfxSpawnCarry));
  this.vfxSpawnCarry -= spawnBudget;

  let attempts = 0;
  while (spawnBudget > 0 && this.vfxParticles.length < this.vfxMaxParticles && attempts < spawnBudget * 18 + 100) {
    attempts++;
    this.vfxParticleCursor = (this.vfxParticleCursor + 97) % this.vfxDensity.length;
    const i = this.vfxParticleCursor;
    const density = this.vfxDensity[i];
    if (density < .004) continue;
    const x = i % size;
    const z = Math.floor(i / size);
    if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;
    if (hash(i, attempts, 211) > Math.min(1, density * .8 + .08)) continue;
    spawnParticle.call(this, x, z, density, now, attempts);
    spawnBudget--;
  }

  // Advect every grain through the terrain-derived vector field.
  const alive = [];
  for (const p of this.vfxParticles) {
    p.age += dt;
    if (p.age >= p.life) continue;

    const gx = p.x / this.sim.cellSize + size / 2;
    const gz = p.z / this.sim.cellSize + size / 2;
    if (gx < 1 || gz < 1 || gx >= size - 2 || gz >= size - 2) continue;

    const dir = downhill.call(this, gx, gz);
    const field = sampleField.call(this, this.vfxDensity, gx, gz);
    const slope = slopeAt.call(this, gx, gz);
    const targetSpeed = .9 + slope * 7.2 + Math.min(3.5, field * 1.5);
    const steer = 1 - Math.exp(-dt * 5.5);
    p.vx += (dir.x * targetSpeed * p.lane - p.vx) * steer;
    p.vz += (dir.z * targetSpeed * p.lane - p.vz) * steer;

    const curl = Math.sin((p.seed * 17.3) + now * (2.1 + p.lane)) * (.12 + slope * .34);
    p.vx += -dir.z * curl * dt;
    p.vz += dir.x * curl * dt;
    p.x += p.vx * dt;
    p.z += p.vz * dt;

    const terrainY = this.sim.sampleWorldHeight(p.x, p.z);
    p.vy += (-1.4 - p.vy) * (1 - Math.exp(-dt * 4));
    p.y += p.vy * dt;
    const floor = terrainY + .05;
    if (p.y < floor) {
      p.y = floor;
      p.vy = .18 + slope * .65 * hash(p.seed, Math.floor(now * 8), 223);
    }

    if (field < .0009 && p.age > .45) p.life = Math.min(p.life, p.age + .25);
    alive.push(p);

    const speed = Math.hypot(p.vx, p.vz);
    const angle = Math.atan2(p.vx, p.vz);
    const fade = Math.min(1, (p.life - p.age) * 3.5);
    const s = p.size * (.72 + fade * .28);
    push(grains, p.x, p.y, p.z,
      s * .72, s * .36, s * (2.2 + Math.min(4.8, speed * .42)), angle);
  }
  this.vfxParticles = alive;

  // Settled snow remains broad and low. Powder is sparse and transparent.
  for (let z = 1; z < size - 1; z += 2) {
    for (let x = 1; x < size - 1; x += 2) {
      const i = this.sim.index(x, z);
      const dep = this.vfxDepositDensity[i];
      const pd = this.vfxPowderDensity[i];
      const world = this.sim.worldPosition(x, z);
      const dir = downhill.call(this, x, z);
      const angle = Math.atan2(dir.x, dir.z);
      if (dep > .022) {
        const r = Math.sqrt(dep);
        push(deposits, world.x, world.y + .08, world.z,
          1.35 + Math.min(2.6, r * 1.4), .10 + Math.min(.15, r * .08), 1.5 + Math.min(3.0, r * 1.55), angle);
      }
      if (pd > .02 && (x + z) % 4 === 0) {
        const r = .45 + Math.min(1.25, Math.sqrt(pd) * .9);
        push(powder, world.x - dir.x * .5, world.y + .7 + r * .7, world.z - dir.z * .5,
          r * 1.5, r * .8, r * 1.15, angle);
      }
    }
  }

  setInstances(this.vfxGrainMesh, grains);
  setInstances(this.vfxDepositMesh, deposits);
  setInstances(this.vfxPowderMesh, powder);
};

function spawnParticle(x, z, density, now, salt) {
  const world = this.sim.worldPosition(x, z);
  const dir = downhill.call(this, x, z);
  const sideX = -dir.z, sideZ = dir.x;
  const seed = hash(x + salt, z - salt, 227);
  const seed2 = hash(x - salt, z + salt, 229);
  const lane = seed < .33 ? .72 : seed < .70 ? 1.0 : 1.34;
  const speed = (.8 + slopeAt.call(this, x, z) * 6.2 + Math.min(2.5, density)) * lane;
  const lateral = (seed2 - .5) * this.sim.cellSize * 1.3;
  const forward = (seed - .5) * this.sim.cellSize * .8;
  this.vfxParticles.push({
    x: world.x + dir.x * forward + sideX * lateral,
    y: world.y + .08 + seed2 * .22,
    z: world.z + dir.z * forward + sideZ * lateral,
    vx: dir.x * speed,
    vy: .08 + seed * .5,
    vz: dir.z * speed,
    age: 0,
    life: 1.15 + seed2 * 1.5,
    size: .018 + seed * .022 + Math.min(.014, Math.sqrt(density) * .006),
    lane,
    seed: seed * 1000 + now
  });
}

function makeGrain() {
  const mesh = BABYLON.MeshBuilder.CreateSphere('vfxGrain061', { diameter: 1, segments: 4 }, this.scene);
  const material = this.mat('vfxGrain061Mat', new BABYLON.Color3(1, .995, 1), .99);
  material.emissiveColor = new BABYLON.Color3(.04, .037, .043);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function makeDeposit() {
  const mesh = BABYLON.MeshBuilder.CreateSphere('vfxDeposit061', { diameter: 2, segments: 12 }, this.scene);
  const material = this.mat('vfxDeposit061Mat', new BABYLON.Color3(.94, .95, .99), .97);
  material.emissiveColor = new BABYLON.Color3(.015, .016, .02);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function makePowder() {
  const mesh = BABYLON.MeshBuilder.CreateSphere('vfxPowder061', { diameter: 2, segments: 8 }, this.scene);
  const material = this.mat('vfxPowder061Mat', new BABYLON.Color3(.99, .97, 1), .99);
  material.alpha = .075;
  material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  material.emissiveColor = new BABYLON.Color3(.02, .018, .024);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function blur(source, target) {
  const size = this.sim.size;
  target.fill(0);
  for (let z = 1; z < size - 1; z++) for (let x = 1; x < size - 1; x++) {
    const i = this.sim.index(x, z);
    let sum = source[i] * 5, weight = 5;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      sum += source[this.sim.index(x + dx, z + dz)];
      weight++;
    }
    target[i] = sum / weight;
  }
}

function sampleField(field, gx, gz) {
  const x = Math.max(0, Math.min(this.sim.size - 1, Math.round(gx)));
  const z = Math.max(0, Math.min(this.sim.size - 1, Math.round(gz)));
  return field[this.sim.index(x, z)];
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

function slopeAt(x, z) {
  x = Math.max(1, Math.min(this.sim.size - 2, Math.round(x)));
  z = Math.max(1, Math.min(this.sim.size - 2, Math.round(z)));
  const left = this.sim.height[this.sim.index(x - 1, z)];
  const right = this.sim.height[this.sim.index(x + 1, z)];
  const up = this.sim.height[this.sim.index(x, z - 1)];
  const down = this.sim.height[this.sim.index(x, z + 1)];
  return Math.min(1, Math.hypot(left - right, up - down) / (this.sim.cellSize * 2.4));
}

function push(arr, x, y, z, sx, sy, sz, angle) {
  const m = BABYLON.Matrix.Compose(
    new BABYLON.Vector3(sx, sy, sz),
    BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Y, angle),
    new BABYLON.Vector3(x, y, z)
  );
  arr.push(...m.toArray());
}

function setInstances(mesh, matrices) {
  mesh.thinInstanceSetBuffer('matrix', new Float32Array(matrices), 16, true);
}

function hash(x, z, salt) {
  let h = ((Math.floor(x) * 374761393) + (Math.floor(z) * 668265263) + salt * 69069) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
