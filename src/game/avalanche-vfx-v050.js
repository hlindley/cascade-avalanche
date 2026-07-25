import { CascadeScene } from './scene.js';

const originalBuildScene = CascadeScene.prototype.buildScene;

CascadeScene.prototype.buildScene = function buildSceneWithVFX() {
  originalBuildScene.call(this);

  for (const mesh of [this.surfaceMesh, this.coreMesh, this.depositMesh, this.powderMesh]) {
    if (mesh) mesh.setEnabled(false);
  }

  const n = this.sim.size * this.sim.size;
  this.vfxMoving = new Float32Array(n);
  this.vfxCore = new Float32Array(n);
  this.vfxDeposit = new Float32Array(n);
  this.vfxPowder = new Float32Array(n);

  this.vfxGroundMesh = makeLobe.call(this, 'vfxGround', new BABYLON.Color3(.98, .97, .99), .9);
  this.vfxCoreMesh = makeLobe.call(this, 'vfxCore', new BABYLON.Color3(1, .87, .78), .84);
  this.vfxBillowMesh = makeBillow.call(this, 'vfxBillow', new BABYLON.Color3(1, .96, .98), .82);
  this.vfxDepositMesh = makeLobe.call(this, 'vfxDeposit', new BABYLON.Color3(.93, .93, .97), .96);
  this.vfxSprayMesh = makeSpray.call(this);
};

CascadeScene.prototype.updateFlow = function updateRegionalVFX() {
  const size = this.sim.size;
  const block = 4;
  const ground = [];
  const core = [];
  const deposit = [];
  const billows = [];
  const spray = [];
  const clusters = [];

  for (let i = 0; i < this.vfxMoving.length; i++) {
    this.vfxMoving[i] = Math.max(this.sim.moving[i], this.vfxMoving[i] * .976);
    this.vfxCore[i] = Math.max(this.sim.core[i], this.vfxCore[i] * .972);
    this.vfxDeposit[i] = Math.max(this.sim.deposit[i], this.vfxDeposit[i] * .9998);
    this.vfxPowder[i] = Math.max(this.sim.powder[i], this.vfxPowder[i] * .948);
  }

  for (let bz = 1; bz < size - block; bz += block) {
    for (let bx = 1; bx < size - block; bx += block) {
      let mass = 0, dense = 0, dep = 0, powder = 0, wx = 0, wz = 0, weight = 0;
      for (let dz = 0; dz < block; dz++) {
        for (let dx = 0; dx < block; dx++) {
          const x = bx + dx, z = bz + dz, i = this.sim.index(x, z);
          const m = this.vfxMoving[i];
          mass += m;
          dense += this.vfxCore[i];
          dep += this.vfxDeposit[i];
          powder += this.vfxPowder[i];
          const w = m + this.vfxDeposit[i] * .35;
          wx += x * w;
          wz += z * w;
          weight += w;
        }
      }
      if (weight < .01 && dep < .025) continue;
      const cx = weight > 0 ? wx / weight : bx + block / 2;
      const cz = weight > 0 ? wz / weight : bz + block / 2;
      const worldX = (cx - size / 2) * this.sim.cellSize;
      const worldZ = (cz - size / 2) * this.sim.cellSize;
      const y = this.sim.sampleWorldHeight(worldX, worldZ);
      const dir = regionalDirection.call(this, cx, cz);
      const angle = Math.atan2(dir.x, dir.z);
      const speed = Math.min(1, mass / 4.5);
      clusters.push({ bx, bz, worldX, worldZ, y, mass, dense, dep, powder, dir, angle, speed });
    }
  }

  const energetic = clusters.filter(c => c.mass > .18 || c.powder > .08)
    .sort((a, b) => (b.mass + b.powder * 1.4) - (a.mass + a.powder * 1.4));

  for (const c of clusters) {
    if (c.mass > .025) {
      const width = 1.5 + Math.min(3.3, Math.sqrt(c.mass) * 1.5);
      const length = 2.4 + Math.min(6.5, Math.sqrt(c.mass) * 2.65);
      pushMatrix(ground, c.worldX + c.dir.x * .55, c.y + .38, c.worldZ + c.dir.z * .55,
        width, .38 + c.speed * .24, length, c.angle);
      pushMatrix(ground, c.worldX - c.dir.x * 1.1, c.y + .31, c.worldZ - c.dir.z * 1.1,
        width * .82, .30 + c.speed * .16, length * .72, c.angle);
    }

    if (c.dense > .035) {
      const width = 1.1 + Math.min(2.5, Math.sqrt(c.dense) * 1.25);
      const length = 2.0 + Math.min(5.8, Math.sqrt(c.dense) * 2.55);
      pushMatrix(core, c.worldX + c.dir.x * 1.25, c.y + .62, c.worldZ + c.dir.z * 1.25,
        width, .55 + c.speed * .38, length, c.angle);
    }

    if (c.dep > .025) {
      const width = 1.7 + Math.min(3.8, Math.sqrt(c.dep) * 1.45);
      const length = 2.1 + Math.min(5.0, Math.sqrt(c.dep) * 1.8);
      pushMatrix(deposit, c.worldX, c.y + .20, c.worldZ, width, .27, length, c.angle);
    }
  }

  for (let k = 0; k < Math.min(12, energetic.length); k++) {
    const c = energetic[k];
    const strength = Math.sqrt(c.mass + c.powder * 1.5);
    const r = 1.25 + Math.min(3.4, strength * 1.8);
    const sideX = -c.dir.z, sideZ = c.dir.x;
    const jitter = (hash(c.bx, c.bz, 7) - .5) * 1.4;

    pushMatrix(billows, c.worldX + sideX * jitter, c.y + 1.0 + r * .35, c.worldZ + sideZ * jitter,
      r * 1.15, r * .72, r * .95, c.angle);
    pushMatrix(billows, c.worldX - sideX * .65 + c.dir.x * 1.0, c.y + 1.7 + r * .48,
      c.worldZ - sideZ * .65 + c.dir.z * 1.0, r * .78, r * .92, r * .72, c.angle + .35);
    if (k < 6) {
      pushMatrix(billows, c.worldX + sideX * .8 - c.dir.x * .7, c.y + 1.25 + r * .38,
        c.worldZ + sideZ * .8 - c.dir.z * .7, r * .68, r * .66, r * .74, c.angle - .42);
    }

    const sprayCount = 6 + Math.floor(Math.min(10, strength * 4));
    for (let p = 0; p < sprayCount; p++) {
      const h = hash(c.bx + p * 3, c.bz - p * 5, 19);
      const h2 = hash(c.bx - p * 7, c.bz + p * 2, 23);
      const forward = .4 + h * 3.0;
      const side = (h2 - .5) * r * 1.5;
      const s = .09 + h * .18;
      pushMatrix(spray,
        c.worldX + c.dir.x * forward + sideX * side,
        c.y + 1.2 + h2 * r * 1.8,
        c.worldZ + c.dir.z * forward + sideZ * side,
        s, s, s, 0);
    }
  }

  setInstances(this.vfxGroundMesh, ground);
  setInstances(this.vfxCoreMesh, core);
  setInstances(this.vfxDepositMesh, deposit);
  setInstances(this.vfxBillowMesh, billows);
  setInstances(this.vfxSprayMesh, spray);
};

