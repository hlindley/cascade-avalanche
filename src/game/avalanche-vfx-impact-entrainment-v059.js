import { CascadeScene } from './scene.js';

const originalBuildScene = CascadeScene.prototype.buildScene;
const originalUpdateFlow = CascadeScene.prototype.updateFlow;

CascadeScene.prototype.buildScene = function buildSceneWithImpactEntrainment() {
  originalBuildScene.call(this);
  this.impactVfx = {
    particles: [],
    maxParticles: 6500,
    lastTime: performance.now() * .001,
    frame: 0
  };
};

CascadeScene.prototype.updateFlow = function updateFlowWithImpactEntrainment() {
  originalUpdateFlow.call(this);

  const slab = this.particleWave;
  const impact = this.impactVfx;
  if (!slab?.particles || !impact) return;

  const now = performance.now() * .001;
  const dt = Math.min(.04, Math.max(.006, now - impact.lastTime));
  impact.lastTime = now;
  impact.frame++;

  // Sample the moving slab rather than every grain. Secondary particles appear
  // only where fast grains meet a terrain direction/curvature change.
  const step = Math.max(10, Math.floor(slab.particles.length / 1200));
  for (let i = impact.frame % step; i < slab.particles.length; i += step) {
    if (impact.particles.length >= impact.maxParticles) break;
    const p = slab.particles[i];
    const speed = Math.hypot(p.vx, p.vz);
    if (speed < 7.5) continue;

    const gx = Math.round(p.x / this.sim.cellSize + this.sim.size / 2);
    const gz = Math.round(p.z / this.sim.cellSize + this.sim.size / 2);
    if (!this.sim.inBounds(gx, gz)) continue;

    const dir = downhill.call(this, gx, gz);
    const vx = p.vx / speed, vz = p.vz / speed;
    const alignment = vx * dir.x + vz * dir.z;
    const curvature = terrainImpact.call(this, gx, gz, dir);
    const impactEnergy = Math.max(0, (1 - alignment) * 1.8 + curvature * 1.35) * Math.min(1.4, speed / 12);
    if (impactEnergy < .24) continue;

    const chance = Math.min(.7, impactEnergy * .42);
    if (noise(i, impact.frame, 17) > chance) continue;

    const count = 2 + Math.floor(Math.min(6, impactEnergy * 5));
    const sideX = -dir.z, sideZ = dir.x;
    for (let n = 0; n < count && impact.particles.length < impact.maxParticles; n++) {
      const a = noise(i, n, impact.frame + 31) - .5;
      const b = noise(n, i, impact.frame + 59);
      const inherited = .72 + b * .22;
      impact.particles.push({
        x: p.x + sideX * a * .24,
        y: p.y + .04 + b * .12,
        z: p.z + sideZ * a * .24,
        vx: p.vx * inherited + sideX * a * (2.2 + impactEnergy * 2.8),
        vy: .55 + b * (1.4 + impactEnergy * 2.1),
        vz: p.vz * inherited + sideZ * a * (2.2 + impactEnergy * 2.8),
        age: 0,
        life: .7 + b * 1.15,
        size: .009 + b * .014,
        seed: b * Math.PI * 2
      });
    }
  }

  const next = [];
  const matrices = [];
  for (const p of impact.particles) {
    p.age += dt;
    if (p.age >= p.life) continue;

    const gx = Math.round(p.x / this.sim.cellSize + this.sim.size / 2);
    const gz = Math.round(p.z / this.sim.cellSize + this.sim.size / 2);
    if (!this.sim.inBounds(gx, gz)) continue;

    const dir = downhill.call(this, gx, gz);
    const steer = Math.min(1, dt * 1.8);
    const speed = Math.hypot(p.vx, p.vz);
    p.vx += (dir.x * speed - p.vx) * steer;
    p.vz += (dir.z * speed - p.vz) * steer;
    p.vy -= 4.8 * dt;
    p.vx *= .994;
    p.vz *= .994;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;

    const ground = this.sim.sampleWorldHeight(p.x, p.z) + .025;
    if (p.y < ground) {
      p.y = ground;
      p.vy = Math.abs(p.vy) * .18;
      p.vx *= .92;
      p.vz *= .92;
    }

    pushImpact(matrices, p);
    next.push(p);
  }
  impact.particles = next;
  this.waveMistMesh.thinInstanceSetBuffer('matrix', new Float32Array(matrices), 16, true);
};

function terrainImpact(gx, gz, dir) {
  const cs = this.sim.cellSize;
  const x = (gx - this.sim.size / 2) * cs;
  const z = (gz - this.sim.size / 2) * cs;
  const h0 = this.sim.sampleWorldHeight(x, z);
  const h1 = this.sim.sampleWorldHeight(x + dir.x * cs, z + dir.z * cs);
  const h2 = this.sim.sampleWorldHeight(x + dir.x * cs * 2, z + dir.z * cs * 2);
  const drop1 = h0 - h1;
  const drop2 = h1 - h2;
  return Math.max(0, drop1 - drop2) / Math.max(.1, cs);
}

function downhill(gx, gz) {
  gx = Math.max(1, Math.min(this.sim.size - 2, gx));
  gz = Math.max(1, Math.min(this.sim.size - 2, gz));
  const left = this.sim.height[this.sim.index(gx - 1, gz)];
  const right = this.sim.height[this.sim.index(gx + 1, gz)];
  const up = this.sim.height[this.sim.index(gx, gz - 1)];
  const down = this.sim.height[this.sim.index(gx, gz + 1)];
  const dx = left - right, dz = up - down;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

function pushImpact(arr, p) {
  const speed = Math.hypot(p.vx, p.vz) || 1;
  const angle = Math.atan2(p.vx, p.vz);
  const fade = Math.max(.08, 1 - p.age / p.life);
  const matrix = BABYLON.Matrix.Compose(
    new BABYLON.Vector3(p.size * .75 * fade, p.size * .52 * fade, p.size * (3.4 + speed * .16) * fade),
    BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Y, angle),
    new BABYLON.Vector3(p.x, p.y, p.z)
  );
  arr.push(...matrix.toArray());
}

function noise(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 69069) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
