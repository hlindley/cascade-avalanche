import { CascadeScene } from './scene.js';

const previousCreateBackdrop = CascadeScene.prototype.createBackdrop;
const previousCreateTrees = CascadeScene.prototype.createTrees;
const previousCreateTargets = CascadeScene.prototype.createTargets;
const previousUpdateTargets = CascadeScene.prototype.updateTargets;
const previousFinish = CascadeScene.prototype.finish;

const CLOUD_IMAGE = 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Dramatic_clouds_at_sunset.jpg?width=1280';

CascadeScene.prototype.createBackdrop = function createPhotographicSunsetBackdrop() {
  // Keep the original gradient dome as a loading/failure fallback, but retire its
  // procedural cloud primitives once the photographic cloud plate is installed.
  previousCreateBackdrop.call(this);
  for (let i = 0; i < 8; i++) this.scene.getMeshByName(`cloud${i}`)?.setEnabled(false);
  this.scene.getMeshByName('sunDisc')?.setEnabled(false);

  const plate = BABYLON.MeshBuilder.CreatePlane('sunsetCloudPhoto080', {
    width: 205,
    height: 116,
    sideOrientation: BABYLON.Mesh.DOUBLESIDE
  }, this.scene);
  plate.position.set(0, 42, 92);
  plate.rotation.y = Math.PI;
  plate.isPickable = false;
  plate.infiniteDistance = true;
  plate.renderingGroupId = 0;

  const material = new BABYLON.StandardMaterial('sunsetCloudPhotoMat080', this.scene);
  const texture = new BABYLON.Texture(CLOUD_IMAGE, this.scene, true, false, BABYLON.Texture.TRILINEAR_SAMPLINGMODE);
  texture.hasAlpha = false;
  material.emissiveTexture = texture;
  material.diffuseTexture = texture;
  material.disableLighting = true;
  material.backFaceCulling = false;
  material.emissiveColor = new BABYLON.Color3(0.92, 0.82, 0.82);
  plate.material = material;

  // Warm early-sunset illumination matching the cloud image.
  this.scene.clearColor = new BABYLON.Color4(0.43, 0.49, 0.66, 1);
  this.scene.fogColor = new BABYLON.Color3(0.57, 0.48, 0.56);
  this.scene.imageProcessingConfiguration.exposure = 1.18;
  this.scene.imageProcessingConfiguration.contrast = 1.04;
  this.sun.diffuse = new BABYLON.Color3(1.0, 0.67, 0.43);
  this.sun.intensity = 2.15;
  this.hemi.diffuse = new BABYLON.Color3(0.71, 0.76, 0.92);
  this.hemi.groundColor = new BABYLON.Color3(0.39, 0.29, 0.34);
};

