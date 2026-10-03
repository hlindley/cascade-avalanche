// Instrumentation: frame interval, CPU update/render split, GPU time (when the timer
// query extension exists), physics/debris counts, draw calls, fracture op costs, and
// the worst frames annotated with whatever destruction happened during them.
export class Perf {
  constructor(game) {
    this.g = game;
    this.frames = [];
    this.pending = [];
    this.lastFrameT = 0;
    this.events = [];
    this.frameEvents = [];
    this.worst = [];
    this.byEvent = {};
    this.gpuMs = null;
    const gl = game.renderer.getContext();
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.queries = [];
    this.el = document.getElementById('perf');
    this.visible = false;
    this.lastUi = 0;
    this.resetT = performance.now();
  }

  event(name, ms = 0, value) {
    this.frameEvents.push(name);
    this.events.push({ name, ms, value, t: performance.now() });
    if (this.events.length > 400) this.events.shift();
  }

  beginFrame(now) {
    this.frameStart = performance.now();
    this.interval = this.lastFrameT ? now - this.lastFrameT : 16.7;
    this.lastFrameT = now;
  }

  markUpdate() { this.updateEnd = performance.now(); }

  beginGpu() {
    if (!this.ext) return;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.activeQuery = q;
  }

  endGpu() {
    if (!this.ext || !this.activeQuery) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.queries.push(this.activeQuery);
    this.activeQuery = null;
    while (this.queries.length) {
      const q = this.queries[0];
      if (!this.gl.getQueryParameter(q, this.gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      if (!disjoint) this.gpuMs = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT) / 1e6;
      this.gl.deleteQuery(q);
      this.queries.shift();
    }
    if (this.queries.length > 8) { this.gl.deleteQuery(this.queries.shift()); }
  }

  endFrame() {
    const end = performance.now();
    const info = this.g.renderer.info.render;
    const f = {
      t: end,
      interval: this.interval,
      cpu: end - this.frameStart,
      update: this.updateEnd - this.frameStart,
      render: end - this.updateEnd,
      gpu: this.gpuMs,
      calls: info.calls,
      tris: info.triangles,
      events: this.frameEvents.length ? [...new Set(this.frameEvents)] : null,
    };
    this.frameEvents = [];
    this.frames.push(f);
    if (this.frames.length > 900) this.frames.shift();
    // worst frames since reset (by CPU cost, which is what destruction spikes)
    if (end - this.resetT > 500) {
      this.worst.push(f);
      this.worst.sort((a, b) => b.cpu - a.cpu);
      if (this.worst.length > 8) this.worst.length = 8;
      if (f.events) for (const e of f.events) {
        const b = (this.byEvent[e] ??= { count: 0, worstCpu: 0, worstInterval: 0 });
        b.count++;
        b.worstCpu = Math.max(b.worstCpu, f.cpu);
        b.worstInterval = Math.max(b.worstInterval, f.interval);
      }
    }
    if (this.visible && end - this.lastUi > 250) { this.lastUi = end; this._ui(); }
  }

  window(sec = 5) {
    const now = performance.now();
    const fr = this.frames.filter((f) => now - f.t < sec * 1000);
    if (!fr.length) return null;
    const pick = (k) => fr.map((f) => f[k] ?? 0).sort((a, b) => a - b);
    const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
    const iv = pick('interval'), cpu = pick('cpu'), up = pick('update');
    return {
      frames: fr.length,
      fps: 1000 / (iv.reduce((a, b) => a + b, 0) / iv.length),
      interval: { p50: pct(iv, 0.5), p95: pct(iv, 0.95), max: iv[iv.length - 1] },
      cpu: { p50: pct(cpu, 0.5), p95: pct(cpu, 0.95), max: cpu[cpu.length - 1] },
      update: { p50: pct(up, 0.5), max: up[up.length - 1] },
    };
  }

  snapshot() {
    const g = this.g;
    const d = g.debris.counts();
    const c = g.destruction.totalCells();
    const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
    const last = this.frames[this.frames.length - 1] ?? {};
    const ops = g.destruction.ops.slice(-40);
    const opWorst = {};
    for (const o of ops) opWorst[o.name] = Math.max(opWorst[o.name] ?? 0, o.ms);
    return {
      window5s: this.window(5),
      last: { cpu: last.cpu, update: last.update, render: last.render, gpu: last.gpu, calls: last.calls, tris: last.tris },
      bodies: { heroActive: d.heroActive, heroSleeping: d.heroSleeping, heroFrozen: d.heroFrozen, rapierBodies: g.physics.world.bodies.len(), rapierColliders: g.physics.world.colliders.len() },
      fragments: { cellsAlive: c.alive, cellsTotal: c.total, cellsRemoved: g.destruction.stats.cellsRemoved, cellsReleased: g.destruction.stats.cellsReleased, cosmeticFlying: d.cosmeticFlying, cosmeticSettled: d.cosmeticSettled, ...g.fx.counts() },
      fractureOpWorstMs: opWorst,
      worstFrames: this.worst.map((f) => ({ cpu: +f.cpu.toFixed(2), update: +f.update.toFixed(2), interval: +f.interval.toFixed(1), events: f.events })),
      byEvent: this.byEvent,
      heapMB: mem,
      gpuTimer: !!this.ext,
      renderer: this.rendererName(),
    };
  }

  rendererName() {
    const gl = this.gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }

  resetStats() {
    this.worst = [];
    this.byEvent = {};
    this.resetT = performance.now();
  }

  toggle() {
    this.visible = !this.visible;
    this.el.hidden = !this.visible;
    if (this.visible) this._ui();
  }

  _ui() {
    const s = this.snapshot();
    const w = s.window5s;
    const f = (v, d = 1) => (v == null ? '—' : v.toFixed(d));
    const lines = [
      `FPS ${f(w?.fps, 0)}  frame p50 ${f(w?.interval.p50)} p95 ${f(w?.interval.p95)} max ${f(w?.interval.max)} ms`,
      `CPU p50 ${f(w?.cpu.p50, 2)} max ${f(w?.cpu.max, 2)}  update ${f(s.last.update, 2)} render ${f(s.last.render, 2)}  GPU ${s.gpuTimer ? f(s.last.gpu, 2) : 'n/a'}`,
      `draws ${s.last.calls}  tris ${(s.last.tris / 1000).toFixed(0)}k  heap ${s.heapMB ?? '—'} MB`,
      `bodies: active ${s.bodies.heroActive} sleeping ${s.bodies.heroSleeping} frozen ${s.bodies.heroFrozen}  rapier ${s.bodies.rapierBodies}b/${s.bodies.rapierColliders}c`,
      `cells ${s.fragments.cellsAlive}/${s.fragments.cellsTotal}  removed ${s.fragments.cellsRemoved} released ${s.fragments.cellsReleased}`,
      `rubble fly ${s.fragments.cosmeticFlying} settled ${s.fragments.cosmeticSettled}  dust ${s.fragments.dust} glow ${s.fragments.glow}`,
      `fracture ops: ${Object.entries(s.fractureOpWorstMs).map(([k, v]) => `${k} ${v.toFixed(2)}ms`).join('  ') || '—'}`,
      `worst frames (cpu ms):`,
      ...s.worstFrames.slice(0, 5).map((x) => `  ${x.cpu.toFixed(1)}  ${x.events ? x.events.join(',') : ''}`),
      `${s.renderer}`,
    ];
    this.el.textContent = lines.join('\n');
  }
}
