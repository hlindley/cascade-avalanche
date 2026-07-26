import { CascadeScene } from './scene.js';

const previousUpdateFlow = CascadeScene.prototype.updateFlow;

CascadeScene.prototype.updateFlow = function updateFlowWithSurfacePolish() {
  previousUpdateFlow.call(this);

  const state = this.continuousFlow;
  const mesh = this.continuousFlowMesh;
  if (!state || !mesh) return;

  const r = state.resolution;
  const cs = this.sim.cellSize;
  const s = this.sim.size;
  const smoothedVisibility = new Float32Array(state.visibility.length);
  const smoothedThickness = new Float32Array(state.visibility.length);

  for (let z = 0; z < r; z++) {
    for (let x = 0; x < r; x++) {
      const i = z * r + x;
      let visTotal = 0;
      let thickTotal = 0;
      let weightTotal = 0;

      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= r || nz >= r) continue;
          const ni = nz * r + nx;
          const dist2 = dx * dx + dz * dz;
          const w = dist2 === 0 ? 6 : dist2 <= 1 ? 3 : dist2 <= 4 ? 1.25 : 0.35;
          const gx = nx / state.scale;
          const gz = nz / state.scale;
          const wx = (gx - s / 2) * cs;
          const wz = (gz - s / 2) * cs;
          const ground = this.sim.sampleWorldHeight(wx, wz);
          const thickness = Math.max(0, state.positions[ni * 3 + 1] - ground - 0.02);
          visTotal += state.visibility[ni] * w;
          thickTotal += thickness * state.visibility[ni] * w;
          weightTotal += w;
        }
      }

      const vis = weightTotal ? visTotal / weightTotal : 0;
      smoothedVisibility[i] = vis;
      smoothedThickness[i] = visTotal > 0 ? thickTotal / visTotal : 0;
    }
  }

  for (let z = 0; z < r; z++) {
    const gz = z / state.scale;
    for (let x = 0; x < r; x++) {
      const gx = x / state.scale;
      const i = z * r + x;
      const wx = (gx - s / 2) * cs;
      const wz = (gz - s / 2) * cs;
      const ground = this.sim.sampleWorldHeight(wx, wz);
      const edge = smoothstep(0.045, 0.34, smoothedVisibility[i]);
      const thickness = smoothedThickness[i] * edge;

      state.positions[i * 3 + 1] = ground + 0.024 + thickness;
      state.colors[i * 4 + 3] = smoothstep(0.07, 0.44, smoothedVisibility[i]);
    }
  }

  const indices = [];
  for (let z = 0; z < r - 1; z++) {
    for (let x = 0; x < r - 1; x++) {
      const i = z * r + x;
      const a = smoothedVisibility[i];
      const b = smoothedVisibility[i + 1];
      const c = smoothedVisibility[i + r];
      const d = smoothedVisibility[i + r + 1];
      const avg = (a + b + c + d) * 0.25;
      const min = Math.min(a, b, c, d);
      if (avg < 0.055 || min < 0.018) continue;
      indices.push(i, i + r, i + 1, i + 1, i + r, i + r + 1);
    }
  }

  const normals = new Array(state.positions.length).fill(0);
  if (indices.length) BABYLON.VertexData.ComputeNormals(Array.from(state.positions), indices, normals);
  mesh.setIndices(indices, null, true);
  mesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, state.positions, true, false);
  mesh.updateVerticesData(BABYLON.VertexBuffer.NormalKind, normals, true, false);
  mesh.updateVerticesData(BABYLON.VertexBuffer.ColorKind, state.colors, true, false);
  mesh.refreshBoundingInfo();
};

function smoothstep(a, b, value) {
  const t = Math.max(0, Math.min(1, (value - a) / Math.max(0.0001, b - a)));
  return t * t * (3 - 2 * t);
}
