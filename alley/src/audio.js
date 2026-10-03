import * as THREE from 'three';

// Procedural mechanical audio: no samples. Every sound is a few oscillators and filtered noise.
export class Audio {
  constructor(game) {
    this.g = game;
    this.ctx = null;
    this.enabled = true;
    this.lastScrape = 0;
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.7;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // ambient: wind + distant plant hum
    const amb = this._noiseSrc(true);
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
    const ag = this.ctx.createGain(); ag.gain.value = 0.05;
    amb.connect(lp).connect(ag).connect(this.master);
    amb.start();
    const hum = this.ctx.createOscillator(); hum.frequency.value = 55;
    const hg = this.ctx.createGain(); hg.gain.value = 0.012;
    hum.connect(hg).connect(this.master); hum.start();
  }

  _noiseSrc(loop = false) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = loop;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    return s;
  }

  // spatial gain + pan relative to the camera
  _out(pos, gain) {
    const c = this.ctx;
    const g = c.createGain();
    let vol = gain, pan = 0;
    if (pos) {
      const cam = this.g.camera.camera;
      const d = cam.position.distanceTo(pos);
      vol *= 1 / (1 + d / 14);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      pan = THREE.MathUtils.clamp(new THREE.Vector3().subVectors(pos, cam.position).normalize().dot(right), -1, 1) * 0.7;
    }
    g.gain.value = vol;
    if (c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(this.master);
    } else g.connect(this.master);
    return g;
  }

  _env(node, t, a, peak, dec) {
    node.gain.setValueAtTime(0.0001, t);
    node.gain.exponentialRampToValueAtTime(peak, t + a);
    node.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
  }

  _noise(out, t, type, f0, f1, dur, peak, q = 1) {
    const c = this.ctx;
    const s = this._noiseSrc();
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    this._env(g, t, 0.004, peak, dur);
    s.connect(f).connect(g).connect(out);
    s.start(t, Math.random()); s.stop(t + dur + 0.1);
  }

  _tone(out, t, type, f0, f1, dur, peak) {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur);
    const g = c.createGain();
    this._env(g, t, 0.005, peak, dur);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + dur + 0.1);
  }

  ok() { return this.enabled && this.ctx && this.ctx.state === 'running'; }

  footstep(pos, strength, sev, isPlayer) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime, o = this._out(isPlayer ? null : pos, isPlayer ? 0.55 : 0.9);
    this._tone(o, t, 'sine', 70 * (1 + strength * 0.2), 28, 0.35, 0.9 * strength);
    this._noise(o, t, 'lowpass', 500, 90, 0.25, 0.5 * strength);
    this._noise(o, t + 0.01, 'bandpass', 1500, 900, 0.07, 0.18 * strength, 6);
    this._tone(o, t + 0.02, 'sawtooth', 210, 140, 0.18, 0.025);
    if (sev > 0.2) {
      this._noise(o, t + 0.03, 'bandpass', 2600, 1800, 0.35 * sev, 0.25 * sev, 8);
      this._tone(o, t + 0.04, 'square', 95, 60, 0.25, 0.05 * sev);
    }
  }

  scrape(pos, s) {
    if (!this.ok()) return;
    const now = this.ctx.currentTime;
    if (now - this.lastScrape < 0.12) return;
    this.lastScrape = now;
    this._noise(this._out(pos, 0.5 * s), now, 'bandpass', 3200, 2400, 0.14, 0.4, 5);
  }

  cannon(pos, gain = 1) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime, o = this._out(gain >= 1 ? null : pos, gain);
    this._noise(o, t, 'lowpass', 6000, 160, 0.55, 1.1);
    this._tone(o, t, 'sine', 95, 32, 0.5, 1.2);
    this._noise(o, t, 'highpass', 3000, 2000, 0.05, 0.6);
    this._tone(o, t + 0.12, 'triangle', 420, 380, 0.25, 0.04);
  }

  rocket(pos) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime, o = this._out(null, 0.6);
    this._noise(o, t, 'bandpass', 600, 2600, 0.35, 0.7, 2);
    this._tone(o, t, 'sine', 140, 60, 0.15, 0.4);
  }

  explosion(pos) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime, o = this._out(pos, 1.6);
    this._noise(o, t, 'lowpass', 2400, 60, 1.6, 1.2);
    this._tone(o, t, 'sine', 70, 22, 1.0, 1.3);
    for (let k = 0; k < 6; k++) this._noise(o, t + 0.15 + Math.random() * 0.9, 'bandpass', 900 + Math.random() * 1500, 400, 0.08, 0.15, 3);
  }

  wallHit(pos, s = 1) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime, o = this._out(pos, 1.2 * s);
    this._noise(o, t, 'lowpass', 1800, 120, 0.6, 1.0);
    this._tone(o, t, 'sine', 80, 35, 0.3, 0.6);
    for (let k = 0; k < 8; k++) this._noise(o, t + 0.1 + Math.random() * 1.1, 'bandpass', 700 + Math.random() * 2000, 500, 0.05, 0.12, 4);
  }

  crash(pos, s = 1) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime, o = this._out(pos, 1.3 * s);
    for (const f of [118, 171, 263, 409]) this._tone(o, t, 'triangle', f, f * 0.8, 0.9, 0.18);
    this._noise(o, t, 'lowpass', 3000, 100, 0.9, 1.1);
    this._tone(o, t, 'sine', 60, 25, 0.6, 1.2);
  }

  metalHit(pos, s = 1) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime, o = this._out(pos, 1.1 * s);
    for (const f of [520, 790, 1230]) this._tone(o, t, 'triangle', f, f * 0.95, 0.5, 0.12);
    this._noise(o, t, 'highpass', 4000, 2000, 0.12, 0.5);
  }

  glass(pos) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime, o = this._out(pos, 0.7);
    for (let k = 0; k < 10; k++) this._tone(o, t + Math.random() * 0.4, 'sine', 2500 + Math.random() * 3500, 2000, 0.15, 0.05);
    this._noise(o, t, 'highpass', 5000, 3000, 0.3, 0.3);
  }

  boost(ram) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime, o = this._out(null, 0.8);
    this._noise(o, t, 'lowpass', 400, 1800, 0.55, 0.9);
    this._noise(o, t + 0.05, 'bandpass', 900, 300, 0.7, 0.5, 1.5);
    if (ram) this._tone(o, t, 'sawtooth', 55, 90, 0.5, 0.15);
  }
}
