import * as THREE from 'three';
import { mulberry32 } from './voronoi.js';

// Late-afternoon light: warm raking sun from the south-west across the main facade,
// cool sky fill, hazy distance. Background masses are big and clean, fogged into the sky.

// Sky fill (hemisphere + IBL) ignores occlusion, which made building interiors as bright as
// the street. A few authored interior volumes scale indirect light inside them, so holes
// reveal a dim, warm interior lit by its own lamps and by sun that enters through breaches.
export function installInteriorOcclusion(volumes) {
  const C = THREE.ShaderChunk;
  if (C.common.includes('vAlleyWorld')) return;
  const boxes = volumes.map((b) => `alleyBox(p, vec3(${b.min.map((v) => v.toFixed(2)).join(',')}), vec3(${b.max.map((v) => v.toFixed(2)).join(',')}), ${b.occ.toFixed(2)})`);
  C.common += `
varying vec3 vAlleyWorld;
float alleyBox(vec3 p, vec3 mn, vec3 mx, float occ){
  vec3 d = min(p - mn, mx - p);
  float inside = smoothstep(-0.05, 0.9, min(min(d.x, d.y), d.z));
  return mix(1.0, occ, inside);
}
float alleyInterior(vec3 p){ return ${boxes.length ? boxes.join(' * ') : '1.0'}; }
`;
  C.project_vertex = C.project_vertex.replace('mvPosition = modelViewMatrix * mvPosition;', 'vAlleyWorld = (modelMatrix * mvPosition).xyz;\nmvPosition = modelViewMatrix * mvPosition;');
  C.aomap_fragment += `
{ float alleyOcc = alleyInterior(vAlleyWorld); reflectedLight.indirectDiffuse *= alleyOcc; reflectedLight.indirectSpecular *= alleyOcc; }
`;
}

export const SUN_DIR = new THREE.Vector3(-0.62, 0.52, 0.58).normalize();

export function buildEnvironment(game) {
  const { scene, renderer } = game;
  const sky = skyDome();
  scene.add(sky);
  scene.fog = new THREE.FogExp2(0xd9d2c4, 0.0062);
  scene.background = new THREE.Color(0xd9d2c4);

  const hemi = new THREE.HemisphereLight(0xbcd2e6, 0x5e544b, 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffdcb4, 3.4);
  sun.position.copy(SUN_DIR).multiplyScalar(60).add(new THREE.Vector3(0, 0, -4));
  sun.target.position.set(0, 0, -4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = -38; sc.right = 38; sc.top = 38; sc.bottom = -38; sc.near = 5; sc.far = 140;
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  // image-based fill from the sky itself
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(skyDome(true));
  const rt = pmrem.fromScene(envScene, 0.02);
  scene.environment = rt.texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  buildBackdrop(scene);
  return { sun, hemi, sky };
}

function skyDome(forEnv = false) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uSun: { value: SUN_DIR.clone() }, uEnv: { value: forEnv ? 1 : 0 } },
    vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun; uniform float uEnv; varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 zen = vec3(0.30,0.46,0.64);
        vec3 mid = vec3(0.62,0.74,0.84);
        vec3 hor = vec3(0.93,0.86,0.76);
        vec3 col = mix(hor, mid, smoothstep(0.0, 0.18, h));
        col = mix(col, zen, smoothstep(0.18, 0.75, h));
        col = mix(col, vec3(0.42,0.39,0.36), smoothstep(0.0,-0.25,h));
        float s = max(dot(d, normalize(uSun)), 0.0);
        col += vec3(1.0,0.78,0.52) * pow(s, 8.0) * 0.35;
        col += vec3(1.0,0.85,0.65) * pow(s, 400.0) * (uEnv > 0.5 ? 6.0 : 14.0);
        // faint high streaks
        float band = smoothstep(0.08,0.2,h) * (1.0-smoothstep(0.35,0.6,h));
        col = mix(col, col*1.05 + 0.03, band * (0.5+0.5*sin(d.x*14.0 + d.z*5.0)) * 0.4);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), mat);
  m.frustumCulled = false;
  m.renderOrder = -10;
  return m;
}

function buildBackdrop(scene) {
  const r = mulberry32(5);
  const mats = [0xd8d3c8, 0xc9c6bf, 0xbfc5c8, 0xa9b3b9, 0xe0d8c8].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));
  const accent = new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x5a6068, roughness: 0.8 });
  const geos = new Map();
  const add = (geo, mat, x, y, z, ry = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    scene.add(m);
  };
  // ring of masses beyond the alley
  for (let i = 0; i < 70; i++) {
    const a = r() * Math.PI * 2;
    const d = 70 + r() * 120;
    const x = Math.cos(a) * d, z = Math.sin(a) * d - 10;
    if (Math.abs(x) < 40 && Math.abs(z + 5) < 45) continue;
    const w = 10 + r() * 22, dd = 10 + r() * 22;
    const h = 12 + r() * r() * 70;
    add(new THREE.BoxGeometry(w, h, dd), mats[i % mats.length], x, h / 2, z, Math.round(r() * 4) * (Math.PI / 8));
    if (r() < 0.35) add(new THREE.BoxGeometry(w * 0.4, 3, dd * 0.4), dark, x, h + 1.5, z);
    if (r() < 0.15) add(new THREE.BoxGeometry(w + 0.2, 1.4, dd + 0.2), accent, x, h * 0.6, z, 0);
  }
  // the viaduct: a long clean curved mass behind block A
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-220, 24, -40), new THREE.Vector3(-90, 24, -78), new THREE.Vector3(0, 24, -88),
    new THREE.Vector3(90, 24, -72), new THREE.Vector3(220, 24, -20),
  ]);
  const shape = new THREE.Shape();
  shape.moveTo(-7, -1.2); shape.lineTo(7, -1.2); shape.lineTo(7.6, 0.4); shape.lineTo(7, 1.6); shape.lineTo(-7, 1.6); shape.lineTo(-7.6, 0.4); shape.closePath();
  const deck = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { steps: 120, extrudePath: curve, bevelEnabled: false }), mats[0]);
  scene.add(deck);
  const stripe = new THREE.Mesh(new THREE.TubeGeometry(curve, 120, 0.5, 4), accent);
  stripe.position.y = -1.6;
  scene.add(stripe);
  for (let t = 0.04; t < 1; t += 0.075) {
    const p = curve.getPoint(t);
    add(new THREE.CylinderGeometry(2.6, 3.2, p.y - 1, 12), mats[1], p.x, (p.y - 1) / 2, p.z);
  }
  // cranes
  for (const [x, z, h, a] of [[-70, -110, 60, 0.4], [95, -95, 52, -0.9]]) {
    add(new THREE.BoxGeometry(2, h, 2), accent, x, h / 2, z);
    const jib = new THREE.Mesh(new THREE.BoxGeometry(46, 1.6, 1.6), accent);
    jib.position.set(x + Math.cos(a) * 14, h, z + Math.sin(a) * 14);
    jib.rotation.y = -a;
    scene.add(jib);
  }
}
