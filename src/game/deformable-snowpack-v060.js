import { CascadeScene } from './scene.js';

const oldAnimateFracture = CascadeScene.prototype.animateFracture;
const oldUpdateFlow = CascadeScene.prototype.updateFlow;

CascadeScene.prototype.animateFracture = function animateFractureWithSnowpack(r) {
  prepareSnowpackCut.call(this, r);
  oldAnimateFracture.call(this, r);
};

CascadeScene.prototype.updateFlow = function updateFlowWithDeformableSnowpack() {
  oldUpdateFlow.call(this);
  updateSnowpackCut.call(this);
};

function prepareSnowpackCut(r) {
  if (!r?.cells?.length || !this.mountain) return;

  const positions = this.mountain.getVerticesData(BABYLON.VertexBuffer.PositionKind);
  const colors = this.mountain.getVerticesData(BABYLON.VertexBuffer.ColorKind);
  const indices = this.mountain.getIndices();
  if (!positions || !colors || !indices) return;

  const vertexCount = positions.length / 3;
  const targetDepth = new Float32Array(vertexCount);
  const targetBed = new Float32Array(vertexCount);
  const occupied = new Set(r.cells.map(c => `${c.x},${c.z}`));

  let maxMass = .001;
  for (const c of r.cells) {
    maxMass = Math.max(maxMass, this.sim.pendingRelease[this.sim.index(c.x, c.z)] || 0);
  }

  for (const c of r.cells) {
    const i = this.sim.index(c.x, c.z);
    const mass = this.sim.pendingRelease[i] || 0;
    const normalized = Math.sqrt(mass / maxMass);
    const edgeDistance = boundaryDistance(c.x, c.z, occupied);
    const edgeFactor = edgeDistance === 0 ? .76 : edgeDistance === 1 ? .92 : 1;
    const irregular = .90 + this.sim.hashNoise(c.x, c.z, 221) * .18;
    targetDepth[i] = (.18 + normalized * .30) * edgeFactor * irregular;
    targetBed[i] = .72 + normalized * .28;
  }

  // Feather only one cell outside the slab. The crown itself remains sharper.
  for (const c of r.cells) {
    const i = this.sim.index(c.x, c.z);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const x = c.x + dx, z = c.z + dz;
      if (!this.sim.inBounds(x, z) || occupied.has(`${x},${z}`)) continue;
      const ni = this.sim.index(x, z);
      const feather = targetDepth[i] * (dx && dz ? .12 : .20);
      targetDepth[ni] = Math.max(targetDepth[ni], feather);
      targetBed[ni] = Math.max(targetBed[ni], .18);
    }
  }

  this.snowpackCut = {
    positions,
    originalPositions: new Float32Array(positions),
    colors,
    originalColors: new Float32Array(colors),
    indices,
    targetDepth,
    targetBed,
    progress: 0,
    started: false,
    completed: false,
    startedAt: 0
  };

  createCrown.call(this, r.boundary);
}

function updateSnowpackCut() {
  const cut = this.snowpackCut;
  if (!cut || cut.completed) return;
  if (!this.flowStarted) return;

  if (!cut.started) {
    cut.started = true;
    cut.startedAt = performance.now();
  }

  const elapsed = (performance.now() - cut.startedAt) / 1000;
  cut.progress = smoothstep(0, .48, elapsed);

  const p = cut.progress;
  const positions = cut.positions;
  const colors = cut.colors;
  const originalPositions = cut.originalPositions;
  const originalColors = cut.originalColors;

  for (let i = 0; i < cut.targetDepth.length; i++) {
    const depth = cut.targetDepth[i];
    const bed = cut.targetBed[i];
    if (depth <= 0 && bed <= 0) continue;

    positions[i * 3 + 1] = originalPositions[i * 3 + 1] - depth * p;

    const bedMix = bed * p;
    const noise = this.sim.hashNoise(i % this.sim.size, Math.floor(i / this.sim.size), 229) - .5;
    const bedR = .24 + noise * .025;
    const bedG = .29 + noise * .022;
    const bedB = .38 + noise * .035;
    colors[i * 4] = lerp(originalColors[i * 4], bedR, bedMix);
    colors[i * 4 + 1] = lerp(originalColors[i * 4 + 1], bedG, bedMix);
    colors[i * 4 + 2] = lerp(originalColors[i * 4 + 2], bedB, bedMix);
  }

  const normals = [];
  BABYLON.VertexData.ComputeNormals(Array.from(positions), cut.indices, normals);
  this.mountain.updateVerticesData(BABYLON.VertexBuffer.PositionKind, positions, true, false);
  this.mountain.updateVerticesData(BABYLON.VertexBuffer.NormalKind, normals, true, false);
  this.mountain.updateVerticesData(BABYLON.VertexBuffer.ColorKind, colors, true, false);
  this.mountain.refreshBoundingInfo();

  if (this.crownMesh) {
    this.crownMesh.visibility = Math.min(1, p * 1.35);
  }

  if (p >= 1) cut.completed = true;
}

function createCrown(boundary) {
  if (this.crownMesh) this.crownMesh.dispose();
  if (!boundary?.length) return;

  const segments = [];
  let highest = -Infinity;
  for (const e of boundary) {
    const a = edgePoint.call(this, e, e.a);
    const b = edgePoint.call(this, e, e.b);
    highest = Math.max(highest, a.y, b.y);
    segments.push([a, b]);
  }

  const crownSegments = segments.filter(([a, b]) => Math.max(a.y, b.y) > highest - 3.5);
  if (!crownSegments.length) return;

  const lines = BABYLON.MeshBuilder.CreateLineSystem('persistentCrown060', {
    lines: crownSegments
  }, this.scene);
  lines.color = new BABYLON.Color3(.18, .23, .34);
  lines.alpha = .9;
  lines.visibility = 0;
  lines.isPickable = false;
  this.crownMesh = lines;
}

function edgePoint(e, point) {
  const x = e.x + point[0];
  const z = e.z + point[1];
  const wx = (x - this.sim.size / 2) * this.sim.cellSize;
  const wz = (z - this.sim.size / 2) * this.sim.cellSize;
  return new BABYLON.Vector3(wx, this.sim.sampleWorldHeight(wx, wz) + .08, wz);
}

function boundaryDistance(x, z, occupied) {
  for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    if (!occupied.has(`${x + dx},${z + dz}`)) return 0;
  }
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    if (!occupied.has(`${x + dx},${z + dz}`)) return 1;
  }
  return 2;
}

function smoothstep(a, b, v) {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
