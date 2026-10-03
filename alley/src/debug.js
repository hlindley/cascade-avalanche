import * as THREE from 'three';

// Scenario presets for the three M1 moments + a scripting API used by the inspection tool.
export function installDebug(game) {
  const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const api = {
    place(actor, x, z, yaw) {
      actor.spawn = { p: v3(x, 0, z), yaw };
      actor.reset();
      if (actor === game.player) { actor.viewYaw = yaw; actor.viewPitch = 0; }
    },
    eye() {
      game.camera.update(0.0001, game.player);
      return game.camera.camera.position.clone();
    },
    aimAt(p) {
      const e = api.eye();
      const d = new THREE.Vector3().subVectors(p, e);
      game.player.viewYaw = Math.atan2(d.x, d.z);
      game.player.viewPitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
      game.player.yaw = game.player.viewYaw;
      game.camera.lastYaw = game.player.viewYaw;
      game.camera.lastPitch = game.player.viewPitch;
      game.camera.update(0.0001, game.player);
    },
    input(o = {}) {
      return { move: { x: o.x ?? 0, z: o.z ?? 0 }, look: { dx: 0, dy: 0 }, fire: !!o.fire, salvo: !!o.salvo, boost: !!o.boost, aimPoint: o.aim ? o.aim.clone() : game.aimPoint.clone() };
    },
    // advance the simulation deterministically; fn(i) may return input overrides
    run(seconds, fn) {
      game.advance(seconds, (i) => api.input(fn ? fn(i) ?? {} : {}));
    },
    fireCannonAt(p) {
      api.aimAt(p);
      game.player.cannonCd = 0;
      game.player.fireCannon(p.clone());
    },
    salvoAt(p) {
      api.aimAt(p);
      game.player.salvoCd = 0;
      api.run(0.6, () => ({ salvo: true, aim: p }));
    },
    knee(i = 0) {
      game.target.rig.updateMatrixWorld?.();
      return game.target.rig.legs[i].knee.clone();
    },
    // lead a moving target: solve for intercept with the cannon speed
    lead(point, vel, speed = 125) {
      const e = api.eye();
      let t = point.distanceTo(e) / speed;
      for (let k = 0; k < 4; k++) t = point.clone().addScaledVector(vel, t).distanceTo(e) / speed;
      return point.clone().addScaledVector(vel, t);
    },
    scenario(name) {
      game.reset();
      const P = game.player, T = game.target;
      if (name === 'A') {
        api.place(P, 0, 13, Math.PI);
        T.setMode('strafe');
        api.place(T, -7.5, -8.6, 0);
        T.fireEnabled = false;
      } else if (name === 'B') {
        api.place(P, -1, 12, Math.PI);
        T.setMode('cover');
        api.place(T, -13.4, -5.4, 0);
        api.aimAt(v3(-12.8, 2.4, -2.3));
      } else if (name === 'C') {
        // weaken facade bay A-g1 with two real cannon impacts, then stage the ram
        const panel = game.destruction.panels.find((p) => p.name === 'A-g1');
        for (const [lx, ly] of [[1.6, 2.1], [3.4, 3.0], [2.4, 4.4]]) {
          const wp = panel.toWorld(v3(lx, ly, 0.05));
          const c = panel.cellAt(lx, ly);
          panel.cannonHit(c, wp, v3(0, 0, -1), 0.8);
        }
        game.debris.reset();
        game.fx.reset();
        api.place(P, -6, 4, Math.PI);
        T.setMode('hold');
        api.place(T, -6, -9.8, 0);
        T.fireEnabled = false;
      }
      game.perf.resetStats();
      game.perf.event(`scenario-${name}`);
      game._flashBanner?.(`TEST ${name}`);
    },
    view(pos, look, fov) { game.camera.setFree(pos, look, fov); },
    cockpit() { game.camera.setMode('cockpit'); },
    snapshot: () => game.perf.snapshot(),
    // Run `seconds` of simulation, timing every fixed step (physics + destruction + debris + rigs + fx).
    timed(seconds, fn, label = '') {
      const n = Math.round(seconds * 60);
      const ms = [];
      let worst = { ms: 0 };
      for (let i = 0; i < n; i++) {
        const inp = api.input(fn ? fn(i) ?? {} : {});
        const opsBefore = game.destruction.ops.length;
        const t0 = performance.now();
        game.step(1 / 60, inp);
        game.fx.update(1 / 60);
        for (const p of game.destruction.panels) p.flush();
        const dt = performance.now() - t0;
        ms.push(dt);
        if (dt > worst.ms) worst = { ms: dt, step: i, ops: game.destruction.ops.slice(opsBefore).map((o) => `${o.name}:${o.ms.toFixed(1)}ms/${o.count}`) };
      }
      const sorted = [...ms].sort((a, b) => a - b);
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      const d = game.debris.counts();
      return { label, steps: n, meanMs: +(ms.reduce((a, b) => a + b, 0) / n).toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +sorted[n - 1].toFixed(2), worst, over16ms: ms.filter((x) => x > 16.7).length, bodies: d, cells: game.destruction.totalCells() };
    },
    renderTimed(frames = 5) {
      const t = [];
      for (let i = 0; i < frames; i++) { const t0 = performance.now(); game.render(); game.renderer.getContext().finish(); t.push(performance.now() - t0); }
      const info = game.renderer.info.render;
      return { renderMs: +Math.min(...t).toFixed(1), calls: info.calls, triangles: info.triangles };
    },
    state() {
      const T = game.target;
      return {
        target: { pos: T.position.toArray().map((x) => +x.toFixed(2)), knee: [...T.rig.kneeHp], chassis: T.rig.chassisHp, disabled: !!T.disabledBody, knock: +T.knock.length().toFixed(2), mode: T.mode },
        player: { pos: game.player.position.toArray().map((x) => +x.toFixed(2)), energy: game.player.energy },
        panels: Object.fromEntries(game.destruction.panels.map((p) => [p.name, p.N - p.aliveCount()])),
        attachmentsReleased: game.destruction.attachments.filter((a) => a.released).map((a) => a.object.name),
        glassBroken: game.destruction.glass.filter((g) => !g.alive).length,
        lastRam: game.player.lastRam,
        lastDebrisHit: T.lastDebrisHit ?? null,
        resetMs: game.lastResetMs,
        initMs: game.initMs,
        buildMs: game.buildMs,
      };
    },
    // is there an open line through panel `name` at a world point? (gameplay truth check)
    rayThrough(from, to) {
      const dir = new THREE.Vector3().subVectors(to, from);
      const len = dir.length();
      dir.normalize();
      const hit = game.physics.castRay(from, dir, len, game.player.collider, (c) => {
        const o = game.physics.ownerOf(c);
        return !(o && (o.kind === 'mech' || o.kind === 'debris'));
      });
      return hit ? { blocked: true, kind: hit.owner?.kind, panel: hit.owner?.panel?.name, dist: hit.toi } : { blocked: false };
    },
  };
  game.debugApi = api;
  return api;
}