CascadeScene.prototype.createTrees = function createColoradoAspenStands() {
  // Do not instantiate the older large conifers. Build many compact, deterministic
  // aspen stands using two thin-instance source meshes for mobile performance.
  this.treeMeshes = [];

  const trunk = BABYLON.MeshBuilder.CreateCylinder('aspenTrunkSource080', {
    height: 1,
    diameter: 0.10,
    tessellation: 6
  }, this.scene);
  const crown = BABYLON.MeshBuilder.CreateSphere('aspenCrownSource080', {
    diameter: 1,
    segments: 6
  }, this.scene);
  trunk.position.y = -1000;
  crown.position.y = -1000;
  trunk.isPickable = false;
  crown.isPickable = false;
  trunk.alwaysSelectAsActiveMesh = true;
  crown.alwaysSelectAsActiveMesh = true;

  const trunkMat = this.mat('aspenTrunkMat080', new BABYLON.Color3(0.72, 0.68, 0.61), 0.92);
  const crownMat = this.mat('aspenGoldMat080', new BABYLON.Color3(0.78, 0.45, 0.12), 0.96);
  crownMat.emissiveColor = new BABYLON.Color3(0.08, 0.035, 0.008);
  trunk.material = trunkMat;
  crown.material = crownMat;

  const trunkMatrices = [];
  const crownMatrices = [];
  const s = this.sim.size;
  const cs = this.sim.cellSize;
  const standCount = 18;

  for (let stand = 0; stand < standCount; stand++) {
    const angle = hash01(stand, 31, this.seed) * Math.PI * 2;
    const radius = 12 + hash01(stand, 47, this.seed) * 25;
    const centerX = Math.cos(angle) * radius + (hash01(stand, 59, this.seed) - 0.5) * 10;
    const centerZ = Math.sin(angle) * radius - 4 + (hash01(stand, 71, this.seed) - 0.5) * 12;
    const count = 18 + Math.floor(hash01(stand, 83, this.seed) * 18);
    const spreadX = 2.2 + hash01(stand, 97, this.seed) * 3.8;
    const spreadZ = 1.8 + hash01(stand, 109, this.seed) * 4.5;

    for (let n = 0; n < count; n++) {
      const theta = hash01(stand * 101 + n, 127, this.seed) * Math.PI * 2;
      const radial = Math.sqrt(hash01(stand * 131 + n, 139, this.seed));
      const x = centerX + Math.cos(theta) * radial * spreadX;
      const z = centerZ + Math.sin(theta) * radial * spreadZ;
      const gx = Math.round(x / cs + s / 2);
      const gz = Math.round(z / cs + s / 2);
      if (!this.sim.inBounds(gx, gz) || gx < 2 || gz < 2 || gx >= s - 2 || gz >= s - 2) continue;

      // Leave the central upper fall line comparatively open and reject cliff faces.
      if (Math.abs(x) < 4.5 && z > -7) continue;
      const slope = localSlope(this.sim, gx, gz);
      if (slope > 2.4) continue;

      const y = this.sim.sampleWorldHeight(x, z);
      const variation = hash01(stand * 149 + n, 151, this.seed);
      const height = 0.92 + variation * 0.48; // roughly one quarter of the old trees
      const crownWidth = 0.34 + variation * 0.16;
      const lean = (hash01(stand * 163 + n, 167, this.seed) - 0.5) * 0.08;
      const rotation = BABYLON.Quaternion.RotationYawPitchRoll(
        hash01(stand * 173 + n, 179, this.seed) * Math.PI * 2,
        lean,
        -lean * 0.6
      );

      const trunkMatrix = BABYLON.Matrix.Compose(
        new BABYLON.Vector3(1, height, 1),
        rotation,
        new BABYLON.Vector3(x, y + height * 0.50, z)
      );
      const crownMatrix = BABYLON.Matrix.Compose(
        new BABYLON.Vector3(crownWidth, height * 0.58, crownWidth),
        rotation,
        new BABYLON.Vector3(x, y + height * 1.08, z)
      );
      trunkMatrices.push(...trunkMatrix.toArray());
      crownMatrices.push(...crownMatrix.toArray());
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

  // The original physical collision remains authoritative. This supplemental pass
  // catches fast/thin snow represented by the newer contour field.
  for (const target of this.targets) {
    if (target.destroyed) continue;
    const gx = Math.round(target.x / this.sim.cellSize + this.sim.size / 2);
    const gz = Math.round(target.z / this.sim.cellSize + this.sim.size / 2);
    let physical = 0;
    let visible = 0;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!this.sim.inBounds(gx + dx, gz + dz)) continue;
        const i = this.sim.index(gx + dx, gz + dz);
        physical += this.sim.core[i] * 1.25 + this.sim.moving[i] * 0.65 + this.sim.deposit[i] * 0.12;
        visible += Math.max(0, (this.contourFlow?.field?.[i] || 0) - 0.028);
      }
    }
    if (physical > 1.35 || visible > 0.34) destroyTarget(this, target);
  }

  const hitCount = this.targets.filter(target => target.destroyed).length;
  this.housesHit = hitCount;
  this.gameScore = Math.round(this.damage + this.sim.totalReleased * 0.42 + hitCount * 650);
  updateGameplayHud(this);
};

