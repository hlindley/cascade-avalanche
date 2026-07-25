import { CascadeScene } from './scene.js';

const originalUpdateFlow = CascadeScene.prototype.updateFlow;
const originalUpdateDirector = CascadeScene.prototype.updateDirector;

CascadeScene.prototype.updateFlow = function updateFlowWithCohortSync() {
  originalUpdateFlow.call(this);

  const state = this.particleWave;
  if (!state?.particles?.length) return;

  const now = performance.now() * .001;
  if (!state.syncStartedAt) state.syncStartedAt = now;
  const elapsed = now - state.syncStartedAt;

  let cx = 0, cy = 0, cz = 0, weight = 0;
  let lead = null;

  for (const p of state.particles) {
    if (!p.syncBoosted) {
      p.vx *= 1.9;
      p.vz *= 1.9;
      p.syncBoosted = true;
    }

    // Strong early acceleration so the visible cohort catches the simulation timing.
    if (elapsed < 2.2) {
      const gx = Math.round(p.x / this.sim.cellSize + this.sim.size / 2);
      const gz = Math.round(p.z / this.sim.cellSize + this.sim.size / 2);
      if (this.sim.inBounds(gx, gz)) {
        const d = downhill.call(this, gx, gz);
        const lane = p.lane === 0 ? 18.5 : p.lane === 1 ? 15.5 : 12.8;
        const speed = Math.hypot(p.vx, p.vz) || 1;
        const blend = elapsed < .65 ? .22 : .11;
        p.vx += (d.x * Math.max(lane, speed) - p.vx) * blend;
        p.vz += (d.z * Math.max(lane, speed) - p.vz) * blend;
      }
    }

    const speed = Math.hypot(p.vx, p.vz);
    const w = .4 + Math.min(2.2, speed * .08);
    cx += p.x * w;
    cy += p.y * w;
    cz += p.z * w;
    weight += w;

    // Leading edge is the particle furthest downhill relative to local terrain height.
    if (!lead || p.y < lead.y) lead = p;
  }

  if (weight > 0) {
    state.cameraCenter = new BABYLON.Vector3(cx / weight, cy / weight, cz / weight);
    state.cameraLead = lead ? new BABYLON.Vector3(lead.x, lead.y, lead.z) : state.cameraCenter.clone();
  }
};

CascadeScene.prototype.updateDirector = function updateDirectorWithParticleTracking(dt) {
  const state = this.particleWave;
  if (!this.director.active || this.director.phase !== 'flow' || !state?.cameraCenter) {
    originalUpdateDirector.call(this, dt);
    return;
  }

  const center = state.cameraCenter;
  const lead = state.cameraLead || center;
  const target = BABYLON.Vector3.Lerp(center, lead, .22);
  target.y = this.sim.sampleWorldHeight(target.x, target.z) + 3.2;

  const spread = estimateSpread(state.particles, center);
  const radius = clamp(54 + spread * .9, 54, 86);
  const alpha = -Math.PI / 2 + clamp(target.x / 75, -.16, .16);
  const beta = .98;
  const k = 1 - Math.exp(-dt * 3.2);

  this.director.target = target;
  this.camera.target = BABYLON.Vector3.Lerp(this.camera.target, target, k);
  this.camera.radius += (radius - this.camera.radius) * k;
  this.camera.beta += (beta - this.camera.beta) * k;
  this.camera.alpha += (alpha - this.camera.alpha) * k;
};

function estimateSpread(particles, center) {
  if (!particles.length) return 0;
  let sum = 0;
  const step = Math.max(1, Math.floor(particles.length / 180));
  let count = 0;
  for (let i = 0; i < particles.length; i += step) {
    const p = particles[i];
    sum += Math.hypot(p.x - center.x, p.z - center.z);
    count++;
  }
  return count ? sum / count : 0;
}

function downhill(x, z) {
  x = Math.max(1, Math.min(this.sim.size - 2, Math.round(x)));
  z = Math.max(1, Math.min(this.sim.size - 2, Math.round(z)));
  const left = this.sim.height[this.sim.index(x - 1, z)];
  const right = this.sim.height[this.sim.index(x + 1, z)];
  const up = this.sim.height[this.sim.index(x, z - 1)];
  const down = this.sim.height[this.sim.index(x, z + 1)];
  const dx = left - right, dz = up - down;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
