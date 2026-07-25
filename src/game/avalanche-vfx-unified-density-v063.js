import { CascadeScene } from './scene.js';

const originalBuildScene = CascadeScene.prototype.buildScene;
const originalUpdateFlow = CascadeScene.prototype.updateFlow;

CascadeScene.prototype.buildScene = function buildSceneWithUnifiedDensityVFX() {
  originalBuildScene.call(this);

  // Previous density layers remain available but are no longer rendered.
  if (this.softDensityMesh) this.softDensityMesh.setEnabled(false);
  if (this.softVeilMesh) this.softVeilMesh.setEnabled(false);
  if (this.waveParticleMesh?.material) this.waveParticleMesh.material.alpha = 0.055;

  this.unifiedDensityMesh = makeSprite.call(this, 'unifiedDensity063', 0.48);
  this.unifiedVeilMesh = makeSprite.call(this, 'unifiedVeil063', 0.16);
};

CascadeScene.prototype.updateFlow = function updateFlowWithUnifiedDensityVFX() {
  originalUpdateFlow.call(this);

  // Do not expose the impact cohort as a separate visible stream.
  if (this.waveMistMesh) setInstances(this.waveMistMesh, []);

  const primary = this.particleWave?.particles || [];
  const secondary = this.impactVfx?.particles || [];
  const all = primary.length ? primary.concat(secondary) : secondary;
  if (!all.length) {
    setInstances(this.unifiedDensityMesh, []);
    setInstances(this.unifiedVeilMesh, []);
    return;
  }

  const now = performance.now() * 0.001;
  const cell = 2.15;
  const ox = Math.sin(now * 0.19) * 0.31;
  const oz = Math.cos(now * 0.17) * 0.31;
  const bins = new Map();

  // Aggregate particles spatially, independent of their source simulation cell.
  // A drifting origin prevents the aggregate pattern from locking into rows.
  const stride = Math.max(1, Math.floor(all.length / 11000));
  for (let i = 0; i < all.length; i += stride) {
    const p = all[i];
    const bx = Math.floor((p.x + ox) / cell);
    const bz = Math.floor((p.z + oz) / cell);
    const key = `${bx}:${bz}`;
    let b = bins.get(key);
    if (!b) {
      b = { x: 0, y: 0, z: 0, vx: 0, vz: 0, n: 0, seed: hash(bx, bz) };
      bins.set(key, b);
    }
    b.x += p.x; b.y += p.y; b.z += p.z;
    b.vx += p.vx || 0; b.vz += p.vz || 0; b.n++;
  }

  const density = [];
  const veil = [];
  const ordered = [...bins.values()].filter(b => b.n >= 2);
  for (let i = 0; i < ordered.length; i++) {
    const b = ordered[i];
    const inv = 1 / b.n;
    const x = b.x * inv;
    const y = b.y * inv;
    const z = b.z * inv;
    const vx = b.vx * inv;
    const vz = b.vz * inv;
    const speed = Math.hypot(vx, vz);
    const angle = Math.atan2(vx, vz || 1);
    const mass = Math.min(1, b.n / 32);
    const wobble = Math.sin(now * (0.55 + b.seed * 0.45) + b.seed * 19);
    const sideX = Math.cos(angle), sideZ = -Math.sin(angle);
    const px = x + sideX * wobble * 0.24;
    const pz = z + sideZ * wobble * 0.24;
    const width = 1.25 + mass * 1.55 + Math.min(0.65, speed * 0.025);
    const height = 0.48 + mass * 0.62;
    density.push(...compose(px, y + 0.10, pz, width, height, angle + (b.seed - .5) * .42));

    // Broad veil patches overlap several aggregates and erase gaps/rows.
    if (i % 3 === 0 || b.n > 18) {
      const vw = width * (1.55 + b.seed * .45);
      const vh = height * (1.45 + (1 - b.seed) * .35);
      veil.push(...compose(
        px + sideX * (b.seed - .5) * .55,
        y + .24,
        pz + sideZ * (.5 - b.seed) * .55,
        vw, vh, angle + (b.seed - .5) * .75
      ));
    }
  }

  setInstances(this.unifiedDensityMesh, density);
  setInstances(this.unifiedVeilMesh, veil);
};

function makeSprite(name, alpha) {
  const mesh = BABYLON.MeshBuilder.CreatePlane(name, { size: 1 }, this.scene);
  mesh.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.renderingGroupId = 2;

  const size = 128;
  const texture = new BABYLON.DynamicTexture(`${name}Texture`, { width: size, height: size }, this.scene, false);
  const ctx = texture.getContext();
  const g = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,.92)');
  g.addColorStop(.28, 'rgba(255,255,255,.82)');
  g.addColorStop(.65, 'rgba(246,249,255,.25)');
  g.addColorStop(1, 'rgba(246,249,255,0)');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  texture.hasAlpha = true;
  texture.update();

  const mat = new BABYLON.StandardMaterial(`${name}Mat`, this.scene);
  mat.diffuseColor = new BABYLON.Color3(.98, .99, 1);
  mat.emissiveColor = new BABYLON.Color3(.22, .24, .28);
  mat.diffuseTexture = texture;
  mat.opacityTexture = texture;
  mat.useAlphaFromDiffuseTexture = true;
  mat.alpha = alpha;
  mat.backFaceCulling = false;
  mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  mat.disableDepthWrite = true;
  mesh.material = mat;
  return mesh;
}

function compose(x, y, z, width, height, angle) {
  return BABYLON.Matrix.Compose(
    new BABYLON.Vector3(width, height, 1),
    BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Z, angle),
    new BABYLON.Vector3(x, y, z)
  ).toArray();
}

function setInstances(mesh, matrices) {
  if (!mesh) return;
  mesh.thinInstanceSetBuffer('matrix', new Float32Array(matrices), 16, true);
}

function hash(a, b) {
  let n = (a * 374761393 + b * 668265263 + 69069) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
