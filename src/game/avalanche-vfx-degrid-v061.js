import { CascadeScene } from './scene.js';

const previousAnimateFracture = CascadeScene.prototype.animateFracture;
const previousUpdateFlow = CascadeScene.prototype.updateFlow;

CascadeScene.prototype.animateFracture = function animateFractureWithDegriddedSlab(r) {
  previousAnimateFracture.call(this, r);
  const state = this.particleWave;
  if (!state?.particles?.length) return;

  const cs = this.sim.cellSize;
  for (let i = 0; i < state.particles.length; i++) {
    const p = state.particles[i];
    const a = hash(i, 17) * Math.PI * 2;
    const radius = Math.sqrt(hash(i, 23)) * cs * .72;
    p.x += Math.cos(a) * radius;
    p.z += Math.sin(a) * radius;
    p.y = this.sim.sampleWorldHeight(p.x, p.z) + .03 + (p.layer || 0);

    p.flowPhase = hash(i, 31) * Math.PI * 2;
    p.flowRate = 2.1 + hash(i, 37) * 4.2;
    p.driftStrength = .15 + hash(i, 41) * .42;
    p.speedBias = .84 + hash(i, 43) * .34;
    p.size *= .68 + hash(i, 47) * .72;
    p.lane = Math.floor(hash(i, 53) * 3);
  }
};

CascadeScene.prototype.updateFlow = function updateFlowWithoutGridBands() {
  const state = this.particleWave;
  if (state?.particles?.length && state.slabReleased) {
    const now = performance.now() * .001;
    const dt = Math.min(.04, Math.max(.006, now - (state.degridTime || now)));
    state.degridTime = now;

    for (let i = 0; i < state.particles.length; i++) {
      const p = state.particles[i];
      const gx = Math.round(p.x / this.sim.cellSize + this.sim.size / 2);
      const gz = Math.round(p.z / this.sim.cellSize + this.sim.size / 2);
      if (!this.sim.inBounds(gx, gz)) continue;

      const d = downhill.call(this, gx, gz);
      const sideX = -d.z;
      const sideZ = d.x;
      const phase = (p.flowPhase || 0) + now * (p.flowRate || 3);
      const drift = Math.sin(phase) * (p.driftStrength || .2);
      const noise = (hash(i, Math.floor(now * 7) + 71) - .5) * .11;
      p.vx += sideX * (drift + noise) * dt;
      p.vz += sideZ * (drift + noise) * dt;

      if (!p.degridSpeedApplied && Math.hypot(p.vx, p.vz) > .25) {
        p.vx *= p.speedBias || 1;
        p.vz *= p.speedBias || 1;
        p.degridSpeedApplied = true;
      }
    }
  }

  previousUpdateFlow.call(this);
};

function downhill(x, z) {
  x = Math.max(1, Math.min(this.sim.size - 2, Math.round(x)));
  z = Math.max(1, Math.min(this.sim.size - 2, Math.round(z)));
  const left = this.sim.height[this.sim.index(x - 1, z)];
  const right = this.sim.height[this.sim.index(x + 1, z)];
  const up = this.sim.height[this.sim.index(x, z - 1)];
  const down = this.sim.height[this.sim.index(x, z + 1)];
  const dx = left - right;
  const dz = up - down;
  const length = Math.hypot(dx, dz) || 1;
  return { x: dx / length, z: dz / length };
}

function hash(index, salt) {
  let h = (Math.imul(index + 1, 374761393) + Math.imul(salt + 1, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
