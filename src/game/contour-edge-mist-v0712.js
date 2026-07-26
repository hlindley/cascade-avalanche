import { CascadeScene } from './scene.js';

const previousBuildScene = CascadeScene.prototype.buildScene;
const previousUpdateFlow = CascadeScene.prototype.updateFlow;
const THRESHOLD = 0.032;
const TEMPLATE_SCALE = 1000;

CascadeScene.prototype.buildScene = function buildSceneWithContourEdgeMist() {
  previousBuildScene.call(this);
  if (this.leadingMistMesh) this.leadingMistMesh.setEnabled(false);

  this.contourMist = {
    particles: [],
    maxParticles: 3200,
    lastTime: performance.now() * 0.001,
    frame: 0
  };

  const mesh = BABYLON.MeshBuilder.CreateIcoSphere('contourEdgeMist0713', {
    radius: 0.001,
    subdivisions: 1
  }, this.scene);
  const material = new BABYLON.StandardMaterial('contourEdgeMistMat0713', this.scene);
  material.diffuseColor = new BABYLON.Color3(1.0, 1.0, 1.0);
  material.emissiveColor = new BABYLON.Color3(0.52, 0.54, 0.62);
  material.alpha = 0.56;
  material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  material.disableDepthWrite = true;
  material.backFaceCulling = false;
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.renderingGroupId = 3;
  this.contourMistMesh = mesh;
};

CascadeScene.prototype.updateFlow = function updateFlowWithContourEdgeMist() {
  previousUpdateFlow.call(this);

  const state = this.contourMist;
  const mesh = this.contourMistMesh;
  const contour = this.contourFlow;
  if (!state || !mesh || !contour) return;

  const now = performance.now() * 0.001;
  const dt = Math.min(0.05, Math.max(0.006, now - state.lastTime));
  state.lastTime = now;
  state.frame++;

  emitFromContour.call(this, state, contour.field);

  const next = [];
  const matrices = [];
  for (const p of state.particles) {
    p.age += dt;
    if (p.age >= p.life) continue;

    p.vy -= 2.5 * dt;
    p.vx *= 0.988;
    p.vz *= 0.988;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;

    const ground = this.sim.sampleWorldHeight(p.x, p.z) + 0.055;
    if (p.y < ground) {
      p.y = ground;
      p.vy = Math.abs(p.vy) * 0.10;
    }

    const lifeT = p.age / p.life;
    const fade = Math.sin(Math.PI * Math.min(1, lifeT));
    const speed = Math.hypot(p.vx, p.vz);
    const angle = Math.atan2(p.vx, p.vz);
    const scale = new BABYLON.Vector3(
      p.size * (0.9 + fade * 0.45) * TEMPLATE_SCALE,
      p.size * (0.75 + fade * 0.25) * TEMPLATE_SCALE,
      p.size * (1.35 + speed * 0.045) * (0.5 + fade * 0.5) * TEMPLATE_SCALE
    );
    const rotation = BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Y, angle);
    const matrix = BABYLON.Matrix.Compose(scale, rotation, new BABYLON.Vector3(p.x, p.y, p.z));
    matrices.push(...matrix.toArray());
    next.push(p);
  }

  state.particles = next;
  mesh.thinInstanceSetBuffer('matrix', new Float32Array(matrices), 16, true);
};

