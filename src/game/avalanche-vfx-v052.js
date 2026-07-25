import { CascadeScene } from './scene.js';

const originalBuildScene = CascadeScene.prototype.buildScene;

CascadeScene.prototype.buildScene = function buildSceneWithMovingFrontVFX() {
  originalBuildScene.call(this);
  for (const mesh of [this.surfaceMesh, this.coreMesh, this.depositMesh, this.powderMesh]) if (mesh) mesh.setEnabled(false);
  const n = this.sim.size * this.sim.size;
  this.vfxMass = new Float32Array(n);
  this.vfxCore = new Float32Array(n);
  this.vfxDeposit = new Float32Array(n);
  this.vfxPowder = new Float32Array(n);
  this.vfxBodyMesh = makeBody.call(this, 'vfxBody052', new BABYLON.Color3(.98, .97, .99));
  this.vfxFrontMesh = makeFront.call(this, 'vfxFront052', new BABYLON.Color3(1, .94, .91));
  this.vfxDepositMesh = makeBody.call(this, 'vfxDeposit052', new BABYLON.Color3(.92, .92, .97), true);
  this.vfxPowderMesh = makePowder.call(this);
  this.vfxSprayMesh = makeSpray.call(this);
};

CascadeScene.prototype.updateFlow = function updateMovingFrontVFX() {
  const size = this.sim.size, block = 5;
  const body = [], fronts = [], deposits = [], powder = [], spray = [], regions = [];

  for (let i = 0; i < this.vfxMass.length; i++) {
    this.vfxMass[i] = Math.max(this.sim.moving[i] + this.sim.core[i] * .25, this.vfxMass[i] * .982);
    this.vfxCore[i] = Math.max(this.sim.core[i], this.vfxCore[i] * .975);
    this.vfxDeposit[i] = Math.max(this.sim.deposit[i], this.vfxDeposit[i] * .99985);
    this.vfxPowder[i] = Math.max(this.sim.powder[i], this.vfxPowder[i] * .955);
  }

  for (let bz = 1; bz < size - block; bz += block) for (let bx = 1; bx < size - block; bx += block) {
    let mass = 0, dense = 0, dep = 0, pow = 0, wx = 0, wz = 0, weight = 0;
    for (let dz = 0; dz < block; dz++) for (let dx = 0; dx < block; dx++) {
      const x = bx + dx, z = bz + dz, i = this.sim.index(x, z), m = this.vfxMass[i];
      mass += m; dense += this.vfxCore[i]; dep += this.vfxDeposit[i]; pow += this.vfxPowder[i];
      const w = m + this.vfxDeposit[i] * .2;
      wx += x * w; wz += z * w; weight += w;
    }
    if (mass < .025 && dep < .03) continue;
    const cx = weight > 0 ? wx / weight : bx + block / 2;
    const cz = weight > 0 ? wz / weight : bz + block / 2;
    const dir = downhill.call(this, cx, cz);
    const worldX = (cx - size / 2) * this.sim.cellSize;
    const worldZ = (cz - size / 2) * this.sim.cellSize;
    regions.push({ bx, bz, cx, cz, worldX, worldZ, y: this.sim.sampleWorldHeight(worldX, worldZ), dir, mass, dense, dep, pow });
  }

  const regionMap = new Map(regions.map(r => [`${r.bx},${r.bz}`, r]));
  const energeticFronts = [];
  for (const r of regions) {
    const angle = Math.atan2(r.dir.x, r.dir.z), speed = Math.min(1, r.mass / 5);
    if (r.mass > .025) {
      const width = 2.6 + Math.min(5.2, Math.sqrt(r.mass) * 2.0);
      const length = 3.2 + Math.min(7.5, Math.sqrt(r.mass) * 2.7);
      push(body, r.worldX - r.dir.x * .9, r.y + .42, r.worldZ - r.dir.z * .9, width, .55 + speed * .28, length, angle);
      push(body, r.worldX + r.dir.x * 1.45, r.y + .48, r.worldZ + r.dir.z * 1.45, width * .86, .48 + speed * .25, length * .68, angle);
    }
    if (r.dep > .035) {
      const width = 2.8 + Math.min(5.8, Math.sqrt(r.dep) * 2.1);
      const length = 3.0 + Math.min(6.2, Math.sqrt(r.dep) * 2.2);
      push(deposits, r.worldX, r.y + .18, r.worldZ, width, .24, length, angle);
    }
    if (r.mass > .09) {
      const downstream = sampleDownstreamRegion(r, regionMap, block), downstreamMass = downstream ? downstream.mass : 0;
      if (downstreamMass < r.mass * .58) {
        const width = 3.1 + Math.min(7.2, Math.sqrt(r.mass) * 2.8);
        const height = .9 + Math.min(1.8, Math.sqrt(r.mass) * .75);
        push(fronts, r.worldX + r.dir.x * 2.25, r.y + .55 + height * .28, r.worldZ + r.dir.z * 2.25, width, height, 1.15 + speed * .55, angle + Math.PI / 2);
        energeticFronts.push({ ...r, width, height, angle, speed });
      }
    }
  }

  energeticFronts.sort((a, b) => (b.mass + b.pow * 1.2) - (a.mass + a.pow * 1.2));
  for (let i = 0; i < Math.min(7, energeticFronts.length); i++) {
    const r = energeticFronts[i], sideX = -r.dir.z, sideZ = r.dir.x;
    const strength = Math.sqrt(r.mass + r.pow * 1.4), cloud = 1.4 + Math.min(3.8, strength * 1.65);
    const side = (hash(r.bx, r.bz, 11) - .5) * r.width * .35;
    push(powder, r.worldX - r.dir.x * .4 + sideX * side, r.y + 1.5 + cloud * .62, r.worldZ - r.dir.z * .4 + sideZ * side, cloud * 1.3, cloud, cloud * 1.05, r.angle);

    const count = 30 + Math.floor(Math.min(48, strength * 15));
    for (let p = 0; p < count; p++) {
      const h1 = hash(r.bx + p * 5, r.bz - p * 3, 19), h2 = hash(r.bx - p * 7, r.bz + p * 2, 23);
      const forward = .5 + h1 * 5.2, lateral = (h2 - .5) * r.width * 1.05;
      const s = .035 + h1 * .085;
      push(spray, r.worldX + r.dir.x * forward + sideX * lateral, r.y + .75 + h2 * (2.5 + cloud), r.worldZ + r.dir.z * forward + sideZ * lateral, s, s, s, 0);
    }
  }

  setInstances(this.vfxBodyMesh, body);
  setInstances(this.vfxFrontMesh, fronts);
  setInstances(this.vfxDepositMesh, deposits);
  setInstances(this.vfxPowderMesh, powder);
  setInstances(this.vfxSprayMesh, spray);
};

