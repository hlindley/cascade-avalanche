import { CascadeSimulation } from '../core/cascade-core.js';

export class CascadeScene {
  constructor(canvas, ui) {
    this.canvas = canvas;
    this.ui = ui;
    const q = Number(new URL(location.href).searchParams.get('seed'));
    this.seed = Number.isFinite(q) && q > 0 ? Math.floor(q) : 48152;
    this.tuning = {
      cohesion: 1, speed: 1, friction: 1, light: .82,
      fractureRadius: 1, stressDecay: 1, continuity: 1,
      releaseDepth: 1, terrainResistance: 1, coreDensity: 1,
      lateralSpread: 1, momentum: 1, entrainment: 1,
      powder: 1, deposition: 1, camera: 1
    };
    this.sim = new CascadeSimulation({ size: 64, cellSize: 1.25, seed: this.seed });
    const n = this.sim.size * this.sim.size;
    this.visualMoving = new Float32Array(n);
    this.visualCore = new Float32Array(n);
    this.visualDeposit = new Float32Array(n);
    this.visualPowder = new Float32Array(n);
    this.engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    this.scene = new BABYLON.Scene(this.engine);
    this.aimPoint = null;
    this.shotFired = false;
    this.flowStarted = false;
    this.accumulator = 0;
    this.damage = 0;
    this.finished = false;
    this.director = { active: false, phase: 'idle', target: null, userInterrupted: false };
    this.buildScene();
    this.bindInput();
    ui.setSeed(this.seed);
    this.engine.runRenderLoop(() => this.frame());
    addEventListener('resize', () => this.engine.resize());
  }