function emitFromContour(state, field) {
  if (!this.sim.active || state.particles.length >= state.maxParticles) return;

  const s = this.sim.size;
  const cs = this.sim.cellSize;
  const parity = state.frame & 1;

  for (let z = 0; z < s - 1; z++) {
    for (let x = parity; x < s - 1; x += 2) {
      if (state.particles.length >= state.maxParticles) return;

      const i00 = this.sim.index(x, z);
      const i10 = this.sim.index(x + 1, z);
      const i11 = this.sim.index(x + 1, z + 1);
      const i01 = this.sim.index(x, z + 1);
      const values = [field[i00], field[i10], field[i11], field[i01]];
      const min = Math.min(...values);
      const max = Math.max(...values);
      if (min >= THRESHOLD || max < THRESHOLD) continue;

      const speed = averageSpeed.call(this, [i00, i10, i11, i01]);
      if (speed < 0.06) continue;

      const crossings = [];
      addCrossing(crossings, x, z, values[0], x + 1, z, values[1]);
      addCrossing(crossings, x + 1, z, values[1], x + 1, z + 1, values[2]);
      addCrossing(crossings, x + 1, z + 1, values[2], x, z + 1, values[3]);
      addCrossing(crossings, x, z + 1, values[3], x, z, values[0]);
      if (!crossings.length) continue;

      const gx = crossings.reduce((sum, p) => sum + p.x, 0) / crossings.length;
      const gz = crossings.reduce((sum, p) => sum + p.z, 0) / crossings.length;
      const dir = downhillAt.call(this, gx, gz);
      const slope = localSlopeAt.call(this, gx, gz);
      const chance = Math.min(0.92, 0.34 + speed * 0.16 + slope * 0.30);
      if (noise(x, z, state.frame) > chance) continue;

      const count = 4 + Math.floor(Math.min(5, speed * 0.9 + slope * 3.0));
      const wx = (gx - s / 2) * cs;
      const wz = (gz - s / 2) * cs;
      const ground = this.sim.sampleWorldHeight(wx, wz);
      const sideX = -dir.z;
      const sideZ = dir.x;

      for (let n = 0; n < count && state.particles.length < state.maxParticles; n++) {
        const a = noise(x + n * 7, z, state.frame + 19) - 0.5;
        const b = noise(z + n * 11, x, state.frame + 47);
        const inherited = 2.7 + speed * 1.8;
        state.particles.push({
          x: wx + sideX * a * cs * 0.55 + dir.x * cs * 0.16,
          y: ground + 0.15 + b * (0.18 + slope * 0.14),
          z: wz + sideZ * a * cs * 0.55 + dir.z * cs * 0.16,
          vx: dir.x * inherited + sideX * a * (0.7 + speed * 0.35),
          vy: 0.45 + b * (0.9 + slope * 0.75),
          vz: dir.z * inherited + sideZ * a * (0.7 + speed * 0.35),
          age: 0,
          life: 0.36 + b * 0.34,
          size: 0.036 + b * 0.030
        });
      }
    }
  }
}

function addCrossing(out, ax, az, av, bx, bz, bv) {
  const aInside = av >= THRESHOLD;
  const bInside = bv >= THRESHOLD;
  if (aInside === bInside) return;
  const denom = bv - av;
  const t = Math.abs(denom) < 1e-6 ? 0.5 : (THRESHOLD - av) / denom;
  out.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t });
}

function averageSpeed(indices) {
  let total = 0;
  for (const i of indices) total += Math.hypot(this.sim.velX[i], this.sim.velZ[i]);
  return total / indices.length;
}

function downhillAt(gx, gz) {
  const x = Math.max(1, Math.min(this.sim.size - 2, Math.round(gx)));
  const z = Math.max(1, Math.min(this.sim.size - 2, Math.round(gz)));
  const left = this.sim.height[this.sim.index(x - 1, z)];
  const right = this.sim.height[this.sim.index(x + 1, z)];
  const up = this.sim.height[this.sim.index(x, z - 1)];
  const down = this.sim.height[this.sim.index(x, z + 1)];
  const dx = left - right;
  const dz = up - down;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

function localSlopeAt(gx, gz) {
  const x = Math.max(1, Math.min(this.sim.size - 2, Math.round(gx)));
  const z = Math.max(1, Math.min(this.sim.size - 2, Math.round(gz)));
  const left = this.sim.height[this.sim.index(x - 1, z)];
  const right = this.sim.height[this.sim.index(x + 1, z)];
  const up = this.sim.height[this.sim.index(x, z - 1)];
  const down = this.sim.height[this.sim.index(x, z + 1)];
  return Math.min(1, Math.hypot(left - right, up - down) / (this.sim.cellSize * 2.2));
}

function noise(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 69069) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
