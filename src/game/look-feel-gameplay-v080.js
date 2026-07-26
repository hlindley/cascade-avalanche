import { CascadeScene } from './scene.js';

const previousCreateBackdrop = CascadeScene.prototype.createBackdrop;
const previousCreateTrees = CascadeScene.prototype.createTrees;
const previousCreateTargets = CascadeScene.prototype.createTargets;
const previousUpdateTargets = CascadeScene.prototype.updateTargets;
const previousFinish = CascadeScene.prototype.finish;

const CLOUD_IMAGE = 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Dramatic_clouds_at_sunset.jpg?width=1600';
const TEMPLATE_SCALE = 1000;

CascadeScene.prototype.createBackdrop = function createSafeSunsetBackdrop() {
  previousCreateBackdrop.call(this);

  // Keep the native gradient dome as a guaranteed fallback, but remove the old
  // procedural cloud blobs and sun disc. The photograph is a DOM layer behind
  // the WebGL canvas, so a failed image request can never become scene geometry.
  for (let i = 0; i < 8; i++) this.scene.getMeshByName(`cloud${i}`)?.setEnabled(false);
  this.scene.getMeshByName('sunDisc')?.setEnabled(false);
  installSunsetDomBackdrop();

  this.scene.clearColor = new BABYLON.Color4(0.43, 0.49, 0.66, 0);
  this.scene.fogColor = new BABYLON.Color3(0.57, 0.48, 0.56);
  this.scene.imageProcessingConfiguration.exposure = 1.18;
  this.scene.imageProcessingConfiguration.contrast = 1.04;
  this.sun.diffuse = new BABYLON.Color3(1.0, 0.67, 0.43);
  this.sun.intensity = 2.15;
  this.hemi.diffuse = new BABYLON.Color3(0.71, 0.76, 0.92);
  this.hemi.groundColor = new BABYLON.Color3(0.39, 0.29, 0.34);
};

CascadeScene.prototype.createTrees = function createColoradoAspenStands() {
  this.treeMeshes = [];

  // Microscopic source meshes stay at the origin; matrices scale them up.
  // This avoids the previous -1000 Y offset being inherited by every instance.
  const trunk = BABYLON.MeshBuilder.CreateCylinder('aspenTrunkSource080', {
    height: 0.001,
    diameter: 0.00010,
    tessellation: 6
  }, this.scene);
  const crown = BABYLON.MeshBuilder.CreateSphere('aspenCrownSource080', {
    diameter: 0.001,
    segments: 6
  }, this.scene);
  trunk.isPickable = false;
  crown.isPickable = false;
  trunk.alwaysSelectAsActiveMesh = true;
  crown.alwaysSelectAsActiveMesh = true;

  const trunkMat = this.mat('aspenTrunkMat080', new BABYLON.Color3(0.76, 0.72, 0.65), 0.92);
  const crownMat = this.mat('aspenGoldMat080', new BABYLON.Color3(0.79, 0.47, 0.13), 0.96);
  crownMat.emissiveColor = new BABYLON.Color3(0.09, 0.04, 0.008);
  trunk.material = trunkMat;
  crown.material = crownMat;

  const trunkMatrices = [];
  const crownMatrices = [];
  const s = this.sim.size;
  const cs = this.sim.cellSize;
  const standCount = 24;

  for (let stand = 0; stand < standCount; stand++) {
    const angle = hash01(stand, 31, this.seed) * Math.PI * 2;
    const radius = 10 + hash01(stand, 47, this.seed) * 29;
    const centerX = Math.cos(angle) * radius + (hash01(stand, 59, this.seed) - 0.5) * 11;
    const centerZ = Math.sin(angle) * radius - 5 + (hash01(stand, 71, this.seed) - 0.5) * 13;
    const count = 24 + Math.floor(hash01(stand, 83, this.seed) * 23);
    const spreadX = 2.3 + hash01(stand, 97, this.seed) * 4.2;
    const spreadZ = 1.8 + hash01(stand, 109, this.seed) * 5.2;

    for (let n = 0; n < count; n++) {
      const theta = hash01(stand * 101 + n, 127, this.seed) * Math.PI * 2;
      const radial = Math.sqrt(hash01(stand * 131 + n, 139, this.seed));
      const x = centerX + Math.cos(theta) * radial * spreadX;
      const z = centerZ + Math.sin(theta) * radial * spreadZ;
      const gx = Math.round(x / cs + s / 2);
      const gz = Math.round(z / cs + s / 2);
      if (!this.sim.inBounds(gx, gz) || gx < 2 || gz < 2 || gx >= s - 2 || gz >= s - 2) continue;
      if (Math.abs(x) < 4.3 && z > -8) continue;
      if (localSlope(this.sim, gx, gz) > 2.35) continue;

      const y = this.sim.sampleWorldHeight(x, z);
      const variation = hash01(stand * 149 + n, 151, this.seed);
      const height = 0.92 + variation * 0.48;
      const crownWidth = 0.34 + variation * 0.16;
      const lean = (hash01(stand * 163 + n, 167, this.seed) - 0.5) * 0.08;
      const rotation = BABYLON.Quaternion.RotationYawPitchRoll(
        hash01(stand * 173 + n, 179, this.seed) * Math.PI * 2,
        lean,
        -lean * 0.6
      );

      trunkMatrices.push(...BABYLON.Matrix.Compose(
        new BABYLON.Vector3(TEMPLATE_SCALE, height * TEMPLATE_SCALE, TEMPLATE_SCALE),
        rotation,
        new BABYLON.Vector3(x, y + height * 0.50, z)
      ).toArray());
      crownMatrices.push(...BABYLON.Matrix.Compose(
        new BABYLON.Vector3(crownWidth * TEMPLATE_SCALE, height * 0.58 * TEMPLATE_SCALE, crownWidth * TEMPLATE_SCALE),
        rotation,
        new BABYLON.Vector3(x, y + height * 1.08, z)
      ).toArray());
    }
  }

  trunk.thinInstanceSetBuffer('matrix', new Float32Array(trunkMatrices), 16, true);
  crown.thinInstanceSetBuffer('matrix', new Float32Array(crownMatrices), 16, true);
  this.treeMeshes.push(trunk, crown);
};