CascadeScene.prototype.finish = function finishWithScore() {
  previousFinish.call(this);
  const score = Math.max(0, this.gameScore || 0);
  const resultScore = document.getElementById('resultScore080');
  if (resultScore) resultScore.textContent = `${score.toLocaleString()} POINTS · ${this.housesHit || 0}/${this.targets?.length || 0} HOUSES HIT`;
};

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
    const debris = BABYLON.MeshBuilder.CreateBox(`houseDebris080_${target.label}_${n}`, {
      size: 0.38 + hash01(target.value + n, 197, scene.seed) * 0.42
    }, scene.scene);
    debris.position.set(
      target.x + (hash01(target.value + n, 199, scene.seed) - 0.5) * 3.2,
      scene.sim.sampleWorldHeight(target.x, target.z) + 0.25 + hash01(target.value + n, 211, scene.seed) * 0.8,
      target.z + (hash01(target.value + n, 223, scene.seed) - 0.5) * 3.2
    );
    debris.rotation.set(
      hash01(target.value + n, 227, scene.seed) * Math.PI,
      hash01(target.value + n, 229, scene.seed) * Math.PI,
      hash01(target.value + n, 233, scene.seed) * Math.PI
    );
    debris.material = debrisMat;
    debris.isPickable = false;
  }
}

function installGameplayHud() {
  if (document.getElementById('gameHud080')) return;
  const hud = document.createElement('div');
  hud.id = 'gameHud080';
  hud.innerHTML = `
    <div class="scoreLabel080">SCORE</div>
    <strong id="scoreValue080">0</strong>
    <div class="gameStats080">
      <span>HOUSES <b id="housesValue080">0/0</b></span>
      <span>DAMAGE <b id="damageValue080">0</b></span>
    </div>`;
  document.body.appendChild(hud);

  const resultPanel = document.getElementById('resultPanel');
  if (resultPanel && !document.getElementById('resultScore080')) {
    const resultScore = document.createElement('div');
    resultScore.id = 'resultScore080';
    resultScore.textContent = '0 POINTS';
    resultPanel.insertBefore(resultScore, document.getElementById('retryButton'));
  }

  const style = document.createElement('style');
  style.textContent = `
    #gameHud080{position:fixed;z-index:4;right:clamp(18px,3vw,38px);top:clamp(18px,3vw,34px);width:min(196px,42vw);padding:14px 16px;border-radius:18px;color:#fff;background:rgba(40,38,55,.62);border:1px solid rgba(255,255,255,.22);backdrop-filter:blur(17px);box-shadow:0 16px 42px rgba(35,24,42,.22);pointer-events:none}
    .scoreLabel080{font-size:9px;letter-spacing:.22em;font-weight:900;opacity:.7}
    #scoreValue080{display:block;margin:3px 0 9px;font-size:clamp(25px,5vw,38px);line-height:1;font-variant-numeric:tabular-nums;color:#ffd27d}
    .gameStats080{display:grid;gap:5px;padding-top:9px;border-top:1px solid rgba(255,255,255,.14);font-size:9px;letter-spacing:.12em;font-weight:800}
    .gameStats080 span{display:flex;justify-content:space-between;gap:8px;opacity:.78}.gameStats080 b{opacity:1;color:#fff;font-variant-numeric:tabular-nums}
    #resultScore080{margin:-7px 0 15px;font-size:11px;letter-spacing:.12em;font-weight:900;color:#ffd27d}
    @media(max-width:600px){#gameHud080{top:18px;right:14px;width:142px;padding:11px 12px;border-radius:15px}#scoreValue080{font-size:25px}.gameStats080{font-size:8px}}
  `;
  document.head.appendChild(style);
}

function updateGameplayHud(scene) {
  const score = document.getElementById('scoreValue080');
  const houses = document.getElementById('housesValue080');
  const damage = document.getElementById('damageValue080');
  if (score) score.textContent = Math.max(0, scene.gameScore || 0).toLocaleString();
  if (houses) houses.textContent = `${scene.housesHit || 0}/${scene.targets?.length || 0}`;
  if (damage) damage.textContent = Math.max(0, scene.damage || 0).toLocaleString();
}

function localSlope(sim, x, z) {
  const left = sim.height[sim.index(x - 1, z)];
  const right = sim.height[sim.index(x + 1, z)];
  const up = sim.height[sim.index(x, z - 1)];
  const down = sim.height[sim.index(x, z + 1)];
  return Math.hypot(left - right, up - down);
}

function hash01(a, b, seed) {
  let h = (Math.imul((a + 1) | 0, 374761393) + Math.imul((b + 1) | 0, 668265263) + (seed | 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
