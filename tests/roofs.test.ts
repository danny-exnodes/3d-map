import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildingFromOsm } from '../src/data/buildings';
import { LocalProjection } from '../src/geo/projection';
import { buildBuildings } from '../src/scene/buildings';
import { MeshBuilder, type XZ } from '../src/scene/geometry';
import { buildRoof, minAreaRect } from '../src/scene/roofs';

const rotated = (w: number, l: number, deg: number): XZ[] => {
  const a = (deg * Math.PI) / 180;
  return [[-w / 2, -l / 2], [w / 2, -l / 2], [w / 2, l / 2], [-w / 2, l / 2]].map(([x, z]) => [x * Math.cos(a) - z * Math.sin(a), x * Math.sin(a) + z * Math.cos(a)]);
};

describe('minAreaRect', () => {
  it('recovers a rotated rectangle', () => {
    const r = minAreaRect([...rotated(6, 18, 33), [0.5, 0.5]]);
    expect(r.short).toBeCloseTo(6, 5);
    expect(r.long).toBeCloseTo(18, 5);
    expect(r.area).toBeCloseTo(108, 4);
  });
});

describe('buildRoof', () => {
  const colors = { roof: new THREE.Color('#c44536'), facade: new THREE.Color('#f4b6c2') };
  const normalsY = (mb: MeshBuilder) => mb.normals.filter((_, i) => i % 3 === 1);

  it('gabled roofs rise above the eaves and face outwards/up', () => {
    const mb = new MeshBuilder();
    buildRoof(mb, { shape: 'gabled', rings: [rotated(6, 12, 20)], y: 10, ...colors });
    const ys = mb.positions.filter((_, i) => i % 3 === 1);
    expect(Math.max(...ys)).toBeGreaterThan(11);
    expect(Math.min(...ys)).toBeCloseTo(10, 5);
    // Every non-underside triangle has a non-negative up component.
    const ny = normalsY(mb);
    expect(ny.filter((v) => v < -0.99).length).toBe(6); // 2 underside triangles × 3 vertices
  });

  it('falls back to flat for L-shaped footprints', () => {
    const mb = new MeshBuilder();
    const L: XZ[] = [[0, 0], [20, 0], [20, 5], [5, 5], [5, 20], [0, 20]];
    buildRoof(mb, { shape: 'hipped', rings: [L], y: 6, ...colors });
    expect(normalsY(mb).every((v) => v > 0.99)).toBe(true);
  });

  it('builds domes and pagodas', () => {
    for (const shape of ['dome', 'pagoda', 'pyramidal'] as const) {
      const mb = new MeshBuilder();
      buildRoof(mb, { shape, rings: [rotated(14, 20, 0)], y: 5, ...colors });
      expect(mb.positions.length).toBeGreaterThan(30);
    }
  });
});

describe('procedural detail', () => {
  it('adds balconies to tube houses facing the nearest road', () => {
    const bbox = { south: 21, west: 105.8, north: 21.001, east: 105.801 };
    const proj = new LocalProjection(bbox);
    const ring = rotated(4.5, 16, 0).map(([x, z]) => proj.unproject(x, z));
    const b = buildingFromOsm('way/42', [ring], { building: 'yes', 'building:levels': '5' });
    expect(b.archetype).toBe('tube');
    const res = buildBuildings([b], proj, { roadDistance: (_x, z) => Math.abs(z - 20) });
    const balconies = res.details.getObjectByName('detail-balconies') as THREE.InstancedMesh;
    expect(balconies.count).toBeGreaterThanOrEqual(2);
    // Front = the short side at z = +8 (closest to the road at z = 20).
    const m = new THREE.Matrix4();
    balconies.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).z).toBeGreaterThan(8);
    expect(res.ids).toEqual(['way/42']);
  });
});
