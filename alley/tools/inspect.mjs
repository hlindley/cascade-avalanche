// Visual inspection + worst-moment benchmarks for The Alley.
//
//   python3 -m http.server 8080          (from the repo root)
//   NODE_PATH=$(npm root -g) node alley/tools/inspect.mjs [outDir] [--gpu]
//
// Captures the ten states named in the M1 brief and writes metrics.json next to them.
// Default launch uses SwiftShader (software WebGL) so it runs headless anywhere; pass --gpu
// to let Chromium use the host GPU. Render timings under SwiftShader are NOT representative.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--')) ?? 'docs/alley/captures';
const gpu = args.includes('--gpu');
const base = process.env.ALLEY_URL ?? 'http://localhost:8080/alley/?manual';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ args: gpu ? ['--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const metrics = { date: new Date().toISOString(), base, gpu, captures: {}, bench: {} };

async function session(fn) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base);
  await page.waitForFunction(() => window.alley && window.alley.debugApi, null, { timeout: 180000 });
  await page.evaluate(() => { document.getElementById('start').hidden = true; });
  const ev = (code) => page.evaluate(`(() => { const g = window.alley, A = g.debugApi, V = (x,y,z) => new (g.camera.camera.position.constructor)(x,y,z); ${code} })()`);
  try { return await fn(page, ev); } finally { if (errors.length) console.warn('page errors:', errors); await page.close(); }
}

async function capture(name, code, view) {
  await session(async (page, ev) => {
    const res = await ev(`${code}; ${view}; g.render(); return { state: A.state(), render: A.renderTimed(1) };`);
    await page.screenshot({ path: path.join(outDir, `${name}.jpg`), type: 'jpeg', quality: 84 });
    metrics.captures[name] = res;
    console.log('captured', name);
  });
}

// ---- reusable scripts --------------------------------------------------------------
const awayTarget = `g.target.setMode('hold'); g.target.fireEnabled = false; A.place(g.target, 13, 9, Math.PI);`;
const testA = `
A.scenario('A');
const waitMoving = () => { for (let i = 0; i < 300 && g.target.velocity.length() < 6.5; i++) A.run(1/60); };
for (let i = 0; i < 3; i++) {
  waitMoving();
  const vdir = g.target.velocity.clone().normalize();
  A.fireCannonAt(g.target.centerPoint().add(V(0, 0.6 - i * 0.5, 0)).addScaledVector(vdir, -1.5));
  A.run(0.3);
}
// corrected lead: keep firing at the knee of the planted leg (it moves at ~half body speed) until it connects
for (let tries = 0; tries < 4 && Math.min(...g.target.rig.kneeHp) >= 100; tries++) {
  waitMoving();
  const L = g.target.rig.legs.findIndex((l) => !l.swing);
  const leg = L < 0 ? 0 : L;
  A.fireCannonAt(A.lead(A.knee(leg), g.target.velocity.clone().multiplyScalar(0.5)));
  A.run(0.55);
}`;
const testC = `
A.scenario('C'); A.run(0.4);
A.run(1/60, () => ({ z: 1, boost: true }));`;
const heavy = `
A.place(g.player, 0, 12, Math.PI); ${awayTarget}
for (const p of [V(-6, 3, -14), V(0, 2.5, -14), V(6, 3, -14), V(-12, 9.5, -14), V(12, 9.8, -14), V(-12.5, 2.4, -2.3)]) { A.salvoAt(p); A.run(0.9); }
for (const p of [V(-1, 9, -14), V(1.5, 11.2, -14), V(6, 11, -14), V(-6, 11.2, -14), V(-3.8, 9, -14), V(8, 8, -14), V(17, 3, -9), V(17, 3, 5), V(17, 4, 7)]) { A.fireCannonAt(p); A.run(0.6); }`;

