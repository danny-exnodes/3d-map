import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FloodLayer } from '../src/scene/flood';
import type { FloodPoint } from '../src/data/flood';
import { LocalProjection } from '../src/geo/projection';

const proj = new LocalProjection({ south: 21.026, north: 21.034, west: 105.846, east: 105.854 });
const p = (o: Partial<FloodPoint>): FloodPoint => ({ id: 'a', name: 'A', lat: 21.03, lon: 105.85, level: 2, radiusM: 70, source: 'hanoi', ...o });

describe('FloodLayer', () => {
  it('draws flooded points inside the model and skips dry or outside ones', () => {
    const l = new FloodLayer(proj, 400);
    l.setPoints([p({}), p({ id: 'b', level: 0 }), p({ id: 'c', lat: 21.2 })]);
    expect(l.mesh.count).toBe(1);
    l.dispose();
  });

  it('clamps a large zone to half the model', () => {
    const l = new FloodLayer(proj, 400);
    l.setPoints([p({ radiusM: 900, source: 'hcm', level: 1 })]);
    const m = new THREE.Matrix4();
    l.mesh.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixScale(m).x).toBeCloseTo(400);
    l.dispose();
  });

  it('caps the disc count at 64', () => {
    const l = new FloodLayer(proj, 400);
    l.setPoints(Array.from({ length: 80 }, (_, i) => p({ id: 'p' + i })));
    expect(l.mesh.count).toBe(64);
    l.dispose();
  });
});
