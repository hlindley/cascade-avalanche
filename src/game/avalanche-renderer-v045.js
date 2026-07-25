import { CascadeScene } from './scene.js';

const originalBuildScene = CascadeScene.prototype.buildScene;

CascadeScene.prototype.buildScene = function patchedBuildScene() {
  originalBuildScene.call(this);
  for (const mesh of [this.surfaceMesh, this.coreMesh, this.depositMesh, this.powderMesh]) {
    if (mesh) mesh.setEnabled(false);
  }

  const n = this.sim.size * this.sim.size;
  this.visualMoving = new Float32Array(n);
  this.visualDeposit = new Float32Array(n);
  this.visualPowder = new Float32Array(n);
  this.smoothedMass = new Float32Array(n);
  this.smoothedDeposit = new Float32Array(n);

  this.flowSurface = createTerrainSurface.call(this, 'flowSurfaceV045', new BABYLON.Color3(.99, .98, 1), .14);
  this.depositSurface = createTerrainSurface.call(this, 'depositSurfaceV045', new BABYLON.Color3(.92, .92, .97), .08);

  this.flowBillowMesh = BABYLON.MeshBuilder.CreateIcoSphere('flowBillowV045', { radius: 1, subdivisions: 2 }, this.scene);
  const billowMaterial = this.mat('flowBillowMatV045', new BABYLON.Color3(1, .97, .99), .88);
  billowMaterial.emissiveColor = new BABYLON.Color3(.12, .10, .12);
  this.flowBillowMesh.material = billowMaterial;
  this.flowBillowMesh.isPickable = false;
  this.flowBillowMesh.alwaysSelectAsActiveMesh = true;

  this.flowPowderMesh = BABYLON.MeshBuilder.CreateSphere('flowPowderV045', { diameter: 1, segments: 10 }, this.scene);
  const powderMaterial = this.mat('flowPowderMatV045', new BABYLON.Color3(.98, .92, .96), .98);
  powderMaterial.alpha = .18;
  powderMaterial.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  powderMaterial.emissiveColor = new BABYLON.Color3(.08, .06, .08);
  this.flowPowderMesh.material = powderMaterial;
  this.flowPowderMesh.isPickable = false;
  this.flowPowderMesh.alwaysSelectAsActiveMesh = true;
};

CascadeScene.prototype.updateFlow = function updateFlowV045() {
  const n = this.visualMoving.length;
  for (let i = 0; i < n; i++) {
    this.visualMoving[i] = Math.max(this.sim.moving[i] + this.sim.core[i] * .35, this.visualMoving[i] * .987);
    this.visualDeposit[i] = Math.max(this.sim.deposit[i], this.visualDeposit[i] * .9998);
    this.visualPowder[i] = Math.max(this.sim.powder[i], this.visualPowder[i] * .965);
  }

  blurField.call(this, this.visualMoving, this.smoothedMass, .987);
  blurField.call(this, this.visualDeposit, this.smoothedDeposit, .9998);
  updateTerrainSurface.call(this, this.flowSurface, this.smoothedMass, .72, .0025);
  updateTerrainSurface.call(this, this.depositSurface, this.smoothedDeposit, .36, .006);

  const billowMatrices = [];
  const powderMatrices = [];
  const matrix = BABYLON.Matrix.Identity();
  const position = new BABYLON.Vector3();
  const scaling = new BABYLON.Vector3();
  const rotation = BABYLON.Quaternion.Identity();
  const add = (arr, x, y, z, sx, sy, sz) => {
    position.set(x, y, z);
    scaling.set(sx, sy, sz);
    BABYLON.Matrix.ComposeToRef(scaling, rotation, position, matrix);
    arr.push(...matrix.toArray());
  };

  const size = this.sim.size;
  for (let z = 2; z < size - 2; z += 2) {
    for (let x = 2; x < size - 2; x += 2) {
      const i = this.sim.index(x, z);
      const mass = this.smoothedMass[i];
      const powder = this.visualPowder[i];

      if (mass > .035 && isLocalPeak.call(this, this.smoothedMass, x, z)) {
        const world = this.sim.worldPosition(x, z);
        const radius = 1.15 + Math.min(3.3, Math.sqrt(mass) * 2.5);
        const jitter = (this.sim.hashNoise(x, z, 42) - .5) * .9;
        add(billowMatrices, world.x + jitter, world.y + .65 + radius * .22, world.z - jitter * .35, radius * 1.1, radius * .72, radius * .92);
        add(billowMatrices, world.x - jitter * .4, world.y + 1 + radius * .34, world.z + jitter, radius * .72, radius * .95, radius * .70);
      }

      if (powder > .012 && (x + z) % 4 === 0) {
        const world = this.sim.worldPosition(x, z);
        const radius = 1.4 + Math.min(4.4, Math.sqrt(powder) * 3.2);
        const jitter = (this.sim.hashNoise(x, z, 51) - .5) * 1.2;
        add(powderMatrices, world.x + jitter, world.y + 1.5 + radius * .55, world.z - jitter * .4, radius * 1.2, radius * .85, radius);
      }
    }
  }

  this.flowBillowMesh.thinInstanceSetBuffer('matrix', new Float32Array(billowMatrices), 16, true);
  this.flowPowderMesh.thinInstanceSetBuffer('matrix', new Float32Array(powderMatrices), 16, true);
};

