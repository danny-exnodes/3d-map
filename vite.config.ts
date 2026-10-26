import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-only endpoint computing Google Open Buildings 2.5D height grids for any bbox in Việt Nam
 * (the GCS bucket has no CORS, so the browser cannot read it directly). Issue #3.
 * GET /api/heights?bbox=south,west,north,east → uint16 decimetres, metadata in X-Grid-Meta.
 */
function heightsApi(): Plugin {
  return {
    name: 'tinymap-heights-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/heights', async (req, res) => {
        try {
          const q = new URL(req.url ?? '', 'http://x').searchParams.get('bbox') ?? '';
          const [south, west, north, east] = q.split(',').map(Number);
          if (![south, west, north, east].every(Number.isFinite) || (east - west) * (north - south) > 0.0009) {
            res.statusCode = 400;
            return res.end('bad bbox');
          }
          // @ts-expect-error plain JS module shared with the CLI
          const { extractHeightGrid } = await import('./tools/lib/gob.mjs');
          const r = await extractHeightGrid({ south, west, north, east }, 2);
          if (!r) {
            res.statusCode = 404;
            return res.end('no coverage');
          }
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('X-Grid-Meta', JSON.stringify(r.meta));
          res.setHeader('Access-Control-Expose-Headers', 'X-Grid-Meta');
          res.end(Buffer.from(r.grid.buffer));
        } catch (e) {
          res.statusCode = 500;
          res.end(String(e));
        }
      });
    },
  };
}

/** Lists the built app files for the service worker to cache on install (offline use, #18). */
function precacheManifest(): Plugin {
  return {
    name: 'tinymap-precache',
    apply: 'build',
    generateBundle(_, bundle) {
      const files = ['./', ...Object.keys(bundle).filter((f) => !f.endsWith('.map'))].concat(['wards/hcm.json', 'wards/hn.json']);
      this.emitFile({ type: 'asset', fileName: 'precache.json', source: JSON.stringify(files) });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [heightsApi(), precacheManifest()],
  build: { chunkSizeWarningLimit: 2000 },
});
