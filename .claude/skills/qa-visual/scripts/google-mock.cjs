// Opens the Google page with every Google endpoint mocked (no real key in the sandbox).
// Usage: node google-mock.cjs [outPrefix]  → checks the key box, a 3D 403 error, 2D tiles, links.
const { chromium } = require('playwright');
(async () => {
  const out = process.argv[2] || 'google';
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 1200, height: 700 } });
  // 1×1 PNG for every 2D tile.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await ctx.route(/tile\.googleapis\.com\/v1\/createSession/, (r) => r.fulfill({ json: { session: 'S', tileWidth: 512, expiry: String(Math.round(Date.now() / 1000 + 9999)) } }));
  await ctx.route(/tile\.googleapis\.com\/v1\/2dtiles/, (r) => r.fulfill({ body: png, contentType: 'image/png' }));
  await ctx.route(/tile\.googleapis\.com\/tile\/v1\/viewport/, (r) => r.fulfill({ json: { copyright: 'Google' } }));
  await ctx.route(/tile\.googleapis\.com\/v1\/3dtiles/, (r) => r.fulfill({ status: 403, json: { error: { message: 'API key not valid' } } }));
  await ctx.route(/maps\.googleapis\.com/, (r) => r.abort());
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await p.goto('http://localhost:4173/#at=10.73776,106.67637');
  await p.waitForTimeout(1500);
  console.log('key box shown:', await p.isVisible('#g-keybox'));
  await p.fill('#g-keyinput', 'AIzaFAKE');
  await p.click('#g-keyform button[type=submit]');
  await p.waitForTimeout(6000);
  console.log('status:', await p.textContent('#g-status'));
  console.log('OSM link:', await p.getAttribute('#g-osm', 'href'));
  await p.screenshot({ path: `${out}.png` });
  await b.close();
})();
