import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright'); // resolves via NODE_PATH or a local install
const url = process.argv[2] ?? 'http://localhost:8080/alley/?manual';
const out = process.argv[3] ?? '/tmp/smoke.png';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(url);
await page.waitForFunction(() => window.alley && window.alley.debugApi, null, { timeout: 120000 }).catch((e) => logs.push('timeout ' + e.message));
const info = await page.evaluate(() => {
  const g = window.alley;
  if (!g.debugApi) return null;
  document.getElementById('start').hidden = true;
  g.debugApi.run(0.5);
  g.render();
  return g.debugApi.state();
}).catch((e) => 'eval error ' + e.message);
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: out });
console.log(logs.join('\n'));
await browser.close();