CascadeScene.prototype.createTargets = function createTargetsWithGameplayState() {
  previousCreateTargets.call(this);
  this.housesHit = 0;
  this.gameScore = 0;
  installGameplayHud();
  updateGameplayHud(this);
};

CascadeScene.prototype.updateTargets = function updateTargetsWithVisibleCollision() {
  previousUpdateTargets.call(this);
  for (const target of this.targets) {
    if (target.destroyed) continue;
    const gx = Math.round(target.x / this.sim.cellSize + this.sim.size / 2);
    const gz = Math.round(target.z / this.sim.cellSize + this.sim.size / 2);
    let physical = 0;
    let visible = 0;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      if (!this.sim.inBounds(gx + dx, gz + dz)) continue;
      const i = this.sim.index(gx + dx, gz + dz);
      physical += this.sim.core[i] * 1.25 + this.sim.moving[i] * 0.65 + this.sim.deposit[i] * 0.12;
      visible += Math.max(0, (this.contourFlow?.field?.[i] || 0) - 0.028);
    }
    if (physical > 1.35 || visible > 0.34) destroyTarget(this, target);
  }
  this.housesHit = this.targets.filter(target => target.destroyed).length;
  this.gameScore = Math.round(this.damage + this.sim.totalReleased * 0.42 + this.housesHit * 650);
  updateGameplayHud(this);
};

CascadeScene.prototype.finish = function finishWithScore() {
  previousFinish.call(this);
  const score = Math.max(0, this.gameScore || 0);
  const resultScore = document.getElementById('resultScore080');
  if (resultScore) resultScore.textContent = `${score.toLocaleString()} POINTS · ${this.housesHit || 0}/${this.targets?.length || 0} HOUSES HIT`;
};

function installSunsetDomBackdrop() {
  if (document.getElementById('sunsetBackdrop080')) return;
  const wrap = document.createElement('div');
  wrap.id = 'sunsetBackdrop080';
  const img = document.createElement('img');
  img.alt = '';
  img.src = CLOUD_IMAGE;
  img.addEventListener('error', () => wrap.classList.add('failed'), { once: true });
  wrap.appendChild(img);
  document.body.prepend(wrap);
  const style = document.createElement('style');
  style.textContent = `
    #sunsetBackdrop080{position:fixed;inset:0;z-index:-2;overflow:hidden;background:linear-gradient(#5f79a3 0%,#d69a99 64%,#f4bc83 100%)}
    #sunsetBackdrop080 img{width:100%;height:100%;object-fit:cover;object-position:50% 35%;filter:saturate(.92) brightness(1.04);opacity:.94}
    #sunsetBackdrop080.failed img{display:none}
    #renderCanvas{background:transparent!important}
  `;
  document.head.appendChild(style);
}

