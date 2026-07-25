import { CascadeScene } from './scene.js';

const originalBuildScene = CascadeScene.prototype.buildScene;
const originalUpdateFlow = CascadeScene.prototype.updateFlow;

CascadeScene.prototype.buildScene = function buildSceneWithSoftDensityVFX() {
  originalBuildScene.call(this);

  // Keep individual grains as subtle texture, not the primary visible body.
  if (this.waveParticleMesh?.material) {
    this.waveParticleMesh.material.alpha = 0.18;
    this.waveParticleMesh.material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    this.waveParticleMesh.material.disableDepthWrite = true;
  }

  this.softDensityMesh = makeSoftSprite.call(this, 'softDensity062', 128, 0.62);
  this.softVeilMesh = makeSoftSprite.call(this, 'softVeil062', 128, 0.24);
};

CascadeScene.prototype.updateFlow = function updateFlowWithSoftDensityVFX() {
  originalUpdateFlow.call(this);

  const particles = this.particleWave?.particles || [];
  if (!this.softDensityMesh || !particles.length) {
    setInstances(this.softDensityMesh, []);
    setInstances(this.softVeilMesh, []);
    return;
  }

  const density = [];
  const veil = [];
  const time = performance.now() * 0.001;

  // Sample across the whole cohort using an irrational stride so particles from
  // neighboring simulation cells do not remain visually grouped together.
  const stride = Math.max(3, Math.floor(particles.length / 2600));
  let cursor = Math.floor((time * 173) % Math.max(1, particles.length));
  const seen = Math.min(3200, Math.ceil(particles.length / stride));

  for (let n = 0; n < seen; n++) {
    const i = (cursor + n * stride * 17) % particles.length;
    const p = particles[i];
    const speed = Math.hypot(p.vx || 0, p.vz || 0);
    const r1 = hash(i, 11);
    const r2 = hash(i, 29);
    const drift = Math.sin(time * (0.7 + r1 * 0.8) + r2 * 12.0);
    const angle = Math.atan2(p.vx || 0, p.vz || 1);
    const sideX = Math.cos(angle);
    const sideZ = -Math.sin(angle);

    const x = p.x + sideX * drift * (0.12 + r1 * 0.32);
    const z = p.z + sideZ * drift * (0.12 + r2 * 0.32);
    const y = p.y + 0.04 + r1 * 0.12;
    const width = 0.42 + r1 * 0.72 + Math.min(0.55, speed * 0.025);
    const height = width * (0.45 + r2 * 0.22);
    density.push(...composeBillboard(x, y, z, width, height, angle + (r2 - 0.5) * 0.7));

    if (n % 7 === 0) {
      const vw = 1.2 + r2 * 1.7 + Math.min(1.1, speed * 0.045);
      const vh = vw * (0.42 + r1 * 0.16);
      veil.push(...composeBillboard(
        x + sideX * (r2 - 0.5) * 0.9,
        y + 0.16 + r1 * 0.35,
        z + sideZ * (r1 - 0.5) * 0.9,
        vw,
        vh,
        angle + (r1 - 0.5) * 1.1
      ));
    }
  }

  setInstances(this.softDensityMesh, density);
  setInstances(this.softVeilMesh, veil);
};

function makeSoftSprite(name, size, alpha) {
  const mesh = BABYLON.MeshBuilder.CreatePlane(name, { size: 1 }, this.scene);
  mesh.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.renderingGroupId = 2;

  const texture = new BABYLON.DynamicTexture(`${name}Texture`, { width: size, height: size }, this.scene, false);
  const ctx = texture.getContext();
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.30, 'rgba(255,255,255,.92)');
  g.addColorStop(0.68, 'rgba(250,250,255,.36)');
  g.addColorStop(1, 'rgba(250,250,255,0)');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  texture.hasAlpha = true;
  texture.update();

  const mat = new BABYLON.StandardMaterial(`${name}Mat`, this.scene);
  mat.diffuseColor = new BABYLON.Color3(0.98, 0.99, 1);
  mat.emissiveColor = new BABYLON.Color3(0.32, 0.34, 0.38);
  mat.opacityTexture = texture;
  mat.diffuseTexture = texture;
  mat.useAlphaFromDiffuseTexture = true;
  mat.alpha = alpha;
  mat.disableLighting = false;
  mat.backFaceCulling = false;
  mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  mat.disableDepthWrite = true;
  mesh.material = mat;
  return mesh;
}

function composeBillboard(x, y, z, width, height, angle) {
  const scale = new BABYLON.Vector3(width, height, 1);
  const rotation = BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Z, angle);
  return BABYLON.Matrix.Compose(scale, rotation, new BABYLON.Vector3(x, y, z)).toArray();
}

function setInstances(mesh, matrices) {
  if (!mesh) return;
  mesh.thinInstanceSetBuffer('matrix', new Float32Array(matrices), 16, true);
}

function hash(i, salt) {
  let n = (i * 374761393 + salt * 668265263) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
