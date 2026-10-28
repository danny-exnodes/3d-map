import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { generateDemoCity } from '../src/data/demo';
import { buildCity } from '../src/scene/buildCity';
import { deserializeObjects, serializeObject } from '../src/scene/serialize';

const bbox = { south: 20.9992, west: 105.8152, north: 21.0068, east: 105.8238 };

describe('worker mesh serialization', () => {
  it('round-trips the built city without losing geometry or material kinds', () => {
    const built = buildCity(generateDemoCity(bbox));
    const before: { name: string; verts: number; inst: number }[] = [];
    built.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) before.push({ name: m.name, verts: m.geometry.attributes.position.count, inst: (o as THREE.InstancedMesh).count ?? 0 });
    });
    const { objects, transfer } = serializeObject(built.group);
    expect(transfer.length).toBeGreaterThan(0);
    const g = deserializeObjects(structuredClone(objects));
    const after = g.children.map((o) => ({
      name: o.name,
      verts: (o as THREE.Mesh).geometry.attributes.position.count,
      inst: (o as THREE.InstancedMesh).count ?? 0,
    }));
    expect(after).toEqual(before);
    const buildings = g.getObjectByName('buildings') as THREE.Mesh;
    expect((buildings.material as THREE.Material).userData.uniforms.uNight).toBeDefined();
    // Toy prototypes keep their shader placement and their shadow material (#32).
    const walls = g.getObjectByName('buildings-walls') as THREE.InstancedMesh;
    expect((walls.material as THREE.Material).userData.toyProto).toBe(true);
    expect(walls.customDepthMaterial).toBeDefined();
    // The street end (door side) of each house crosses the worker boundary per instance.
    const front = walls.geometry.getAttribute('aFront') as THREE.InstancedBufferAttribute;
    expect(front.isInstancedBufferAttribute).toBe(true);
    expect(front.count).toBe(walls.count);
    const flatRoof = g.getObjectByName('buildings-roof-flat') as THREE.InstancedMesh;
    expect(flatRoof.geometry.getAttribute('aRoof').getX(0)).toBe(1);
    const bulbs = g.getObjectByName('lampBulbs') as THREE.InstancedMesh;
    expect((bulbs.material as THREE.MeshBasicMaterial).color.r).toBeGreaterThan(1); // HDR colour preserved
  });
});
