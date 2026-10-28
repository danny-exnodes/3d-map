import { describe, expect, it } from 'vitest';
import { removeOverlaps } from '../src/data/overlap';
import { makeBuilding } from '../src/data/buildings';
import type { CityData, Road } from '../src/data/types';

const bbox = { south: 10.73, west: 106.66, north: 10.74, east: 106.67 };
// A w × l m rectangle with its south-west corner at (lon, lat).
const box = (lon: number, lat: number, w: number, l: number): [number, number][] => {
  const dx = w / 109000, dy = l / 110574;
  return [[lon, lat], [lon + dx, lat], [lon + dx, lat + dy], [lon, lat + dy]];
};
const city = (polys: [number, number][][], source: 'osm' | 'overture' | 'gob' = 'osm', roads: Road[] = []): CityData => ({
  bbox,
  roads,
  source: 'test',
  buildings: polys.map((p, i) => makeBuilding({ id: `b${i}`, polygon: [p], kind: 'house', levels: 2, tags: {}, footprintSource: source })),
} as unknown as CityData);

describe('removeOverlaps', () => {
  it('resolves a ~2% overlap with the default threshold', () => {
    // 40 × 40 m houses; the second starts 0.8 m inside the first (2% of its area).
    const dx = 39.2 / 109000;
    const data = city([box(106.665, 10.735, 40, 40), box(106.665 + dx, 10.735, 40, 40)]);
    const r = removeOverlaps(data);
    expect(r.dropped + r.shrunk).toBe(1);
  });

  it('keeps touching neighbours unchanged', () => {
    const dx = 10 / 109000;
    const polys = [box(106.665, 10.735, 10, 10), box(106.665 + dx, 10.735, 10, 10)];
    const data = city(polys);
    const before = JSON.stringify(data.buildings.map((b) => b.polygon));
    const r = removeOverlaps(data);
    expect(r).toEqual({ dropped: 0, shrunk: 0, roadShrunk: 0, roadDropped: 0 });
    expect(data.buildings).toHaveLength(2);
    expect(JSON.stringify(data.buildings.map((b) => b.polygon))).toBe(before);
  });
});

// An east-west street along the latitude `lat`, `width` m wide.
const street = (lat: number, width: number, extra: Partial<Road> = {}): Road => ({
  id: 'r', line: [[106.6645, lat], [106.6655 + 0.002, lat]], cls: 'residential', width, lanes: 2, oneway: false, layer: 0, bridge: false, tunnel: false, ...extra,
});
const LAT = 10.735, LON = 106.665;
// South edge of a house that reaches `m` metres into the north half of a 10 m wide street at LAT.
const south = (m: number) => LAT + (5 - m) / 110574;
const snap = (data: CityData) => JSON.stringify(data.buildings.map((b) => b.polygon));

describe('removeOverlaps on streets', () => {
  it('shrinks an inferred house that covers 20% of the street off it', () => {
    const data = city([box(LON, south(4), 20, 20)], 'gob', [street(LAT, 10)]);
    const before = snap(data);
    const r = removeOverlaps(data);
    expect(r.roadShrunk + r.roadDropped).toBe(1);
    expect(r.roadDropped).toBe(0);
    expect(data.buildings).toHaveLength(1);
    expect(snap(data)).not.toBe(before);
  });

  it('keeps an inferred house with a sliver (<1%) on the street unchanged', () => {
    const data = city([box(LON, south(0.3), 60, 60)], 'gob', [street(LAT, 10)]);
    const before = snap(data);
    expect(removeOverlaps(data)).toEqual({ dropped: 0, shrunk: 0, roadShrunk: 0, roadDropped: 0 });
    expect(snap(data)).toBe(before);
  });

  it('drops an inferred house that sits in the street', () => {
    const data = city([box(LON, LAT - 10 / 110574, 20, 20)], 'gob', [street(LAT, 40)]);
    const r = removeOverlaps(data);
    expect(r.roadDropped).toBe(1);
    expect(data.buildings).toHaveLength(0);
  });

  it('keeps an Overture house that overlaps the street edge by 5%', () => {
    const data = city([box(LON, south(1), 20, 20)], 'overture', [street(LAT, 10)]);
    const before = snap(data);
    expect(removeOverlaps(data)).toEqual({ dropped: 0, shrunk: 0, roadShrunk: 0, roadDropped: 0 });
    expect(snap(data)).toBe(before);
  });

  it('shrinks an Overture house with 25% on the street until it is within 15%', () => {
    const data = city([box(LON, south(5), 20, 20)], 'overture', [street(LAT, 10)]);
    const before = snap(data);
    const r = removeOverlaps(data);
    expect(r.roadShrunk).toBe(1);
    expect(data.buildings).toHaveLength(1);
    expect(snap(data)).not.toBe(before);
    // South edge moved off the street by at least the shrink step.
    expect(Math.min(...data.buildings[0].polygon[0].map((p) => p[1]))).toBeGreaterThan(south(5));
  });

  it('keeps an Overture house that cannot be shrunk off the street', () => {
    const data = city([box(LON, LAT - 10 / 110574, 20, 20)], 'overture', [street(LAT, 40)]);
    const before = snap(data);
    const r = removeOverlaps(data);
    expect(r.roadDropped).toBe(0);
    expect(data.buildings).toHaveLength(1);
    expect(snap(data)).toBe(before);
  });

  it('ignores bridges, tunnels and elevated roads', () => {
    for (const extra of [{ bridge: true }, { tunnel: true }, { layer: 1 }]) {
      const data = city([box(LON, LAT - 10 / 110574, 20, 20)], 'gob', [street(LAT, 40, extra)]);
      const before = snap(data);
      expect(removeOverlaps(data)).toEqual({ dropped: 0, shrunk: 0, roadShrunk: 0, roadDropped: 0 });
      expect(snap(data)).toBe(before);
    }
  });
});
