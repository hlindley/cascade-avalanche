import { CascadeScene } from './scene.js';

const previousBuildScene = CascadeScene.prototype.buildScene;
const previousUpdateFlow = CascadeScene.prototype.updateFlow;
const TRAIL_LEVEL = 0.038;

CascadeScene.prototype.buildScene = function buildSceneWithTrailMemory() {
  previousBuildScene.call(this);
  this.avalancheTrailMemory = new Float32Array(this.sim.size * this.sim.size);
  this.avalancheTrailFrozen = false;
};

CascadeScene.prototype.updateFlow = function updateFlowWithTrailMemory() {
  const trail = this.avalancheTrailMemory;
  if (trail && !this.avalancheTrailFrozen) {
    const active = this.sim.active;
    for (let i = 0; i < trail.length; i++) {
      const moving = this.sim.moving[i] + this.sim.core[i] * 0.45;
      const speed = Math.hypot(this.sim.velX[i], this.sim.velZ[i]);
      const passed = moving > 0.012 || (moving > 0.004 && speed > 0.22);

      if (passed || (this.contourFlow?.field?.[i] ?? 0) > 0.050) {
        trail[i] = Math.max(trail[i], TRAIL_LEVEL + Math.min(0.010, moving * 0.08));
      } else if (active) {
        trail[i] *= 0.9995;
      }
    }

    // Once physics settles, freeze the preserved route permanently. This keeps
    // the final contour from oscillating around its visibility threshold.
    if (!active && this.flowStarted) this.avalancheTrailFrozen = true;
  }

  // Trail memory is now consumed by the contour renderer before it builds the
  // mesh. Never mutate contour.field after rendering.
  previousUpdateFlow.call(this);
};
