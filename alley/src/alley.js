import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';
import { Attachment } from './destruct.js';
import { concreteMap, fractureMap, plasterMap, paintPanel, ops, groundTexture, toTexture, canvas, grain } from './textures.js';
import { mulberry32 } from './voronoi.js';

// THE ALLEY — one compact courtyard (~40 m) framed by a primary infrastructure block (north),
// a lower warehouse (east), a retaining wall + pipe rack (west) and an alley mouth (south).
// Rule: complexity lives on the permanent skeleton; destruction lives on simple thick infill.

const PAL = {
  bone: 0xe7e1d3, boneDark: 0xcbc3b2, graphite: 0x2a2e33, steel: 0x80878e, orange: 0xff5a1f,
  teal: 0x1e9e98, ink: 0x1f2c3a, yellow: 0xf0b92a, warm: 0xe8d7bb, rust: 0x9a4a2a,
};
const rng = mulberry32(2024);

class Builder {
  constructor(game) {
    this.g = game;
    this.scene = game.scene;
    this.batches = new Map();
    this.dynamicGroup = new THREE.Group();
    this.scene.add(this.dynamicGroup);
    const env = (c, rough, metal, extra = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal, ...extra });
    const cMap = concreteMap(11, '#ffffff', 1);
    cMap.repeat.set(0.25, 0.25);
    this.m = {
      bone: env(PAL.bone, 0.82, 0.0, { map: cMap }),
      boneDark: env(PAL.boneDark, 0.85, 0.0, { map: cMap }),
      graphite: env(PAL.graphite, 0.55, 0.55),
      steel: env(PAL.steel, 0.38, 0.85),
      galv: env(0xa9aeb2, 0.42, 0.8),
      orange: env(PAL.orange, 0.5, 0.15),
      teal: env(PAL.teal, 0.5, 0.2),
      ink: env(PAL.ink, 0.6, 0.2),
      yellow: env(PAL.yellow, 0.55, 0.15),
      warm: env(PAL.warm, 0.9, 0.0, { map: cMap }),
      floor: env(0x6d6862, 0.7, 0.0, { map: cMap }),
      rubber: env(0x18191b, 0.9, 0.0),
      lampWarm: new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.4, 1.5) }),
      lampCool: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 2.6, 3.0) }),
      signRed: new THREE.MeshBasicMaterial({ color: new THREE.Color(3.0, 0.5, 0.25) }),
    };
  }

  // static mesh, merged by material at finalize; optional collider
  add(geo, mat, pos, rot, opts = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(pos);
    if (rot) m.rotation.copy(rot);
    m.updateMatrixWorld(true);
    if (opts.dynamic) {
      m.castShadow = opts.shadow ?? true;
      m.receiveShadow = true;
      return m;
    }
    const g = geo.clone().applyMatrix4(m.matrixWorld);
    const key = mat.uuid + (opts.shadow === false ? ':ns' : '');
    if (!this.batches.has(key)) this.batches.set(key, { mat, geos: [], shadow: opts.shadow !== false });
    this.batches.get(key).geos.push(g);
    return m;
  }

  box(w, h, d, mat, x, y, z, opts = {}) {
    const geo = opts.r ? new RoundedBoxGeometry(w, h, d, 2, Math.min(opts.r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3)) : new THREE.BoxGeometry(w, h, d);
    const rot = opts.ry || opts.rx || opts.rz ? new THREE.Euler(opts.rx ?? 0, opts.ry ?? 0, opts.rz ?? 0) : null;
    const pos = new THREE.Vector3(x, y, z);
    const m = this.add(geo, mat, pos, rot, opts);
    if (opts.collide !== false && !opts.dynamic) {
      const q = rot ? new THREE.Quaternion().setFromEuler(rot) : undefined;
      this.g.physics.fixedBox(x, y, z, w / 2, h / 2, d / 2, q, { kind: 'static' });
    }
    return m;
  }

  // box from min/max corners
  span(x0, y0, z0, x1, y1, z1, mat, opts = {}) {
    return this.box(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, opts);
  }

  cyl(r, len, mat, x, y, z, axis = 'y', opts = {}) {
    const geo = new THREE.CylinderGeometry(r, r, len, opts.seg ?? 14, 1, !!opts.open);
    const rot = axis === 'x' ? new THREE.Euler(0, 0, Math.PI / 2) : axis === 'z' ? new THREE.Euler(Math.PI / 2, 0, 0) : null;
    const m = this.add(geo, mat, new THREE.Vector3(x, y, z), rot, opts);
    if (opts.collide) {
      const hx = axis === 'x' ? len / 2 : r, hy = axis === 'y' ? len / 2 : r, hz = axis === 'z' ? len / 2 : r;
      this.g.physics.fixedBox(x, y, z, hx, hy, hz, undefined, { kind: 'static' });
    }
    return m;
  }

  finalize() {
    let draws = 0;
    for (const { mat, geos, shadow } of this.batches.values()) {
      // merge needs consistent attributes
      const norm = geos.map((g) => {
        const ng = g.index ? g.toNonIndexed() : g;
        for (const k of Object.keys(ng.attributes)) if (!['position', 'normal', 'uv'].includes(k)) ng.deleteAttribute(k);
        if (!ng.attributes.uv) ng.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(ng.attributes.position.count * 2), 2));
        return ng;
      });
      const merged = mergeGeometries(norm, false);
      if (!merged) continue;
      // world-space UVs so concrete texture scale is consistent everywhere
      if (mat.map) worldUV(merged);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      draws++;
    }
    this.batches.clear();
    return draws;
  }
}

