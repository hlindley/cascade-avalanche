import { CascadeScene } from './scene.js';

const originalBuildScene = CascadeScene.prototype.buildScene;

CascadeScene.prototype.buildScene = function buildSceneWithHybridSurgeVFX() {
  originalBuildScene.call(this);
  for (const mesh of [this.surfaceMesh, this.coreMesh, this.depositMesh, this.powderMesh]) {
    if (mesh) mesh.setEnabled(false);
  }

  const n = this.sim.size * this.sim.size;
  this.vfxMass = new Float32Array(n);
  this.vfxCore = new Float32Array(n);
  this.vfxDeposit = new Float32Array(n);
  this.vfxPowder = new Float32Array(n);

  this.vfxSurgeMesh = makeSurge.call(this);
  this.vfxBodyMesh = makeBody.call(this, 'vfxBody054', new BABYLON.Color3(.98, .97, .99));
  this.vfxFrontMesh = makeFront.call(this);
  this.vfxDepositMesh = makeBody.call(this, 'vfxDeposit054', new BABYLON.Color3(.92, .92, .97), true);
  this.vfxPowderMesh = makePowder.call(this);
  this.vfxSprayMesh = makeSpray.call(this);
};

CascadeScene.prototype.updateFlow = function updateHybridSurgeVFX() {
  const size = this.sim.size;
  const cellSize = this.sim.cellSize;
  const block = 5;
  const surge = [], body = [], fronts = [], deposits = [], powder = [], spray = [];
  const regions = [];

  for (let i = 0; i < this.vfxMass.length; i++) {
    this.vfxMass[i] = Math.max(this.sim.moving[i] + this.sim.core[i] * .3, this.vfxMass[i] * .978);
    this.vfxCore[i] = Math.max(this.sim.core[i], this.vfxCore[i] * .97);
    this.vfxDeposit[i] = Math.max(this.sim.deposit[i], this.vfxDeposit[i] * .99985);
    this.vfxPowder[i] = Math.max(this.sim.powder[i], this.vfxPowder[i] * .95);
  }

  // Fine particle surge: the primary visual language on steep, fast sections.
  for (let z = 1; z < size - 1; z++) {
    for (let x = 1; x < size - 1; x++) {
      const i = this.sim.index(x, z);
      const mass = this.vfxMass[i];
      if (mass < .004) continue;
      const dir = downhill.call(this, x, z);
      const slope = slopeAt.call(this, x, z);
      const energy = Math.min(1, mass * .8 + slope * 1.8 + this.vfxCore[i] * .35);
      const world = this.sim.worldPosition(x, z);
      const sideX = -dir.z, sideZ = dir.x;
      const count = 1 + Math.floor(Math.min(5, mass * 2.2 + energy * 2.8));
      const angle = Math.atan2(dir.x, dir.z);

      for (let p = 0; p < count; p++) {
        const h1 = hash(x + p * 7, z - p * 5, 41);
        const h2 = hash(x - p * 3, z + p * 11, 47);
        const forward = (h1 - .25) * (1.0 + energy * 1.8);
        const lateral = (h2 - .5) * (cellSize * 1.15 + energy * .9);
        const scale = .10 + Math.min(.30, Math.sqrt(mass) * .12 + h1 * .11);
        push(surge,
          world.x + dir.x * forward + sideX * lateral,
          world.y + .18 + h2 * (.20 + energy * .55),
          world.z + dir.z * forward + sideZ * lateral,
          scale * (.8 + h1 * .7),
          scale * (.45 + h2 * .35),
          scale * (1.5 + energy * 2.3),
          angle);
      }
    }
  }

  // Coarse regions provide body overlap only where flow is dense or slowing.
  for (let bz = 1; bz < size - block; bz += block) {
    for (let bx = 1; bx < size - block; bx += block) {
      let mass = 0, dense = 0, dep = 0, pow = 0, slope = 0, wx = 0, wz = 0, weight = 0;
      for (let dz = 0; dz < block; dz++) for (let dx = 0; dx < block; dx++) {
        const x = bx + dx, z = bz + dz, i = this.sim.index(x, z);
        const m = this.vfxMass[i];
        mass += m;
        dense += this.vfxCore[i];
        dep += this.vfxDeposit[i];
        pow += this.vfxPowder[i];
        slope += slopeAt.call(this, x, z);
        const w = m + this.vfxDeposit[i] * .22;
        wx += x * w; wz += z * w; weight += w;
      }
      if (mass < .025 && dep < .03) continue;
      const cx = weight > 0 ? wx / weight : bx + block / 2;
      const cz = weight > 0 ? wz / weight : bz + block / 2;
      const dir = downhill.call(this, cx, cz);
      const worldX = (cx - size / 2) * cellSize;
      const worldZ = (cz - size / 2) * cellSize;
      const y = this.sim.sampleWorldHeight(worldX, worldZ);
      const avgSlope = slope / (block * block);
      const speedBias = Math.min(1, avgSlope * 2.6 + dense * .06);
      regions.push({ bx, bz, worldX, worldZ, y, dir, mass, dense, dep, pow, speedBias });
    }
  }

  const regionMap = new Map(regions.map(r => [`${r.bx},${r.bz}`, r]));
  const energeticFronts = [];

  for (const r of regions) {
    const angle = Math.atan2(r.dir.x, r.dir.z);
    const compression = 1 - r.speedBias;

    if (r.mass > .05 && compression > .18) {
      const width = 2.0 + Math.min(4.5, Math.sqrt(r.mass) * 1.65);
      const length = 2.5 + Math.min(5.8, Math.sqrt(r.mass) * 2.0);
      const height = .28 + compression * .48;
      push(body, r.worldX - r.dir.x * .55, r.y + .27 + height * .28, r.worldZ - r.dir.z * .55,
        width, height, length, angle);
      if (compression > .42) {
        push(body, r.worldX + r.dir.x * 1.0, r.y + .30 + height * .24, r.worldZ + r.dir.z * 1.0,
          width * .82, height * .82, length * .72, angle);
      }
    }

    if (r.dep > .035) {
      const width = 2.7 + Math.min(5.7, Math.sqrt(r.dep) * 2.0);
      const length = 2.8 + Math.min(6.0, Math.sqrt(r.dep) * 2.0);
      push(deposits, r.worldX, r.y + .16, r.worldZ, width, .20, length, angle);
    }

    if (r.mass > .11) {
      const downstream = sampleDownstreamRegion(r, regionMap, block);
      const downstreamMass = downstream ? downstream.mass : 0;
      const edge = downstreamMass < r.mass * .56;
      if (edge && compression > .12) {
        const width = 2.7 + Math.min(6.0, Math.sqrt(r.mass) * 2.25);
        const height = .48 + compression * 1.05;
        push(fronts,
          r.worldX + r.dir.x * 1.9,
          r.y + .38 + height * .25,
          r.worldZ + r.dir.z * 1.9,
          width, height, .72 + compression * .65, angle + Math.PI / 2);
        energeticFronts.push({ ...r, width, height, angle, compression });
      }
    }
  }

  energeticFronts.sort((a, b) => (b.mass + b.pow) - (a.mass + a.pow));
  for (let i = 0; i < Math.min(9, energeticFronts.length); i++) {
    const r = energeticFronts[i];
    const sideX = -r.dir.z, sideZ = r.dir.x;
    const cloud = 1.0 + Math.min(2.8, Math.sqrt(r.mass + r.pow) * 1.25);
    const side = (hash(r.bx, r.bz, 71) - .5) * r.width * .45;

    push(powder,
      r.worldX - r.dir.x * .2 + sideX * side,
      r.y + 1.0 + cloud * .45,
      r.worldZ - r.dir.z * .2 + sideZ * side,
      cloud * 1.45, cloud * .72, cloud, r.angle);

    const count = 34 + Math.floor(Math.min(34, Math.sqrt(r.mass + r.pow) * 10));
    for (let p = 0; p < count; p++) {
      const h1 = hash(r.bx + p * 5, r.bz - p * 3, 73);
      const h2 = hash(r.bx - p * 7, r.bz + p * 2, 79);
      const forward = .2 + h1 * 5.2;
      const lateral = (h2 - .5) * r.width * 1.15;
      const s = .025 + h1 * .07;
      push(spray,
        r.worldX + r.dir.x * forward + sideX * lateral,
        r.y + .55 + h2 * (1.2 + cloud * 1.4),
        r.worldZ + r.dir.z * forward + sideZ * lateral,
        s, s, s, 0);
    }
  }

  setInstances(this.vfxSurgeMesh, surge);
  setInstances(this.vfxBodyMesh, body);
  setInstances(this.vfxFrontMesh, fronts);
  setInstances(this.vfxDepositMesh, deposits);
  setInstances(this.vfxPowderMesh, powder);
  setInstances(this.vfxSprayMesh, spray);
};