function destroyTarget(scene, target) {
  if (target.destroyed) return;
  target.destroyed = true;
  scene.damage += target.value;
  target.mesh.rotation.z = 0.82 + hash01(target.value, 191, scene.seed) * 0.35;
  target.mesh.rotation.x = (hash01(target.value, 193, scene.seed) - 0.5) * 0.35;
  target.mesh.position.y -= 0.65;
  target.mesh.scaling.y = 0.48;
  const debrisMat = target.mesh.material;
  for (let n = 0; n < 5; n++) {
    const debris = BABYLON.MeshBuilder.CreateBox(`houseDebris080_${target.label}_${n}`, { size: 0.38 + hash01(target.value + n, 197, scene.seed) * 0.42 }, scene.scene);
    debris.position.set(target.x + (hash01(target.value + n, 199, scene.seed) - 0.5) * 3.2, scene.sim.sampleWorldHeight(target.x, target.z) + 0.25 + hash01(target.value + n, 211, scene.seed) * 0.8, target.z + (hash01(target.value + n, 223, scene.seed) - 0.5) * 3.2);
    debris.rotation.set(hash01(target.value + n, 227, scene.seed) * Math.PI, hash01(target.value + n, 229, scene.seed) * Math.PI, hash01(target.value + n, 233, scene.seed) * Math.PI);
    debris.material = debrisMat;
    debris.isPickable = false;
  }
}

function installGameplayHud() {
  if (document.getElementById('gameHud080')) return;
  const hud = document.createElement('div');
  hud.id = 'gameHud080';
  hud.innerHTML = `<div class="scoreLabel080">SCORE</div><strong id="scoreValue080">0</strong><div class="gameStats080"><span>HOUSES <b id="housesValue080">0/0</b></span><span>DAMAGE <b id="damageValue080">0</b></span></div>`;
  document.body.appendChild(hud);
  const resultPanel = document.getElementById('resultPanel');
  if (resultPanel && !document.getElementById('resultScore080')) {
    const resultScore = document.createElement('div');
    resultScore.id = 'resultScore080';
    resultScore.textContent = '0 POINTS';
    resultPanel.insertBefore(resultScore, document.getElementById('retryButton'));
  }
  const style = document.createElement('style');
  style.textContent = `#gameHud080{position:fixed;z-index:4;right:clamp(18px,3vw,38px);top:clamp(18px,3vw,34px);width:min(196px,42vw);padding:14px 16px;border-radius:18px;color:#fff;background:rgba(40,38,55,.62);border:1px solid rgba(255,255,255,.22);backdrop-filter:blur(17px);box-shadow:0 16px 42px rgba(35,24,42,.22);pointer-events:none}.scoreLabel080{font-size:9px;letter-spacing:.22em;font-weight:900;opacity:.7}#scoreValue080{display:block;margin:3px 0 9px;font-size:clamp(25px,5vw,38px);line-height:1;font-variant-numeric:tabular-nums;color:#ffd27d}.gameStats080{display:grid;gap:5px;padding-top:9px;border-top:1px solid rgba(255,255,255,.14);font-size:9px;letter-spacing:.12em;font-weight:800}.gameStats080 span{display:flex;justify-content:space-between;gap:8px;opacity:.78}.gameStats080 b{opacity:1;color:#fff;font-variant-numeric:tabular-nums}#resultScore080{margin:-7px 0 15px;font-size:11px;letter-spacing:.12em;font-weight:900;color:#ffd27d}@media(max-width:600px){#gameHud080{top:18px;right:14px;width:142px;padding:11px 12px;border-radius:15px}#scoreValue080{font-size:25px}.gameStats080{font-size:8px}}`;
  document.head.appendChild(style);
}

function updateGameplayHud(scene) {
  const score = document.getElementById('scoreValue080');
  const houses = document.getElementById('housesValue080');
  const damage = document.getElementById('damageValue080');
  if (score) score.textContent = Math.max(0, scene.gameScore || 0).toLocaleString();
  if (houses) houses.textContent = `${scene.housesHit || 0}/${scene.targets?.length || 0}`;
  if (damage) damage.textContent = Math.round(scene.damage || 0).toLocaleString();
}

function localSlope(sim, x, z) {
  const left = sim.height[sim.index(x - 1, z)];
  const right = sim.height[sim.index(x + 1, z)];
  const up = sim.height[sim.index(x, z - 1)];
  const down = sim.height[sim.index(x, z + 1)];
  return Math.hypot(left - right, up - down) / Math.max(0.001, sim.cellSize * 2);
}

function hash01(a, b, seed) {
  let h = (Math.imul((a + 1) | 0, 374761393) + Math.imul((b + 1) | 0, 668265263) + Math.imul((seed + 1) | 0, 69069)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
