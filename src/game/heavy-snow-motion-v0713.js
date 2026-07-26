import { CascadeScene } from './scene.js';

const previousBuildScene = CascadeScene.prototype.buildScene;
const previousSetTuning = CascadeScene.prototype.setTuning;
const previousUpdateDirector = CascadeScene.prototype.updateDirector;

CascadeScene.prototype.buildScene = function buildSceneWithHeavySnowMotion() {
  this.tuning.speed = 0.58;
  this.tuning.friction = 1.16;
  this.tuning.lateralSpread = 0.72;
  this.tuning.momentum = 1.24;
  this.tuning.entrainment = 0.82;
  this.tuning.powder = 0.86;
  previousBuildScene.call(this);
};

CascadeScene.prototype.setTuning = function setTuningWithHeavySnowMotion(key, value) {
  previousSetTuning.call(this, key, value);
};

CascadeScene.prototype.updateDirector = function updateDirectorForHeavySnow(dt) {
  previousUpdateDirector.call(this, dt * 0.72);
};