function makeSurge() {
  const mesh = BABYLON.MeshBuilder.CreateSphere('vfxSurge054', { diameter: 1, segments: 6 }, this.scene);
  const material = this.mat('vfxSurge054Mat', new BABYLON.Color3(1, .98, .99), .96);
  material.emissiveColor = new BABYLON.Color3(.055, .05, .06);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function makeBody(name, color, deposit = false) {
  const mesh = BABYLON.MeshBuilder.CreateSphere(name, { diameter: 2, segments: 16 }, this.scene);
  const material = this.mat(`${name}Mat`, color, .94);
  material.emissiveColor = color.scale(deposit ? .018 : .035);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function makeFront() {
  const mesh = BABYLON.MeshBuilder.CreateCapsule('vfxFront054', {
    height: 2.8, radius: .72, tessellation: 16, capSubdivisions: 5
  }, this.scene);
  mesh.rotation.x = Math.PI / 2;
  mesh.bakeCurrentTransformIntoVertices();
  const material = this.mat('vfxFront054Mat', new BABYLON.Color3(1, .95, .93), .91);
  material.emissiveColor = new BABYLON.Color3(.055, .045, .045);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function makePowder() {
  const mesh = BABYLON.MeshBuilder.CreateSphere('vfxPowder054', { diameter: 2, segments: 10 }, this.scene);
  const material = this.mat('vfxPowder054Mat', new BABYLON.Color3(.98, .94, .98), .99);
  material.alpha = .13;
  material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  material.emissiveColor = new BABYLON.Color3(.04, .035, .045);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function makeSpray() {
  const mesh = BABYLON.MeshBuilder.CreateSphere('vfxSpray054', { diameter: 1, segments: 4 }, this.scene);
  const material = this.mat('vfxSpray054Mat', new BABYLON.Color3(1, .99, 1), .99);
  material.emissiveColor = new BABYLON.Color3(.06, .055, .06);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function downhill(cx, cz) {
  const x = Math.max(1, Math.min(this.sim.size - 2, Math.round(cx)));
  const z = Math.max(1, Math.min(this.sim.size - 2, Math.round(cz)));
  const left = this.sim.height[this.sim.index(x - 1, z)];
  const right = this.sim.height[this.sim.index(x + 1, z)];
  const up = this.sim.height[this.sim.index(x, z - 1)];
  const down = this.sim.height[this.sim.index(x, z + 1)];
  const dx = left - right, dz = up - down;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

function slopeAt(x, z) {
  const left = this.sim.height[this.sim.index(Math.max(0, x - 1), z)];
  const right = this.sim.height[this.sim.index(Math.min(this.sim.size - 1, x + 1), z)];
  const up = this.sim.height[this.sim.index(x, Math.max(0, z - 1))];
  const down = this.sim.height[this.sim.index(x, Math.min(this.sim.size - 1, z + 1))];
  return Math.min(1, Math.hypot(left - right, up - down) / (this.sim.cellSize * 2.5));
}

function sampleDownstreamRegion(region, regionMap, block) {
  const sx = region.dir.x > .35 ? block : region.dir.x < -.35 ? -block : 0;
  const sz = region.dir.z > .35 ? block : region.dir.z < -.35 ? -block : 0;
  return regionMap.get(`${region.bx + sx},${region.bz + sz}`) || null;
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
