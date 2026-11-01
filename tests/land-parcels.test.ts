import { describe, expect, it } from 'vitest';
import type { LngLat } from '../src/data/types';
import { LocalProjection } from '../src/geo/projection';
import { makeParcel, parcelMetrics, simplifyRing } from '../src/land/parcels';

// Build rings in metres around a point in TP.HCM and unproject to lon/lat.
const bbox = { south: 10.775, north: 10.776, west: 106.69, east: 106.691 };
const P = new LocalProjection(bbox);
/** x = east, y = north (metres). */
const ll = (x: number, y: number): LngLat => P.unproject(x, -y);
const rect = (w: number, d: number): LngLat[] => [ll(0, 0), ll(w, 0), ll(w, d), ll(0, d)];
// Street along the south (short) side, 6 m away.
const street = { name: 'Lê Lợi', line: [ll(-50, -6), ll(50, -6)] };

describe('parcel metrics (#37)', () => {
  it('measures a 5 × 20 m tube lot facing a street on its short side', () => {
    const m = parcelMetrics(rect(5, 20), [street]);
    expect(Math.abs(m.area - 100) / 100).toBeLessThan(0.005);
    expect(m.perimeter).toBeCloseTo(50, 1);
    expect(m.edges).toHaveLength(4);
    expect(m.frontage).toBeCloseTo(5, 1);
    expect(m.depth).toBeCloseTo(20, 1);
    expect(m.shape).toBe('vuong');
    expect(m.streetDistance).toBeCloseTo(6, 1);
    expect(m.streetName).toBe('Lê Lợi');
    expect(m.edges.filter((e) => e.front)).toHaveLength(1);
  });

  it('detects nở hậu and tóp hậu', () => {
    const noHau = [ll(0, 0), ll(5, 0), ll(6.5, 20), ll(-1.5, 20)];
    expect(parcelMetrics(noHau, [street]).shape).toBe('no-hau');
    const topHau = [ll(0, 0), ll(6, 0), ll(4.5, 20), ll(1.5, 20)];
    expect(parcelMetrics(topHau, [street]).shape).toBe('top-hau');
  });

  it('flags an irregular non-quadrilateral as méo', () => {
    // An L-shaped lot whose back half is as wide as the front.
    const L = [ll(0, 0), ll(10, 0), ll(10, 10), ll(4, 10), ll(4, 16), ll(10, 16), ll(10, 20), ll(0, 20)];
    expect(parcelMetrics(L, [street]).shape).toBe('meo');
  });

  it('has no frontage without a street within 40 m, and measures depth off the longest edge', () => {
    const m = parcelMetrics(rect(5, 20), []);
    expect(m.frontage).toBeNull();
    expect(m.streetDistance).toBeNull();
    expect(m.depth).toBeCloseTo(5, 1);
    const far = { line: [ll(-50, -60), ll(50, -60)] };
    expect(parcelMetrics(rect(5, 20), [far]).frontage).toBeNull();
  });

  it('simplifies closing, duplicate and collinear vertices', () => {
    const ring = [ll(0, 0), ll(0, 0), ll(2.5, 0), ll(5, 0), ll(5, 20), ll(0, 20), ll(0, 0)];
    expect(simplifyRing(ring)).toHaveLength(4);
    const p = makeParcel({ id: 't', source: 'vn2000', ring, landCode: 'ODT', soTo: '12', soThua: '345' }, [street]);
    expect(p.ring).toHaveLength(4);
    expect(p.landCodeGuessed).toBe(false);
    expect(p.metrics.frontage).toBeCloseTo(5, 1);
    expect(p.soThua).toBe('345');
  });
});
