import * as THREE from 'three';
import { mulberry32 } from './voronoi.js';

const rng = mulberry32(1234);

// Camera-facing particle pool on a single instanced draw call.
class Billboards {
  constructor(scene, max, additive, name) {
    this.max = max;
    const base = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.attributes.position);
    g.setAttribute('uv', base.attributes.uv);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aSz = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iCol', this.aCol);
    g.setAttribute('iSz', this.aSz);
    g.instanceCount = 0;
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uFogColor: { value: new THREE.Color() }, uFogDensity: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec3 iPos; attribute vec4 iCol; attribute vec2 iSz;
        varying vec2 vUv; varying vec4 vCol; varying float vSeed; varying float vDepth;
        void main(){
          vUv = uv; vCol = iCol; vSeed = fract(iPos.x*0.37+iPos.z*0.71);
          vec4 mv = modelViewMatrix * vec4(iPos,1.0);
          float c = cos(iSz.y), s = sin(iSz.y);
          vec2 p = position.xy;
          mv.xy += vec2(c*p.x - s*p.y, s*p.x + c*p.y) * iSz.x;
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uFogColor; uniform float uFogDensity;
        varying vec2 vUv; varying vec4 vCol; varying float vSeed; varying float vDepth;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
        float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
        void main(){
          vec2 q = vUv - 0.5;
          float r = length(q) * 2.0;
          float puff = n(q*5.0 + vSeed*17.0)*0.6 + n(q*11.0 - vSeed*9.0)*0.4;
          float a = smoothstep(1.0, 0.25, r + (puff-0.5)*0.55) * vCol.a;
          if (a < 0.004) discard;
          vec3 col = vCol.rgb * (0.82 + puff*0.3);
          ${additive ? '' : 'float f = 1.0 - exp(-uFogDensity*uFogDensity*vDepth*vDepth); col = mix(col, uFogColor, f);'}
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 12 : 10;
    this.mesh.name = name;
    scene.add(this.mesh);
    // simulation state (struct of arrays)
    this.n = 0;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.age = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.rot = new Float32Array(max);
    this.spin = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
  }

  emit(px, py, pz, vx, vy, vz, life, s0, s1, r, g, b, alpha, grav = 0, drag = 1.2) {
    let i = this.n;
    if (i >= this.max) i = Math.floor(rng() * this.max);
    else this.n++;
    this.p[i * 3] = px; this.p[i * 3 + 1] = py; this.p[i * 3 + 2] = pz;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
    this.life[i] = life; this.age[i] = 0; this.size0[i] = s0; this.size1[i] = s1; this.alpha[i] = alpha;
    this.rot[i] = rng() * 6.28; this.spin[i] = (rng() - 0.5) * 1.5; this.grav[i] = grav; this.drag[i] = drag;
  }

  _swap(i, j) {
    const S = (a, k) => { const t = a[i * k]; a[i * k] = a[j * k]; a[j * k] = t; };
    for (const [a, k] of [[this.p, 3], [this.v, 3], [this.col, 3]]) for (let q = 0; q < k; q++) { const t = a[i * k + q]; a[i * k + q] = a[j * k + q]; a[j * k + q] = t; }
    for (const a of [this.life, this.age, this.size0, this.size1, this.alpha, this.rot, this.spin, this.grav, this.drag]) S(a, 1);
  }

  update(dt, floorAt) {
    let i = 0;
    while (i < this.n) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this.n--; if (i !== this.n) this._swap(i, this.n); continue; }
      const o = i * 3;
      const d = Math.exp(-this.drag[i] * dt);
      this.v[o] *= d; this.v[o + 1] = this.v[o + 1] * d - this.grav[i] * dt; this.v[o + 2] *= d;
      this.p[o] += this.v[o] * dt; this.p[o + 1] += this.v[o + 1] * dt; this.p[o + 2] += this.v[o + 2] * dt;
      if (this.grav[i] > 0 && floorAt) {
        const f = floorAt(this.p[o], this.p[o + 2], this.p[o + 1] + 0.5);
        if (this.p[o + 1] < f) { this.p[o + 1] = f; this.v[o + 1] *= -0.3; this.v[o] *= 0.5; this.v[o + 2] *= 0.5; }
      }
      this.rot[i] += this.spin[i] * dt;
      i++;
    }
    const P = this.aPos.array, C = this.aCol.array, Z = this.aSz.array;
    for (let k = 0; k < this.n; k++) {
      const t = this.age[k] / this.life[k];
      P[k * 3] = this.p[k * 3]; P[k * 3 + 1] = this.p[k * 3 + 1]; P[k * 3 + 2] = this.p[k * 3 + 2];
      C[k * 4] = this.col[k * 3]; C[k * 4 + 1] = this.col[k * 3 + 1]; C[k * 4 + 2] = this.col[k * 3 + 2];
      C[k * 4 + 3] = this.alpha[k] * Math.min(1, t * 8) * (1 - t) * (1 - t * 0.3);
      Z[k * 2] = this.size0[k] + (this.size1[k] - this.size0[k]) * (1 - (1 - t) * (1 - t));
      Z[k * 2 + 1] = this.rot[k];
    }
    this.geo.instanceCount = this.n;
    if (this.n) {
      this.aPos.needsUpdate = true;
      this.aCol.needsUpdate = true;
      this.aSz.needsUpdate = true;
    }
  }

  clear() { this.n = 0; this.geo.instanceCount = 0; }
}

