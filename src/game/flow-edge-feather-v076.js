import { CascadeScene } from './scene.js';

const previousBuildScene = CascadeScene.prototype.buildScene;
const previousUpdateFlow = CascadeScene.prototype.updateFlow;

CascadeScene.prototype.buildScene = function buildSceneWithFlowEdgeFeather() {
  previousBuildScene.call(this);

  if (this.leadingMist?.particles) this.leadingMist.maxParticles = 3200;
  if (this.leadingMistMesh?.material) {
    this.leadingMistMesh.material.alpha = 0.62;
    this.leadingMistMesh.material.emissiveColor = new BABYLON.Color3(0.34, 0.36, 0.42);
  }

  const state = this.continuousFlow;
  if (!state) return;

  const count = state.resolution * state.resolution;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 4);
  const mesh = new BABYLON.Mesh('flowEdgeFeather076', this.scene);
  const vd = new BABYLON.VertexData();
  vd.positions = Array.from(positions);
  vd.indices = [];
  vd.normals = new Array(count * 3).fill(0);
  vd.colors = Array.from(colors);
  vd.applyToMesh(mesh, true);

  const mat = new BABYLON.PBRMaterial('flowEdgeFeatherMat076', this.scene);
  mat.albedoColor = new BABYLON.Color3(0.985, 0.99, 1.0);
  mat.roughness = 1;
  mat.metallic = 0;
  mat.alpha = 0.72;
  mat.useVertexColors = true;
  mat.useVertexAlpha = true;
  mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  mat.backFaceCulling = false;
  mat.disableDepthWrite = true;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.renderingGroupId = 1;

  this.flowEdgeFeather = {
    mesh,
    positions,
    colors,
    broadVisibility: new Float32Array(count)
  };
};

CascadeScene.prototype.updateFlow = function updateFlowWithFlowEdgeFeather() {
  previousUpdateFlow.call(this);

  // Make the short-lived mist readable at mobile camera distance while keeping
  // the lifetime and emission behavior from the balanced pass.
  if (this.leadingMist?.particles) {
    for (const p of this.leadingMist.particles) {
      if (p.v076Boosted) continue;
      p.size *= 1.65;
      p.v076Boosted = true;
    }
  }

  const flow = this.continuousFlow;
  const feather = this.flowEdgeFeather;
  if (!flow || !feather) return;

  const r = flow.resolution;
  const scale = flow.scale;
  const s = this.sim.size;
  const cs = this.sim.cellSize;
  const broad = feather.broadVisibility;

  // A wider, low-frequency visibility field extends beyond the clipped main
  // surface and removes the hard triangle-to-terrain intersection.
  for (let z = 0; z < r; z++) {
    for (let x = 0; x < r; x++) {
      let total = 0;
      let weight = 0;
      for (let dz = -4; dz <= 4; dz++) {
        for (let dx = -4; dx <= 4; dx++) {
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= r || nz >= r) continue;
          const dist2 = dx * dx + dz * dz;
          if (dist2 > 18) continue;
          const w = Math.exp(-dist2 / 7.5);
          total += flow.visibility[nz * r + nx] * w;
          weight += w;
        }
      }
      broad[z * r + x] = weight ? total / weight : 0;
    }
  }

  for (let z = 0; z < r; z++) {
    const gz = z / scale;
    for (let x = 0; x < r; x++) {
      const gx = x / scale;
      const i = z * r + x;
      const wx = (gx - s / 2) * cs;
      const wz = (gz - s / 2) * cs;
      const ground = this.sim.sampleWorldHeight(wx, wz);
      const vis = broad[i];
      const mainVis = flow.visibility[i];
      const halo = Math.max(0, vis - mainVis * 0.28);
      const edge = smoothstep(0.008, 0.12, halo);
      const height = 0.012 + edge * (0.025 + Math.min(0.10, vis * 0.20));

      feather.positions[i * 3] = wx;
      feather.positions[i * 3 + 1] = ground + height;
      feather.positions[i * 3 + 2] = wz;
      feather.colors[i * 4] = 0.97;
      feather.colors[i * 4 + 1] = 0.985;
      feather.colors[i * 4 + 2] = 1.0;
      feather.colors[i * 4 + 3] = edge * 0.62;
    }
  }

  const indices = [];
  for (let z = 0; z < r - 1; z++) {
    for (let x = 0; x < r - 1; x++) {
      const i = z * r + x;
      const a = broad[i];
      const b = broad[i + 1];
      const c = broad[i + r];
      const d = broad[i + r + 1];
      const avg = (a + b + c + d) * 0.25;
      const max = Math.max(a, b, c, d);
      if (avg < 0.006 || max < 0.014) continue;
      indices.push(i, i + r, i + 1, i + 1, i + r, i + r + 1);
    }
  }

  const normals = new Array(feather.positions.length).fill(0);
  if (indices.length) BABYLON.VertexData.ComputeNormals(Array.from(feather.positions), indices, normals);
  feather.mesh.setIndices(indices, null, true);
  feather.mesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, feather.positions, true, false);
  feather.mesh.updateVerticesData(BABYLON.VertexBuffer.NormalKind, normals, true, false);
  feather.mesh.updateVerticesData(BABYLON.VertexBuffer.ColorKind, feather.colors, true, false);
  feather.mesh.refreshBoundingInfo();
};

function smoothstep(a, b, value) {
  const t = Math.max(0, Math.min(1, (value - a) / Math.max(0.0001, b - a)));
  return t * t * (3 - 2 * t);
}