  buildScene() {
    const s = this.scene;
    s.clearColor = new BABYLON.Color4(.13, .23, .42, 1);
    s.fogMode = BABYLON.Scene.FOGMODE_EXP2;
    s.fogDensity = .0028;
    s.fogColor = new BABYLON.Color3(.48, .40, .50);
    s.imageProcessingConfiguration.contrast = 1.08;
    s.imageProcessingConfiguration.exposure = 1.12;

    this.hemi = new BABYLON.HemisphericLight('sky', new BABYLON.Vector3(-.4, 1, -.2), s);
    this.hemi.intensity = .68;
    this.hemi.diffuse = new BABYLON.Color3(.62, .72, .92);
    this.hemi.groundColor = new BABYLON.Color3(.30, .22, .30);

    this.sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-.82, -.18, .46), s);
    this.sun.position.set(58, 20, -58);
    this.sun.intensity = 2.05;
    this.sun.diffuse = new BABYLON.Color3(1, .65, .42);

    this.shadowGenerator = new BABYLON.ShadowGenerator(2048, this.sun);
    this.shadowGenerator.useBlurExponentialShadowMap = true;
    this.shadowGenerator.blurKernel = 42;
    this.shadowGenerator.darkness = .22;

    this.camera = new BABYLON.ArcRotateCamera(
      'camera', -Math.PI / 2, 1.08, 92, new BABYLON.Vector3(0, 13, 7), s
    );
    this.camera.lowerRadiusLimit = 40;
    this.camera.upperRadiusLimit = 130;
    this.camera.lowerBetaLimit = .48;
    this.camera.upperBetaLimit = 1.45;
    this.camera.wheelPrecision = 35;
    this.camera.pinchPrecision = 80;
    this.camera.attachControl(this.canvas, true);

    this.createBackdrop();
    this.mountain = this.createMountain();
    this.surfaceMesh = this.flowPatch('surface', new BABYLON.Color3(.98, .97, .98), .50, 2.6);
    this.coreMesh = this.flowPatch('core', new BABYLON.Color3(1, .88, .80), .42, 3.0);
    this.depositMesh = this.flowPatch('deposit', new BABYLON.Color3(.94, .92, .95), .56, 2.2);
    this.powderMesh = this.flowCloud('powder', new BABYLON.Color3(.98, .91, .92));
    this.createTrees();
    this.createTargets();
    this.createCannon();
    this.fallLines = [];
  }

  mat(name, color, rough = .96) {
    const m = new BABYLON.PBRMaterial(name, this.scene);
    m.albedoColor = color;
    m.roughness = rough;
    m.metallic = 0;
    m.environmentIntensity = .45;
    return m;
  }

  createBackdrop() {
    const sky = BABYLON.MeshBuilder.CreateSphere('sunsetSky', {
      diameter: 900, segments: 24, sideOrientation: BABYLON.Mesh.BACKSIDE
    }, this.scene);
    const tex = new BABYLON.DynamicTexture('sunsetGradient', { width: 32, height: 512 }, this.scene, false);
    const ctx = tex.getContext();
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, '#163d72');
    g.addColorStop(.42, '#526fa4');
    g.addColorStop(.72, '#d89a9a');
    g.addColorStop(1, '#ffd09a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 512);
    tex.update();

    const sm = new BABYLON.StandardMaterial('skyMat', this.scene);
    sm.emissiveTexture = tex;
    sm.disableLighting = true;
    sm.backFaceCulling = false;
    sky.material = sm;
    sky.isPickable = false;
    sky.infiniteDistance = true;

    const cloudMat = new BABYLON.StandardMaterial('cloudMat', this.scene);
    cloudMat.diffuseColor = BABYLON.Color3.Black();
    cloudMat.emissiveColor = new BABYLON.Color3(.86, .90, .98);
    cloudMat.alpha = .24;
    cloudMat.disableLighting = true;
    cloudMat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    cloudMat.backFaceCulling = false;

    const clouds = [
      [-84, 49, 95, 32, 4.5, 12],
      [-38, 58, 118, 24, 3.5, 10],
      [18, 52, 108, 28, 4, 11],
      [74, 43, 88, 34, 5, 13],
      [4, 72, 142, 18, 2.8, 8]
    ];
    for (let i = 0; i < clouds.length; i++) {
      const [x, y, z, sx, sy, sz] = clouds[i];
      const cloud = BABYLON.MeshBuilder.CreateSphere(`cloud${i}`, { diameter: 2, segments: 12 }, this.scene);
      cloud.position.set(x, y, z);
      cloud.scaling.set(sx, sy, sz);
      cloud.material = cloudMat;
      cloud.isPickable = false;
      cloud.infiniteDistance = true;
    }

    const d = BABYLON.MeshBuilder.CreateDisc('sunDisc', { radius: 7, tessellation: 48 }, this.scene);
    d.position.set(48, 20, 58);
    d.rotation.y = Math.PI;
    const m = new BABYLON.StandardMaterial('sunMat', this.scene);
    m.emissiveColor = new BABYLON.Color3(1, .52, .22);
    m.disableLighting = true;
    d.material = m;
    d.isPickable = false;
  }

  createMountain() {
    const s = this.sim.size, cs = this.sim.cellSize, p = [], ind = [], n = [], c = [];
    for (let z = 0; z < s; z++) for (let x = 0; x < s; x++) {
      const i = this.sim.index(x, z);
      const snow = Math.min(1, this.sim.snow[i] / 2.4);
      const v = this.sim.hashNoise(x, z, 11) * .025;
      p.push((x - s / 2) * cs, this.sim.height[i], (z - s / 2) * cs);
      c.push(.29 + snow * .50 + v, .30 + snow * .48 + v, .38 + snow * .47 + v, 1);
    }
    for (let z = 0; z < s - 1; z++) for (let x = 0; x < s - 1; x++) {
      const i = z * s + x, r = i + 1, d = i + s, dr = d + 1;
      ind.push(i, d, r, r, d, dr);
    }
    BABYLON.VertexData.ComputeNormals(p, ind, n);
    const vd = new BABYLON.VertexData();
    vd.positions = p; vd.indices = ind; vd.normals = n; vd.colors = c;
    const mesh = new BABYLON.Mesh('mountain', this.scene);
    vd.applyToMesh(mesh, true);
    const m = this.mat('mountainClay', BABYLON.Color3.White(), 1);
    m.backFaceCulling = false;
    mesh.material = m;
    mesh.isPickable = true;
    mesh.receiveShadows = true;
    return mesh;
  }

  flowPatch(name, color, radius, height) {
    const mesh = BABYLON.MeshBuilder.CreateCapsule(name, {
      height, radius, tessellation: 10, capSubdivisions: 4
    }, this.scene);
    mesh.rotation.x = Math.PI / 2;
    mesh.bakeCurrentTransformIntoVertices();
    const m = this.mat(`${name}Mat`, color, .9);
    m.emissiveColor = color.scale(name === 'core' ? .14 : .05);
    mesh.material = m;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    return mesh;
  }

  flowCloud(name, color) {
    const mesh = BABYLON.MeshBuilder.CreateSphere(name, { diameter: 1, segments: 8 }, this.scene);
    const m = this.mat(`${name}Mat`, color, .98);
    m.alpha = .27;
    m.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    m.emissiveColor = color.scale(.08);
    mesh.material = m;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    return mesh;
  }

  createTrees() {
    this.treeMeshes = [];
    const trunkMat = this.mat('trunk', new BABYLON.Color3(.28, .13, .16));
    const pineMat = this.mat('pine', new BABYLON.Color3(.10, .25, .31));
    let n = 0;
    for (let z = 2; z < this.sim.size - 2; z += 2) for (let x = 2; x < this.sim.size - 2; x += 2) {
      const i = this.sim.index(x, z), d = this.sim.forest[i];
      if (d < .28 || this.sim.hashNoise(x, z, 14) > d) continue;
      const wx = (x - this.sim.size / 2) * this.sim.cellSize + (this.sim.hashNoise(x, z, 15) - .5) * 1.1;
      const wz = (z - this.sim.size / 2) * this.sim.cellSize + (this.sim.hashNoise(x, z, 16) - .5) * 1.1;
      const y = this.sim.sampleWorldHeight(wx, wz);
      const sc = .75 + this.sim.hashNoise(x, z, 17) * .55;
      const tr = BABYLON.MeshBuilder.CreateCylinder(`tr${n}`, { height: 1.8 * sc, diameter: .42 * sc, tessellation: 7 }, this.scene);
      const cr = BABYLON.MeshBuilder.CreateCylinder(`pi${n}`, { height: 3.8 * sc, diameterTop: .15, diameterBottom: 2.1 * sc, tessellation: 8 }, this.scene);
      tr.position.set(wx, y + .9 * sc, wz);
      cr.position.set(wx, y + 3 * sc, wz);
      tr.material = trunkMat; cr.material = pineMat;
      this.treeMeshes.push(tr, cr);
      n++;
    }
  }

  createTargets() {
    this.targets = [];
    const defs = [
      { x: -10, z: -22, label: 'CHALET', value: 1800 },
      { x: -2, z: -25, label: 'LODGE', value: 3200 },
      { x: 9, z: -19, label: 'LIFT', value: 2200 },
      { x: 15, z: -27, label: 'BRIDGE', value: 4200 }
    ];
    const wall = this.mat('wall', new BABYLON.Color3(.62, .22, .16));
    const roof = this.mat('roof', new BABYLON.Color3(.23, .11, .18));
    for (const d of defs) {
      const mesh = BABYLON.MeshBuilder.CreateBox(d.label, { width: 3.2, height: 2, depth: 3.2 }, this.scene);
      mesh.position.set(d.x, this.sim.sampleWorldHeight(d.x, d.z) + 1, d.z);
      mesh.material = wall;
      const cap = BABYLON.MeshBuilder.CreateCylinder(`${d.label}Roof`, { height: 1.4, diameter: 4.5, tessellation: 4 }, this.scene);
      cap.rotation.y = Math.PI / 4;
      cap.material = roof;
      cap.parent = mesh;
      cap.position.set(0, 1.55, 0);
      this.targets.push({ ...d, mesh, destroyed: false });
    }
  }

  createCannon() {
    const m = this.mat('cannon', new BABYLON.Color3(.16, .19, .22));
    const b = BABYLON.MeshBuilder.CreateCylinder('base', { diameter: 4, height: 1.2, tessellation: 10 }, this.scene);
    const bar = BABYLON.MeshBuilder.CreateCylinder('barrel', { diameter: 1.1, height: 8, tessellation: 9 }, this.scene);
    b.position.set(-28, 2, -31);
    bar.rotation.x = Math.PI / 2;
    bar.rotation.z = -.18;
    bar.position.set(-26.7, 4.2, -27.5);
    b.material = m; bar.material = m;
  }

  bindInput() {
    this.scene.onPointerObservable.add(info => {
      if (info.type === BABYLON.PointerEventTypes.POINTERDOWN && this.director.active) {
        this.director.active = false;
        this.director.userInterrupted = true;
        this.ui.setCamera('MANUAL');
      }
      if (this.shotFired || info.type !== BABYLON.PointerEventTypes.POINTERPICK) return;
      const p = info.pickInfo;
      if (p?.hit && p.pickedMesh === this.mountain) {
        this.aimPoint = p.pickedPoint.clone();
        this.ui.showReticle(this.scene, this.camera, this.aimPoint);
        this.ui.setShot('AIM LOCKED');
        this.showFallLines(this.aimPoint);
      }
    });
  }

  showFallLines(point) {
    this.fallLines.forEach(l => l.dispose());
    this.fallLines = [];
    const gx = Math.round(point.x / this.sim.cellSize + this.sim.size / 2);
    const gz = Math.round(point.z / this.sim.cellSize + this.sim.size / 2);
    for (let k = -2; k <= 2; k++) {
      let x = gx + k, z = gz;
      const pts = [];
      for (let n = 0; n < 10; n++) {
        if (!this.sim.inBounds(x, z)) break;
        const p = this.sim.worldPosition(x, z);
        pts.push(new BABYLON.Vector3(p.x, p.y + .2, p.z));
        let best = null, h = Infinity;
        for (const [nx, nz] of N(x, z)) {
          if (this.sim.inBounds(nx, nz) && this.sim.height[this.sim.index(nx, nz)] < h) {
            h = this.sim.height[this.sim.index(nx, nz)];
            best = [nx, nz];
          }
        }
        if (!best) break;
        [x, z] = best;
      }
      if (pts.length > 1) {
        const l = BABYLON.MeshBuilder.CreateLines(`fall${k}`, { points: pts }, this.scene);
        l.color = new BABYLON.Color3(1, .72, .48);
        l.alpha = .46;
        l.isPickable = false;
        this.fallLines.push(l);
      }
    }
  }

  setTuning(k, v) {
    this.tuning[k] = v;
    if (k === 'light') {
      this.sun.intensity = 1.35 + v * 1.15;
      this.hemi.intensity = .48 + v * .28;
    }
  }

  fire() {
    if (!this.aimPoint || this.shotFired) return;
    this.shotFired = true;
    this.ui.setShot('IN FLIGHT');
    this.ui.disableFire(true);
    this.fallLines.forEach(l => l.dispose());
    this.fallLines = [];
    this.startDirector('shell', this.aimPoint);
    const shell = BABYLON.MeshBuilder.CreateIcoSphere('shell', { radius: .34, subdivisions: 1 }, this.scene);
    const m = new BABYLON.StandardMaterial('shellMat', this.scene);
    m.emissiveColor = new BABYLON.Color3(1, .35, .08);
    shell.material = m;
    const a = new BABYLON.Vector3(-25, 5, -26), b = this.aimPoint.clone();
    const began = performance.now();
    const animate = () => {
      const t = Math.min(1, (performance.now() - began) / 900);
      BABYLON.Vector3.LerpToRef(a, b, t, shell.position);
      shell.position.y += Math.sin(Math.PI * t) * 13;
      if (t < 1) requestAnimationFrame(animate);
      else { shell.dispose(); this.impact(b); }
    };
    animate();
  }

  impact(point) {
    this.ui.setShot('IMPACT');
    this.startDirector('fracture', point);
    this.sim.configureFracture({
      radius: this.tuning.fractureRadius,
      decay: this.tuning.stressDecay,
      continuity: this.tuning.continuity,
      releaseDepth: this.tuning.releaseDepth,
      terrainResistance: this.tuning.terrainResistance
    });
    this.sim.configureBody({
      coreDensity: this.tuning.coreDensity,
      lateralSpread: this.tuning.lateralSpread,
      momentum: this.tuning.momentum,
      entrainment: this.tuning.entrainment,
      powder: this.tuning.powder,
      deposition: this.tuning.deposition
    });
    const r = this.sim.triggerAt(point.x, point.z, 1 / this.tuning.cohesion);
    this.ui.setFracture(r.cells.length, r.released * 1.7);
    if (!r.triggered) {
      this.ui.setShot('NO RELEASE');
      setTimeout(() => this.finish(), 1200);
      return;
    }
    this.animateFracture(r);
  }

  animateFracture(r) {
    this.ui.setShot('CRACK RUNNING');
    const mat = new BABYLON.StandardMaterial('crackMat', this.scene);
    mat.emissiveColor = new BABYLON.Color3(1, .36, .18);
    const meshes = [], edges = [...r.boundary];
    let i = 0;
    const timer = setInterval(() => {
      for (let n = 0; n < Math.max(2, Math.ceil(edges.length / 28)) && i < edges.length; n++, i++) {
        const e = edges[i], a = this.edge(e, e.a), b = this.edge(e, e.b);
        const m = BABYLON.MeshBuilder.CreateTube(`cr${i}`, { path: [a, b], radius: .045, tessellation: 5 }, this.scene);
        m.material = mat;
        meshes.push(m);
      }
      if (i >= edges.length) {
        clearInterval(timer);
        this.ui.setShot('SLAB DETACHED');
        setTimeout(() => {
          meshes.forEach(m => m.dispose());
          mat.dispose();
          this.sim.commitPendingRelease();
          this.flowStarted = true;
          this.startDirector('flow', this.aimPoint);
          this.ui.setShot('CASCADE');
        }, 520);
      }
    }, 24);
  }

  edge(e, p) {
    const x = e.x + p[0], z = e.z + p[1];
    const wx = (x - this.sim.size / 2) * this.sim.cellSize;
    const wz = (z - this.sim.size / 2) * this.sim.cellSize;
    return new BABYLON.Vector3(wx, this.sim.sampleWorldHeight(wx, wz) + .24, wz);
  }

  startDirector(phase, target) {
    if (this.tuning.camera < .5 || this.director.userInterrupted) return;
    this.director.active = true;
    this.director.phase = phase;
    this.director.target = target.clone ? target.clone() : new BABYLON.Vector3(target.x, 0, target.z);
    this.ui.setCamera('DIRECTOR');
  }

  updateDirector(dt) {
    if (!this.director.active) return;
    let target = this.director.target, radius = 74, beta = 1.03, alpha = this.camera.alpha;
    if (this.director.phase === 'shell') { radius = 82; beta = 1.08; }
    else if (this.director.phase === 'fracture') { radius = 58; beta = .92; }
    else if (this.director.phase === 'flow') {
      const f = this.sim.getFlowCenter();
      if (f) {
        target = new BABYLON.Vector3(f.x, this.sim.sampleWorldHeight(f.x, f.z) + 3, f.z);
        this.director.target = target;
        radius = clamp(58 + Math.sqrt(f.mass) * 1.8, 58, 96);
        alpha = -Math.PI / 2 + clamp(f.x / 70, -.18, .18);
      }
    } else if (this.director.phase === 'overview') {
      target = new BABYLON.Vector3(0, 12, 0);
      radius = 92;
    }
    const k = 1 - Math.exp(-dt * 2.4);
    this.camera.target = BABYLON.Vector3.Lerp(this.camera.target, target, k);
    this.camera.radius += (radius - this.camera.radius) * k;
    this.camera.beta += (beta - this.camera.beta) * k;
    this.camera.alpha += (alpha - this.camera.alpha) * k;
  }

  frame() {
    const dt = Math.min(.05, this.engine.getDeltaTime() / 1000);
    this.ui.setFps(this.engine.getFps());

    if (this.flowStarted && this.sim.active) {
      this.accumulator += dt * this.tuning.speed;
      while (this.accumulator >= this.sim.fixedDt) {
        this.sim.flowScale = this.tuning.speed;
        this.sim.frictionScale = this.tuning.friction;
        this.sim.step();
        this.accumulator -= this.sim.fixedDt;
      }
      this.updateTargets();
      this.ui.update(this.sim.totalReleased * 1.7, this.damage);
    }

    if (this.flowStarted) {
      this.updateFlow();
      if (!this.sim.active && !this.finished) this.finish();
    }

    this.updateDirector(dt);
    this.scene.render();
    if (this.aimPoint && !this.shotFired) this.ui.showReticle(this.scene, this.camera, this.aimPoint);
  }

  fallDirection(x, z) {
    const hL = this.sim.height[this.sim.index(Math.max(0, x - 1), z)];
    const hR = this.sim.height[this.sim.index(Math.min(this.sim.size - 1, x + 1), z)];
    const hU = this.sim.height[this.sim.index(x, Math.max(0, z - 1))];
    const hD = this.sim.height[this.sim.index(x, Math.min(this.sim.size - 1, z + 1))];
    const dx = hL - hR, dz = hU - hD, len = Math.hypot(dx, dz) || 1;
    return { x: dx / len, z: dz / len };
  }

  updateFlow() {
    const arrays = [[], [], [], []];
    const matrix = BABYLON.Matrix.Identity();
    const position = new BABYLON.Vector3();
    const scale = new BABYLON.Vector3();
    const rotation = new BABYLON.Quaternion();

    const add = (arr, x, z, y, sx, sy, sz, angle) => {
      position.set(x, y, z);
      scale.set(sx, sy, sz);
      BABYLON.Quaternion.RotationAxisToRef(BABYLON.Axis.Y, angle, rotation);
      BABYLON.Matrix.ComposeToRef(scale, rotation, position, matrix);
      arr.push(...matrix.toArray());
    };

    for (let z = 1; z < this.sim.size - 1; z++) for (let x = 1; x < this.sim.size - 1; x++) {
      const i = this.sim.index(x, z);
      this.visualMoving[i] = Math.max(this.sim.moving[i], this.visualMoving[i] * .982);
      this.visualCore[i] = Math.max(this.sim.core[i], this.visualCore[i] * .978);
      this.visualDeposit[i] = Math.max(this.sim.deposit[i], this.visualDeposit[i] * .9997);
      this.visualPowder[i] = Math.max(this.sim.powder[i], this.visualPowder[i] * .955);

      const w = this.sim.worldPosition(x, z);
      const mass = this.visualMoving[i];
      const core = Math.min(mass, this.visualCore[i]);
      const surface = Math.max(0, mass - core * .55);
      const dep = this.visualDeposit[i];
      const pow = this.visualPowder[i];
      const d = this.fallDirection(x, z);
      const angle = Math.atan2(d.x, d.z);
      const jitter = (this.sim.hashNoise(x, z, 31) - .5) * .36;
      const sideX = -d.z, sideZ = d.x;

      if (surface > .004) {
        const width = .72 + Math.min(1.25, Math.sqrt(surface) * .86);
        const length = 1.25 + Math.min(2.55, Math.sqrt(surface) * 1.8);
        add(arrays[0], w.x + d.x * .42 + sideX * jitter, w.z + d.z * .42 + sideZ * jitter, w.y + .30, width, .34, length, angle);
        add(arrays[0], w.x - d.x * .45 - sideX * jitter * .45, w.z - d.z * .45 - sideZ * jitter * .45, w.y + .27, width * .82, .28, length * .78, angle);
      }

      if (core > .006) {
        const width = .54 + Math.min(1.0, Math.sqrt(core) * .72);
        const length = 1.55 + Math.min(3.0, Math.sqrt(core) * 2.05);
        add(arrays[1], w.x + d.x * .62 - sideX * jitter * .25, w.z + d.z * .62 - sideZ * jitter * .25, w.y + .42, width, .40, length, angle);
      }

      if (dep > .012) {
        const width = .82 + Math.min(1.55, Math.sqrt(dep) * .95);
        const length = 1.05 + Math.min(2.0, Math.sqrt(dep) * 1.25);
        add(arrays[2], w.x + sideX * jitter * .4, w.z + sideZ * jitter * .4, w.y + .13, width, .22, length, angle);
      }

      if (pow > .006 && (x + z) % 2 === 0) {
        const a = 1.0 + Math.min(3.25, Math.sqrt(pow) * 2.0);
        add(arrays[3], w.x - sideX * jitter, w.z - sideZ * jitter, w.y + 1.35 + a * .40, a, 1.05 + a * .42, a * .95, angle);
      }
    }

    [this.surfaceMesh, this.coreMesh, this.depositMesh, this.powderMesh]
      .forEach((mesh, i) => mesh.thinInstanceSetBuffer('matrix', new Float32Array(arrays[i]), 16, true));
  }

  updateTargets() {
    for (const t of this.targets) {
      if (t.destroyed) continue;
      const gx = Math.round(t.x / this.sim.cellSize + this.sim.size / 2);
      const gz = Math.round(t.z / this.sim.cellSize + this.sim.size / 2);
      let force = 0, burial = 0;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        if (!this.sim.inBounds(gx + dx, gz + dz)) continue;
        const i = this.sim.index(gx + dx, gz + dz);
        force += this.sim.core[i] * 1.6 + this.sim.moving[i] * .45;
        burial += this.sim.deposit[i];
      }
      t.mesh.position.y -= Math.min(.018, burial * .0006);
      if (force > 2.6) {
        t.destroyed = true;
        this.damage += t.value;
        t.mesh.rotation.z = .95;
        t.mesh.position.y -= .7;
        t.mesh.scaling.y = .45;
      }
    }
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.ui.setShot('SETTLED');
    this.director.phase = 'overview';
    setTimeout(() => {
      this.director.active = false;
      this.ui.setCamera('MANUAL');
    }, 3200);
    const title = this.damage >= 7000 ? 'PERFECT CASCADE'
      : this.damage >= 3000 ? 'CHAIN REACTION'
      : this.damage > 0 ? 'PARTIAL RELEASE'
      : 'THE MOUNTAIN HELD';
    setTimeout(() => this.ui.showResult(title), 2300);
  }

  reset() { location.reload(); }

  reseed() {
    let n = this.seed;
    while (n === this.seed) n = Math.floor(10000 + Math.random() * 89999);
    const u = new URL(location.href);
    u.searchParams.set('seed', String(n));
    u.searchParams.set('v', String(Date.now()));
    location.assign(u.toString());
  }
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const N = (x, z) => [
  [x - 1, z - 1], [x, z - 1], [x + 1, z - 1],
  [x - 1, z], [x + 1, z],
  [x - 1, z + 1], [x, z + 1], [x + 1, z + 1]
];