export class FX {
  constructor(scene, floorAt) {
    this.scene = scene;
    this.floorAt = floorAt;
    this.dust = new Billboards(scene, 1400, false, 'dust');
    this.glow = new Billboards(scene, 900, true, 'glow');
    // a fixed number of flash lights (constant light count avoids shader recompiles)
    this.lights = [];
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffa860, 0, 18, 1.6);
      l.castShadow = false;
      scene.add(l);
      this.lights.push({ l, t: 0, dur: 0.1, peak: 0 });
    }
    this.glassShards = [];
    this.shake = 0;
  }

  setFog(fog) {
    for (const b of [this.dust]) {
      b.mat.uniforms.uFogColor.value.copy(fog.color);
      b.mat.uniforms.uFogDensity.value = fog.density ?? 0.008;
    }
  }

  flash(pos, color, intensity, dur, dist = 18) {
    let best = this.lights[0];
    for (const s of this.lights) if (s.t <= 0 || s.peak * s.t < best.peak * best.t) best = s;
    best.l.position.copy(pos);
    best.l.color.set(color);
    best.l.distance = dist;
    best.t = 1;
    best.dur = dur;
    best.peak = intensity;
    best.l.intensity = intensity;
  }

  muzzle(pos, dir, big = true) {
    this.flash(pos, 0xffc27a, big ? 160 : 60, 0.07, 14);
    for (let i = 0; i < (big ? 7 : 3); i++) {
      const s = 0.6 + rng() * 1.2;
      this.glow.emit(pos.x + dir.x * i * 0.35, pos.y + dir.y * i * 0.35, pos.z + dir.z * i * 0.35,
        dir.x * 6, dir.y * 6, dir.z * 6, 0.06 + rng() * 0.05, s, s * 1.6, 1.0, 0.62, 0.3, 0.9);
    }
    for (let i = 0; i < (big ? 6 : 3); i++) {
      this.dust.emit(pos.x + dir.x, pos.y + dir.y, pos.z + dir.z, dir.x * (3 + rng() * 4) + (rng() - 0.5) * 2, (rng()) * 1.2, dir.z * (3 + rng() * 4) + (rng() - 0.5) * 2,
        0.8 + rng() * 0.7, 0.6, 2.2, 0.55, 0.53, 0.5, 0.35);
    }
  }

  // Dust plume for broken infill. scale ~ event size.
  impactDust(point, dir, scale, tint) {
    const t = tint ?? { r: 0.8, g: 0.78, b: 0.72 };
    const n = Math.round(14 * scale);
    for (let i = 0; i < n; i++) {
      const sp = 1.5 + rng() * 4 * scale;
      const back = rng() < 0.5 ? -1 : 1;
      const vx = (rng() - 0.5) * 3 + dir.x * sp * back;
      const vy = rng() * 1.8 * scale - 0.3;
      const vz = (rng() - 0.5) * 3 + dir.z * sp * back;
      const s0 = 0.5 + rng() * 0.8 * scale;
      const k = 0.8 + rng() * 0.25;
      this.dust.emit(point.x + (rng() - 0.5) * scale, point.y + (rng() - 0.5) * scale, point.z + (rng() - 0.5) * scale,
        vx, vy, vz, 2.5 + rng() * 3.5 * scale, s0, s0 * (3 + rng() * 3) * Math.sqrt(scale), t.r * k, t.g * k, t.b * k, 0.55, -0.12, 0.9);
    }
    // chips
    for (let i = 0; i < Math.round(10 * scale); i++) {
      this.dust.emit(point.x, point.y, point.z, (rng() - 0.5) * 10 + dir.x * 6, rng() * 7, (rng() - 0.5) * 10 + dir.z * 6,
        0.8 + rng() * 0.6, 0.06, 0.05, t.r * 0.6, t.g * 0.6, t.b * 0.6, 1.0, 12, 0.1);
    }
  }

  landingDust(p, mass) {
    const s = Math.min(1.6, 0.3 + mass / 1500);
    for (let i = 0; i < 5 * s; i++) {
      const a = rng() * 6.28;
      this.dust.emit(p.x, p.y, p.z, Math.cos(a) * 2.5 * s, 0.4 + rng() * 0.6, Math.sin(a) * 2.5 * s, 1.5 + rng() * 2, 0.6 * s, 2.5 * s, 0.72, 0.69, 0.64, 0.4, -0.05, 1.5);
    }
  }

  footDust(p, strength) {
    for (let i = 0; i < 3; i++) {
      const a = rng() * 6.28;
      this.dust.emit(p.x, p.y + 0.1, p.z, Math.cos(a) * 1.8 * strength, 0.3, Math.sin(a) * 1.8 * strength, 0.9 + rng() * 0.8, 0.4, 1.6 * strength, 0.66, 0.63, 0.58, 0.25 * strength, 0, 2.5);
    }
  }

  sparks(p, n, dir, color = [1, 0.7, 0.35], speed = 9) {
    for (let i = 0; i < n; i++) {
      const vx = (rng() - 0.5) * speed + (dir ? dir.x * speed * 0.6 : 0);
      const vy = rng() * speed * 0.7 + (dir ? dir.y * speed * 0.6 : 0);
      const vz = (rng() - 0.5) * speed + (dir ? dir.z * speed * 0.6 : 0);
      this.glow.emit(p.x, p.y, p.z, vx, vy, vz, 0.25 + rng() * 0.45, 0.09, 0.04, color[0], color[1], color[2], 1.0, 14, 0.4);
    }
  }

  explosion(p, scale = 1) {
    this.flash(p, 0xff8a3d, 420 * scale, 0.28, 26);
    for (let i = 0; i < 16 * scale; i++) {
      const a = rng() * 6.28, b = rng() * 3.14;
      const sp = 3 + rng() * 9;
      this.glow.emit(p.x, p.y, p.z, Math.cos(a) * Math.sin(b) * sp, Math.cos(b) * sp * 0.7 + 1, Math.sin(a) * Math.sin(b) * sp,
        0.18 + rng() * 0.3, 0.8 + rng(), 2.6 + rng() * 2.5, 1.0, 0.45 + rng() * 0.25, 0.15, 0.95, -1, 3.5);
    }
    for (let i = 0; i < 22 * scale; i++) {
      const a = rng() * 6.28;
      const sp = 2 + rng() * 6;
      const g = 0.18 + rng() * 0.15;
      this.dust.emit(p.x, p.y, p.z, Math.cos(a) * sp, rng() * 4, Math.sin(a) * sp, 3 + rng() * 4, 0.8, 4 + rng() * 4, g, g * 0.95, g * 0.9, 0.75, -0.25, 1.1);
    }
    this.sparks(p, 22 * scale, null, [1, 0.6, 0.25], 16);
  }

  smoke(p, amount = 1, dark = true) {
    const g = dark ? 0.12 + rng() * 0.08 : 0.5;
    this.dust.emit(p.x, p.y, p.z, (rng() - 0.5) * 0.6, 1.2 + rng() * 0.8, (rng() - 0.5) * 0.6, 1.8 + rng() * 1.5, 0.3 * amount, 1.6 * amount, g, g, g * 1.05, 0.5, -0.6, 0.6);
  }

  glassBurst(pane, point, dir) {
    for (let i = 0; i < 40; i++) {
      const px = point.x + (rng() - 0.5) * pane.hw * 1.6, py = point.y + (rng() - 0.5) * pane.hh * 1.6;
      this.glow.emit(px, py, point.z + (rng() - 0.5) * 0.3, dir.x * 4 + (rng() - 0.5) * 4, rng() * 2, dir.z * 4 + (rng() - 0.5) * 4,
        0.6 + rng() * 0.7, 0.06, 0.05, 0.55, 0.75, 0.8, 0.8, 10, 0.2);
    }
  }

  update(dt) {
    for (const s of this.lights) {
      if (s.t <= 0) { s.l.intensity = 0; continue; }
      s.t -= dt / s.dur;
      s.l.intensity = Math.max(0, s.t) ** 2 * s.peak;
    }
    this.dust.update(dt, this.floorAt);
    this.glow.update(dt, this.floorAt);
  }

  counts() { return { dust: this.dust.n, glow: this.glow.n }; }

  reset() {
    this.dust.clear();
    this.glow.clear();
    for (const s of this.lights) { s.t = 0; s.l.intensity = 0; }
  }
}
