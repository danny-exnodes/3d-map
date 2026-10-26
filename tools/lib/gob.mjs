// Google Open Buildings 2.5D Temporal (CC BY 4.0) → building-height grid for a bbox.
// Shared by the CLI (tools/gob-heights.mjs) and the Vite dev-server endpoint (/api/heights).
import { fromUrl } from 'geotiff';
import { readFileSync } from 'node:fs';
import { toUtm, utmEpsg, utmZoneOf } from '../../src/geo/utm.ts';

const HEIGHT_BAND = 1; // bands: 0 fractional count, 1 building height (m), 2 building presence (0..1)
const PRESENCE_BAND = 2;
const RES = 0.5;
export const GOB_SOURCE = 'Google Open Buildings 2.5D Temporal (2023), CC BY 4.0';

let index;
function tileIndex() {
  index ??= JSON.parse(readFileSync(new URL('../data/gob-vnm-2023-index.json', import.meta.url), 'utf8'));
  return index;
}

/**
 * Samples the height band on a `cell`-metre grid laid out in the app's local projection
 * (centre of the bbox, x east, z south). Returns null when no tile covers the bbox.
 * Values are uint16 decimetres, 0 = no building (presence < 0.5).
 */
export async function extractHeightGrid({ south, west, north, east }, cell = 2) {
  const lat0 = (south + north) / 2;
  const lon0 = (west + east) / 2;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110574;
  const width = Math.ceil(((east - west) * kx) / cell);
  const depth = Math.ceil(((north - south) * ky) / cell);
  if (width * depth > 16e6) throw new Error('bbox too large');
  const zone = utmZoneOf(lon0);
  const corners = [[west, south], [east, south], [east, north], [west, north]].map(([lo, la]) => toUtm(lo, la, zone));
  const ux0 = Math.min(...corners.map((c) => c[0])), ux1 = Math.max(...corners.map((c) => c[0]));
  const uy0 = Math.min(...corners.map((c) => c[1])), uy1 = Math.max(...corners.map((c) => c[1]));
  const tiles = tileIndex().filter((t) => t.epsg === utmEpsg(zone) && t.bbox[0] < ux1 && t.bbox[2] > ux0 && t.bbox[1] < uy1 && t.bbox[3] > uy0);
  if (!tiles.length) return null;

  // UTM coordinates of every cell centre, computed once.
  const utm = new Float64Array(width * depth * 2);
  for (let j = 0; j < depth; j++) {
    for (let i = 0; i < width; i++) {
      const x = (i + 0.5) * cell - (width * cell) / 2;
      const z = (j + 0.5) * cell - (depth * cell) / 2;
      const [ux, uy] = toUtm(x / kx + lon0, -z / ky + lat0, zone);
      utm[(j * width + i) * 2] = ux;
      utm[(j * width + i) * 2 + 1] = uy;
    }
  }

  const grid = new Uint16Array(width * depth);
  for (const t of tiles) {
    const img = await (await fromUrl(t.url)).getImage();
    const [bx0, , , by1] = t.bbox;
    const px0 = Math.max(0, Math.floor((ux0 - bx0) / RES) - 2);
    const px1 = Math.min(img.getWidth(), Math.ceil((ux1 - bx0) / RES) + 2);
    const py0 = Math.max(0, Math.floor((by1 - uy1) / RES) - 2);
    const py1 = Math.min(img.getHeight(), Math.ceil((by1 - uy0) / RES) + 2);
    if (px1 <= px0 || py1 <= py0) continue;
    const w = px1 - px0;
    const h = py1 - py0;
    const [hBand, pBand] = await img.readRasters({ window: [px0, py0, px1, py1], samples: [HEIGHT_BAND, PRESENCE_BAND] });
    for (let k = 0; k < width * depth; k++) {
      const px = Math.floor((utm[k * 2] - bx0) / RES) - px0;
      const py = Math.floor((by1 - utm[k * 2 + 1]) / RES) - py0;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const q = py * w + px;
      if (pBand[q] < 0.5 || !(hBand[q] > 0)) continue;
      grid[k] = Math.min(65535, Math.round(hBand[q] * 10));
    }
  }
  return {
    meta: { bbox: { south, west, north, east }, cell, width, depth, encoding: 'uint16le-decimetres', source: GOB_SOURCE },
    grid,
  };
}