function makeBody(name, color, deposit = false) {
  const mesh = BABYLON.MeshBuilder.CreateSphere(name, { diameter: 2, segments: 16 }, this.scene);
  const material = this.mat(`${name}Mat`, color, .94);
  material.emissiveColor = color.scale(deposit ? .02 : .045);
  mesh.material = material; mesh.isPickable = false; mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}
function makeFront(name, color) {
  const mesh = BABYLON.MeshBuilder.CreateCapsule(name, { height: 3.0, radius: .82, tessellation: 18, capSubdivisions: 6 }, this.scene);
  mesh.rotation.x = Math.PI / 2; mesh.bakeCurrentTransformIntoVertices();
  const material = this.mat(`${name}Mat`, color, .9); material.emissiveColor = color.scale(.07);
  mesh.material = material; mesh.isPickable = false; mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}
function makePowder() {
  const mesh = BABYLON.MeshBuilder.CreateSphere('vfxPowder052', { diameter: 2, segments: 12 }, this.scene);
  const material = this.mat('vfxPowder052Mat', new BABYLON.Color3(.98, .94, .98), .99);
  material.alpha = .18; material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND; material.emissiveColor = new BABYLON.Color3(.055, .045, .06);
  mesh.material = material; mesh.isPickable = false; mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}
function makeSpray() {
  const mesh = BABYLON.MeshBuilder.CreateSphere('vfxSpray052', { diameter: 1, segments: 5 }, this.scene);
  const material = this.mat('vfxSpray052Mat', new BABYLON.Color3(1, .98, .99), .99);
  material.emissiveColor = new BABYLON.Color3(.07, .06, .07);
  mesh.material = material; mesh.isPickable = false; mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}
function downhill(cx, cz) {
  const x = Math.max(1, Math.min(this.sim.size - 2, Math.round(cx))), z = Math.max(1, Math.min(this.sim.size - 2, Math.round(cz)));
  const dx = this.sim.height[this.sim.index(x - 1, z)] - this.sim.height[this.sim.index(x + 1, z)];
  const dz = this.sim.height[this.sim.index(x, z - 1)] - this.sim.height[this.sim.index(x, z + 1)];
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}
function sampleDownstreamRegion(region, regionMap, block) {
  const sx = region.dir.x > .35 ? block : region.dir.x < -.35 ? -block : 0;
  const sz = region.dir.z > .35 ? block : region.dir.z < -.35 ? -block : 0;
  return regionMap.get(`${region.bx + sx},${region.bz + sz}`) || null;
}
function push(arr, x, y, z, sx, sy, sz, angle) {
  const m = BABYLON.Matrix.Compose(new BABYLON.Vector3(sx, sy, sz), BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Y, angle), new BABYLON.Vector3(x, y, z));
  arr.push(...m.toArray());
}
function setInstances(mesh, matrices) { mesh.thinInstanceSetBuffer('matrix', new Float32Array(matrices), 16, true); }
function hash(x, z, salt) {
  let h = (x * 374761393 + z * 668265263 + salt * 69069) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
