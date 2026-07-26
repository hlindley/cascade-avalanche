import { CascadeScene } from './scene.js';

const previousBuildScene = CascadeScene.prototype.buildScene;
const previousUpdateFlow = CascadeScene.prototype.updateFlow;
const TRAIL_LEVEL = 0.038;

CascadeScene.prototype.buildScene = function buildSceneWithTrailMemory() {
  previousBuildScene.call(this);
  this.avalancheTrailMemory = new Float32Array(this.sim.size * this.sim.size);
};

CascadeScene.prototype.updateFlow = function updateFlowWithTrailMemory() {
  previousUpdateFlow.call(this);

  const contour = this.contourFlow;
  const trail = this.avalancheTrailMemory;
  if (!contour || !trail) return;

  const active = this.sim.active;
  for (let i = 0; i < trail.length; i++) {
    const moving = this.sim.moving[i] + this.sim.core[i] * 0.45;
    const speed = Math.hypot(this.sim.velX[i], this.sim.velZ[i]);

    // Record meaningful passage, including fast shallow flow on steep sections.
    const passed = moving > 0.012 || (moving > 0.004 && speed > 0.22);
    if (passed || contour.field[i] > 0.050) {
      trail[i] = Math.max(trail[i], TRAIL_LEVEL + Math.min(0.010, moving * 0.08));
    } else if (active) {
      // Very slow fade while the run is active; once settled, preserve the route.
      trail[i] *= 0.9995;
    }

    if (trail[i] > contour.field[i]) contour.field[i] = trail[i];
  }
};
