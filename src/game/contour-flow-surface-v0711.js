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
  material.useVertexAlpha = true;
  material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.renderingGroupId = 1;

  this.contourFlow = {
    mesh,
    field: new Float32Array(this.sim.size * this.sim.size),
    target: new Float32Array(this.sim.size * this.sim.size),
    visibleCenter: null,
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

  let centerX = 0;
  let centerZ = 0;
  let centerWeight = 0;

  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
      let total = 0;
      let weight = 0;
      let speedTotal = 0;
      let movingTotal = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const nz = z + dz;
          if (!this.sim.inBounds(nx, nz)) continue;
          const w = dx === 0 && dz === 0 ? 4 : (dx === 0 || dz === 0 ? 2 : 1);
          const i = this.sim.index(nx, nz);
          const moving = this.sim.moving[i];
          const speed = Math.hypot(this.sim.velX[i], this.sim.velZ[i]);
          total += (moving + this.sim.core[i] * 0.55 + this.sim.deposit[i] * 0.24) * w;
          speedTotal += speed * moving * w;
          movingTotal += moving * w;
          weight += w;
        }
      }
      const i = this.sim.index(x, z);
      const baseMass = weight ? total / weight : 0;
      const weightedSpeed = movingTotal > 0.0001 ? speedTotal / movingTotal : 0;
      const fastThinSupport = Math.min(0.052, weightedSpeed * 0.0105) * smoothstep(0.002, 0.035, baseMass);
      state.target[i] = baseMass + fastThinSupport;
      state.field[i] += (state.target[i] - state.field[i]) * response;

      const visibleWeight = Math.max(0, state.field[i] - THRESHOLD * 0.72);
      if (visibleWeight > 0) {
        centerX += (x - s / 2) * this.sim.cellSize * visibleWeight;
        centerZ += (z - s / 2) * this.sim.cellSize * visibleWeight;
        centerWeight += visibleWeight;
      }
    }
  }

  state.visibleCenter = centerWeight > 0
    ? { x: centerX / centerWeight, z: centerZ / centerWeight, weight: centerWeight }
    : null;

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
  return {
    x: wx,
    y: ground + 0.022 + thickness,
    ground,
    z: wz,
    value,
    alpha: smoothstep(THRESHOLD, THRESHOLD * 2.4, value)
  };
}

function emitClippedTriangle(a, b, c, positions, colors, indices) {
  const polygon = [];
  const input = [a, b, c];
  for (let i = 0; i < input.length; i++) {
    const current = input[i];
    const next = input[(i + 1) % input.length];
    const currentInside = current.value >= THRESHOLD;
    const nextInside = next.value >= THRESHOLD;
    if (currentInside) polygon.push(current);
    if (currentInside !== nextInside) polygon.push(interpolate(current, next));
  }
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
  const ground = lerp(a.ground, b.ground, t);
  return {
    x: lerp(a.x, b.x, t),
    y: ground + 0.022,
    ground,
    z: lerp(a.z, b.z, t),
    value: THRESHOLD,
    alpha: 0
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(a, b, value) {
  const t = Math.max(0, Math.min(1, (value - a) / Math.max(0.0001, b - a)));
  return t * t * (3 - 2 * t);
}
