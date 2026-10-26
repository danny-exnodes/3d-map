import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { HeightGrid } from '../src/data/heights';
import { synthesizeFromGrid } from '../src/data/synth';
import type { CityData } from '../src/data/types';
import { LocalProjection, pointInRing } from '../src/geo/projection';

function load(id: string) {
  // Data as loaded before inference (tools/snapshot.ts --raw).
  const data = JSON.parse(gunzipSync(readFileSync(`tests/fixtures/${id}-raw.json.gz`)).toString('utf8')) as CityData;
  const meta = JSON.parse(readFileSync(`public/heights/${id}.json`, 'utf8'));
  const b = readFileSync(`public/heights/${id}.bin`);
  return { data, grid: new HeightGrid(meta, new Uint16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))) };
}

/** Share of raster-built cells (inside the bbox) covered by a footprint. */
function coverage(data: CityData, grid: HeightGrid): number {
  const { width: w, depth: d, cell } = grid.meta;
  const proj = new LocalProjection(grid.meta.bbox);
  const rings = data.buildings.map((b) => b.polygon[0].map((p) => proj.project(p)));
  const boxes = rings.map((r) => r.reduce((a, [x, z]) => [Math.min(a[0], x), Math.min(a[1], z), Math.max(a[2], x), Math.max(a[3], z)], [Infinity, Infinity, -Infinity, -Infinity]));
  let built = 0, hit = 0;
  // Sample every 3rd cell to keep the test fast.
  for (let j = 0; j < d; j += 3)
    for (let i = 0; i < w; i += 3) {
      if (grid.data[j * w + i] < 25) continue;
      const x = (i + 0.5) * cell - (w * cell) / 2, z = (j + 0.5) * cell - (d * cell) / 2;
      const [lon, lat] = proj.unproject(x, z);
      const bb = data.bbox;
      if (lon < bb.west || lon > bb.east || lat < bb.south || lat > bb.north) continue;
      built++;
      if (rings.some((r, k) => x >= boxes[k][0] && x <= boxes[k][2] && z >= boxes[k][1] && z <= boxes[k][3] && pointInRing(x, z, r))) hit++;
    }
  return hit / built;
}

describe('buildings inferred from the Google 2.5D raster (#16)', () => {
  it('raises footprint coverage of built area in Én Nam to ≥ 85 %', () => {
    const { data, grid } = load('ennam');
    const before = coverage(data, grid);
    const r = synthesizeFromGrid(data, grid);
    const after = coverage(data, grid);
    expect(before).toBeLessThan(0.5);
    expect(after).toBeGreaterThanOrEqual(0.85);
    expect(r.added).toBeGreaterThan(500);
    expect(data.buildings.filter((b) => b.footprintSource === 'gob').every((b) => b.heightSource === 'gob' && b.height >= 2.5)).toBe(true);
  });

  it('splits row blocks into 4–6.5 m lots with their own heights', () => {
    const { data, grid } = load('ngatuso');
    const r = synthesizeFromGrid(data, grid);
    expect(r.split).toBeGreaterThan(50);
    const lots = data.buildings.filter((b) => b.lot && b.footprintSource === 'overture');
    expect(lots.length).toBe(r.lots);
    expect(new Set(lots.slice(0, 200).map((b) => Math.round(b.height))).size).toBeGreaterThan(3);
  }, 20000);
});
