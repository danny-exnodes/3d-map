import { describe, expect, it } from 'vitest';
import { makeBuilding } from '../src/data/buildings';
import type { Building } from '../src/data/types';
import { LocalProjection } from '../src/geo/projection';
import { buildBuildings, isLandmark } from '../src/scene/buildings';

const bbox = { south: 10.73, west: 106.66, north: 10.74, east: 106.67 };
const proj = new LocalProjection(bbox);
// A w × l m rectangle at (lon, lat).
const rect = (lon: number, lat: number, w: number, l: number): [number, number][] => {
  const dx = w / 2 / 109000, dy = l / 2 / 110574;
  return [[lon - dx, lat - dy], [lon + dx, lat - dy], [lon + dx, lat + dy], [lon - dx, lat + dy]];
};

describe('prototype instancing (#22)', () => {
  it('draws ordinary houses from shared prototypes and landmarks exactly', () => {
    const houses: Building[] = [];
    for (let i = 0; i < 20; i++) houses.push(makeBuilding({ id: `h${i}`, polygon: [rect(106.661 + i * 0.0002, 10.735, 4.5, 16)], kind: 'house', levels: 4, tags: {}, footprintSource: 'overture' }));
    const temple = makeBuilding({ id: 'temple', polygon: [rect(106.666, 10.737, 20, 30)], kind: 'temple', levels: 1, tags: { name: 'Chùa' }, footprintSource: 'osm' });
    const r = buildBuildings([...houses, temple], proj);
    const walls = r.instanced.find((m) => m.name === 'buildings-walls')!;
    expect(walls.count).toBe(20);
    expect(isLandmark(temple, 600)).toBe(true);
    // The temple is the only exact building; its id is in the exact mesh.
    const bids = new Set(Array.from(r.mesh.geometry.getAttribute('aBid').array as Float32Array).map(Math.round));
    expect([...bids].map((b) => r.ids[b])).toEqual(['temple']);
    // Instance ids map back to houses.
    const ib = walls.geometry.getAttribute('aBid');
    expect(r.ids[ib.getX(0)]).toBe('h0');
    // Prototype walls are scaled to the footprint: 4.5 m wide, 16 m long.
    const m = walls.instanceMatrix.array;
    const sx = Math.hypot(m[0], m[1], m[2]), sz = Math.hypot(m[8], m[9], m[10]);
    expect(Math.min(sx, sz)).toBeCloseTo(4.5, 0);
    expect(Math.max(sx, sz)).toBeCloseTo(16, 0);
  });
});
