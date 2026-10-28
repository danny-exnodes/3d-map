import { describe, expect, it } from 'vitest';
import type { CityData } from '../src/data/types';
import { bboxSizeMeters, LocalProjection } from '../src/geo/projection';
import { Boats, BOAT_TRIANGLES, boatCount, boatRoutes, pointInRing, type BoatRoute } from '../src/scene/boats';
import type { XZ } from '../src/scene/geometry';

const LAKE: XZ[] = [[-100, -50], [100, -50], [100, 50], [-100, 50]];
const RIVER: XZ[] = [[-150, 200], [0, 200], [150, 200]];
const lake: BoatRoute = { kind: 'area', ring: LAKE, areaM2: 20000 };
const river: BoatRoute = { kind: 'line', pts: RIVER, width: 40 };

/** Distance from p to the polyline. */
function distToLine(p: XZ, pts: XZ[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const l2 = (bx - ax) ** 2 + (bz - az) ** 2;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * (bx - ax) + (p[1] - az) * (bz - az)) / l2));
    best = Math.min(best, Math.hypot(p[0] - (ax + t * (bx - ax)), p[1] - (az + t * (bz - az))));
  }
  return best;
}

const BBOX = { west: 105.79, south: 20.99, east: 105.81, north: 21.01 };
const proj = new LocalProjection(BBOX);
const ll = (p: XZ): [number, number] => proj.unproject(p[0], p[1]);
const emptyData = (over: Partial<CityData>): CityData => ({
  bbox: BBOX, buildings: [], roads: [], rails: [], areas: [], waterways: [], trees: [], pois: [], source: 't', ...over,
});
const rect = (cx: number, cz: number, w: number, h: number): XZ[] => [[cx - w / 2, cz - h / 2], [cx + w / 2, cz - h / 2], [cx + w / 2, cz + h / 2], [cx - w / 2, cz + h / 2]];

describe('boatRoutes', () => {
  it('keeps wide waterways and big lakes, skips ponds and ditches', () => {
    const data = emptyData({
      areas: [
        { id: 'a', kind: 'water', polygon: [LAKE.map(ll)] },
        { id: 'b', kind: 'water', polygon: [rect(0, 500, 40, 40).map(ll)] },
        { id: 'c', kind: 'park', polygon: [rect(0, -500, 300, 300).map(ll)] },
      ],
      waterways: [
        { id: 'r', line: RIVER.map(ll), width: 40 },
        { id: 'd', line: [[0, 0], [300, 0]].map((p) => ll(p as XZ)), width: 4 },
      ],
    });
    const routes = boatRoutes(data, proj);
    expect(routes.map((r) => r.kind).sort()).toEqual(['area', 'line']);
    const a = routes.find((r) => r.kind === 'area')!;
    expect(a.kind === 'area' && a.areaM2).toBeGreaterThan(19000);
  });
  it('only counts and sails the part of the water inside the model', () => {
    const { width } = bboxSizeMeters(BBOX);
    const hx = width / 2;
    const edge = rect(hx, 0, 400, 200);
    const routes = boatRoutes(emptyData({ areas: [{ id: 'e', kind: 'water', polygon: [edge.map(ll)] }, { id: 'f', kind: 'water', polygon: [rect(hx + 900, 0, 100, 100).map(ll)] }] }), proj);
    expect(routes.length).toBe(1);
    const r = routes[0];
    expect(r.kind === 'area' && r.areaM2).toBeGreaterThan(36000);
    expect(r.kind === 'area' && r.areaM2).toBeLessThan(44000);
    const boats = new Boats(routes, 3, true);
    for (let i = 0; i < 300; i++) boats.update(0.1, i * 0.1);
    expect(boats.positions().every((p) => p[0] <= hx)).toBe(true);
  });
  it('drops waterways shorter than 20 m', () => {
    const routes = boatRoutes(emptyData({ waterways: [{ id: 's', line: [[0, 0], [10, 0]].map((p) => ll(p as XZ)), width: 12 }, { id: 'k', line: [[0, 0], [30, 0]].map((p) => ll(p as XZ)), width: 12 }] }), proj);
    expect(routes.length).toBe(1);
  });
  it('returns nothing without water', () => {
    expect(boatRoutes(emptyData({}), proj)).toEqual([]);
    expect(new Boats([], 1, true).group.children.length).toBe(0);
  });
});

describe('boatCount', () => {
  it('is about one per 5,000 m², at least one', () => {
    expect(boatCount(lake)).toBe(4);
    expect(boatCount(river)).toBe(Math.round((300 * 40) / 5000));
    expect(boatCount({ kind: 'area', ring: LAKE, areaM2: 5000 })).toBe(1);
    expect(boatCount({ kind: 'line', pts: [[0, 0], [10, 0]], width: 6 })).toBe(1);
  });
});

describe('pointInRing', () => {
  it('tells inside from outside', () => {
    expect(pointInRing([0, 0], LAKE)).toBe(true);
    expect(pointInRing([0, 80], LAKE)).toBe(false);
  });
});

describe('Boats', () => {
  it('stay on the water, swans on lakes only, barges on rivers only', () => {
    const boats = new Boats([lake, river], 1, true);
    for (let i = 0; i < 600; i++) {
      boats.update(0.1, i * 0.1);
      for (const b of boats.list()) {
        if (b.route === 0) expect(pointInRing([b.x, b.z], LAKE)).toBe(true);
        else expect(distToLine([b.x, b.z], RIVER)).toBeLessThanOrEqual(20);
      }
    }
    const list = boats.list();
    expect(list.length).toBe(boatCount(lake) + boatCount(river));
    expect(list.every((b) => (b.kind === 'swan' ? b.route === 0 : true))).toBe(true);
    expect(list.every((b) => (b.kind === 'barge' ? b.route === 1 : true))).toBe(true);
    expect(list.some((b) => b.kind === 'swan')).toBe(true);
    expect(list.some((b) => b.kind === 'barge')).toBe(true);
    expect(boats.positions().length).toBe(list.length);
    boats.dispose();
  });
  it('keep off the island in a lake', () => {
    const island = rect(0, 0, 60, 30);
    const isle: BoatRoute = { kind: 'area', ring: LAKE, areaM2: 50000, holes: [island] };
    const boats = new Boats([isle], 5, true);
    expect(boats.list().length).toBe(10);
    for (let i = 0; i < 1500; i++) {
      boats.update(0.1, i * 0.1);
      for (const p of boats.positions()) {
        expect(pointInRing(p, island)).toBe(false);
        expect(pointInRing(p, LAKE)).toBe(true);
      }
    }
  });
  it('actually moves', () => {
    const boats = new Boats([lake], 2, false);
    const before = boats.positions().map((p) => [...p]);
    for (let i = 0; i < 100; i++) boats.update(0.1, i * 0.1);
    expect(boats.positions().some((p, i) => Math.hypot(p[0] - before[i][0], p[1] - before[i][1]) > 5)).toBe(true);
  });
  it('uses at most two draw calls', () => {
    expect(new Boats([lake, river], 1, true).group.children.length).toBeLessThanOrEqual(2);
  });
  it('stays inside the triangle budget at 60 boats', () => {
    const per = BOAT_TRIANGLES.boat + BOAT_TRIANGLES.barge + BOAT_TRIANGLES.swan;
    expect(per * 60).toBeLessThanOrEqual(15000);
  });
  it('caps the fleet at 60', () => {
    const big: BoatRoute = { kind: 'area', ring: rect(0, 0, 2000, 2000), areaM2: 4e6 };
    expect(new Boats([big, big], 1, true).list().length).toBe(60);
  });
});
