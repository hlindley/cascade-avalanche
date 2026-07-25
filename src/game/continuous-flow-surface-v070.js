import { CascadeScene } from './scene.js';

const previousBuildScene = CascadeScene.prototype.buildScene;
const previousUpdateFlow = CascadeScene.prototype.updateFlow;

CascadeScene.prototype.buildScene = function buildSceneWithContinuousFlowSurface() {
  previousBuildScene.call(this);

  for (const mesh of [this.surfaceMesh, this.coreMesh, this.depositMesh, this.powderMesh]) {
    if (mesh) mesh.setEnabled(false);
  }
  for (const mesh of this.scene.meshes) {
    if (/waveParticle|waveMist|softDensity|softVeil|unified|impact/i.test(mesh.name)) mesh.setEnabled(false);
  }

  const scale = 3;
  const resolution = (this.sim.size - 1) * scale + 1;
  const count = resolution * resolution;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 4);

  // Start every vertex on the terrain so there is never a zero-height grid flash.
  for (let vz = 0; vz < resolution; vz++) {
    const gz = vz / scale;
    for (let vx = 0; vx < resolution; vx++) {
      const gx = vx / scale;
      const vi = vz * resolution + vx;
      const wx = (gx - this.sim.size / 2) * this.sim.cellSize;
      const wz = (gz - this.sim.size / 2) * this.sim.cellSize;
      const ground = this.sim.sampleWorldHeight(wx, wz);
      positions[vi * 3] = wx;
      positions[vi * 3 + 1] = ground + 0.018;
      positions[vi * 3 + 2] = wz;
      colors[vi * 4] = 0.96;
      colors[vi * 4 + 1] = 0.975;
      colors[vi * 4 + 2] = 1.0;
      colors[vi * 4 + 3] = 0;
    }
  }

  this.continuousFlow = {
    scale,
    resolution,
    density: new Float32Array(count),
    deposit: new Float32Array(count),
    visibility: new Float32Array(count),
    positions,
    colors,
    lastTime: performance.now() * 0.001
  };

  const mesh = new BABYLON.Mesh('continuousAvalanche070', this.scene);
  const vd = new BABYLON.VertexData();
  vd.positions = Array.from(positions);
  vd.indices = [];
  vd.normals = new Array(count * 3).fill(0);
  vd.colors = Array.from(colors);
  vd.applyToMesh(mesh, true);

  const mat = new BABYLON.PBRMaterial('continuousAvalancheMat070', this.scene);
  mat.albedoColor = new BABYLON.Color3(0.985, 0.99, 1.0);
  mat.roughness = 0.96;
  mat.metallic = 0;
  mat.alpha = 1;
  mat.useVertexColors = true;
  mat.useVertexAlpha = true;
  mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  mat.backFaceCulling = false;
  mat.environmentIntensity = 0.48;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.renderingGroupId = 1;
  this.continuousFlowMesh = mesh;
};

CascadeScene.prototype.updateFlow = function updateContinuousFlowSurface() {
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
  const response = 1 - Math.exp(-dt * 9.5);
  const fadeResponse = 1 - Math.exp(-dt * 3.4);
  const depositResponse = 1 - Math.exp(-dt * 2.4);

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
      const blurred = localBlur(this.sim, gx, gz);
      const targetDensity = Math.max(moving + core * 0.52, blurred * 0.94);

      state.density[vi] += (targetDensity - state.density[vi]) * response;
      state.deposit[vi] += (deposit - state.deposit[vi]) * depositResponse;

      const combined = state.density[vi] + state.deposit[vi] * 0.34;
      const targetVisible = smoothstep(0.018, 0.11, combined);
      const visK = targetVisible > state.visibility[vi] ? response : fadeResponse;
      state.visibility[vi] += (targetVisible - state.visibility[vi]) * visK;

      const wx = (gx - s / 2) * cs;
      const wz = (gz - s / 2) * cs;
      const ground = this.sim.sampleWorldHeight(wx, wz);
      const density = state.density[vi];
      const settled = state.deposit[vi];
      const visible = state.visibility[vi];
      const movingShare = density / Math.max(0.001, density + settled * 0.34);

      const thickness = Math.min(
        1.65,
        Math.sqrt(Math.max(0, density)) * 0.72 + Math.sqrt(Math.max(0, settled)) * 0.22
      );
      const roll = Math.sin(wx * 0.19 + wz * 0.13 + now * (2.0 + movingShare * 1.3))
        * 0.055 * visible * movingShare;

      const p = vi * 3;
      state.positions[p] = wx;
      state.positions[p + 1] = ground + 0.025 + thickness * visible + roll;
      state.positions[p + 2] = wz;

      const c = vi * 4;
      const warm = 0.025 * movingShare;
      state.colors[c] = 0.955 + warm;
      state.colors[c + 1] = 0.97 + warm * 0.35;
      state.colors[c + 2] = 1.0;
      state.colors[c + 3] = smoothstep(0.06, 0.45, visible);
    }
  }

  // Build triangles only where the flow actually exists. This is the critical fix:
  // empty terrain has no avalanche topology, rather than transparent grid triangles.
  const activeIndices = [];
  for (let z = 0; z < r - 1; z++) {
    for (let x = 0; x < r - 1; x++) {
      const i = z * r + x;
      const a = state.visibility[i];
      const b = state.visibility[i + 1];
      const c = state.visibility[i + r];
      const d = state.visibility[i + r + 1];
      const maxV = Math.max(a, b, c, d);
      const avgV = (a + b + c + d) * 0.25;
      if (maxV < 0.07 || avgV < 0.025) continue;
      activeIndices.push(i, i + r, i + 1, i + 1, i + r, i + r + 1);
    }
  }

  const normals = new Array(state.positions.length).fill(0);
  if (activeIndices.length) {
    BABYLON.VertexData.ComputeNormals(Array.from(state.positions), activeIndices, normals);
  }
  mesh.setIndices(activeIndices, null, true);
  mesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, state.positions, true, false);
  mesh.updateVerticesData(BABYLON.VertexBuffer.NormalKind, normals, true, false);
  mesh.updateVerticesData(BABYLON.VertexBuffer.ColorKind, state.colors, true, false);
  mesh.refreshBoundingInfo();
};

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
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx;
      const z = cz + dz;
      if (!sim.inBounds(x, z)) continue;
      const dist2 = dx * dx + dz * dz;
      const w = dist2 === 0 ? 7 : dist2 <= 1 ? 4 : dist2 <= 4 ? 1.5 : 0.45;
      const i = sim.index(x, z);
      total += (sim.moving[i] + sim.core[i] * 0.48) * w;
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
