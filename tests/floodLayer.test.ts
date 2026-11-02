import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FloodLayer } from '../src/scene/flood';
import type { FloodPoint } from '../src/data/flood';
import { LocalProjection } from '../src/geo/projection';

const proj = new LocalProjection({ south: 21.026, north: 21.034, west: 105.846, east: 105.854 });
const p = (o: Partial<FloodPoint>): FloodPoint => ({ id: 'a', name: 'A', lat: 21.03, lon: 105.85, level: 2, radiusM: 70, source: 'hanoi', ...o });

describe('FloodLayer', () => {
  it('draws flooded points inside the model and skips dry or outside ones', () => {
    const l = new FloodLayer(proj, 400, 400);
    l.setPoints([p({}), p({ id: 'b', level: 0 }), p({ id: 'c', lat: 21.2 })]);
    expect(l.mesh.count).toBe(1);
    l.dispose();
  });

  it('keeps a large off-centre zone on the slab: clipped at the model edges, not shrunk', () => {
    const l = new FloodLayer(proj, 400, 300);
    l.setPoints([p({ radiusM: 900, source: 'hcm', level: 1, lat: 21.031 })]);
    expect(l.mesh.count).toBe(1);
    const planes = (l.mesh.material as THREE.Material).clippingPlanes ?? [];
    expect(planes).toHaveLength(4);
    const kept = (x: number, z: number) => planes.every((pl) => pl.distanceToPoint(new THREE.Vector3(x, 0.3, z)) >= 0);
    expect(kept(0, 0)).toBe(true);
    expect(kept(399, -299)).toBe(true);
    expect(kept(401, 0)).toBe(false);
    expect(kept(0, -301)).toBe(false);
    l.dispose();
  });

  it('uses each axis of a non-square model: a point past the narrow edge is not drawn', () => {
    const l = new FloodLayer(proj, 400, 200);
    const [, z] = proj.project([105.85, 21.0275]); // about 280 m south of the centre
    expect(z).toBeGreaterThan(200);
    l.setPoints([p({ lat: 21.0275 })]);
    expect(l.mesh.count).toBe(0);
    l.dispose();
  });

  it('caps the disc count at 64', () => {
    const l = new FloodLayer(proj, 400, 400);
    l.setPoints(Array.from({ length: 80 }, (_, i) => p({ id: 'p' + i })));
    expect(l.mesh.count).toBe(64);
    l.dispose();
  });
});
