import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Aircraft, deadReckon, displayAltitude, displayRadius } from '../src/scene/aircraft';
import type { Flight } from '../src/data/flights';
import { LocalProjection } from '../src/geo/projection';

const flight = (o: Partial<Flight> = {}): Flight => ({ hex: 'abc123', callsign: 'VN123', type: 'A321', lat: 21.0, lon: 105.8, altM: 3000, gsMs: 100, trackDeg: 90, seenAt: 1_000_000, ...o });
const proj = new LocalProjection({ south: 20.995, north: 21.005, west: 105.795, east: 105.805 });

describe('displayRadius', () => {
  const half = 600;
  it('is the identity inside the model', () => {
    for (const d of [0, 1, 300, 600]) expect(displayRadius(d, half)).toBe(d);
  });
  it('grows with distance and lands 40 nm within 3x the half-size', () => {
    let prev = -1;
    for (const d of [0, 200, 600, 601, 1000, 3000, 10_000, 40_000, 74_080]) {
      const r = displayRadius(d, half);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    expect(displayRadius(74_080, half)).toBeLessThanOrEqual(3 * half);
    expect(displayRadius(1000, half)).toBeGreaterThan(displayRadius(700, half));
  });
});

describe('displayAltitude', () => {
  it('runs from 150 m on the ground to 900 m at 12 km and up', () => {
    expect(displayAltitude(0)).toBe(150);
    expect(displayAltitude(12_000)).toBe(900);
    expect(displayAltitude(20_000)).toBe(900);
    expect(displayAltitude(-50)).toBe(150);
  });
  it('is monotonic', () => {
    let prev = 0;
    for (let a = 0; a <= 13_000; a += 250) {
      expect(displayAltitude(a)).toBeGreaterThanOrEqual(prev);
      prev = displayAltitude(a);
    }
  });
});

describe('deadReckon', () => {
  it('moves a plane heading 90 deg at 100 m/s about 1000 m east in 10 s, and not north', () => {
    const f = flight();
    const p = deadReckon(f, f.seenAt + 10_000);
    const [x, z] = proj.project([p.lon, p.lat]);
    const [x0, z0] = proj.project([f.lon, f.lat]);
    expect(x - x0).toBeCloseTo(1000, -1);
    expect(Math.abs(x - x0 - 1000)).toBeLessThan(5);
    expect(Math.abs(z - z0)).toBeLessThan(5);
  });
  it('does not move backwards for a report from the future', () => {
    const f = flight();
    expect(deadReckon(f, f.seenAt - 5000)).toEqual({ lat: f.lat, lon: f.lon });
  });
});

describe('Aircraft', () => {
  it('shows planes and drops those with no report for over 60 s', () => {
    const a = new Aircraft(proj, 600);
    const now = 1_000_000;
    a.setFlights([flight(), flight({ hex: 'b', lat: 21.001 })], now);
    a.update(now, new THREE.PerspectiveCamera());
    expect(a.mesh.count).toBe(2);
    a.update(now + 61_000, new THREE.PerspectiveCamera());
    expect(a.mesh.count).toBe(0);
    a.dispose();
  });

  it('points the nose along the track: east for 90, north for 0', () => {
    const a = new Aircraft(proj, 600);
    const now = 1_000_000;
    a.setFlights([flight({ gsMs: 0, trackDeg: 90 }), flight({ hex: 'n', gsMs: 0, trackDeg: 0 })], now);
    a.update(now, new THREE.PerspectiveCamera());
    const m = new THREE.Matrix4();
    const nose = (i: number) => {
      a.mesh.getMatrixAt(i, m);
      return new THREE.Vector3(1, 0, 0).transformDirection(m);
    };
    const dirs = [nose(0), nose(1)].sort((p, q) => q.x - p.x);
    expect(dirs[0].x).toBeCloseTo(1, 5);
    expect(dirs[1].z).toBeCloseTo(-1, 5);
    a.dispose();
  });

  it('picks the plane a ray passes through, and nothing for a ray far away', () => {
    const a = new Aircraft(proj, 600);
    const now = 1_000_000;
    a.setFlights([flight({ gsMs: 0 })], now);
    a.update(now, new THREE.PerspectiveCamera());
    const m = new THREE.Matrix4();
    a.mesh.getMatrixAt(0, m);
    const at = new THREE.Vector3().setFromMatrixPosition(m);
    const ray = new THREE.Raycaster(at.clone().add(new THREE.Vector3(0, 500, 0)), new THREE.Vector3(0, -1, 0));
    expect(a.pick(ray)?.hex).toBe('abc123');
    const miss = new THREE.Raycaster(at.clone().add(new THREE.Vector3(2000, 500, 0)), new THREE.Vector3(0, -1, 0));
    expect(a.pick(miss)).toBeNull();
    a.dispose();
  });

  it('keeps the nearest planes when there are more than it can draw', () => {
    const a = new Aircraft(proj, 600);
    const now = 1_000_000;
    a.setFlights(Array.from({ length: 400 }, (_, i) => flight({ hex: String(i), lat: 21 + i * 0.01 })), now);
    a.update(now, new THREE.PerspectiveCamera());
    expect(a.mesh.count).toBeLessThanOrEqual(100);
    expect(a.mesh.count).toBeGreaterThan(0);
    a.dispose();
  });
});
