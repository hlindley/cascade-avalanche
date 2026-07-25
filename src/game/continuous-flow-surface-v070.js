import { CascadeScene } from './scene.js';

const previousBuildScene = CascadeScene.prototype.buildScene;
const previousUpdateFlow = CascadeScene.prototype.updateFlow;

CascadeScene.prototype.buildScene = function buildSceneWithContinuousFlowSurface() {
  previousBuildScene.call(this);

  // Retire every primitive/particle visual from previous renderer experiments.
  for (const mesh of [this.surfaceMesh, this.coreMesh, this.depositMesh, this.powderMesh]) {
    if (mesh) mesh.setEnabled(false);
  }
  for (const mesh of this.scene.meshes) {
    if (/waveParticle|waveMist|softDensity|softVeil|unified|impact/i.test(mesh.name)) mesh.setEnabled(false);
  }

  const scale = 3;
  const resolution = (this.sim.size - 1) * scale + 1;
  const count = resolution * resolution;
  this.continuousFlow = {
    scale,
    resolution,
    density: new Float32Array(count),
    deposit: new Float32Array(count),
    positions: new Float32Array(count * 3),
    colors: new Float32Array(count * 4),
    indices: buildIndices(resolution),
    lastTime: performance.now() * 0.001
  };

  const mesh = new BABYLON.Mesh('continuousAvalanche070', this.scene);
  const vd = new BABYLON.VertexData();
  vd.positions = Array.from(this.continuousFlow.positions);
  vd.indices = this.continuousFlow.indices;
  vd.normals = new Array(count * 3).fill(0);
  vd.colors = Array.from(this.continuousFlow.colors);
  vd.applyToMesh(mesh, true);

  const mat = new BABYLON.PBRMaterial('continuousAvalancheMat070', this.scene);
  mat.albedoColor = new BABYLON.Color3(0.98, 0.985, 1.0);
  mat.roughness = 0.92;
  mat.metallic = 0;
  mat.alpha = 0.96;
  mat.useVertexColors = true;
  mat.useVertexAlpha = true;
  mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  mat.backFaceCulling = false;
  mat.environmentIntensity = 0.55;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.renderingGroupId = 1;
  this.continuousFlowMesh = mesh;
};

CascadeScene.prototype.updateFlow = function updateContinuousFlowSurface() {
  // Preserve snowpack deformation and target-side effects from the base scene.
  previousUpdateFlow.call(this);

  const state = this.continuousFlow;
  const mesh = this.continuousFlowMesh;
  if (!state || !mesh) return;

  const now = performance.now() * 0.001;
  const dt = Math.min(0.05, Math.max(0.006, now - state.lastTime));
  state.lastTime = now;

  const r = state.resolution;
  const scale = state.scale;
  const cs = this.sim.cellSize;
  const s = this.sim.size;
  const response = 1 - Math.exp(-dt * 8.0);
  const depositResponse = 1 - Math.exp(-dt * 2.6);

  for (let vz = 0; vz < r; vz++) {
    const gz = vz / scale;
    const z0 = Math.floor(gz);
    const z1 = Math.min(s - 1, z0 + 1);
    const tz = gz - z0;

    for (let vx = 0; vx < r; vx++) {
      const gx = vx / scale;
      const x0 = Math.floor(gx);
      const x1 = Math.min(s - 1, x0 + 1);
      const tx = gx - x0;
      const vi = vz * r + vx;

      const moving = sampleField(this.sim.moving, this.sim, x0, x1, z0, z1, tx, tz);
      const core = sampleField(this.sim.core, this.sim, x0, x1, z0, z1, tx, tz);
      const deposit = sampleField(this.sim.deposit, this.sim, x0, x1, z0, z1, tx, tz);

      // A compact blur across the simulation field removes cell boundaries while
      // preserving the broad route and split/merge behavior of the underlying flow.
      const blurred = localBlur(this.sim, gx, gz);
      const targetDensity = Math.max(moving + core * 0.45, blurred * 0.88);
      state.density[vi] += (targetDensity - state.density[vi]) * response;
      state.deposit[vi] += (deposit - state.deposit[vi]) * depositResponse;

      const wx = (gx - s / 2) * cs;
      const wz = (gz - s / 2) * cs;
      const ground = this.sim.sampleWorldHeight(wx, wz);
      const density = state.density[vi];
      const settled = state.deposit[vi];
      const visible = smoothstep(0.012, 0.18, density + settled * 0.42);
      const movingShare = density / Math.max(0.001, density + settled * 0.42);

      // Height is intentionally modest. The connected silhouette and changing
      // thickness should communicate mass without returning to blob geometry.
      const thickness = Math.min(1.35, Math.sqrt(Math.max(0, density)) * 0.48 + Math.sqrt(Math.max(0, settled)) * 0.18);
      const microRoll = Math.sin(wx * 0.23 + wz * 0.14 + now * (1.7 + movingShare)) * 0.035 * visible * movingShare;

      const p = vi * 3;
      state.positions[p] = wx;
      state.positions[p + 1] = ground + 0.035 + thickness + microRoll;
      state.positions[p + 2] = wz;

      const c = vi * 4;
      const warm = 0.035 * movingShare;
      state.colors[c] = 0.93 + warm;
      state.colors[c + 1] = 0.95 + warm * 0.45;
      state.colors[c + 2] = 1.0;
      state.colors[c + 3] = visible * (0.42 + movingShare * 0.50);
    }
  }

  const normals = [];
  BABYLON.VertexData.ComputeNormals(Array.from(state.positions), state.indices, normals);
  mesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, state.positions, true, false);
  mesh.updateVerticesData(BABYLON.VertexBuffer.NormalKind, normals, true, false);
  mesh.updateVerticesData(BABYLON.VertexBuffer.ColorKind, state.colors, true, false);
  mesh.refreshBoundingInfo();
};

function buildIndices(r) {
  const indices = [];
  for (let z = 0; z < r - 1; z++) {
    for (let x = 0; x < r - 1; x++) {
      const i = z * r + x;
      indices.push(i, i + r, i + 1, i + 1, i + r, i + r + 1);
    }
  }
  return indices;
}

function sampleField(field, sim, x0, x1, z0, z1, tx, tz) {
  const a = field[sim.index(x0, z0)];
  const b = field[sim.index(x1, z0)];
  const c = field[sim.index(x0, z1)];
  const d = field[sim.index(x1, z1)];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

function localBlur(sim, gx, gz) {
  const cx = Math.round(gx);
  const cz = Math.round(gz);
  let total = 0;
  let weight = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      const z = cz + dz;
      if (!sim.inBounds(x, z)) continue;
      const w = dx === 0 && dz === 0 ? 4 : (dx === 0 || dz === 0 ? 2 : 1);
      const i = sim.index(x, z);
      total += (sim.moving[i] + sim.core[i] * 0.42) * w;
      weight += w;
    }
  }
  return weight ? total / weight : 0;
}

function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(a, b, v) {
  const t = Math.max(0, Math.min(1, (v - a) / Math.max(0.0001, b - a)));
  return t * t * (3 - 2 * t);
}
