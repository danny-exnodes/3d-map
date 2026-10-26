import { describe, expect, it } from 'vitest';
import { generateDemoCity } from '../src/data/demo';
import { bboxAreaKm2, LocalProjection } from '../src/geo/projection';
import { compassLabel, sunPosition } from '../src/scene/sun';
import { densityAt, flowFactor } from '../src/scene/traffic';

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
    expect(flowFactor('way/1', 8)).toBeLessThanOrEqual(flowFactor('way/1', 3));
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
