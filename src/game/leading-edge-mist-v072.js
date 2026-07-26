import { CascadeScene } from './scene.js';

const previousBuildScene = CascadeScene.prototype.buildScene;
const previousUpdateFlow = CascadeScene.prototype.updateFlow;
const TEMPLATE_SCALE = 1000;

CascadeScene.prototype.buildScene = function buildSceneWithLeadingEdgeMist() {
  previousBuildScene.call(this);

  this.leadingMist = {
    particles: [],
    maxParticles: 2600,
    lastTime: performance.now() * 0.001,
    frame: 0
  };

  // Use a microscopic source mesh so the non-instanced template is invisible.
  // Thin-instance matrices compensate with TEMPLATE_SCALE.
  const mesh = BABYLON.MeshBuilder.CreateIcoSphere('leadingEdgeMist072', {
    radius: 0.001,
    subdivisions: 0
  }, this.scene);
  const mat = new BABYLON.StandardMaterial('leadingEdgeMistMat072', this.scene);
  mat.diffuseColor = new BABYLON.Color3(1.0, 1.0, 1.0);
  mat.emissiveColor = new BABYLON.Color3(0.25, 0.27, 0.32);
  mat.alpha = 0.50;
  mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  mat.disableDepthWrite = true;
  mat.backFaceCulling = false;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.renderingGroupId = 2;
  this.leadingMistMesh = mesh;
};

CascadeScene.prototype.updateFlow = function updateFlowWithLeadingEdgeMist() {
  previousUpdateFlow.call(this);

  const state = this.leadingMist;
  const mesh = this.leadingMistMesh;
  if (!state || !mesh) return;

  const now = performance.now() * 0.001;
  const dt = Math.min(0.05, Math.max(0.006, now - state.lastTime));
  state.lastTime = now;
  state.frame++;

  emitLeadingEdgeMist.call(this, state);

  const next = [];
  const matrices = [];
  for (const p of state.particles) {
    p.age += dt;
    if (p.age >= p.life) continue;

    p.vy -= 3.0 * dt;
    p.vx *= 0.992;
    p.vz *= 0.992;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;

    const ground = this.sim.sampleWorldHeight(p.x, p.z) + 0.035;
    if (p.y < ground) {
      p.y = ground;
      p.vy = Math.abs(p.vy) * 0.10;
    }

    const fade = Math.max(0, 1 - p.age / p.life);
    const speed = Math.hypot(p.vx, p.vz);
    const angle = Math.atan2(p.vx, p.vz);
    const scale = new BABYLON.Vector3(
      p.size * (0.72 + fade * 0.34) * TEMPLATE_SCALE,
      p.size * 0.48 * TEMPLATE_SCALE,
      p.size * (1.9 + speed * 0.09) * Math.max(0.08, fade) * TEMPLATE_SCALE
    );
    const rotation = BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Y, angle);
    const matrix = BABYLON.Matrix.Compose(scale, rotation, new BABYLON.Vector3(p.x, p.y, p.z));
    matrices.push(...matrix.toArray());
    next.push(p);
  }

  state.particles = next;
  mesh.thinInstanceSetBuffer('matrix', new Float32Array(matrices), 16, true);
};

function emitLeadingEdgeMist(state) {
  if (!this.sim.active || state.particles.length >= state.maxParticles) return;

  const s = this.sim.size;
  const step = 2;
  for (let z = 2 + (state.frame % step); z < s - 2; z += step) {
    for (let x = 2; x < s - 2; x += step) {
      if (state.particles.length >= state.maxParticles) return;
      const i = this.sim.index(x, z);
      const mass = this.sim.moving[i];
      if (mass < 0.022) continue;

      const dir = downhill.call(this, x, z);
      const nx = Math.max(1, Math.min(s - 2, Math.round(x + dir.x)));
      const nz = Math.max(1, Math.min(s - 2, Math.round(z + dir.z)));
      const frontMass = this.sim.moving[this.sim.index(nx, nz)];
      const edgeStrength = mass - frontMass * 1.20;
      if (edgeStrength < 0.011) continue;

      const speed = Math.hypot(this.sim.velX[i], this.sim.velZ[i]);
      if (speed < 0.11) continue;

      const slope = localSlope.call(this, x, z);
      const chance = Math.min(0.78, 0.20 + edgeStrength * 0.82 + speed * 0.105 + slope * 0.13);
      if (noise(x, z, state.frame) > chance) continue;

      const count = 3 + Math.floor(Math.min(6, edgeStrength * 8 + speed * 1.35 + slope * 1.8));
      const world = this.sim.worldPosition(x, z);
      const sideX = -dir.z;
      const sideZ = dir.x;
      for (let n = 0; n < count && state.particles.length < state.maxParticles; n++) {
        const a = noise(x + n, z, state.frame + 17) - 0.5;
        const b = noise(z, x + n, state.frame + 43);
        const inherited = 4.35 + speed * 2.65;
        state.particles.push({
          x: world.x + sideX * a * this.sim.cellSize * 0.62,
          y: world.y + 0.08 + b * (0.12 + slope * 0.08),
          z: world.z + sideZ * a * this.sim.cellSize * 0.62,
          vx: dir.x * inherited + sideX * a * (0.95 + speed * 0.62),
          vy: 0.34 + b * (0.78 + slope * 0.52),
          vz: dir.z * inherited + sideZ * a * (0.95 + speed * 0.62),
          age: 0,
          life: 0.24 + b * 0.30,
          size: 0.018 + b * 0.016
        });
      }
    }
  }
}

function downhill(x, z) {
  const left = this.sim.height[this.sim.index(x - 1, z)];
  const right = this.sim.height[this.sim.index(x + 1, z)];
  const up = this.sim.height[this.sim.index(x, z - 1)];
  const down = this.sim.height[this.sim.index(x, z + 1)];
  const dx = left - right;
  const dz = up - down;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

function localSlope(x, z) {
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
