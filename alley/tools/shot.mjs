// Generic scripted capture: node shot.mjs <out.png> <js-to-eval-before-render>
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');
const [out, script = '', w = 1280, h = 720] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on('console', (m) => { if (m.type() !== 'log' || m.text().startsWith('OUT')) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto('http://localhost:8080/alley/?manual');
await page.waitForFunction(() => window.alley && window.alley.debugApi, null, { timeout: 120000 });
const res = await page.evaluate(`(async () => { const g = window.alley, A = g.debugApi, V = (x,y,z) => new (g.camera.camera.position.constructor)(x,y,z); document.getElementById('start').hidden = true; ${script}; g.render(); return A.state(); })()`).catch((e) => 'eval error ' + e.message);
await page.screenshot({ path: out });
console.log(typeof res === 'string' ? res : JSON.stringify({ target: res.target, panels: Object.fromEntries(Object.entries(res.panels).filter(([k, v]) => v)), att: res.attachmentsReleased, glass: res.glassBroken, lastRam: res.lastRam, debris: res.lastDebrisHit }));
console.log(logs.join('\n'));
await browser.close();
