import { LocalProjection, pointInRing } from '../geo/projection';
import { cacheGet, cacheSet } from './cache';
import type { BBox, LngLat } from './types';

export interface HeightGridMeta {
  bbox: BBox;
  cell: number;
  width: number;
  depth: number;
  source: string;
}

/**
 * Building-height raster (Google Open Buildings 2.5D) laid out on the local projection of
 * its own bbox. Produced by tools/gob-heights.mjs or the /api/heights endpoint (#3).
 */
export class HeightGrid {
  private proj: LocalProjection;

  constructor(readonly meta: HeightGridMeta, readonly data: Uint16Array) {
    this.proj = new LocalProjection(meta.bbox);
  }

  /** Metres at a cell, 0 when no building. */
  private at(i: number, j: number): number {
    if (i < 0 || j < 0 || i >= this.meta.width || j >= this.meta.depth) return 0;
    return this.data[j * this.meta.width + i] / 10;
  }

  private cellOf(x: number, z: number): [number, number] {
    const { cell, width, depth } = this.meta;
    return [Math.floor((x + (width * cell) / 2) / cell), Math.floor((z + (depth * cell) / 2) / cell)];
  }

  /**
   * Median height of the grid cells inside a footprint (outer ring, lon/lat), or null when the
   * grid has no building there. Small footprints fall back to the cell under the centroid.
   */
  sampleFootprint(ring: LngLat[]): number | null {
    const pts = ring.map((p) => this.proj.project(p));
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, cx = 0, cz = 0;
    for (const [x, z] of pts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      cx += x; cz += z;
    }
    const { cell } = this.meta;
    const values: number[] = [];
    const [i0, j0] = this.cellOf(minX, minZ);
    const [i1, j1] = this.cellOf(maxX, maxZ);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 40_000) return null; // absurdly large footprint
    const half = (n: number, size: number) => (n + 0.5) * cell - (size * cell) / 2;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const v = this.at(i, j);
        if (v > 0 && pointInRing(half(i, this.meta.width), half(j, this.meta.depth), pts)) values.push(v);
      }
    }
    if (!values.length) {
      const [ci, cj] = this.cellOf(cx / pts.length, cz / pts.length);
      const v = this.at(ci, cj);
      return v > 0 ? v : null;
    }
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }

  covers(b: BBox): boolean {
    const g = this.meta.bbox;
    return b.west < g.east && b.east > g.west && b.south < g.north && b.north > g.south;
  }
}

export interface HeightSourceOptions {
  /** Absolute URL of the folder holding index.json + <id>.json/.bin (static, bundled). */
  staticBase?: string;
  /** Optional endpoint computing grids on demand: GET {api}?bbox=s,w,n,e → binary, meta in X-Grid-Meta. */
  api?: string;
  signal?: AbortSignal;
}

interface ManifestEntry {
  id: string;
  name: string;
  bbox: BBox;
}

const overlapArea = (a: BBox, b: BBox) =>
  Math.max(0, Math.min(a.east, b.east) - Math.max(a.west, b.west)) * Math.max(0, Math.min(a.north, b.north) - Math.max(a.south, b.south));

/**
 * Finds a height grid for the bbox: a bundled grid covering most of it, else the on-demand API,
 * else a bundled grid covering part of it. Never throws (except on abort).
 */
export async function loadHeightGrid(bbox: BBox, opts: HeightSourceOptions): Promise<HeightGrid | null> {
  const area = (bbox.east - bbox.west) * (bbox.north - bbox.south);
  let partial: ManifestEntry | null = null;
  if (opts.staticBase) {
    try {
      const res = await fetch(new URL('index.json', opts.staticBase), { signal: opts.signal });
      const list = res.ok ? ((await res.json()) as ManifestEntry[]) : [];
      const best = list
        .map((e) => ({ e, a: overlapArea(e.bbox, bbox) }))
        .filter((x) => x.a > 0)
        .sort((x, y) => y.a - x.a)[0];
      if (best && best.a >= area * 0.5) return await fetchStatic(best.e, opts);
      partial = best?.e ?? null;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
    }
  }
  if (opts.api) {
    const grid = await fetchFromApi(bbox, opts);
    if (grid) return grid;
  }
  if (partial) {
    try {
      return await fetchStatic(partial, opts);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
    }
  }
  return null;
}

async function fetchStatic(e: ManifestEntry, opts: HeightSourceOptions): Promise<HeightGrid> {
  const [meta, bin] = await Promise.all([
    fetch(new URL(`${e.id}.json`, opts.staticBase), { signal: opts.signal }).then((r) => r.json() as Promise<HeightGridMeta>),
    fetch(new URL(`${e.id}.bin`, opts.staticBase), { signal: opts.signal }).then((r) => r.arrayBuffer()),
  ]);
  return new HeightGrid(meta, new Uint16Array(bin));
}

async function fetchFromApi(bbox: BBox, opts: HeightSourceOptions): Promise<HeightGrid | null> {
  const key = [bbox.south, bbox.west, bbox.north, bbox.east].map((v) => v.toFixed(4)).join(',');
  try {
    const hit = await cacheGet<{ meta: HeightGridMeta; data: ArrayBuffer }>('heights', key);
    if (hit) return new HeightGrid(hit.meta, new Uint16Array(hit.data));
    const res = await fetch(`${opts.api}?bbox=${key}`, { signal: opts.signal });
    if (!res.ok) return null;
    const meta = JSON.parse(res.headers.get('X-Grid-Meta') ?? 'null') as HeightGridMeta | null;
    if (!meta) return null;
    const data = await res.arrayBuffer();
    void cacheSet('heights', key, { meta, data }, 30 * 24 * 3600 * 1000, data.byteLength);
    return new HeightGrid(meta, new Uint16Array(data));
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    return null;
  }
}
