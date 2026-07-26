import { CascadeScene } from './scene.js';

const previousBuildScene = CascadeScene.prototype.buildScene;
const previousUpdateFlow = CascadeScene.prototype.updateFlow;
const THRESHOLD = 0.032;

CascadeScene.prototype.buildScene = function buildSceneWithContourFlow() {
  previousBuildScene.call(this);

  const mesh = new BABYLON.Mesh('contourAvalanche0711', this.scene);
  const material = new BABYLON.PBRMaterial('contourAvalancheMat0711', this.scene);
  material.albedoColor = new BABYLON.Color3(0.975, 0.985, 1.0);
  material.roughness = 0.97;
  material.metallic = 0;
  material.backFaceCulling = false;
  material.useVertexColors = true;
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.renderingGroupId = 1;

  this.contourFlow = {
    mesh,
    field: new Float32Array(this.sim.size * this.sim.size),
    target: new Float32Array(this.sim.size * this.sim.size),
    lastTime: performance.now() * 0.001
  };
};

CascadeScene.prototype.updateFlow = function updateContourFlow() {
  previousUpdateFlow.call(this);

  if (this.continuousFlowMesh) this.continuousFlowMesh.setEnabled(false);

  const state = this.contourFlow;
  if (!state) return;

  const now = performance.now() * 0.001;
  const dt = Math.min(0.05, Math.max(0.006, now - state.lastTime));
  state.lastTime = now;
  const s = this.sim.size;
  const response = 1 - Math.exp(-dt * 10);

  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
      let total = 0;
      let weight = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const nz = z + dz;
          if (!this.sim.inBounds(nx, nz)) continue;
          const w = dx === 0 && dz === 0 ? 4 : (dx === 0 || dz === 0 ? 2 : 1);
          const i = this.sim.index(nx, nz);
          total += (this.sim.moving[i] + this.sim.core[i] * 0.55 + this.sim.deposit[i] * 0.24) * w;
          weight += w;
        }
      }
      const i = this.sim.index(x, z);
      state.target[i] = weight ? total / weight : 0;
      state.field[i] += (state.target[i] - state.field[i]) * response;
    }
  }

  const positions = [];
  const colors = [];
  const indices = [];
  const cs = this.sim.cellSize;

  for (let z = 0; z < s - 1; z++) {
    for (let x = 0; x < s - 1; x++) {
      const corners = [
        makeVertex.call(this, state, x, z, cs),
        makeVertex.call(this, state, x + 1, z, cs),
        makeVertex.call(this, state, x + 1, z + 1, cs),
        makeVertex.call(this, state, x, z + 1, cs)
      ];
      emitClippedTriangle(corners[0], corners[1], corners[2], positions, colors, indices);
      emitClippedTriangle(corners[0], corners[2], corners[3], positions, colors, indices);
    }
  }

  const normals = new Array(positions.length).fill(0);
  if (indices.length) BABYLON.VertexData.ComputeNormals(positions, indices, normals);
  const vd = new BABYLON.VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  vd.colors = colors;
  vd.applyToMesh(state.mesh, true);
  state.mesh.refreshBoundingInfo();
};

function makeVertex(state, x, z, cs) {
  const i = this.sim.index(x, z);
  const value = state.field[i];
  const wx = (x - this.sim.size / 2) * cs;
  const wz = (z - this.sim.size / 2) * cs;
  const ground = this.sim.sampleWorldHeight(wx, wz);
  const edge = smoothstep(THRESHOLD, THRESHOLD * 3.2, value);
  const thickness = Math.min(1.5, Math.sqrt(Math.max(0, value)) * 0.82) * edge;
  return { x: wx, y: ground + 0.022 + thickness, z: wz, value, alpha: smoothstep(THRESHOLD, THRESHOLD * 2.4, value) };
}

function emitClippedTriangle(a, b, c, positions, colors, indices) {
  let polygon = [a, b, c];
  const output = [];
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    const currentInside = current.value >= THRESHOLD;
    const nextInside = next.value >= THRESHOLD;
    if (currentInside) output.push(current);
    if (currentInside !== nextInside) output.push(interpolate(current, next));
  }
  polygon = output;
  if (polygon.length < 3) return;

  const base = positions.length / 3;
  for (const v of polygon) {
    positions.push(v.x, v.y, v.z);
    colors.push(0.975, 0.985, 1.0, v.alpha);
  }
  for (let i = 1; i < polygon.length - 1; i++) indices.push(base, base + i, base + i + 1);
}

function interpolate(a, b) {
  const denom = b.value - a.value;
  const t = Math.abs(denom) < 1e-6 ? 0.5 : (THRESHOLD - a.value) / denom;
  const x = lerp(a.x, b.x, t);
  const z = lerp(a.z, b.z, t);
  const groundY = lerp(a.y, b.y, t);
  return { x, y: groundY - Math.max(0, lerp(a.y, b.y, t) - groundY), z, value: THRESHOLD, alpha: 0 };
}

function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(a, b, value) {
  const t = Math.max(0, Math.min(1, (value - a) / Math.max(0.0001, b - a)));
  return t * t * (3 - 2 * t);
}
