import { CascadeScene } from './scene.js';

const previousCreateBackdrop = CascadeScene.prototype.createBackdrop;

CascadeScene.prototype.createBackdrop = function createThreeDimensionalSunsetSky() {
  previousCreateBackdrop.call(this);

  // Remove the unreliable remote DOM photograph installed by v0.8.1.
  document.getElementById('sunsetBackdrop080')?.remove();
  document.querySelectorAll('style').forEach(style => {
    if (style.textContent?.includes('#sunsetBackdrop080')) style.remove();
  });

  // Return the canvas and Babylon scene to an opaque, self-contained sky.
  this.scene.clearColor = new BABYLON.Color4(0.26, 0.34, 0.52, 1);
  this.scene.fogColor = new BABYLON.Color3(0.53, 0.43, 0.52);
  this.scene.fogDensity = 0.0025;
  this.scene.imageProcessingConfiguration.exposure = 1.16;
  this.scene.imageProcessingConfiguration.contrast = 1.04;

  const sky = this.scene.getMeshByName('sunsetSky');
  if (sky) {
    sky.setEnabled(true);
    sky.infiniteDistance = true;
  }

  const sunDisc = this.scene.getMeshByName('sunDisc');
  if (sunDisc) {
    sunDisc.setEnabled(true);
    sunDisc.position.set(56, 24, 72);
    sunDisc.scaling.setAll(1.15);
  }

  // Restore and reshape the original cloud volumes into layered sunset banks.
  const cloudPalette = [
    new BABYLON.Color3(0.92, 0.70, 0.69),
    new BABYLON.Color3(0.95, 0.76, 0.66),
    new BABYLON.Color3(0.73, 0.66, 0.80)
  ];
  for (let i = 0; i < 8; i++) {
    const cloud = this.scene.getMeshByName(`cloud${i}`);
    if (!cloud) continue;
    cloud.setEnabled(true);
    cloud.infiniteDistance = true;
    cloud.renderingGroupId = 0;
    const material = cloud.material;
    if (material) {
      material.alpha = 0.30 + (i % 3) * 0.045;
      material.emissiveColor = cloudPalette[i % cloudPalette.length];
      material.disableLighting = true;
      material.backFaceCulling = false;
    }
  }

  // Add smaller lobes around the original five clouds for a richer but inexpensive
  // 3D cloudscape. These inherit the same infinite-distance behavior.
  const cloudMaterial = this.scene.getMaterialByName('cloudMat');
  const banks = [
    [-68, 55, 110, 19, 4.0, 10], [-50, 47, 94, 14, 3.1, 8],
    [-20, 62, 124, 17, 3.3, 9], [6, 57, 116, 20, 4.2, 11],
    [34, 49, 101, 17, 3.4, 9], [58, 57, 122, 21, 4.5, 12],
    [82, 45, 96, 16, 3.2, 9], [12, 74, 151, 29, 3.0, 12]
  ];
  for (let i = 0; i < banks.length; i++) {
    if (this.scene.getMeshByName(`sunsetCloudBank082_${i}`)) continue;
    const [x, y, z, sx, sy, sz] = banks[i];
    const cloud = BABYLON.MeshBuilder.CreateSphere(`sunsetCloudBank082_${i}`, {
      diameter: 2,
      segments: 10
    }, this.scene);
    cloud.position.set(x, y, z);
    cloud.scaling.set(sx, sy, sz);
    cloud.material = cloudMaterial;
    cloud.isPickable = false;
    cloud.infiniteDistance = true;
    cloud.renderingGroupId = 0;
  }

  this.sun.diffuse = new BABYLON.Color3(1.0, 0.69, 0.46);
  this.sun.intensity = 2.08;
  this.hemi.diffuse = new BABYLON.Color3(0.69, 0.75, 0.93);
  this.hemi.groundColor = new BABYLON.Color3(0.38, 0.28, 0.35);
};
