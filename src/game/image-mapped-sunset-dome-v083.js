import { CascadeScene } from './scene.js';

const previousCreateBackdrop = CascadeScene.prototype.createBackdrop;

// Embedded SVG image map: no CORS, network, or deployment dependency.
const SKY_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7598cf"/>
      <stop offset="0.42" stop-color="#a99ac2"/>
      <stop offset="0.72" stop-color="#e3a18f"/>
      <stop offset="1" stop-color="#ffc17a"/>
    </linearGradient>
    <radialGradient id="sun" cx="72%" cy="67%" r="34%">
      <stop offset="0" stop-color="#fff2c8" stop-opacity="0.95"/>
      <stop offset="0.16" stop-color="#ffd18c" stop-opacity="0.72"/>
      <stop offset="0.48" stop-color="#f19a79" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#f19a79" stop-opacity="0"/>
    </radialGradient>
    <filter id="blur24"><feGaussianBlur stdDeviation="24"/></filter>
    <filter id="blur12"><feGaussianBlur stdDeviation="12"/></filter>
    <linearGradient id="cloudWarm" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffe0bb"/>
      <stop offset="0.42" stop-color="#e99d91"/>
      <stop offset="1" stop-color="#74627f"/>
    </linearGradient>
    <linearGradient id="cloudCool" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#d7c8dd"/>
      <stop offset="0.55" stop-color="#9a839f"/>
      <stop offset="1" stop-color="#63576f"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="900" fill="url(#sky)"/>
  <rect width="1600" height="900" fill="url(#sun)"/>
  <g filter="url(#blur24)" opacity="0.88" fill="url(#cloudCool)">
    <ellipse cx="250" cy="260" rx="310" ry="78"/>
    <ellipse cx="530" cy="215" rx="250" ry="95"/>
    <ellipse cx="880" cy="285" rx="340" ry="105"/>
    <ellipse cx="1320" cy="205" rx="360" ry="98"/>
  </g>
  <g filter="url(#blur12)" opacity="0.94" fill="url(#cloudWarm)">
    <ellipse cx="130" cy="430" rx="230" ry="76"/>
    <ellipse cx="320" cy="395" rx="180" ry="110"/>
    <ellipse cx="520" cy="455" rx="290" ry="92"/>
    <ellipse cx="790" cy="390" rx="220" ry="125"/>
    <ellipse cx="1030" cy="455" rx="310" ry="102"/>
    <ellipse cx="1310" cy="390" rx="245" ry="135"/>
    <ellipse cx="1540" cy="470" rx="250" ry="90"/>
  </g>
  <g opacity="0.72" fill="#ffcf9e">
    <ellipse cx="300" cy="360" rx="130" ry="30"/>
    <ellipse cx="720" cy="340" rx="160" ry="36"/>
    <ellipse cx="1180" cy="345" rx="190" ry="38"/>
  </g>
  <g opacity="0.38" fill="#5a5068">
    <ellipse cx="260" cy="520" rx="330" ry="55"/>
    <ellipse cx="850" cy="555" rx="390" ry="62"/>
    <ellipse cx="1380" cy="530" rx="300" ry="54"/>
  </g>
</svg>`;

const SKY_DATA_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SKY_SVG)}`;

CascadeScene.prototype.createBackdrop = function createImageMappedSunsetDome() {
  previousCreateBackdrop.call(this);

  // Remove the failed DOM photo layer and the later procedural 3D cloud pass.
  document.getElementById('sunsetBackdrop080')?.remove();
  document.querySelectorAll('style').forEach(style => {
    if (style.textContent?.includes('#sunsetBackdrop080')) style.remove();
  });
  for (let i = 0; i < 8; i++) this.scene.getMeshByName(`cloud${i}`)?.setEnabled(false);
  for (let i = 0; i < 8; i++) this.scene.getMeshByName(`sunsetCloudBank082_${i}`)?.setEnabled(false);
  this.scene.getMeshByName('sunDisc')?.setEnabled(false);
  this.scene.getMeshByName('sunsetSky')?.setEnabled(false);

  let dome = this.scene.getMeshByName('imageMappedSkyDome083');
  if (!dome) {
    dome = BABYLON.MeshBuilder.CreateSphere('imageMappedSkyDome083', {
      diameter: 420,
      segments: 32,
      sideOrientation: BABYLON.Mesh.BACKSIDE
    }, this.scene);
    dome.infiniteDistance = true;
    dome.isPickable = false;
    dome.renderingGroupId = 0;

    const material = new BABYLON.StandardMaterial('imageMappedSkyMat083', this.scene);
    const texture = new BABYLON.Texture(SKY_DATA_URI, this.scene, true, false, BABYLON.Texture.BILINEAR_SAMPLINGMODE);
    texture.coordinatesMode = BABYLON.Texture.FIXED_EQUIRECTANGULAR_MODE;
    texture.uScale = -1;
    texture.vScale = 1;
    material.emissiveTexture = texture;
    material.diffuseTexture = texture;
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.specularColor = BABYLON.Color3.Black();
    dome.material = material;
  }
  dome.setEnabled(true);

  this.scene.clearColor = new BABYLON.Color4(0.34, 0.40, 0.58, 1);
  this.scene.fogColor = new BABYLON.Color3(0.58, 0.48, 0.57);
  this.scene.fogDensity = 0.0024;
  this.scene.imageProcessingConfiguration.exposure = 1.16;
  this.scene.imageProcessingConfiguration.contrast = 1.03;
  this.sun.diffuse = new BABYLON.Color3(1.0, 0.69, 0.46);
  this.sun.intensity = 2.08;
  this.hemi.diffuse = new BABYLON.Color3(0.70, 0.76, 0.94);
  this.hemi.groundColor = new BABYLON.Color3(0.39, 0.29, 0.35);
};
