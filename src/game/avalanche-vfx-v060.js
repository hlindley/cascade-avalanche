import { CascadeScene } from './scene.js';

const originalBuildScene = CascadeScene.prototype.buildScene;

CascadeScene.prototype.buildScene = function buildSceneWithDensityVFX() {
  originalBuildScene.call(this);

  for (const mesh of [this.surfaceMesh, this.coreMesh, this.depositMesh, this.powderMesh]) {
    if (mesh) mesh.setEnabled(false);
  }

  const n = this.sim.size * this.sim.size;
  this.vfxDensity = new Float32Array(n);
  this.vfxDensityNext = new Float32Array(n);
  this.vfxDepositDensity = new Float32Array(n);
  this.vfxPowderDensity = new Float32Array(n);

  this.vfxGrainMesh = makeGrain.call(this);
  this.vfxBulkMesh = makeBulk.call(this);
  this.vfxDepositMesh = makeDeposit.call(this);
  this.vfxPowderMesh = makePowder.call(this);

  // Earlier, brighter sunset. Repaint the existing dynamic sky texture when available.
  const sky = this.scene.getMeshByName('sunsetSky');
  const skyTexture = sky?.material?.emissiveTexture;
  if (skyTexture?.getContext) {
    const ctx = skyTexture.getContext();
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, '#5f88c1');
    g.addColorStop(.42, '#92add3');
    g.addColorStop(.73, '#efb6ad');
    g.addColorStop(1, '#ffe1a8');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 512);
    skyTexture.update();
  }

  this.scene.clearColor = new BABYLON.Color4(.38, .53, .72, 1);
  this.scene.fogColor = new BABYLON.Color3(.68, .67, .76);
  this.scene.fogDensity = .0021;
  this.scene.imageProcessingConfiguration.exposure = 1.28;
  this.scene.imageProcessingConfiguration.contrast = 1.02;
  this.hemi.intensity = .86;
  this.hemi.diffuse = new BABYLON.Color3(.78, .84, 1);
  this.hemi.groundColor = new BABYLON.Color3(.46, .38, .45);
  this.sun.intensity = 1.72;
  this.sun.diffuse = new BABYLON.Color3(1, .76, .56);
  this.sun.direction = new BABYLON.Vector3(-.72, -.34, .42);
  if (this.shadowGenerator) this.shadowGenerator.darkness = .14;
};

