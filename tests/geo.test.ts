import { describe, expect, it } from 'vitest';
import { generateDemoCity } from '../src/data/demo';
import { bboxAreaKm2, LocalProjection } from '../src/geo/projection';
import { compassLabel, sunPosition } from '../src/scene/sun';
import { densityAt } from '../src/scene/traffic';
import { kindMix, roadLoad } from '../src/scene/trafficModel';

const bbox = { south: 20.9992, west: 105.8152, north: 21.0068, east: 105.8238 };

describe('projection', () => {
  it('round-trips and centres on the bbox', () => {
    const p = new LocalProjection(bbox);
    const [cx, cz] = p.project([p.lon0, p.lat0]);
    expect(Math.abs(cx) + Math.abs(cz)).toBe(0);
    const [x, z] = p.project([105.82, 21.005]);
    const [lon, lat] = p.unproject(x, z);
    expect(lon).toBeCloseTo(105.82, 9);
    expect(lat).toBeCloseTo(21.005, 9);
    // North is -z.
    expect(p.project([p.lon0, bbox.north])[1]).toBeLessThan(0);
  });

  it('computes area in km²', () => {
    expect(bboxAreaKm2(bbox)).toBeGreaterThan(0.7);
    expect(bboxAreaKm2(bbox)).toBeLessThan(0.8);
  });
});

describe('sun', () => {
  it('is high around noon and below the horizon at midnight in Hanoi', () => {
    // 12:00 local (UTC+7) = 05:00 UTC
    const noon = sunPosition(new Date(Date.UTC(2026, 5, 21, 5, 0)), 21, 105.8);
    const midnight = sunPosition(new Date(Date.UTC(2026, 5, 20, 17, 0)), 21, 105.8);
    expect((noon.altitude * 180) / Math.PI).toBeGreaterThan(80);
    expect(midnight.altitude).toBeLessThan(0);
  });

  it('rises in the east', () => {
    const morning = sunPosition(new Date(Date.UTC(2026, 2, 20, 0, 30)), 21, 105.8); // 07:30 local
    expect(morning.azimuth).toBeLessThan(-Math.PI / 3); // negative = east of south
  });

  it('labels compass directions', () => {
    expect(compassLabel(0)).toBe('Bắc');
    expect(compassLabel(135)).toBe('Đông Nam');
    expect(compassLabel(350, true)).toBe('B');
  });
});

describe('traffic model', () => {
  it('is busier at rush hour than at night', () => {
    expect(densityAt(8)).toBeGreaterThan(densityAt(3));
    // Slower at rush hour, and more so near attractors.
    expect(roadLoad('primary', 8).speedRatio).toBeLessThan(roadLoad('primary', 3).speedRatio);
    expect(roadLoad('primary', 8, 1.4).speedRatio).toBeLessThan(roadLoad('primary', 8).speedRatio);
    // Arterials carry far more than alleys.
    expect(roadLoad('primary', 8).flow).toBeGreaterThan(2 * roadLoad('residential', 8).flow);
  });

  it('is mostly motorbikes on city streets (#26)', () => {
    const mix = kindMix('secondary');
    expect(mix.moto).toBeGreaterThan(0.7);
    expect(Object.values(mix).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(Object.values(kindMix('motorway')).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(Object.values(kindMix('residential')).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });
});

describe('demo city', () => {
  it('is deterministic and non-trivial', () => {
    const a = generateDemoCity(bbox);
    const b = generateDemoCity(bbox);
    expect(a.buildings.length).toBeGreaterThan(300);
    expect(a.buildings.length).toBe(b.buildings.length);
    expect(a.roads.some((r) => r.bridge)).toBe(true);
  });
});

describe('mono colour mode', () => {
  it('maps colours to the tint while keeping relative brightness', async () => {
    const THREE = await import('three');
    const { monoColor, MONO_TINT } = await import('../src/scene/colorMode');
    const water = monoColor(new THREE.Color('#5fa8d8'));
    const road = monoColor(new THREE.Color('#40444d'));
    const white = monoColor(new THREE.Color('#ffffff'));
    expect(white.r).toBeCloseTo(MONO_TINT.r, 5);
    expect(road.r).toBeLessThan(water.r);
    // Near-neutral: channels follow the tint ratios.
    expect(water.r / water.b).toBeCloseTo(MONO_TINT.r / MONO_TINT.b, 5);
    // amount = 0 is identity.
    expect(monoColor(new THREE.Color('#ff0000'), 0).getHexString()).toBe('ff0000');
  });
});

describe('clipping to the area', () => {
  it('cuts polylines and polygons at the bbox', async () => {
    const { clipPolyline, clipPolygon } = await import('../src/data/clip');
    const b = { south: 0, west: 0, north: 1, east: 1 };
    expect(clipPolyline([[-1, 0.5], [2, 0.5]], b)).toEqual([[[0, 0.5], [1, 0.5]]]);
    // Leaves and re-enters: two pieces.
    expect(clipPolyline([[0.2, 0.2], [0.2, 2], [0.8, 2], [0.8, 0.2]], b)).toHaveLength(2);
    expect(clipPolyline([[2, 2], [3, 3]], b)).toEqual([]);
    const sq = clipPolygon([[[-1, -1], [0.5, -1], [0.5, 0.5], [-1, 0.5]]], b)!;
    expect(sq[0]).toHaveLength(4);
    expect(clipPolygon([[[2, 2], [3, 2], [3, 3]]], b)).toBeNull();
  });
});

describe('Overture segments with ranged rules (#25)', () => {
  it('cuts a segment where a tunnel starts and ends', async () => {
    const { roadsFromSegment } = await import('../src/data/overtureBase');
    const line: [number, number][] = [[105.84, 21.0], [105.85, 21.0]];
    const props = { class: 'primary', level_rules: JSON.stringify([{ value: -1, between: [0.3, 0.7] }]) };
    const roads = roadsFromSegment(props, line, 's1');
    expect(roads.map((r) => r.tunnel)).toEqual([false, true, false]);
    expect(roads[1].line[0][0]).toBeCloseTo(105.843, 4);
    expect(roads[1].line[roads[1].line.length - 1][0]).toBeCloseTo(105.847, 4);
    expect(roadsFromSegment({ class: 'primary' }, line, 's2')).toHaveLength(1);
  });
});

describe('reverse geocoding (#28)', () => {
  it('formats a Vietnamese address from Nominatim parts', async () => {
    const { formatAddress } = await import('../src/services/geocode');
    expect(formatAddress({ house_number: '101', road: 'Châu Thị Hoá', quarter: 'Phường Chánh Hưng', city: 'Thành phố Hồ Chí Minh' })).toBe('101 Châu Thị Hoá, Phường Chánh Hưng, Thành phố Hồ Chí Minh');
    expect(formatAddress({ road: 'Đường Láng', suburb: 'Phường Láng', city: 'Hà Nội', amenity: 'Trường X' })).toBe('Trường X, Đường Láng, Phường Láng, Hà Nội');
  });
});