// triplanar-ish box projection into UVs (metres)
function worldUV(geo) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); }
    else if (ax >= az) { u = p.getZ(i); v = p.getY(i); }
    else { u = p.getX(i); v = p.getY(i); }
    uv.setXY(i, u, v);
  }
}

export function buildAlley(game) {
  const B = new Builder(game);
  const { m } = B;
  const D = game.destruction;
  const scene = game.scene;
  const panels = {};

  // shared infill materials (inner plaster, fracture core)
  const innerMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: plasterMap(), roughness: 0.92, vertexColors: true });
  // fracture faces meet the facade surface exactly at cell edges: push them back in depth so the
  // intact slab never shows a z-fighting crack network (they still read normally inside holes)
  const sideMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: fractureMap(), roughness: 0.97, vertexColors: true, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 6 });
  const outerMat = (tex, rough = 0.8) => new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, roughness: rough, metalness: 0, vertexColors: true });

  // ---------------------------------------------------------------- ground
  const gt = groundTexture(2048, 80);
  const gctx = gt.ctx, ppm = gt.ppm;
  const G = (x, z) => [(x + 40) * ppm, (z + 40) * ppm];
  // painted bays and lanes
  gctx.fillStyle = 'rgba(240,185,42,0.85)';
  for (const z of [-10.5, -1]) { const [x0, y0] = G(-16, z); gctx.fillRect(x0, y0, 30 * ppm, 0.18 * ppm); }
  gctx.fillStyle = 'rgba(235,232,225,0.8)';
  for (let x = -14; x < 16; x += 3) { const [x0, y0] = G(x, 4); gctx.fillRect(x0, y0, 1.6 * ppm, 0.2 * ppm); }
  // loading bay hatching
  gctx.save();
  { const [x0, y0] = G(9.5, -14); gctx.beginPath(); gctx.rect(x0, y0, 5 * ppm, 5 * ppm); gctx.clip(); }
  gctx.strokeStyle = 'rgba(240,185,42,0.75)'; gctx.lineWidth = 0.22 * ppm;
  for (let k = -10; k < 12; k += 0.9) { const [a, b] = G(9.5 + k, -14); const [c2, d2] = G(14.5 + k, -9); gctx.beginPath(); gctx.moveTo(a, b); gctx.lineTo(c2, d2); gctx.stroke(); }
  gctx.restore();
  // big bay number on the ground
  gctx.save();
  { const [x0, y0] = G(-12.5, 9); gctx.translate(x0, y0); }
  gctx.fillStyle = 'rgba(235,232,225,0.55)';
  gctx.font = `800 ${4 * ppm}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  gctx.fillText('04', 0, 0);
  gctx.restore();
  // drain channel
  { const [x0, y0] = G(-21, 1.2); gctx.fillStyle = 'rgba(25,25,26,0.85)'; gctx.fillRect(x0, y0, 38 * ppm, 0.35 * ppm); }
  const groundTex = toTexture(gt.canvas, 1);
  groundTex.wrapS = groundTex.wrapT = THREE.ClampToEdgeWrapping;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.88, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0x8a867f, roughness: 0.95 }));
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.02;
  outer.receiveShadow = true;
  scene.add(outer);
  game.physics.fixedBox(0, -0.5, 0, 300, 0.5, 300, undefined, { kind: 'ground' });

  // ================================================================ BLOCK A (north)
  const FZ = -14; // facade outer plane
  const colX = [-15, -9, -3, 3, 9, 15];
  const designA = {
    ops: [
      ops.fill('#e6e0d2'),
      ops.hlines('rgba(80,70,60,0.10)', 0.6),
      ops.ties('rgba(70,62,54,0.35)', 1.2, 0.9),
      ops.rect('#1e9e98', 0.45, 0.35, 5.1, 3.25),
      ops.text('SERVICE', '#e6e0d2', 0.85, 2.7, 0.42, { spacing: 0.04 }),
      ops.text('04', '#e6e0d2', 0.85, 0.9, 1.7),
      ops.rect('#ff5a1f', 0, 3.6, 30, 0.55),
      ops.rect('#1f2c3a', 0, 4.27, 30, 0.07),
      ops.text('A7', '#1f2c3a', 13.0, 0.95, 2.5),
      ops.rect('#1f2c3a', 18.45, 0.35, 0.22, 3.25),
      ops.text('LOAD', '#1f2c3a', 18.95, 0.85, 0.5, { spacing: 0.03 }),
      ops.text('→', '#ff5a1f', 18.95, 1.7, 0.9),
      // upper floor
      ops.circle('#1f2c3a', 3.0, 10.3, 1.55),
      ops.circle('#e6e0d2', 3.0, 10.3, 1.05),
      ops.rect('#1f2c3a', 3.0, 8.75, 1.55, 3.1),
      ops.rect('#ff5a1f', 12.45, 11.55, 5.1, 0.22),
      ops.text('INTAKE  CONTROL', '#1f2c3a', 12.75, 10.95, 0.32, { spacing: 0.05 }),
      ops.rect('#1f2c3a', 24.45, 7.4, 0.5, 4.8),
      ops.rect('#1e9e98', 25.2, 7.4, 0.18, 4.8),
      ops.text('07', '#1f2c3a', 26.0, 8.0, 1.6),
    ],
  };
  const mkPanel = (name, design, s0, y0, w, h, place, opts = {}) => {
    const tex = paintPanel(design, s0, y0, w, h, opts.ppm ?? 80);
    const p = D.addPanel({
      name, width: w, height: h, thickness: opts.thickness ?? 0.4, seed: opts.seed ?? Math.floor(s0 * 31 + y0 * 7 + 3),
      origin: place.origin, u: place.u, v: new THREE.Vector3(0, 1, 0),
      materials: [outerMat(tex, opts.rough ?? 0.8), innerMat, sideMat],
      anchors: opts.anchors, hp: opts.hp, supportRatio: opts.supportRatio, rMin: opts.rMin, rMax: opts.rMax,
      debrisTint: new THREE.Color(opts.tint ?? 0xd9d2c3),
    });
    panels[name] = p;
    return p;
  };
  const facadeA = (name, x0, y0, w, h, opts) => mkPanel(name, designA, x0 + 15, y0, w, h, { origin: new THREE.Vector3(x0, y0, FZ), u: new THREE.Vector3(1, 0, 0) }, opts);

  // ground floor infill bays 0..3 (bay 4 is the open loading bay)
  for (let i = 0; i < 4; i++) facadeA(`A-g${i}`, colX[i] + 0.45, 0.35, 5.1, 6.25);
  // upper floor: solid bays 0,2,4; ribbon windows in bays 1,3
  for (const i of [0, 2, 4]) facadeA(`A-u${i}`, colX[i] + 0.45, 7.4, 5.1, 4.8, { anchors: { top: 1.2 } });
  for (const i of [1, 3]) {
    facadeA(`A-s${i}`, colX[i] + 0.45, 7.4, 5.1, 1.1);
    facadeA(`A-h${i}`, colX[i] + 0.45, 10.5, 5.1, 1.7, { anchors: { top: 1.5 } });
  }

  // permanent skeleton: columns, slab edge, roof beam, plinth
  for (const x of colX) {
    B.span(x - 0.45, 0, FZ + 0.28, x + 0.45, 13.4, FZ - 0.75, m.bone, { r: 0.14 });
    B.span(x - 0.3, 0, FZ + 0.31, x + 0.3, 0.35, FZ + 0.2, m.graphite, { collide: false });
  }
  B.span(-15.5, 6.6, FZ + 0.18, 15.5, 7.4, FZ - 0.75, m.bone, { r: 0.12 });
  B.span(-15.5, 6.95, FZ + 0.2, 15.5, 7.05, FZ + 0.17, m.orange, { collide: false });
  B.span(-15.6, 12.2, FZ + 0.35, 15.6, 13.4, FZ - 0.8, m.bone, { r: 0.3 });
  B.span(-15.6, 12.15, FZ + 0.36, 15.6, 12.25, FZ + 0.3, m.ink, { collide: false });
  B.span(-15, 0, FZ + 0.12, 15, 0.35, FZ - 0.4, m.boneDark);
  // window surrounds + mullions for ribbon bays
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x2c4550, roughness: 0.06, metalness: 0.9, transparent: true, opacity: 0.55, envMapIntensity: 1.4 });
  for (const i of [1, 3]) {
    const x0 = colX[i] + 0.45, x1 = colX[i + 1] - 0.45;
    B.span(x0, 8.42, FZ + 0.25, x1, 8.55, FZ - 0.45, m.graphite);
    B.span(x0, 10.45, FZ + 0.18, x1, 10.55, FZ - 0.45, m.graphite);
    for (let k = 0; k <= 3; k++) {
      const x = x0 + (k / 3) * (x1 - x0);
      B.span(x - 0.06, 8.55, FZ + 0.05, x + 0.06, 10.45, FZ - 0.2, m.graphite);
      if (k < 3) {
        const xm = x0 + ((k + 0.5) / 3) * (x1 - x0);
        D.addGlass(new THREE.Vector3(xm, 9.5, FZ - 0.1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), (x1 - x0) / 6 - 0.06, 0.95, glassMat);
      }
    }
  }
  // loading bay: heavy lintel with chevrons, half-raised roll shutter
  {
    const [cv, cx] = canvas(512, 64);
    ops.chevrons('#f0b92a', '#1f2c3a', 0, 0, 512, 64, 40)(cx);
    const chev = toTexture(cv, 1);
    chev.wrapS = THREE.RepeatWrapping;
    const chevMat = new THREE.MeshStandardMaterial({ map: chev, roughness: 0.6 });
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(5.1, 0.5, 0.2), [m.graphite, m.graphite, m.graphite, m.graphite, chevMat, m.graphite]);
    lintel.position.set(12, 6.1, FZ + 0.12);
    lintel.castShadow = true;
    scene.add(lintel);
    B.span(9.45, 5.3, FZ + 0.05, 14.55, 6.35, FZ - 0.35, m.graphite);
    // shutter slats
    for (let k = 0; k < 6; k++) B.span(9.6, 5.3 - k * 0.16 - 0.14, FZ - 0.25, 14.4, 5.3 - k * 0.16, FZ - 0.32, m.galv, { collide: false });
    for (const s of [-1, 1]) B.span(12 + s * 2.55 - 0.1, 0, FZ - 0.1, 12 + s * 2.55 + 0.1, 6.35, FZ - 0.4, m.yellow, { collide: false });
  }
  // service spine on column x=-3: duct + pipes, roof to ground
  {
    const z = FZ + 0.65;
    B.span(-3.5, 0.4, z - 0.25, -2.5, 15.2, z + 0.25, m.galv, { r: 0.08 });
    for (let y = 1.5; y < 15; y += 1.6) B.span(-3.6, y, z - 0.32, -2.4, y + 0.08, z + 0.32, m.graphite, { collide: false });
    B.cyl(0.13, 15, m.teal, -2.2, 7.6, FZ + 0.55, 'y', { collide: false });
    B.cyl(0.09, 15, m.orange, -1.95, 7.6, FZ + 0.48, 'y', { collide: false });
    B.cyl(0.07, 13.2, m.yellow, -3.75, 6.8, FZ + 0.45, 'y', { collide: false });
    B.span(-3.8, 0, z - 0.4, -2.2, 0.5, z + 0.45, m.graphite);
  }
  // roof: slab, HVAC, vent stack, sign frame, mast
  B.span(-15.5, 12.2, -26.5, 15.5, 12.6, FZ - 0.4, m.boneDark);
  B.span(-12, 12.6, -24, -6, 14.8, -18, m.galv, { r: 0.25 });
  for (let k = 0; k < 3; k++) B.cyl(0.85, 0.35, m.graphite, -10.2 + k * 2.1, 14.95, -21, 'y', { collide: false, seg: 20 });
  B.span(-4.5, 12.6, -22, -1, 16.2, -19, m.bone, { r: 0.3 });
  B.cyl(0.9, 6.5, m.galv, 5, 15.8, -22, 'y', { seg: 20 });
  B.cyl(1.05, 0.25, m.graphite, 5, 19.1, -22, 'y', { collide: false, seg: 20 });
  // roof sign frame: big graphic numeral on an open steel frame
  {
    const [cv, cx] = canvas(512, 256);
    cx.fillStyle = '#ff5a1f'; cx.fillRect(0, 0, 512, 256);
    cx.fillStyle = '#1f2c3a'; cx.fillRect(0, 210, 512, 46);
    cx.fillStyle = '#f4efe4'; cx.font = '800 190px "Helvetica Neue", Helvetica, Arial, sans-serif'; cx.fillText('A7', 30, 190);
    cx.fillStyle = '#1f2c3a'; cx.font = '700 34px "Helvetica Neue", Helvetica, Arial, sans-serif'; cx.fillText('NORTH INTAKE', 300, 80); cx.fillText('BLOCK', 300, 120);
    const t = toTexture(cv, 1);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(7, 3.5), new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 }));
    sign.position.set(8, 16.2, FZ - 1.2);
    sign.castShadow = true;
    scene.add(sign);
    for (const x of [5, 11]) B.span(x - 0.08, 12.6, FZ - 1.4, x + 0.08, 18.1, FZ - 1.25, m.graphite, { collide: false });
    B.span(4.5, 14.3, FZ - 1.4, 11.5, 14.42, FZ - 1.3, m.graphite, { collide: false });
  }
  B.cyl(0.06, 9, m.steel, -13, 17, -24, 'y', { collide: false, seg: 6 });
  B.box(0.3, 0.3, 0.3, m.signRed, -13, 21.5, -24, { collide: false, shadow: false });

  // ---------- interior of block A (shallow, warm, revealed by destruction)
  B.span(-15.5, 0, -26.6, 15.5, 12.6, -26.0, m.warm);
  B.span(-15.6, 0, -26.6, -15.0, 12.6, FZ - 0.4, m.bone);
  B.span(15.0, 0, -26.6, 15.6, 12.6, FZ - 0.4, m.bone);
  B.span(-15, 6.6, -26.0, 15, 7.4, FZ - 0.4, m.boneDark); // upper slab
  B.span(-15, -0.05, -26.0, 15, 0.02, FZ - 0.4, m.floor, { collide: false });
  // interior columns
  for (const x of [-3, 3, 9]) B.span(x - 0.35, 0, -21.35, x + 0.35, 6.6, -20.65, m.bone, { r: 0.08 });
  // partition walls (destructible, thinner) behind bays 2/3
  const designP = { ops: [ops.fill('#cfd6cc'), ops.rect('#c8442a', 0, 1.0, 12, 0.18), ops.rect('#1f2c3a', 0, 0, 12, 0.35), ops.text('MECH  3', '#1f2c3a', 0.4, 1.5, 0.5, { spacing: 0.04 })] };
  for (const [i, x0, x1] of [[0, -2.65, 2.65], [1, 3.35, 8.65]]) {
    mkPanel(`A-p${i}`, designP, x0 + 3, 0, x1 - x0, 6.6, { origin: new THREE.Vector3(x0, 0, -20.75), u: new THREE.Vector3(1, 0, 0) }, { thickness: 0.25, hp: 70, tint: 0xd2d8cf, rMin: 0.32, rMax: 0.6 });
  }
  // machinery: large press block (orange casing) + teal generator behind partition
  {
    B.span(-12.5, 0, -24.5, -5, 3.6, -18.5, m.orange, { r: 0.25 });
    B.span(-12, 3.6, -24, -5.5, 4.6, -19, m.graphite, { r: 0.1 });
    B.span(-11, 4.6, -23, -6.5, 5.6, -20, m.galv, { r: 0.12 });
    B.span(-12.6, 0.8, -18.45, -4.9, 1.0, -18.4, m.ink, { collide: false });
    B.span(-1.5, 0, -25.5, 7.5, 3.2, -22.3, m.teal, { r: 0.3 });
    B.span(-1, 3.2, -25, 3, 4.6, -23, m.graphite, { r: 0.1 });
    B.cyl(0.6, 4, m.galv, 5.5, 4.2, -24, 'y', { seg: 18 });
    // pipe runs on back wall
    const pipes = [[m.orange, 0.22, 5.7], [m.teal, 0.3, 5.0], [m.yellow, 0.14, 4.4], [m.galv, 0.4, 6.1]];
    for (const [mat, r, y] of pipes) B.cyl(r, 30, mat, 0, y, -25.6 + r, 'x', { collide: false });
    for (const x of [-13, -6, 1, 8, 13]) B.cyl(0.18, 5.5, m.orange, x, 3, -25.7, 'y', { collide: false });
    // cable trays + light bars under the slab
    for (const z of [-17, -20.5, -24]) {
      B.span(-14.5, 6.25, z - 0.3, 14.5, 6.32, z + 0.3, m.galv, { collide: false });
      for (let x = -12; x <= 12; x += 6) B.span(x - 1.2, 6.1, z - 0.12, x + 1.2, 6.2, z + 0.12, m.lampWarm, { collide: false, shadow: false });
    }
    // crates / pallets
    for (let k = 0; k < 5; k++) B.box(1.4, 1.1, 1.2, k % 2 ? m.boneDark : m.ink, 10.5 + (k % 2) * 1.6, 0.55 + Math.floor(k / 2) * 1.1 * 0, -24.4 + Math.floor(k / 2) * 1.5, { r: 0.04 });
    // upper floor office
    B.span(-15, 7.4, -26, 15, 7.45, FZ - 0.4, m.floor, { collide: false });
    for (let x = -12; x <= 12; x += 6) B.span(x - 1.5, 11.95, -20.1, x + 1.5, 12.05, -19.9, m.lampCool, { collide: false, shadow: false });
    B.span(-15, 7.4, -26, 15, 12.2, -25.9, m.teal, { collide: false });
    for (let x = -13; x < 13; x += 4.2) B.span(x, 7.4, -25.6, x + 2.8, 9.6, -24.4, m.graphite, { r: 0.06 });
    for (let x = -11; x < 13; x += 6) B.span(x, 7.4, -19, x + 0.12, 9.3, -16, m.ink, { collide: false });
  }
  const iLights = [];
  for (const [x, y, z, c, i] of [[-8, 5.6, -19.5, 0xffc68a, 70], [3, 5.6, -18, 0xffc68a, 60], [4, 5.4, -23.5, 0xffb070, 40], [-2, 11, -20, 0xcfeeff, 40], [23, 7.5, -2, 0xffc68a, 50]]) {
    const l = new THREE.PointLight(c, i, 16, 1.4);
    l.position.set(x, y, z);
    scene.add(l);
    iLights.push(l);
  }

  // ---------- attachments on A infill: AC units, conduit, blade sign
  {
    const acMat = new THREE.MeshStandardMaterial({ color: 0xd4d0c6, roughness: 0.6, metalness: 0.3 });
    const grill = new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.7, metalness: 0.4 });
    const mkAC = (panel, lx, ly, name) => {
      const g = new THREE.Group();
      g.name = name;
      const body = new THREE.Mesh(new RoundedBoxGeometry(1.3, 0.85, 0.7, 2, 0.06), acMat);
      body.castShadow = body.receiveShadow = true;
      g.add(body);
      const fan = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 16), grill);
      fan.rotation.x = Math.PI / 2;
      fan.position.set(-0.25, 0, 0.36);
      g.add(fan);
      const br = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 0.8), grill);
      br.position.y = -0.47;
      g.add(br);
      const wp = panel.toWorld(new THREE.Vector3(lx, ly, 0.4));
      g.position.copy(wp);
      scene.add(g);
      new Attachment(D, panel, g, { half: new THREE.Vector3(0.65, 0.47, 0.4), mass: 450, mountsLocal: [{ x: lx - 0.5, y: ly - 0.4 }, { x: lx + 0.5, y: ly - 0.4 }], minMounts: 1 });
    };
    mkAC(panels['A-u2'], 1.6, 1.6, 'ac-1');
    mkAC(panels['A-u2'], 3.4, 2.9, 'ac-2');
    mkAC(panels['A-g1'], 3.9, 5.2, 'ac-3');
    // conduit run across bay 1 ground floor
    const cond = new THREE.Group();
    cond.name = 'conduit';
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 4.9, 10), m.orange);
    pipe.rotation.z = Math.PI / 2;
    pipe.castShadow = true;
    cond.add(pipe);
    for (const x of [-2, 0, 2]) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.3, 0.25), m.graphite);
      c.position.set(x, 0, -0.1);
      cond.add(c);
    }
    cond.position.copy(panels['A-g2'].toWorld(new THREE.Vector3(2.55, 4.9, 0.18)));
    scene.add(cond);
    new Attachment(D, panels['A-g2'], cond, { half: new THREE.Vector3(2.45, 0.15, 0.15), mass: 300, mountsLocal: [{ x: 0.55, y: 4.9 }, { x: 2.55, y: 4.9 }, { x: 4.55, y: 4.9 }], minMounts: 2 });
    // blade sign
    const [cv, cx] = canvas(128, 512);
    cx.fillStyle = '#1f2c3a'; cx.fillRect(0, 0, 128, 512);
    cx.fillStyle = '#ff5a1f'; cx.fillRect(0, 0, 128, 18); cx.fillRect(0, 494, 128, 18);
    cx.fillStyle = '#f4efe4'; cx.font = '800 64px "Helvetica Neue", Helvetica, Arial, sans-serif';
    'KILN'.split('').forEach((ch, k) => cx.fillText(ch, 38, 110 + k * 100));
    const st = toTexture(cv, 1);
    st.wrapS = st.wrapT = THREE.ClampToEdgeWrapping;
    const sign = new THREE.Group();
    sign.name = 'blade-sign';
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.2, 0.9), [m.graphite, m.graphite, m.graphite, m.graphite, new THREE.MeshStandardMaterial({ map: st, roughness: 0.5 }), new THREE.MeshStandardMaterial({ map: st, roughness: 0.5 })]);
    face.rotation.y = Math.PI / 2;
    face.castShadow = true;
    sign.add(face);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1.3), m.graphite);
    arm.position.set(0, 1.5, -0.45);
    sign.add(arm);
    sign.position.copy(panels['A-g0'].toWorld(new THREE.Vector3(4.6, 4.4, 1.0)));
    scene.add(sign);
    new Attachment(D, panels['A-g0'], sign, { half: new THREE.Vector3(0.45, 1.6, 0.1), mass: 260, mountsLocal: [{ x: 4.6, y: 5.9 }, { x: 4.6, y: 3.0 }], minMounts: 2 });
  }

  // ================================================================ BLOCK B (east warehouse)
  const BX = 17;
  const colZ = [-12.5, -5, 2, 9.5];
  const designB = {
    ops: [
      ops.fill('#d8dcd3'),
      ops.hlines('rgba(60,70,70,0.12)', 0.4, 0.01),
      ops.rect('#24364a', 0, 0, 22, 2.6),
      ops.rect('#f0b92a', 0, 2.6, 22, 0.14),
      ops.text('03', '#d8dcd3', 15.6, 0.45, 1.75),
      ops.text('WAREHOUSE  B', '#24364a', 0.9, 4.6, 0.42, { spacing: 0.05 }),
      ops.rect('#1e9e98', 3.2, 2.74, 0.25, 3.2),
      ops.rect('#1e9e98', 3.6, 2.74, 0.25, 3.2),
    ],
  };
  for (const [i, z0, z1] of [[0, colZ[0] + 0.45, colZ[1] - 0.45], [2, colZ[2] + 0.45, colZ[3] - 0.45]]) {
    mkPanel(`B-g${i}`, designB, z0 + 12.5, 0.3, z1 - z0, 5.9, { origin: new THREE.Vector3(BX, 0.3, z0), u: new THREE.Vector3(0, 0, 1) }, { tint: 0xc7ccc4, thickness: 0.35 });
  }
  for (const z of colZ) B.span(BX + 0.75, 0, z - 0.45, BX - 0.3, 9.2, z + 0.45, m.boneDark, { r: 0.12 });
  B.span(BX - 0.25, 6.2, -12.9, BX + 0.6, 6.7, 9.9, m.graphite);
  B.span(BX - 0.1, 7.9, -12.9, BX + 0.6, 9.2, 9.9, m.bone, { r: 0.1 });
  B.span(BX - 0.05, 0, -12.9, BX + 0.5, 0.3, 9.9, m.boneDark);
  // clerestory glazing
  for (let z = -12; z < 9.4; z += 2.2) D.addGlass(new THREE.Vector3(BX + 0.2, 7.3, z + 1.05), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), 1.0, 0.55, glassMat);
  B.span(BX + 0.1, 6.7, -12.9, BX + 0.6, 7.9, 9.9, m.ink, { collide: true, dynamic: false });
  // middle bay: closed roll door (permanent)
  {
    const [cv, cx] = canvas(256, 256);
    cx.fillStyle = '#c95a2a'; cx.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 10) { cx.fillStyle = 'rgba(0,0,0,0.18)'; cx.fillRect(0, y, 256, 3); cx.fillStyle = 'rgba(255,255,255,0.08)'; cx.fillRect(0, y + 4, 256, 2); }
    grain(cx, 256, 256, 77, { count: 600, min: 0.5, max: 2, alpha: 0.2 });
    const dt = toTexture(cv, 1);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.2, 5.9, 6.1), new THREE.MeshStandardMaterial({ map: dt, roughness: 0.55, metalness: 0.5 }));
    door.position.set(BX + 0.15, 3.25, (colZ[1] + colZ[2]) / 2);
    door.castShadow = door.receiveShadow = true;
    scene.add(door);
    game.physics.fixedBox(door.position.x, door.position.y, door.position.z, 0.1, 2.95, 3.05);
  }
  B.span(BX + 0.6, 0, -12.9, 29.5, 9.2, -12.4, m.bone);
  B.span(BX + 0.6, 0, 9.4, 29.5, 9.2, 9.9, m.bone);
  B.span(29, 0, -12.9, 29.5, 9.2, 9.9, m.bone);
  B.span(BX + 0.6, 9.2, -12.9, 29.5, 9.6, 9.9, m.boneDark);
  B.span(BX + 0.5, -0.05, -12.4, 29, 0.02, 9.4, m.floor, { collide: false });
  for (let z = -10; z < 9; z += 5) B.box(1.6, 3.2, 1.6, z % 2 ? m.ink : m.teal, 26.5, 1.6, z, { r: 0.05 });
  B.span(19, 0, -11.5, 22, 2.2, -9.5, m.orange, { r: 0.1 });
  // roof gear B
  B.span(21, 9.6, -6, 25, 11.6, -2, m.galv, { r: 0.2 });
  for (let z = -11; z < 9; z += 1.2) B.box(0.1, 0.4, 0.1, m.yellow, BX - 0.35, 9.3, z, { collide: false });

  // ================================================================ courtyard
  // screen wall S1 (free-standing; only bottom + posts support it)
  const designS = {
    ops: [ops.fill('#e3ddd0'), ops.ties('rgba(70,62,54,0.35)', 1.0, 1.0, 0.5, 0.5), ops.rect('#1e9e98', 0, 0, 7, 1.25), ops.chevrons('#f0b92a', '#1f2c3a', 0, 4.25, 6.5, 0.55, 0.32), ops.text('S1', '#1f2c3a', 0.4, 2.2, 1.3)],
  };
  mkPanel('S1', designS, 0, 0, 6.5, 4.8, { origin: new THREE.Vector3(-16.5, 0, -2.3), u: new THREE.Vector3(1, 0, 0) }, { thickness: 0.45, anchors: { bottom: 3, left: 1.0, right: 1.0, top: 0 }, supportRatio: 0.1, tint: 0xd8d2c5 });
  for (const x of [-16.6, -9.9]) {
    B.span(x - 0.15, 0, -2.25, x + 0.15, 5.2, -2.85, m.graphite);
    B.span(x - 0.35, 0, -2.0, x + 0.35, 0.25, -3.1, m.graphite);
  }
  // jersey barriers
  for (let k = 0; k < 4; k++) {
    const x = -6 + k * 2.1;
    B.span(x - 1.0, 0, 6.6, x + 1.0, 0.25, 7.4, m.boneDark, { r: 0.05 });
    B.span(x - 1.0, 0.25, 6.82, x + 1.0, 0.85, 7.18, m.boneDark, { r: 0.05 });
    B.span(x - 0.98, 0.5, 6.81, x + 0.98, 0.62, 6.8, m.orange, { collide: false });
  }
  // container (west)
  {
    const [cv, cx] = canvas(512, 256);
    cx.fillStyle = '#d6512a'; cx.fillRect(0, 0, 512, 256);
    for (let x = 0; x < 512; x += 16) { cx.fillStyle = 'rgba(0,0,0,0.2)'; cx.fillRect(x, 0, 4, 256); cx.fillStyle = 'rgba(255,255,255,0.08)'; cx.fillRect(x + 6, 0, 3, 256); }
    cx.fillStyle = '#f4efe4'; cx.font = '800 54px "Helvetica Neue", Helvetica, Arial, sans-serif'; cx.fillText('CTX 2210', 40, 90);
    cx.fillStyle = '#1f2c3a'; cx.fillRect(0, 200, 512, 26);
    grain(cx, 512, 256, 91, { count: 900, min: 0.5, max: 3, alpha: 0.25 });
    const t = toTexture(cv, 1);
    const cm = new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, metalness: 0.4 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(2.45, 2.6, 6.1), cm);
    box.position.set(-17.8, 1.3, 9);
    box.castShadow = box.receiveShadow = true;
    scene.add(box);
    game.physics.fixedBox(-17.8, 1.3, 9, 1.225, 1.3, 3.05);
    const box2 = box.clone();
    box2.position.set(-17.6, 3.9, 10.2);
    box2.rotation.y = 0.06;
    scene.add(box2);
    game.physics.fixedBox(-17.6, 3.9, 10.2, 1.225, 1.3, 3.05, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.06, 0)));
  }
  // light poles
  for (const [x, z, a] of [[-12.5, 12, 0.6], [7, 13, -0.5], [14, -9, -2.4]]) {
    B.cyl(0.13, 9, m.graphite, x, 4.5, z, 'y', { collide: true, seg: 8 });
    const arm = B.box(0.12, 0.12, 2.2, m.graphite, x + Math.sin(a) * 1.0, 8.9, z + Math.cos(a) * 1.0, { ry: a, collide: false });
    B.box(0.5, 0.18, 0.9, m.graphite, x + Math.sin(a) * 2.1, 8.85, z + Math.cos(a) * 2.1, { ry: a, collide: false });
    B.box(0.4, 0.04, 0.75, m.lampWarm, x + Math.sin(a) * 2.1, 8.75, z + Math.cos(a) * 2.1, { ry: a, collide: false, shadow: false });
  }
  // bollards
  for (let z = -11; z < 10; z += 3.2) {
    B.cyl(0.16, 1.0, m.yellow, BX - 1.4, 0.5, z, 'y', { collide: true, seg: 10 });
    B.cyl(0.165, 0.12, m.ink, BX - 1.4, 0.82, z, 'y', { collide: false, seg: 10 });
  }

  // ================================================================ west: retaining wall + pipe rack
  B.span(-22.5, 0, -30, -21.5, 5, 26, m.bone);
  for (let z = -28; z < 26; z += 4) B.span(-21.5, 0, z - 0.25, -21.2, 5, z + 0.25, m.boneDark, { collide: false });
  B.span(-23, 5, -30, -21.3, 5.3, 26, m.boneDark);
  for (let z = -26; z < 24; z += 6) {
    B.span(-21.0, 0, z - 0.15, -20.7, 7.2, z + 0.15, m.graphite);
    B.span(-23.5, 7.0, z - 0.15, -20.5, 7.2, z + 0.15, m.graphite, { collide: false });
  }
  B.cyl(0.42, 56, m.bone, -22.0, 7.65, -2, 'z', { collide: false, seg: 16 });
  B.cyl(0.32, 56, m.teal, -21.1, 7.55, -2, 'z', { collide: false, seg: 14 });
  B.cyl(0.2, 56, m.orange, -23.0, 7.45, -2, 'z', { collide: false, seg: 12 });
  B.cyl(0.14, 56, m.yellow, -21.6, 6.95, -2, 'z', { collide: false, seg: 10 });
  // external stair on block A west end
  {
    const x0 = -21.0, x1 = -18.2;
    for (let k = 0; k < 22; k++) {
      const y = 0.33 * (k + 1), z = 4 - k * 0.42;
      B.span(x0, y - 0.06, z - 0.4, x1, y, z, m.galv, { collide: false });
    }
    B.span(x0 - 0.1, 0, -6, x0, 7.4, 4.2, m.graphite, { collide: false, shadow: true, r: 0 });
    B.span(x0, 7.2, -14, -15.6, 7.4, -5, m.galv);
    B.span(x0, 7.4, -14, x0 + 0.06, 8.5, -5, m.yellow, { collide: false });
    for (let z = -13; z < -5; z += 2) B.cyl(0.08, 7.2, m.graphite, x1 + 0.2, 3.6, z, 'y', { collide: true, seg: 8 });
    B.span(-15.6, 7.4, -13.2, -15.4, 10, -11.6, m.ink, { collide: false });
  }

  // ================================================================ south: alley mouth + block C
  B.span(-22.5, 0, 22, 17, 11, 30, m.bone);
  {
    const [cv, cx] = canvas(1024, 256);
    cx.fillStyle = '#e7e1d3'; cx.fillRect(0, 0, 1024, 256);
    cx.fillStyle = '#1f2c3a'; cx.fillRect(0, 150, 1024, 106);
    cx.fillStyle = '#ff5a1f'; cx.fillRect(0, 128, 1024, 22);
    cx.fillStyle = '#1e9e98'; cx.fillRect(620, 0, 60, 128); cx.fillRect(700, 0, 20, 128);
    cx.fillStyle = '#e7e1d3'; cx.font = '800 80px "Helvetica Neue", Helvetica, Arial, sans-serif'; cx.fillText('C', 60, 236);
    grain(cx, 1024, 256, 33, { count: 3000, min: 0.5, max: 2, alpha: 0.1 });
    const t = toTexture(cv, 1);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    const mural = new THREE.Mesh(new THREE.PlaneGeometry(39.5, 9.75), new THREE.MeshStandardMaterial({ map: t, roughness: 0.85 }));
    mural.position.set(-2.75, 4.9, 21.98);
    mural.rotation.y = Math.PI;
    mural.receiveShadow = true;
    scene.add(mural);
  }
  for (let x = -20; x < 17; x += 6) B.span(x - 0.35, 0, 21.6, x + 0.35, 11.4, 22.05, m.boneDark, { r: 0.08 });
  B.span(-22.5, 11, 21.4, 17, 11.6, 22.1, m.bone, { r: 0.15 });
  // overhead gantry across the alley
  {
    B.span(-20.5, 0, 16.6, -20.1, 8.2, 17.0, m.graphite);
    B.span(16.2, 0, 16.6, 16.6, 8.2, 17.0, m.graphite);
    B.span(-20.5, 7.8, 16.6, 16.6, 8.2, 17.0, m.graphite, { collide: false });
    B.span(-20.5, 8.8, 16.6, 16.6, 9.0, 17.0, m.graphite, { collide: false });
    for (let x = -20; x < 16; x += 1.2) B.box(0.06, 0.95, 0.06, m.graphite, x, 8.4, 16.8, { rz: 0.6, collide: false });
    const [cv, cx] = canvas(512, 128);
    cx.fillStyle = '#1f2c3a'; cx.fillRect(0, 0, 512, 128);
    cx.fillStyle = '#f0b92a'; cx.fillRect(0, 0, 14, 128);
    cx.fillStyle = '#f4efe4'; cx.font = '800 64px "Helvetica Neue", Helvetica, Arial, sans-serif'; cx.fillText('ALLEY 4', 40, 88);
    cx.fillStyle = '#ff5a1f'; cx.font = '800 64px "Helvetica Neue", Helvetica, Arial, sans-serif'; cx.fillText('↑', 400, 88);
    const t = toTexture(cv, 1);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    for (const side of [-1, 1]) {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(5, 1.25), new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 }));
      s.position.set(-2, 7.2, 16.8 + side * 0.22);
      s.rotation.y = side < 0 ? Math.PI : 0;
      scene.add(s);
    }
    B.span(-4.6, 6.5, 16.5, 0.6, 7.9, 17.1, m.graphite, { collide: false });
  }
  // overhead cables
  {
    const mat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.8 });
    for (const [a, b] of [[[-21.5, 9.5, -8], [17, 8.8, -6]], [[-21.5, 9.2, 4], [17, 8.6, 1]], [[-21.5, 10, 14], [17, 9.4, 12]]]) {
      const p0 = new THREE.Vector3(...a), p1 = new THREE.Vector3(...b);
      const mid = p0.clone().lerp(p1, 0.5); mid.y -= 1.4;
      const curve = new THREE.QuadraticBezierCurve3(p0, mid, p1);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.035, 5), mat);
      tube.castShadow = true;
      scene.add(tube);
    }
  }

  const staticDraws = B.finalize();

  // ---------------------------------------------------------------- floors for cheap particles
  const floors = [
    { x0: -15, x1: 15, z0: -26, z1: -14.2, y: 7.4 },
    { x0: -15.6, x1: 15.6, z0: -26.6, z1: -13.2, y: 13.4 },
    { x0: 17, x1: 29.5, z0: -12.9, z1: 9.9, y: 9.6 },
    { x0: -23, x1: -21.3, z0: -30, z1: 26, y: 5.3 },
    { x0: -19, x1: -16.5, z0: 5.9, z1: 12.1, y: 2.6 },
    { x0: -22.5, x1: 17, z0: 22, z1: 30, y: 11 },
    { x0: -12.5, x1: -5, z0: -24.5, z1: -18.5, y: 3.6 },
    { x0: -1.5, x1: 7.5, z0: -25.5, z1: -22.3, y: 3.2 },
  ];
  const floorAt = (x, z, y) => {
    let best = 0;
    for (const f of floors) if (x > f.x0 && x < f.x1 && z > f.z0 && z < f.z1 && f.y <= y && f.y > best) best = f.y;
    return best;
  };

  return {
    panels,
    floorAt,
    staticDraws,
    interiorLights: iLights,
    spawns: {
      player: { p: new THREE.Vector3(0, 0, 13), yaw: Math.PI },
      target: { p: new THREE.Vector3(-6, 0, -5), yaw: 0 },
    },
    routes: {
      strafe: [new THREE.Vector3(-7.5, 0, -8.6), new THREE.Vector3(7.5, 0, -8.6)],
      cover: [new THREE.Vector3(-9, 0, -5.6), new THREE.Vector3(-13.4, 0, -5.4)],
      inside: [new THREE.Vector3(12, 0, -7.5), new THREE.Vector3(12, 0, -16.8), new THREE.Vector3(6, 0, -17.6)],
      hold: [],
    },
  };
}
