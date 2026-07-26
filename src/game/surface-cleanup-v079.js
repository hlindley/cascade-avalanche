import { CascadeScene } from './scene.js';

const previousBuildScene = CascadeScene.prototype.buildScene;
const previousUpdateFlow = CascadeScene.prototype.updateFlow;

CascadeScene.prototype.buildScene = function buildSceneWithSurfaceCleanup079() {
  previousBuildScene.call(this);
  if (this.leadingMistMesh?.material) {
    this.leadingMistMesh.material.alpha = 0.31;
  }
};

CascadeScene.prototype.updateFlow = function updateFlowWithSurfaceCleanup079() {
  previousUpdateFlow.call(this);

  const state = this.continuousFlow;
  const mesh = this.continuousFlowMesh;
  if (!state || !mesh) return;

  const r = state.resolution;
  const indices = [];

  for (let z = 0; z < r - 1; z++) {
    for (let x = 0; x < r - 1; x++) {
      const i = z * r + x;
      const ids = [i, i + 1, i + r, i + r + 1];
      const vis = ids.map(id => state.visibility[id]);
      const avgVis = (vis[0] + vis[1] + vis[2] + vis[3]) * 0.25;
      const minVis = Math.min(...vis);
      if (avgVis < 0.06 || minVis < 0.022) continue;

      const ground = ids.map(id => {
        const wx = state.positions[id * 3];
        const wz = state.positions[id * 3 + 2];
        return this.sim.sampleWorldHeight(wx, wz);
      });
      const groundSpan = Math.max(...ground) - Math.min(...ground);
      if (groundSpan > this.sim.cellSize * 0.62) continue;

      const snowHeight = ids.map((id, n) => state.positions[id * 3 + 1] - ground[n]);
      const snowSpan = Math.max(...snowHeight) - Math.min(...snowHeight);
      if (snowSpan > 0.72) continue;

      indices.push(i, i + r, i + 1, i + 1, i + r, i + r + 1);
    }
  }

  const normals = new Array(state.positions.length).fill(0);
  if (indices.length) {
    BABYLON.VertexData.ComputeNormals(Array.from(state.positions), indices, normals);
  }
  mesh.setIndices(indices, null, true);
  mesh.updateVerticesData(BABYLON.VertexBuffer.NormalKind, normals, true, false);
  mesh.refreshBoundingInfo();
};