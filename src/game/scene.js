import { CascadeSimulation } from '../core/cascade-core.js';

export class CascadeScene {
  constructor(canvas, ui) {
    this.canvas = canvas;
    this.ui = ui;
    const requestedSeed = Number(new URL(window.location.href).searchParams.get('seed'));
    this.seed = Number.isFinite(requestedSeed) && requestedSeed > 0 ? Math.floor(requestedSeed) : 48152;
    this.tuning = { cohesion: 1, speed: 1, friction: 1, light: 0.82 };
    this.sim = new CascadeSimulation({ size: 64, cellSize: 1.25, seed: this.seed });
    this.engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    this.scene = new BABYLON.Scene(this.engine);
    this.scene.clearColor = new BABYLON.Color4(0.12, 0.12, 0.19, 1);
    this.aimPoint = null;
    this.shotFired = false;
    this.accumulator = 0;
    this.damage = 0;
    this.finished = false;
    this.buildScene();
    this.bindInput();
    this.ui.setSeed(this.seed);
    this.engine.runRenderLoop(() => this.frame());
    window.addEventListener('resize', () => this.engine.resize());
  }

  buildScene() {
    const s = this.scene;
    s.fogMode = BABYLON.Scene.FOGMODE_EXP2;
    s.fogDensity = 0.0036;
    s.fogColor = new BABYLON.Color3(0.55, 0.45, 0.58);
    s.imageProcessingConfiguration.contrast = 1.25;
    s.imageProcessingConfiguration.exposure = 1.02;

    this.hemi = new BABYLON.HemisphericLight('sky', new BABYLON.Vector3(-0.4, 1, -0.2), s);
    this.hemi.intensity = 0.46;
    this.hemi.diffuse = new BABYLON.Color3(0.48, 0.58, 0.88);
    this.hemi.groundColor = new BABYLON.Color3(0.18, 0.11, 0.23);

    this.sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.82, -0.24, 0.46), s);
    this.sun.position = new BABYLON.Vector3(58, 28, -58);
    this.sun.intensity = 2.85;
    this.sun.diffuse = new BABYLON.Color3(1, 0.55, 0.3);
    this.sun.specular = new BABYLON.Color3(1, 0.68, 0.46);

    this.shadowGenerator = new BABYLON.ShadowGenerator(2048, this.sun);
    this.shadowGenerator.useBlurExponentialShadowMap = true;
    this.shadowGenerator.blurKernel = 24;
    this.shadowGenerator.bias = 0.0008;
    this.shadowGenerator.normalBias = 0.025;

    this.camera = new BABYLON.ArcRotateCamera('camera', -Math.PI / 2, 1.08, 92, new BABYLON.Vector3(0, 13, 7), s);
    this.camera.lowerRadiusLimit = 48;
    this.camera.upperRadiusLimit = 125;
    this.camera.lowerBetaLimit = 0.55;
    this.camera.upperBetaLimit = 1.42;
    this.camera.wheelPrecision = 35;
    this.camera.pinchPrecision = 80;
    this.camera.attachControl(this.canvas, true);

    this.createBackdrop();
    this.mountain = this.createMountainMesh();
    this.snowMesh = this.createSnowMassMesh();
    this.createTrees();
    this.createTargets();
    this.createCannon();
  }

  clayMaterial(name, color, rough = 0.95) {
    const m = new BABYLON.PBRMaterial(name, this.scene);
    m.albedoColor = color;
    m.roughness = rough;
    m.metallic = 0;
    m.environmentIntensity = 0.35;
    return m;
  }

  createBackdrop() {
    const disc = BABYLON.MeshBuilder.CreateDisc('sunDisc', { radius: 8, tessellation: 48 }, this.scene);
    disc.position.set(44, 25, 44);
    disc.rotation.y = Math.PI;
    const mat = new BABYLON.StandardMaterial('sunDiscMat', this.scene);
    mat.emissiveColor = new BABYLON.Color3(1, 0.3, 0.15);
    mat.disableLighting = true;
    disc.material = mat;
    disc.isPickable = false;
  }

  createMountainMesh() {
    const s = this.sim.size, cs = this.sim.cellSize;
    const positions = [], indices = [], normals = [], colors = [];
    for (let z = 0; z < s; z++) {
      for (let x = 0; x < s; x++) {
        const i = this.sim.index(x, z);
        positions.push((x - s / 2) * cs, this.sim.height[i], (z - s / 2) * cs);
        const snow = Math.min(1, this.sim.snow[i] / 2.4);
        const variation = this.sim.hashNoise(x, z, 11) * 0.035;
        colors.push(0.34 + snow * 0.53 + variation, 0.27 + snow * 0.61 + variation * 0.65, 0.32 + snow * 0.64, 1);
      }
    }
    for (let z = 0; z < s - 1; z++) {
      for (let x = 0; x < s - 1; x++) {
        const i = z * s + x, r = i + 1, d = i + s, dr = d + 1;
        indices.push(i, d, r, r, d, dr);
      }
    }
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);
    const vd = new BABYLON.VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    vd.colors = colors;
    const mesh = new BABYLON.Mesh('mountain', this.scene);
    vd.applyToMesh(mesh, true);
    const mat = this.clayMaterial('mountainClay', BABYLON.Color3.White(), 1);
    mat.backFaceCulling = false;
    mesh.material = mat;
    mesh.isPickable = true;
    mesh.receiveShadows = true;
    return mesh;
  }

  createSnowMassMesh() {
    const mesh = BABYLON.MeshBuilder.CreateIcoSphere('movingSnow', { radius: 0.42, subdivisions: 1 }, this.scene);
    mesh.material = this.clayMaterial('snowClay', new BABYLON.Color3(0.96, 0.88, 0.91), 0.98);
    mesh.isPickable = false;
    mesh.thinInstanceEnablePicking = false;
    return mesh;
  }

  createTrees() {
    this.treeMeshes = [];
    const trunkMat = this.clayMaterial('trunkClay', new BABYLON.Color3(0.28, 0.13, 0.16));
    const pineMat = this.clayMaterial('pineClay', new BABYLON.Color3(0.1, 0.22, 0.23));
    const stride = 2;
    let treeNumber = 0;

    for (let z = 2; z < this.sim.size - 2; z += stride) {
      for (let x = 2; x < this.sim.size - 2; x += stride) {
        const i = this.sim.index(x, z);
        const density = this.sim.forest[i];
        if (density < 0.28 || this.sim.hashNoise(x, z, 14) > density) continue;
        const wx = (x - this.sim.size / 2) * this.sim.cellSize + (this.sim.hashNoise(x, z, 15) - 0.5) * 1.1;
        const wz = (z - this.sim.size / 2) * this.sim.cellSize + (this.sim.hashNoise(x, z, 16) - 0.5) * 1.1;
        const y = this.sim.sampleWorldHeight(wx, wz);
        const scale = 0.75 + this.sim.hashNoise(x, z, 17) * 0.55;

        const trunk = BABYLON.MeshBuilder.CreateCylinder(`trunk${treeNumber}`, { height: 1.8 * scale, diameter: 0.42 * scale, tessellation: 7 }, this.scene);
        trunk.position.set(wx, y + 0.9 * scale, wz);
        trunk.material = trunkMat;

        const crown = BABYLON.MeshBuilder.CreateCylinder(`pine${treeNumber}`, { height: 3.8 * scale, diameterTop: 0.15, diameterBottom: 2.1 * scale, tessellation: 8 }, this.scene);
        crown.position.set(wx, y + 3 * scale, wz);
        crown.rotation.y = this.sim.hashNoise(x, z, 18) * Math.PI;
        crown.material = pineMat;

        this.shadowGenerator.addShadowCaster(trunk);
        this.shadowGenerator.addShadowCaster(crown);
        this.treeMeshes.push(trunk, crown);
        treeNumber++;
      }
    }
  }

  createTargets() {
    this.targets = [];
    const defs = [
      { x: -10, z: -22, label: 'CHALET', value: 1800 },
      { x: -2, z: -25, label: 'LODGE', value: 3200 },
      { x: 9, z: -19, label: 'LIFT', value: 2200 },
      { x: 15, z: -27, label: 'BRIDGE', value: 4200 },
    ];
    const wall = this.clayMaterial('targetClay', new BABYLON.Color3(0.62, 0.22, 0.16));
    const roof = this.clayMaterial('roofClay', new BABYLON.Color3(0.23, 0.11, 0.18));
    for (const d of defs) {
      const y = this.sim.sampleWorldHeight(d.x, d.z) + 1;
      const mesh = BABYLON.MeshBuilder.CreateBox(d.label, { width: 3.2, height: 2, depth: 3.2 }, this.scene);
      mesh.position.set(d.x, y, d.z);
      mesh.rotation.y = ((d.x + d.z) % 7) * 0.04;
      mesh.material = wall;
      const cap = BABYLON.MeshBuilder.CreateCylinder(`${d.label}Roof`, { height: 1.4, diameter: 4.5, tessellation: 4 }, this.scene);
      cap.rotation.y = Math.PI / 4;
      cap.material = roof;
      cap.parent = mesh;
      cap.position.set(0, 1.55, 0);
      this.shadowGenerator.addShadowCaster(mesh);
      this.shadowGenerator.addShadowCaster(cap);
      this.targets.push({ ...d, mesh, destroyed: false });
    }
  }

  createCannon() {
    const mat = this.clayMaterial('cannonClay', new BABYLON.Color3(0.16, 0.19, 0.22));
    const base = BABYLON.MeshBuilder.CreateCylinder('cannonBase', { diameter: 4, height: 1.2, tessellation: 10 }, this.scene);
    base.position.set(-28, 2, -31);
    base.material = mat;
    const barrel = BABYLON.MeshBuilder.CreateCylinder('barrel', { diameter: 1.1, height: 8, tessellation: 9 }, this.scene);
    barrel.rotation.x = Math.PI / 2;
    barrel.rotation.z = -0.18;
    barrel.position.set(-26.7, 4.2, -27.5);
    barrel.material = mat;
    this.shadowGenerator.addShadowCaster(base);
    this.shadowGenerator.addShadowCaster(barrel);
  }

  bindInput() {
    this.scene.onPointerObservable.add((info) => {
      if (this.shotFired || info.type !== BABYLON.PointerEventTypes.POINTERPICK) return;
      const p = info.pickInfo;
      if (p?.hit && p.pickedMesh === this.mountain) {
        this.aimPoint = p.pickedPoint.clone();
        this.ui.showReticle(this.scene, this.camera, this.aimPoint);
        this.ui.setShot('AIM LOCKED');
      }
    });
  }

  setTuning(key, value) {
    this.tuning[key] = value;
    if (key === 'light') {
      this.sun.intensity = 1.65 + value * 1.65;
      this.hemi.intensity = 0.28 + value * 0.28;
      this.scene.fogColor = new BABYLON.Color3(0.4 + value * 0.2, 0.35 + value * 0.14, 0.5 + value * 0.1);
    }
  }

  fire() {
    if (!this.aimPoint || this.shotFired) return;
    this.shotFired = true;
    this.ui.setShot('IN FLIGHT');
    this.ui.disableFire(true);
    const shell = BABYLON.MeshBuilder.CreateIcoSphere('shell', { radius: 0.34, subdivisions: 1 }, this.scene);
    const mat = new BABYLON.StandardMaterial('shellMat', this.scene);
    mat.emissiveColor = new BABYLON.Color3(1, 0.35, 0.08);
    shell.material = mat;
    const start = new BABYLON.Vector3(-25, 5, -26);
    shell.position.copyFrom(start);
    const target = this.aimPoint.clone(), duration = 900, began = performance.now();
    const animate = () => {
      const t = Math.min(1, (performance.now() - began) / duration);
      BABYLON.Vector3.LerpToRef(start, target, t, shell.position);
      shell.position.y += Math.sin(Math.PI * t) * 13;
      if (t < 1) requestAnimationFrame(animate);
      else { shell.dispose(); this.impact(target); }
    };
    animate();
  }

  impact(point) {
    this.ui.setShot('IMPACT');
    const flash = BABYLON.MeshBuilder.CreateIcoSphere('impactFlash', { radius: 0.7, subdivisions: 1 }, this.scene);
    flash.position.copyFrom(point);
    const mat = new BABYLON.StandardMaterial('flashMat', this.scene);
    mat.emissiveColor = new BABYLON.Color3(1, 0.52, 0.18);
    flash.material = mat;
    const start = performance.now();
    const pulse = () => {
      const t = (performance.now() - start) / 350;
      flash.scaling.setAll(1 + t * 8);
      mat.alpha = 1 - t;
      if (t < 1) requestAnimationFrame(pulse);
      else flash.dispose();
    };
    pulse();
    const triggered = this.sim.triggerAt(point.x, point.z, 1 / this.tuning.cohesion);
    this.ui.setShot(triggered ? 'FRACTURE' : 'NO RELEASE');
    if (!triggered) setTimeout(() => this.finish(), 1200);
  }

  frame() {
    const dt = Math.min(0.05, this.engine.getDeltaTime() / 1000);
    this.ui.setFps(this.engine.getFps());
    if (this.shotFired && this.sim.active) {
      this.accumulator += dt * this.tuning.speed;
      while (this.accumulator >= this.sim.fixedDt) {
        this.sim.flowScale = this.tuning.speed;
        this.sim.frictionScale = this.tuning.friction;
        this.sim.step();
        this.accumulator -= this.sim.fixedDt;
      }
      this.updateSnowInstances();
      this.updateTargets();
      this.ui.update(this.sim.totalReleased * 1.7, this.damage);
      if (!this.sim.active) this.finish();
    }
    this.scene.render();
    if (this.aimPoint && !this.shotFired) this.ui.showReticle(this.scene, this.camera, this.aimPoint);
  }

  updateSnowInstances() {
    const matrices = [], m = BABYLON.Matrix.Identity(), scale = new BABYLON.Vector3();
    const q = BABYLON.Quaternion.Identity(), pos = new BABYLON.Vector3();
    const stride = this.sim.totalReleased > 150 ? 2 : 1;
    for (let z = 0; z < this.sim.size; z += stride) {
      for (let x = 0; x < this.sim.size; x += stride) {
        const i = this.sim.index(x, z), mass = this.sim.moving[i];
        if (mass < 0.025) continue;
        const p = this.sim.worldPosition(x, z);
        pos.set(p.x, p.y + 0.22, p.z);
        const sz = 0.5 + Math.min(2.6, Math.sqrt(mass) * 1.7);
        scale.set(sz, 0.45 + sz * 0.18, sz);
        BABYLON.Matrix.ComposeToRef(scale, q, pos, m);
        matrices.push(...m.toArray());
      }
    }
    this.snowMesh.thinInstanceSetBuffer('matrix', new Float32Array(matrices), 16, true);
  }

  updateTargets() {
    for (const t of this.targets) {
      if (t.destroyed) continue;
      const gx = Math.round(t.x / this.sim.cellSize + this.sim.size / 2);
      const gz = Math.round(t.z / this.sim.cellSize + this.sim.size / 2);
      let force = 0;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (this.sim.inBounds(gx + dx, gz + dz)) force += this.sim.moving[this.sim.index(gx + dx, gz + dz)];
        }
      }
      if (force > 2.4) {
        t.destroyed = true;
        this.damage += t.value;
        t.mesh.rotation.z = 0.95;
        t.mesh.position.y -= 0.7;
        t.mesh.scaling.y = 0.45;
      }
    }
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.ui.setShot('SETTLED');
    const title = this.damage >= 7000 ? 'PERFECT CASCADE' : this.damage >= 3000 ? 'CHAIN REACTION' : this.damage > 0 ? 'PARTIAL RELEASE' : 'THE MOUNTAIN HELD';
    setTimeout(() => this.ui.showResult(title), 700);
  }

  reset() { window.location.reload(); }

  reseed() {
    let nextSeed = this.seed;
    while (nextSeed === this.seed) nextSeed = Math.floor(10000 + Math.random() * 89999);
    const u = new URL(window.location.href);
    u.searchParams.set('seed', String(nextSeed));
    u.searchParams.set('v', String(Date.now()));
    window.location.assign(u.toString());
  }
}
