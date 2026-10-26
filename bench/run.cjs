// Usage: node bench/run.cjs [url]   (expects `vite preview` on :4173)
const { chromium } = require('playwright');
const budget = require('./budget.json');

(async () => {
  const url = process.argv[2] || 'http://localhost:4173/?demo&bench';
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__bench, null, { timeout: 120000 });
  const r = await page.evaluate(() => window.__bench);
  await browser.close();
  console.log(JSON.stringify(r, null, 2));
  let failed = false;
  for (const [k, limit] of Object.entries(budget)) {
    if (k.startsWith('/')) continue;
    const v = r[k];
    const ok = v <= limit * 1.2;
    console.log(`${ok ? '✓' : '✗'} ${k}: ${v} (budget ${limit})`);
    if (!ok) failed = true;
  }
  if (!r.worker) {
    console.log('✗ build did not run in a Web Worker');
    failed = true;
  }
  process.exit(failed ? 1 : 0);
})();
