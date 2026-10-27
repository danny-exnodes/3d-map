import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { bakeToyInstance, toyFlatRoofUnit, toyPitchedRoofUnit, toyWallsUnit, TOY } from '../src/scene/toyGeometry';

const m = (w: number, h: number, l: number, y = 0) => new THREE.Matrix4().compose(new THREE.Vector3(0, y, 0), new THREE.Quaternion(), new THREE.Vector3(w, h, l));
const box = (g: THREE.BufferGeometry) => (g.computeBoundingBox(), g.boundingBox!);

describe('toy prototypes', () => {
  it('toy geometry stays inside the footprint', () => {
    for (const [w, l] of [[4.5, 16], [12, 30], [2.5, 3]]) {
      for (const unit of [toyWallsUnit(), toyFlatRoofUnit(), toyPitchedRoofUnit(false), toyPitchedRoofUnit(true)]) {
        const b = box(bakeToyInstance(unit, m(w, 9, l)));
        expect(b.max.x - b.min.x).toBeLessThanOrEqual(w + 1e-3);
        expect(b.max.z - b.min.z).toBeLessThanOrEqual(l + 1e-3);
      }
    }
  });
  it('keeps the same real bevel on small and large houses', () => {
    for (const [w, l] of [[4.4, 10], [20, 40]]) {
      const g = bakeToyInstance(toyWallsUnit(), m(w, 9, l));
      // The plinth spans the full footprint.
      expect(box(g).max.x).toBeCloseTo(w / 2, 3);
      // Body corner above the plinth: the 45° bevel vertex sits r·(√2 − 1) from the sharp inset corner, whatever the size.
      const p = g.getAttribute('position');
      let best = Infinity;
      for (let i = 0; i < p.count; i++) if (p.getY(i) > TOY.plinthH + 1e-3) best = Math.min(best, Math.hypot(w / 2 - TOY.inset - p.getX(i), l / 2 - TOY.inset - p.getZ(i)));
      expect(best).toBeCloseTo(TOY.radius * (Math.SQRT2 - 1), 1);
    }
  });
  it('clamps the radius on tiny houses', () => {
    const g = bakeToyInstance(toyWallsUnit(), m(2.5, 6, 2.5));
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      expect(Math.abs(p.getX(i))).toBeLessThanOrEqual(1.25 + 1e-3);
      expect(Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i))).toBe(true);
    }
    expect(g.getAttribute('normal').count).toBe(p.count);
  });
  it('keeps the inset body of a tiny house from turning inside out', () => {
    const p = bakeToyInstance(toyWallsUnit(), m(2.5, 6, 2.5)).getAttribute('position');
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) <= TOY.plinthH + 1e-3) continue;
      expect(Math.abs(p.getX(i))).toBeLessThanOrEqual(1.25 - TOY.inset + 1e-3);
      expect(Math.abs(p.getZ(i))).toBeLessThanOrEqual(1.25 - TOY.inset + 1e-3);
      minX = Math.min(minX, p.getX(i));
      maxX = Math.max(maxX, p.getX(i));
    }
    expect(maxX - minX).toBeCloseTo(2.5 - 2 * TOY.inset, 3);
  });
  it('stays low-poly', () => {
    const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    expect(tris(toyWallsUnit()) + tris(toyPitchedRoofUnit(false))).toBeLessThanOrEqual(140);
  });
});

describe('toy prototypes: shading and chimneys', () => {
  it('winds every face the way its normals point', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
    for (const [w, rise, l] of [[2.5, 1, 2.5], [4.5, 1.8, 16], [20, 3, 40]]) {
      for (const [unit, h] of [[toyWallsUnit(), 9], [toyFlatRoofUnit(), 1], [toyPitchedRoofUnit(false), rise], [toyPitchedRoofUnit(true), rise]] as const) {
        const g = bakeToyInstance(unit, new THREE.Matrix4().compose(new THREE.Vector3(5, 2, -3), q, new THREE.Vector3(w, h, l)));
        const p = g.getAttribute('position'), n = g.getAttribute('normal'), idx = g.index!;
        for (let i = 0; i < idx.count; i += 3) {
          const ids = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
          const [a, b, c] = ids.map((k) => new THREE.Vector3().fromBufferAttribute(p, k));
          const face = b.clone().sub(a).cross(c.clone().sub(a));
          if (face.length() < 1e-9) continue;
          const want = ids.reduce((s, k) => s.add(new THREE.Vector3().fromBufferAttribute(n, k)), new THREE.Vector3());
          expect(face.dot(want)).toBeGreaterThan(0);
        }
      }
    }
  });
  it('drops the chimney by the same seed rule as the shader', () => {
    const top = (seed?: number) => box(bakeToyInstance(toyPitchedRoofUnit(false), m(6, 2, 12), seed)).max.y;
    // fract(seed × 13) > 0.6 drops it.
    expect(top(0.05)).toBeCloseTo(2, 3);
    expect(top(0.01)).toBeGreaterThan(2.4);
    expect(top()).toBeGreaterThan(2.4);
  });
});