// ---- the ten inspection states ------------------------------------------------------
await capture('01-pristine-cockpit', `A.place(g.player, 0, 13, Math.PI); A.place(g.target, -2, -8.6, 0); g.target.setMode('hold'); A.run(0.5)`, `A.cockpit(); A.aimAt(V(-1, 4, -14))`);
await capture('01b-pristine-wide', `${awayTarget} A.run(0.3)`, `A.view(V(-14, 9, 16), V(2, 4, -14), 55)`);
await capture('02-one-cannon-hole', `A.place(g.player, 2, 6, Math.PI); ${awayTarget} A.fireCannonAt(V(0.5, 3.0, -14)); A.run(6)`, `A.view(V(1.2, 3.0, -9.5), V(0.4, 2.9, -14), 50)`);
await capture('03-adjacent-cannon-holes', `A.place(g.player, 2, 6, Math.PI); ${awayTarget} for (const p of [V(-1.2, 2.2, -14), V(0.8, 3.4, -14), V(1.6, 1.4, -14), V(-0.4, 4.6, -14), V(-1.8, 4.0, -14)]) { A.fireCannonAt(p); A.run(0.7); } A.run(5)`, `A.view(V(1.0, 3.2, -7.5), V(0, 3.0, -14), 55)`);
await capture('04-rocket-facade', `A.place(g.player, 1, 10, Math.PI); ${awayTarget} A.salvoAt(V(6, 3.2, -14)); A.run(6)`, `A.view(V(3, 3.6, -5.5), V(6, 3.2, -14), 60)`);
await capture('05-large-breach', `A.place(g.player, 1, 10, Math.PI); ${awayTarget} A.salvoAt(V(6, 2.4, -14)); A.run(4); A.salvoAt(V(5, 4.5, -14)); A.run(4); A.fireCannonAt(V(7.5, 1.5, -14)); A.run(4)`, `A.view(V(4, 3.4, -4), V(6, 2.6, -16), 62)`);
await capture('06-target-healthy-gait', `A.place(g.player, 0, 13, Math.PI); g.target.fireEnabled = false; g.target.setMode('strafe'); A.place(g.target, -7.5, -8.6, 0); for (let i = 0; i < 400 && !(g.target.position.x > -2 && g.target.rig.legs[0].swing && g.target.rig.legs[0].t > 0.4); i++) A.run(1/60)`, `const p = g.target.position; A.view(V(p.x + 1, 2.4, p.z + 9), V(p.x, 2.0, p.z), 45)`);
await capture('07-target-limp', `A.place(g.player, 0, 13, Math.PI); g.target.fireEnabled = false; g.target.setMode('strafe'); A.place(g.target, -7.5, -8.6, 0); g.target.rig.damage('knee', 1, 88, g.target.centerPoint()); for (let i = 0; i < 400 && !(g.target.position.x > -2 && g.target.rig.legs[0].swing && g.target.rig.legs[0].t > 0.4); i++) A.run(1/60)`, `const p = g.target.position; A.view(V(p.x + 1, 2.4, p.z + 9), V(p.x, 2.0, p.z), 45)`);
await capture('07b-testA-cockpit-after-knee-hit', testA + `; A.run(0.6)`, `A.cockpit(); A.aimAt(V(g.target.position.x - 2, 2.2, -11))`);
await capture('07c-testA-holes-behind', testA + `; A.run(5); ${awayTarget}`, `A.view(V(-2, 3.0, 1.0), V(-4.5, 2.2, -14), 55)`);
await capture('08-ram-impact', testC + `; A.run(0.48, () => ({ z: 1 }))`, `A.view(V(4, 4.5, -3), V(-6, 2.6, -13), 60)`);
await capture('08b-ram-cockpit', testC + `; A.run(0.5, () => ({ z: 0 }))`, `A.cockpit()`);
await capture('09-post-collapse-debris', testC + `; A.run(1.5, () => ({ z: 0 })); A.place(g.player, 0, 4, Math.PI); A.salvoAt(V(-12.8, 1.6, -2.3)); A.run(5)`, `A.view(V(-3, 4.5, 3), V(-8, 2, -11), 62)`);
await capture('10-heavily-damaged-alley', heavy + `; A.run(6)`, `A.view(V(-14, 9, 16), V(2, 4, -14), 55)`);
await capture('10b-heavily-damaged-cockpit', heavy + `; A.run(6)`, `A.cockpit(); A.aimAt(V(0, 5, -14))`);

// ---- worst-moment benchmarks (simulation CPU per fixed step) ---------------------------
await session(async (page, ev) => {
  metrics.bench.environment = await ev(`return { renderer: g.perf.rendererName(), ua: navigator.userAgent, cores: navigator.hardwareConcurrency, initMs: g.initMs, buildMs: g.buildMs, cells: g.destruction.totalCells(), staticDraws: g.alley.staticDraws };`);
  metrics.bench.idle = await ev(`A.place(g.player, 0, 13, Math.PI); return A.timed(3, null, 'idle, target strafing');`);
  metrics.bench.salvoIntact = await ev(`A.place(g.player, 0, 10, Math.PI); ${awayTarget} A.aimAt(V(0, 3, -14)); g.player.salvoCd = 0; return A.timed(4, (i) => ({ salvo: i < 40, aim: V(0, 3, -14) }), 'rocket salvo into intact facade');`);
  metrics.bench.repeatedCannon = await ev(`g.reset(); A.place(g.player, 0, 8, Math.PI); ${awayTarget} const pts = [V(6,2,-14),V(7,3,-14),V(5,4,-14),V(6.5,5,-14),V(4.5,2.5,-14),V(7.5,1.5,-14),V(5.5,5.8,-14),V(4,4.5,-14),V(8,4,-14),V(6,1,-14)]; let k = 0; return A.timed(6.5, (i) => { if (i % 36 === 0 && k < pts.length) { A.aimAt(pts[k]); g.player.cannonCd = 0; return { fire: true, aim: pts[k++] }; } return {}; }, '10 cannon rounds into one bay, 0.6 s apart');`);
  metrics.bench.ramBreach = await ev(`A.scenario('C'); A.run(0.4); return A.timed(4, (i) => (i === 0 ? { z: 1, boost: true } : { z: 0 }), 'boost-ram target through weakened facade');`);
  metrics.bench.heavy = await ev(`g.reset(); A.place(g.player, 0, 12, Math.PI); ${awayTarget} const sal = [V(-6,3,-14),V(0,2.5,-14),V(6,3,-14),V(-12,9.5,-14),V(12,9.8,-14),V(-12.5,2.4,-2.3)]; let k = 0; return A.timed(9, (i) => { if (i % 80 === 0 && k < sal.length) { A.aimAt(sal[k]); g.player.salvoCd = 0; g.player.salvo = null; return { salvo: true, aim: sal[k++] }; } if (i % 80 < 30 && k > 0) return { salvo: true, aim: sal[k - 1] }; return {}; }, 'six salvos 1.33 s apart across the alley (simultaneous debris)');`);
  metrics.bench.heavyRender = await ev(`return A.renderTimed(4);`);
  metrics.bench.heavySnapshot = await ev(`return A.snapshot();`);
  metrics.bench.reset = await ev(`const t = []; for (let i = 0; i < 5; i++) { const t0 = performance.now(); g.reset(); t.push(performance.now() - t0); } return { resetMs: t.map((x) => +x.toFixed(2)), cellsAfter: g.destruction.totalCells(), bodies: g.debris.counts() };`);
  metrics.bench.pristineRender = await ev(`return A.renderTimed(4);`);
});

fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
console.log(JSON.stringify(metrics.bench, null, 1));
await browser.close();
