import { CascadeSimulation } from '../core/cascade-core.js';

export class CascadeScene {
  constructor(canvas, ui) {
    this.canvas = canvas;
    this.ui = ui;
    this.sim = new CascadeSimulation({ size: 64, cellSize: 1.25, seed: 48152 });
    this.engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    this.scene = new BABYLON.Scene(this.engine);
    this.scene.clearColor = new BABYLON.Color4(.045, .065, .085, 1);
    this.aimPoint = null;
    this.shotFired = false;
    this.accumulator = 0;
    this.damage = 0;
    this.buildScene();
    this.bindInput();
    this.engine.runRenderLoop(() => this.frame());
    window.addEventListener('resize', () => this.engine.resize());
  }

  buildScene() {
    const scene = this.scene;
    scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
    scene.fogDensity = .0045;
    scene.fogColor = new BABYLON.Color3(.56, .65, .72);
    const hemi = new BABYLON.HemisphericLight('sky', new BABYLON.Vector3(-.3, 1, -.2), scene);
    hemi.intensity = 1.4;
    hemi.groundColor = new BABYLON.Color3(.08, .1, .12);
    const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-.45, -1, .35), scene);
    sun.position = new BABYLON.Vector3(35, 65, -45);
    sun.intensity = 2.0;

    this.camera = new BABYLON.ArcRotateCamera('camera', -Math.PI/2, 1.1, 92, new BABYLON.Vector3(0, 13, 7), scene);
    this.camera.lowerRadiusLimit = 48; this.camera.upperRadiusLimit = 125;
    this.camera.lowerBetaLimit = .55; this.camera.upperBetaLimit = 1.42;
    this.camera.wheelPrecision = 35;
    this.camera.pinchPrecision = 80;
    this.camera.attachControl(this.canvas, true);

    this.mountain = this.createMountainMesh();
    this.snowMesh = this.createSnowMassMesh();
    this.createTargets();
    this.createCannon();
  }

  createMountainMesh() {
    const s = this.sim.size, cs = this.sim.cellSize;
    const positions = [], indices = [], normals = [], colors = [];
    for (let z=0; z<s; z++) for (let x=0; x<s; x++) {
      const i = this.sim.index(x,z);
      positions.push((x-s/2)*cs, this.sim.height[i], (z-s/2)*cs);
      const snowMix = Math.min(1, this.sim.snow[i]/2.4);
      colors.push(.24 + snowMix*.60, .28 + snowMix*.62, .3 + snowMix*.65, 1);
    }
    for (let z=0; z<s-1; z++) for (let x=0; x<s-1; x++) {
      const i=z*s+x, r=i+1, d=i+s, dr=d+1;
      indices.push(i,d,r, r,d,dr);
    }
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);
    const vd = new BABYLON.VertexData();
    vd.positions=positions; vd.indices=indices; vd.normals=normals; vd.colors=colors;
    const mesh = new BABYLON.Mesh('mountain', this.scene); vd.applyToMesh(mesh, true);
    const mat = new BABYLON.StandardMaterial('mountainMat', this.scene);
    mat.diffuseColor = BABYLON.Color3.White(); mat.specularColor = new BABYLON.Color3(.08,.08,.08);
    mat.backFaceCulling = false; mesh.material = mat; mesh.isPickable = true;
    return mesh;
  }

  createSnowMassMesh() {
    const mesh = BABYLON.MeshBuilder.CreateSphere('movingSnow', { diameter: .72, segments: 5 }, this.scene);
    const mat = new BABYLON.StandardMaterial('snowMassMat', this.scene);
    mat.diffuseColor = new BABYLON.Color3(.92,.96,1); mat.emissiveColor = new BABYLON.Color3(.08,.1,.12);
    mat.specularColor = new BABYLON.Color3(.2,.2,.2); mesh.material=mat; mesh.isPickable=false;
    mesh.thinInstanceEnablePicking = false;
    return mesh;
  }

  createTargets() {
    this.targets = [];
    const defs = [
      {x:-10,z:-22, label:'CONVOY', value:1800}, {x:-2,z:-25,label:'DEPOT',value:3200},
      {x:9,z:-19,label:'TOWER',value:2200}, {x:15,z:-27,label:'BRIDGE',value:4200}
    ];
    for (const d of defs) {
      const y=this.sim.sampleWorldHeight(d.x,d.z)+1;
      const mesh=BABYLON.MeshBuilder.CreateBox(d.label,{width:3.2,height:2,depth:3.2},this.scene);
      mesh.position.set(d.x,y,d.z); mesh.rotation.y=(Math.random()-.5)*.45;
      const mat=new BABYLON.StandardMaterial(`${d.label}Mat`,this.scene);
      mat.diffuseColor=new BABYLON.Color3(.75,.28,.12); mat.emissiveColor=new BABYLON.Color3(.08,.018,.005); mesh.material=mat;
      this.targets.push({...d,mesh,destroyed:false});
    }
  }

  createCannon() {
    const base=BABYLON.MeshBuilder.CreateCylinder('cannonBase',{diameter:4,height:1.2,tessellation:12},this.scene);
    base.position.set(-28,2,-31);
    const mat=new BABYLON.StandardMaterial('cannonMat',this.scene); mat.diffuseColor=new BABYLON.Color3(.12,.15,.16); base.material=mat;
    const barrel=BABYLON.MeshBuilder.CreateCylinder('barrel',{diameter:1.1,height:8,tessellation:10},this.scene);
    barrel.rotation.x=Math.PI/2; barrel.rotation.z=-.18; barrel.position.set(-26.7,4.2,-27.5); barrel.material=mat;
  }

  bindInput() {
    this.scene.onPointerObservable.add((info) => {
      if (this.shotFired || info.type !== BABYLON.PointerEventTypes.POINTERPICK) return;
      const pick=info.pickInfo;
      if (pick?.hit && pick.pickedMesh === this.mountain) {
        this.aimPoint=pick.pickedPoint.clone();
        this.ui.showReticle(this.scene, this.camera, this.aimPoint);
        this.ui.setShot('AIM LOCKED');
      }
    });
  }

  fire() {
    if (!this.aimPoint || this.shotFired) return;
    this.shotFired=true; this.ui.setShot('IN FLIGHT'); this.ui.disableFire(true);
    const shell=BABYLON.MeshBuilder.CreateSphere('shell',{diameter:.62,segments:8},this.scene);
    const mat=new BABYLON.StandardMaterial('shellMat',this.scene); mat.emissiveColor=new BABYLON.Color3(1,.42,.08); shell.material=mat;
    const start=new BABYLON.Vector3(-25,5,-26); shell.position.copyFrom(start);
    const target=this.aimPoint.clone(); const duration=900; const began=performance.now();
    const animate=()=>{
      const t=Math.min(1,(performance.now()-began)/duration);
      BABYLON.Vector3.LerpToRef(start,target,t,shell.position); shell.position.y += Math.sin(Math.PI*t)*13;
      if(t<1) requestAnimationFrame(animate); else { shell.dispose(); this.impact(target); }
    }; animate();
  }

  impact(point) {
    this.ui.setShot('IMPACT');
    const flash=BABYLON.MeshBuilder.CreateSphere('impactFlash',{diameter:1.2,segments:8},this.scene); flash.position.copyFrom(point);
    const mat=new BABYLON.StandardMaterial('flashMat',this.scene); mat.emissiveColor=new BABYLON.Color3(1,.65,.2); flash.material=mat;
    const start=performance.now(); const pulse=()=>{const t=(performance.now()-start)/350; flash.scaling.setAll(1+t*8); mat.alpha=1-t; if(t<1)requestAnimationFrame(pulse);else flash.dispose();};pulse();
    const triggered=this.sim.triggerAt(point.x,point.z,1);
    this.ui.setShot(triggered?'FRACTURE':'NO RELEASE');
    if(!triggered) setTimeout(()=>this.finish(),1200);
  }

  frame() {
    const dt=Math.min(.05,this.engine.getDeltaTime()/1000);
    if(this.shotFired && this.sim.active){
      this.accumulator+=dt;
      while(this.accumulator>=this.sim.fixedDt){this.sim.step();this.accumulator-=this.sim.fixedDt;}
      this.updateSnowInstances(); this.updateTargets();
      this.ui.update(this.sim.totalReleased*1.7,this.damage);
      if(!this.sim.active) this.finish();
    }
    this.scene.render();
    if(this.aimPoint && !this.shotFired) this.ui.showReticle(this.scene,this.camera,this.aimPoint);
  }

  updateSnowInstances() {
    const matrices=[]; const m=BABYLON.Matrix.Identity(); const scale=new BABYLON.Vector3(); const q=BABYLON.Quaternion.Identity(); const pos=new BABYLON.Vector3();
    const stride=this.sim.totalReleased>150?2:1;
    for(let z=0;z<this.sim.size;z+=stride)for(let x=0;x<this.sim.size;x+=stride){
      const i=this.sim.index(x,z), mass=this.sim.moving[i]; if(mass<.025)continue;
      const p=this.sim.worldPosition(x,z); pos.set(p.x,p.y+.22,p.z); const sz=.5+Math.min(2.6,Math.sqrt(mass)*1.7); scale.set(sz,.45+sz*.18,sz);
      BABYLON.Matrix.ComposeToRef(scale,q,pos,m); matrices.push(...m.toArray());
    }
    this.snowMesh.thinInstanceSetBuffer('matrix',new Float32Array(matrices),16,true);
  }

  updateTargets() {
    for(const t of this.targets){if(t.destroyed)continue;
      const gx=Math.round(t.x/this.sim.cellSize+this.sim.size/2), gz=Math.round(t.z/this.sim.cellSize+this.sim.size/2);
      let force=0; for(let dz=-2;dz<=2;dz++)for(let dx=-2;dx<=2;dx++)if(this.sim.inBounds(gx+dx,gz+dz))force+=this.sim.moving[this.sim.index(gx+dx,gz+dz)];
      if(force>2.4){t.destroyed=true;this.damage+=t.value;t.mesh.rotation.z=.95;t.mesh.position.y-=.7;t.mesh.scaling.y=.45;}
    }
  }

  finish() {
    if(this.finished)return;this.finished=true;
    this.ui.setShot('SETTLED');
    const title=this.damage>=7000?'PERFECT CASCADE':this.damage>=3000?'CHAIN REACTION':this.damage>0?'PARTIAL RELEASE':'THE MOUNTAIN HELD';
    setTimeout(()=>this.ui.showResult(title),700);
  }

  reset() { window.location.reload(); }
}