function createTerrainSurface(name, color, emissive) {
  const size = this.sim.size;
  const cellSize = this.sim.cellSize;
  const positions = [];
  const indices = [];
  const normals = [];
  const colors = [];

  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const i = this.sim.index(x, z);
      positions.push((x - size / 2) * cellSize, this.sim.height[i] - .1, (z - size / 2) * cellSize);
      colors.push(color.r, color.g, color.b, 1);
    }
  }

  for (let z = 0; z < size - 1; z++) {
    for (let x = 0; x < size - 1; x++) {
      const i = z * size + x;
      const right = i + 1;
      const down = i + size;
      const downRight = down + 1;
      indices.push(i, down, right, right, down, downRight);
    }
  }

  BABYLON.VertexData.ComputeNormals(positions, indices, normals);
  const data = new BABYLON.VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.colors = colors;

  const mesh = new BABYLON.Mesh(name, this.scene);
  data.applyToMesh(mesh, true);
  mesh.setVerticesData(BABYLON.VertexBuffer.PositionKind, positions, true);
  mesh.setVerticesData(BABYLON.VertexBuffer.NormalKind, normals, true);

  const material = this.mat(`${name}Mat`, color, .92);
  material.emissiveColor = color.scale(emissive);
  material.backFaceCulling = false;
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

function blurField(source, target, decay) {
  const size = this.sim.size;
  for (let z = 1; z < size - 1; z++) {
    for (let x = 1; x < size - 1; x++) {
      const i = this.sim.index(x, z);
      let sum = source[i] * 4;
      let weight = 4;
      for (const [nx, nz] of neighbors(x, z)) {
        sum += source[this.sim.index(nx, nz)];
        weight++;
      }
      target[i] = Math.max(sum / weight, target[i] * decay);
    }
  }
}

function updateTerrainSurface(mesh, field, lift, threshold) {
  const positions = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
  const size = this.sim.size;
  const cellSize = this.sim.cellSize;

  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const i = this.sim.index(x, z);
      const p = i * 3;
      const value = field[i];
      positions[p] = (x - size / 2) * cellSize;
      positions[p + 1] = this.sim.height[i] + (value > threshold ? .10 + Math.min(lift, Math.sqrt(value) * lift) : -.10);
      positions[p + 2] = (z - size / 2) * cellSize;
    }
  }

  mesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, positions, false, false);
  mesh.refreshBoundingInfo();
}

function isLocalPeak(field, x, z) {
  const value = field[this.sim.index(x, z)];
  for (const [nx, nz] of neighbors(x, z)) {
    if (field[this.sim.index(nx, nz)] > value * 1.08) return false;
  }
  return true;
}

function neighbors(x, z) {
  return [[x - 1, z - 1], [x, z - 1], [x + 1, z - 1], [x - 1, z], [x + 1, z], [x - 1, z + 1], [x, z + 1], [x + 1, z + 1]];
}
