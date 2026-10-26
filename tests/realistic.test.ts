import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateDemoCity } from '../src/data/demo';
import { buildCity } from '../src/scene/buildCity';
import { Realism } from '../src/scene/realistic';

const bbox = { south: 10.75, west: 106.65, north: 10.756, east: 106.656 };

describe('realistic view (#19)', () => {
  it('swaps every lit material for a PBR one and restores the originals', () => {
    const { group } = buildCity(generateDemoCity(bbox));
    const before = new Map<THREE.Mesh, { mat: THREE.Material | THREE.Material[]; geo: THREE.BufferGeometry }>();
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) before.set(m, { mat: m.material, geo: m.geometry });
    });
    // PMREM is only used by update(); apply/restore need no GPU.
    const realism = new Realism({} as THREE.WebGLRenderer);
    realism.apply(group);
    for (const [mesh] of before) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if ((m as THREE.MeshBasicMaterial).isMeshBasicMaterial) continue;
        expect((m as THREE.MeshStandardMaterial).isMeshStandardMaterial, mesh.name).toBe(true);
      }
    }
    const buildings = group.getObjectByName('buildings') as THREE.Mesh;
    // The realistic building material drives the same uniforms (night, selection, source view).
    expect((buildings.material as THREE.Material).userData.uniforms).toBe((before.get(buildings)!.mat as THREE.Material).userData.uniforms);
    const crowns = group.getObjectByName('crowns') as THREE.Mesh;
    expect(crowns.geometry).not.toBe(before.get(crowns)!.geo);
    expect(crowns.geometry.getAttribute('position').count).toBeGreaterThan(before.get(crowns)!.geo.getAttribute('position').count);

    realism.apply(group); // idempotent
    realism.restore();
    for (const [mesh, { mat, geo }] of before) {
      expect(mesh.material).toBe(mat);
      expect(mesh.geometry).toBe(geo);
    }
  });
});