CascadeScene.prototype.updateFlow = function updateDensityFieldVFX() {
  const size = this.sim.size;
  const cs = this.sim.cellSize;
  const now = performance.now() * .001;
  const grains = [];
  const bulk = [];
  const deposits = [];
  const powder = [];

  // Persist raw fields, then blur into a continuous density field.
  for (let i = 0; i < this.vfxDensity.length; i++) {
    const live = this.sim.moving[i] + this.sim.core[i] * .42;
    this.vfxDensity[i] = Math.max(live, this.vfxDensity[i] * .974);
    this.vfxDepositDensity[i] = Math.max(this.sim.deposit[i], this.vfxDepositDensity[i] * .9999);
    this.vfxPowderDensity[i] = Math.max(this.sim.powder[i], this.vfxPowderDensity[i] * .94);
  }
  blur.call(this, this.vfxDensity, this.vfxDensityNext);
  [this.vfxDensity, this.vfxDensityNext] = [this.vfxDensityNext, this.vfxDensity];

  // Nearly invisible bulk volume: density only, never the main visual language.
  for (let z = 1; z < size - 1; z += 2) {
    for (let x = 1; x < size - 1; x += 2) {
      const i = this.sim.index(x, z);
      const density = this.vfxDensity[i];
      const dep = this.vfxDepositDensity[i];
      const world = this.sim.worldPosition(x, z);
      const dir = downhill.call(this, x, z);
      const angle = Math.atan2(dir.x, dir.z);

      if (density > .018) {
        const r = Math.sqrt(density);
        push(bulk, world.x, world.y + .18 + Math.min(.42, r * .18), world.z,
          1.25 + Math.min(2.5, r * 1.35), .16 + Math.min(.34, r * .20), 1.55 + Math.min(3.4, r * 1.8), angle);
      }

      if (dep > .018) {
        const r = Math.sqrt(dep);
        push(deposits, world.x, world.y + .10, world.z,
          1.45 + Math.min(2.9, r * 1.45), .12 + Math.min(.18, r * .10), 1.65 + Math.min(3.3, r * 1.6), angle);
      }
    }
  }

  // Particle texture: roughly 10x the v0.5.4 count, about one quarter the size.
  // Three velocity lanes shear past one another to create internal motion.
  const maxParticles = 18000;
  outer:
  for (let z = 1; z < size - 1; z++) {
    for (let x = 1; x < size - 1; x++) {
      const i = this.sim.index(x, z);
      const density = this.vfxDensity[i];
      if (density < .0025) continue;

      const world = this.sim.worldPosition(x, z);
      const dir = downhill.call(this, x, z);
      const sideX = -dir.z, sideZ = dir.x;
      const slope = slopeAt.call(this, x, z);
      const energy = Math.min(1, slope * 2.4 + density * .7 + this.sim.core[i] * .3);
      const count = Math.min(26, 5 + Math.floor(density * 5 + energy * 15));
      const angle = Math.atan2(dir.x, dir.z);

      for (let p = 0; p < count; p++) {
        if (grains.length / 16 >= maxParticles) break outer;
        const lane = p % 3;
        const laneSpeed = lane === 0 ? 2.35 : lane === 1 ? 1.55 : .95;
        const h1 = hash(x + p * 13, z - p * 7, 101);
        const h2 = hash(x - p * 5, z + p * 11, 103);
        const cycle = ((now * laneSpeed + h1 * 3.7) % 1) - .35;
        const forward = cycle * (1.25 + energy * 3.2);
        const lateral = (h2 - .5) * (cs * 1.35 + energy * 1.25) + (lane - 1) * .18;
        const lift = .07 + h1 * (.15 + energy * .48);
        const s = .022 + h2 * .032 + Math.min(.025, Math.sqrt(density) * .012);

        push(grains,
          world.x + dir.x * forward + sideX * lateral,
          world.y + lift,
          world.z + dir.z * forward + sideZ * lateral,
          s * (.8 + h1 * .55),
          s * (.42 + h2 * .25),
          s * (2.1 + energy * 3.1),
          angle);
      }

      const pd = this.vfxPowderDensity[i];
      if (pd > .012 && (x + z) % 3 === 0) {
        const r = .55 + Math.min(1.65, Math.sqrt(pd) * 1.1);
        push(powder,
          world.x - dir.x * .35 + sideX * (hNoise(x, z) - .5),
          world.y + .75 + r * .65,
          world.z - dir.z * .35 + sideZ * (hNoise(z, x) - .5),
          r * 1.35, r, r * 1.1, angle);
      }
    }
  }

  setInstances(this.vfxGrainMesh, grains);
  setInstances(this.vfxBulkMesh, bulk);
  setInstances(this.vfxDepositMesh, deposits);
  setInstances(this.vfxPowderMesh, powder);
};

function makeGrain() {
  const mesh = BABYLON.MeshBuilder.CreateSphere('vfxGrain060', { diameter: 1, segments: 4 }, this.scene);
  const material = this.mat('vfxGrain060Mat', new BABYLON.Color3(1, .99, 1), .98);
  material.emissiveColor = new BABYLON.Color3(.045, .04, .045);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function makeBulk() {
  const mesh = BABYLON.MeshBuilder.CreateSphere('vfxBulk060', { diameter: 2, segments: 12 }, this.scene);
  const material = this.mat('vfxBulk060Mat', new BABYLON.Color3(.98, .97, .99), .98);
  material.alpha = .22;
  material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  material.emissiveColor = new BABYLON.Color3(.025, .022, .028);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function makeDeposit() {
  const mesh = BABYLON.MeshBuilder.CreateSphere('vfxDeposit060', { diameter: 2, segments: 12 }, this.scene);
  const material = this.mat('vfxDeposit060Mat', new BABYLON.Color3(.93, .94, .98), .96);
  material.emissiveColor = new BABYLON.Color3(.018, .018, .022);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function makePowder() {
  const mesh = BABYLON.MeshBuilder.CreateSphere('vfxPowder060', { diameter: 2, segments: 8 }, this.scene);
  const material = this.mat('vfxPowder060Mat', new BABYLON.Color3(.98, .96, 1), .99);
  material.alpha = .10;
  material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  material.emissiveColor = new BABYLON.Color3(.025, .022, .03);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function blur(source, target) {
  const size = this.sim.size;
  target.fill(0);
  for (let z = 1; z < size - 1; z++) {
    for (let x = 1; x < size - 1; x++) {
      const i = this.sim.index(x, z);
      let sum = source[i] * 5;
      let weight = 5;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        sum += source[this.sim.index(x + dx, z + dz)];
        weight++;
      }
      target[i] = sum / weight;
    }
  }
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
  let h = (x * 374761393 + z * 668265263 + salt * 69069) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function hNoise(x, z) {
  return hash(x, z, 151);
}