function makeLobe(name, color, roughness) {
  const mesh = BABYLON.MeshBuilder.CreateCapsule(name, {
    height: 2.8, radius: .75, tessellation: 14, capSubdivisions: 5
  }, this.scene);
  mesh.rotation.x = Math.PI / 2;
  mesh.bakeCurrentTransformIntoVertices();
  const material = this.mat(`${name}Mat`, color, roughness);
  material.emissiveColor = color.scale(name === 'vfxCore' ? .10 : .035);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function makeBillow(name, color, roughness) {
  const mesh = BABYLON.MeshBuilder.CreateIcoSphere(name, { radius: 1, subdivisions: 3 }, this.scene);
  const material = this.mat(`${name}Mat`, color, roughness);
  material.emissiveColor = color.scale(.055);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function makeSpray() {
  const mesh = BABYLON.MeshBuilder.CreateSphere('vfxSpray', { diameter: 1, segments: 6 }, this.scene);
  const material = this.mat('vfxSprayMat', new BABYLON.Color3(1, .97, .98), .98);
  material.emissiveColor = new BABYLON.Color3(.08, .07, .08);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function regionalDirection(cx, cz) {
  const x = Math.max(1, Math.min(this.sim.size - 2, Math.round(cx)));
  const z = Math.max(1, Math.min(this.sim.size - 2, Math.round(cz)));
  const left = this.sim.height[this.sim.index(x - 1, z)];
  const right = this.sim.height[this.sim.index(x + 1, z)];
  const up = this.sim.height[this.sim.index(x, z - 1)];
  const down = this.sim.height[this.sim.index(x, z + 1)];
  const dx = left - right;
  const dz = up - down;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

function pushMatrix(arr, x, y, z, sx, sy, sz, angle) {
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
