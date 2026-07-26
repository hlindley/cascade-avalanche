import { CascadeScene } from './scene.js';

const previousBuildScene = CascadeScene.prototype.buildScene;
const previousUpdateFlow = CascadeScene.prototype.updateFlow;

CascadeScene.prototype.buildScene = function buildSceneWithLightweightFeather() {
  previousBuildScene.call(this);

  // Keep mist subtle and short-lived.
  if (this.leadingMistMesh?.material) this.leadingMistMesh.material.alpha = 0.31;

  const s = this.sim.size;
  const count = s * s;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 4);

  const mesh = new BABYLON.Mesh('flowEdgeFeather078', this.scene);
  const vd = new BABYLON.VertexData();
  vd.positions = Array.from(positions);
  vd.indices = [];
  vd.normals = new Array(count * 3).fill(0);
  vd.colors = Array.from(colors);
  vd.applyToMesh(mesh, true);

  const mat = new BABYLON.StandardMaterial('flowEdgeFeatherMat078', this.scene);
  mat.diffuseColor = new BABYLON.Color3(0.985, 0.99, 1.0);
  mat.emissiveColor = new BABYLON.Color3(0.08, 0.09, 0.12);
  mat.alpha = 0.42;
  mat.useVertexColors = true;
  mat.useVertexAlpha = true;
  mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  mat.backFaceCulling = false;
  mat.disableDepthWrite = true;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.renderingGroupId = 1;

  this.flowEdgeFeather078 = {
    mesh,
    positions,
    colors,
    visibility: new Float32Array(count),
    frame: 0
  };
};

CascadeScene.prototype.updateFlow = function updateFlowWithLightweightFeather() {
  previousUpdateFlow.call(this);

  const state = this.flowEdgeFeather078;
  if (!state) return;
  state.frame++;

  // Update this secondary layer at half rate to protect mobile FPS.
  if (state.frame % 2) return;

  const s = this.sim.size;
  const cs = this.sim.cellSize;
  const flow = this.continuousFlow;
  if (!flow) return;

  // Collapse the upsampled visibility field back to simulation resolution,
  // then use only a compact 3x3 blur.
  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
      let total = 0;
      let weight = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const nz = z + dz;
          if (!this.sim.inBounds(nx, nz)) continue;
          const vx = Math.min(flow.resolution - 1, nx * flow.scale);
          const vz = Math.min(flow.resolution - 1, nz * flow.scale);
          const w = dx === 0 && dz === 0 ? 4 : (dx === 0 || dz === 0 ? 2 : 1);
          total += flow.visibility[vz * flow.resolution + vx] * w;
          weight += w;
        }
      }
      state.visibility[z * s + x] = weight ? total / weight : 0;
    }
  }

  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
      const i = z * s + x;
      const wx = (x - s / 2) * cs;
      const wz = (z - s / 2) * cs;
      const ground = this.sim.sampleWorldHeight(wx, wz);
      const vis = state.visibility[i];
      const edge = smoothstep(0.018, 0.16, vis);

      state.positions[i * 3] = wx;
      state.positions[i * 3 + 1] = ground + 0.012 + edge * 0.025;
      state.positions[i * 3 + 2] = wz;
      state.colors[i * 4] = 0.97;
      state.colors[i * 4 + 1] = 0.985;
      state.colors[i * 4 + 2] = 1.0;
      state.colors[i * 4 + 3] = edge * 0.34;
    }
  }

  const indices = [];
  for (let z = 0; z < s - 1; z++) {
    for (let x = 0; x < s - 1; x++) {
      const i = z * s + x;
      const vis = [state.visibility[i], state.visibility[i + 1], state.visibility[i + s], state.visibility[i + s + 1]];
      if (Math.max(...vis) < 0.035 || vis.reduce((a, b) => a + b, 0) * 0.25 < 0.018) continue;

      const heights = [
        state.positions[i * 3 + 1],
        state.positions[(i + 1) * 3 + 1],
        state.positions[(i + s) * 3 + 1],
        state.positions[(i + s + 1) * 3 + 1]
      ];
      if (Math.max(...heights) - Math.min(...heights) > cs * 0.72) continue;

      indices.push(i, i + s, i + 1, i + 1, i + s, i + s + 1);
    }
  }

  const normals = new Array(state.positions.length).fill(0);
  if (indices.length) BABYLON.VertexData.ComputeNormals(Array.from(state.positions), indices, normals);
  state.mesh.setIndices(indices, null, true);
  state.mesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, state.positions, true, false);
  state.mesh.updateVerticesData(BABYLON.VertexBuffer.NormalKind, normals, true, false);
  state.mesh.updateVerticesData(BABYLON.VertexBuffer.ColorKind, state.colors, true, false);
  state.mesh.refreshBoundingInfo();
};

function smoothstep(a, b, value) {
  const t = Math.max(0, Math.min(1, (value - a) / Math.max(0.0001, b - a)));
  return t * t * (3 - 2 * t);
}
