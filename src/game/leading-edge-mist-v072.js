import { CascadeScene } from './scene.js';

const previousBuildScene = CascadeScene.prototype.buildScene;
const previousUpdateFlow = CascadeScene.prototype.updateFlow;

CascadeScene.prototype.buildScene = function buildSceneWithLeadingEdgeMist() {
  previousBuildScene.call(this);

  this.leadingMist = {
    particles: [],
    maxParticles: 5200,
    lastTime: performance.now() * 0.001,
    frame: 0
  };

  const mesh = BABYLON.MeshBuilder.CreateIcoSphere('leadingEdgeMist072', {
    radius: 1,
    subdivisions: 0
  }, this.scene);
  const mat = new BABYLON.StandardMaterial('leadingEdgeMistMat072', this.scene);
  mat.diffuseColor = new BABYLON.Color3(1.0, 1.0, 1.0);
  mat.emissiveColor = new BABYLON.Color3(0.34, 0.36, 0.42);
  mat.alpha = 0.68;
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

    p.vy -= 2.25 * dt;
    p.vx *= 0.994;
    p.vz *= 0.994;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;

    const ground = this.sim.sampleWorldHeight(p.x, p.z) + 0.045;
    if (p.y < ground) {
      p.y = ground;
      p.vy = Math.abs(p.vy) * 0.16;
    }

    const fade = Math.max(0, 1 - p.age / p.life);
    const speed = Math.hypot(p.vx, p.vz);
    const angle = Math.atan2(p.vx, p.vz);
    const scale = new BABYLON.Vector3(
      p.size * (0.9 + fade * 0.65),
      p.size * (0.72 + fade * 0.38),
      p.size * (2.6 + speed * 0.15) * Math.max(0.28, fade)
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
  for (let z = 2; z < s - 2; z++) {
    for (let x = 2; x < s - 2; x++) {
      if (state.particles.length >= state.maxParticles) return;
      const i = this.sim.index(x, z);
      const mass = this.sim.moving[i];
      if (mass < 0.018) continue;

      const dir = downhill.call(this, x, z);
      const nx = Math.max(1, Math.min(s - 2, Math.round(x + dir.x)));
      const nz = Math.max(1, Math.min(s - 2, Math.round(z + dir.z)));
      const frontMass = this.sim.moving[this.sim.index(nx, nz)];
      const edgeStrength = mass - frontMass * 1.12;
      if (edgeStrength < 0.008) continue;

      const speed = Math.hypot(this.sim.velX[i], this.sim.velZ[i]);
      if (speed < 0.09) continue;

      const slope = localSlope.call(this, x, z);
      const chance = Math.min(0.96, 0.28 + edgeStrength * 1.1 + speed * 0.14 + slope * 0.22);
      if (noise(x, z, state.frame) > chance) continue;

      const count = 5 + Math.floor(Math.min(13, edgeStrength * 14 + speed * 2.4 + slope * 4));
      const world = this.sim.worldPosition(x, z);
      const sideX = -dir.z;
      const sideZ = dir.x;
      for (let n = 0; n < count && state.particles.length < state.maxParticles; n++) {
        const a = noise(x + n, z, state.frame + 17) - 0.5;
        const b = noise(z, x + n, state.frame + 43);
        const inherited = 4.8 + speed * 3.2;
        state.particles.push({
          x: world.x + sideX * a * this.sim.cellSize * 0.95,
          y: world.y + 0.12 + b * (0.25 + slope * 0.2),
          z: world.z + sideZ * a * this.sim.cellSize * 0.95,
          vx: dir.x * inherited + sideX * a * (1.8 + speed * 1.2),
          vy: 0.8 + b * (1.5 + slope * 1.4),
          vz: dir.z * inherited + sideZ * a * (1.8 + speed * 1.2),
          age: 0,
          life: 0.5 + b * 0.65,
          size: 0.032 + b * 0.035
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
