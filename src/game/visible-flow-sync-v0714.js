import { CascadeScene } from './scene.js';

const previousUpdateFlow = CascadeScene.prototype.updateFlow;
const previousUpdateDirector = CascadeScene.prototype.updateDirector;

CascadeScene.prototype.updateFlow = function updateFlowWithVisibleSync() {
  previousUpdateFlow.call(this);

  // v0.7.14 already halved the visible mist lifetime once. Halve it once more
  // for v0.7.15 so contour spray flashes at the edge instead of lingering.
  if (this.contourMist?.particles) {
    for (const particle of this.contourMist.particles) {
      if (!particle.v0714LifeAdjusted) {
        particle.life *= 0.5;
        particle.v0714LifeAdjusted = true;
      }
      if (!particle.v0715LifeAdjusted) {
        particle.life *= 0.5;
        particle.v0715LifeAdjusted = true;
      }
    }
  }
};

CascadeScene.prototype.updateDirector = function updateDirectorWithVisibleSync(dt) {
  previousUpdateDirector.call(this, dt);

  if (!this.director?.active || this.director.phase !== 'flow') return;
  const visible = this.contourFlow?.visibleCenter;
  if (!visible || visible.weight <= 0) return;

  const target = new BABYLON.Vector3(
    visible.x,
    this.sim.sampleWorldHeight(visible.x, visible.z) + 3.2,
    visible.z
  );

  const k = 1 - Math.exp(-dt * 1.65);
  this.director.target = BABYLON.Vector3.Lerp(this.director.target, target, k);
  this.camera.target = BABYLON.Vector3.Lerp(this.camera.target, target, k);
};
