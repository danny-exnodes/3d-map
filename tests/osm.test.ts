import { describe, expect, it } from 'vitest';
import { buildOverpassQuery, parseNumber, parseOverpass } from '../src/data/osm';
import { joinRings } from '../src/data/rings';

const bbox = { south: 21, west: 105.8, north: 21.01, east: 105.81 };
const sq = (x: number, y: number, s = 0.0002) => [
  { lat: y, lon: x }, { lat: y, lon: x + s }, { lat: y + s, lon: x + s }, { lat: y + s, lon: x }, { lat: y, lon: x },
];

describe('parseNumber', () => {
  it('handles units and commas', () => {
    expect(parseNumber('12')).toBe(12);
    expect(parseNumber('12,5 m')).toBe(12.5);
    expect(parseNumber('30 ft')).toBeCloseTo(9.144);
    expect(parseNumber('abc')).toBeUndefined();
  });
});

describe('buildOverpassQuery', () => {
  it('uses south,west,north,east order', () => {
    expect(buildOverpassQuery(bbox)).toContain('(21,105.8,21.01,105.81)');
  });
});

describe('joinRings', () => {
  it('joins open segments, reversing as needed', () => {
    const rings = joinRings([
      [[0, 0], [1, 0]],
      [[1, 1], [1, 0]],
      [[1, 1], [0, 1], [0, 0]],
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
  });
});

describe('parseOverpass', () => {
  const data = parseOverpass(bbox, {
    elements: [
      { type: 'way', id: 1, tags: { building: 'yes', 'building:levels': '5' }, geometry: sq(105.801, 21.001) },
      { type: 'way', id: 2, tags: { building: 'house', height: '7.5', 'roof:shape': 'gabled' }, geometry: sq(105.802, 21.001) },
      { type: 'way', id: 3, tags: { highway: 'primary', lanes: '4', bridge: 'yes', layer: '1' }, geometry: [{ lat: 21, lon: 105.8 }, { lat: 21.01, lon: 105.81 }] },
      { type: 'way', id: 4, tags: { highway: 'bus_stop' }, geometry: [{ lat: 21, lon: 105.8 }, { lat: 21.01, lon: 105.81 }] },
      { type: 'node', id: 5, lat: 21.005, lon: 105.805, tags: { natural: 'tree' } },
      {
        type: 'relation', id: 6, tags: { natural: 'water' },
        members: [
          { type: 'way', role: 'outer', geometry: sq(105.805, 21.005, 0.001).slice(0, 3) },
          { type: 'way', role: 'outer', geometry: sq(105.805, 21.005, 0.001).slice(2) },
        ],
      },
      { type: 'way', id: 7, tags: { railway: 'light_rail', bridge: 'viaduct', layer: '2' }, geometry: [{ lat: 21, lon: 105.8 }, { lat: 21.01, lon: 105.8 }] },
      { type: 'node', id: 8, lat: 21.004, lon: 105.804, tags: { amenity: 'place_of_worship', name: 'Chùa Phúc Khánh' } },
    ],
  });

  it('extracts buildings with heights', () => {
    expect(data.buildings).toHaveLength(2);
    expect(data.buildings[0].height).toBeCloseTo(5 * 3.3);
    expect(data.buildings[0].polygon[0]).toHaveLength(4);
    expect(data.buildings[1].height).toBe(7.5);
    expect(data.buildings[1].roof).toBe('gabled');
  });

  it('extracts roads and skips unknown highway kinds', () => {
    expect(data.roads).toHaveLength(1);
    expect(data.roads[0]).toMatchObject({ cls: 'primary', lanes: 4, bridge: true, layer: 1 });
  });

  it('assembles multipolygon water and keeps trees, rails, POIs', () => {
    expect(data.areas.filter((a) => a.kind === 'water')).toHaveLength(1);
    expect(data.trees).toHaveLength(1);
    expect(data.rails[0]).toMatchObject({ kind: 'light_rail', bridge: true, layer: 2 });
    expect(data.pois[0].name).toBe('Chùa Phúc Khánh');
  });
});
