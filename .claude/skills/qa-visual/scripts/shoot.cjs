// Builds a bbox in the OSM app and takes screenshots after running camera/scene snippets.
// Needs `vite preview --port 4173` on a fresh build, with the debug hook on (window.__city).
// Usage: node shoot.cjs <south,west,north,east> '[["name","js snippet"],...]' [outPrefix]
//   env STYLE=real|color|mono, W/H viewport, DUMP=file.json writes __city.data, GEO=lat,lon
// Example snippet (camera): "c=__city;c.controls.target.set(0,0,0);c.camera.position.set(60,70,90);c.controls.update()"
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const [bbox, shots = '[]', out = 'shot'] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const geo = process.env.GEO?.split(',').map(Number);
  const ctx = await b.newContext({
    viewport: { width: Number(process.env.W || 1200), height: Number(process.env.H || 700) },
    ...(geo ? { geolocation: { latitude: geo[0], longitude: geo[1] }, permissions: ['geolocation'] } : {}),
  });
  await ctx.route(/overpass/, (r) => r.abort()); // not reachable from the sandbox anyway
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await p.goto(`http://localhost:4173/openstreetmap/${process.env.STYLE ? `?style=${process.env.STYLE}` : ''}#bbox=${bbox}`);
  await p.waitForTimeout(2500);
  await p.click('#btn-build');
  await p.waitForFunction(() => !document.getElementById('city-view').hidden || !document.getElementById('p-error').hidden, null, { timeout: 300000 });
  await p.waitForTimeout(2000);
  console.log(await p.textContent('#i-stats'));
  if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, await p.evaluate(() => JSON.stringify(window.__city.data)));
  const files = [];
  for (const [name, code] of JSON.parse(shots)) {
    await p.evaluate(code);
    await p.waitForTimeout(2500);
    const f = `${out}-${name}.png`;
    await p.screenshot({ path: f, timeout: 180000 });
    files.push(f);
  }
  await b.close();
  if (files.length > 1) require('child_process').execFileSync('python3', [__dirname + '/grid.py', `${out}-grid.png`, ...files]);
})();
