import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { makeBuilding } from '../src/data/buildings';
import { LocalProjection } from '../src/geo/projection';
import { buildBuildings } from '../src/scene/buildings';
import { toyDeckContains, toyFlatRoofUnit, toyRoofDeck } from '../src/scene/toyGeometry';

const proj = new LocalProjection({ south: 10.73, west: 106.66, north: 10.74, east: 106.67 });
const rect = (lon: number, lat: number, w: number, l: number): [number, number][] => {
  const dx = w / 2 / 109000, dy = l / 2 / 110574;
  return [[lon - dx, lat - dy], [lon + dx, lat - dy], [lon + dx, lat + dy], [lon - dx, lat + dy]];
};

describe('rooftop cubes on toy roofs (#32)', () => {
  it('flat roof slab top is the instance origin height', () => {
    const geo = toyFlatRoofUnit();
    geo.computeBoundingBox();
    expect(geo.boundingBox!.max.y).toBeCloseTo(0, 6);
  });

  it('keeps every hut and tank on the deck, bottoms on the slab top', () => {
    const sizes: [number, number, number][] = [[4.5, 14, 9], [6, 6, 6], [3.6, 5, 6], [8, 12, 9], [4, 4, 6], [10, 10, 9]];
    const houses = [];
    for (let i = 0; i < 80; i++) {
      const [w, l, h] = sizes[i % sizes.length];
      houses.push(makeBuilding({ id: `h${i}`, polygon: [rect(106.661 + (i % 20) * 0.0004, 10.731 + Math.floor(i / 20) * 0.002, w, l)], kind: 'house', levels: Math.round(h / 3), height: h, tags: { 'roof:shape': 'flat' }, footprintSource: 'overture' }));
    }
    const r = buildBuildings(houses, proj);
    const roofs = r.instanced.find((m) => m.name === 'buildings-roof-flat')!;
    expect(roofs.count).toBeGreaterThan(40);
    const huts = r.details.getObjectByName('detail-huts') as THREE.InstancedMesh;
    const tanks = r.details.getObjectByName('detail-tanks') as THREE.InstancedMesh;
    expect(huts.count).toBeGreaterThan(5);
    expect(tanks.count).toBeGreaterThan(0);

    // Each roof instance: centre, slab-top height, size (local x = w, z = l), yaw.
    const roofM = Array.from({ length: roofs.count }, (_, k) => { const m = new THREE.Matrix4(); roofs.getMatrixAt(k, m); return m; });
    const inv = roofM.map((m) => m.clone().invert());
    const size = roofM.map((m) => new THREE.Vector3().setFromMatrixScale(m));
    const roofQ = roofM.map((m) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(m)));
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    // Asserts the cube (half-sizes in its unit frame) lies in the deck of the roof it is over; returns that roof's slab top.
    const check = (mesh: THREE.InstancedMesh, k: number, halfX: number, halfZ: number) => {
      mesh.getMatrixAt(k, m);
      m.decompose(p, q, sc);
      const hx = halfX * sc.x, hz = halfZ * sc.z;
      const i = roofM.findIndex((_, j) => {
        const loc = p.clone().applyMatrix4(inv[j]).multiply(size[j]);
        return Math.abs(loc.x) < size[j].x / 2 && Math.abs(loc.z) < size[j].z / 2;
      });
      expect(i).toBeGreaterThanOrEqual(0);
      const loc = p.clone().applyMatrix4(inv[i]).multiply(size[i]);
      // Cube yaw relative to the roof: its local x runs along the roof's long axis (z).
      const rel = roofQ[i].clone().invert().multiply(q);
      const ang = 2 * Math.atan2(rel.y, rel.w);
      const c = Math.abs(Math.cos(ang)), s = Math.abs(Math.sin(ang));
      expect(toyDeckContains(toyRoofDeck(size[i].x, size[i].z), loc.x, loc.z, hx * c + hz * s, hx * s + hz * c)).toBe(true);
      return roofM[i].elements[13];
    };
    const hutTops: number[] = [];
    for (let k = 0; k < huts.count; k++) {
      const top = check(huts, k, 0.5, 0.5);
      huts.getMatrixAt(k, m);
      expect(Math.abs(m.elements[13] - top)).toBeLessThan(0.01); // bottom on the slab top
      hutTops.push(m.elements[13] + m.elements[5]);
    }
    // A tank rests on the slab top or on a hut roof; its footprint is 1.7 × 1.1 and its bottom is centre − radius.
    for (let k = 0; k < tanks.count; k++) {
      tanks.getMatrixAt(k, m);
      m.decompose(p, q, sc);
      const bottom = p.y - 0.55 * sc.y;
      const onRoof = roofM.some((rm) => Math.abs(bottom - rm.elements[13]) < 0.01);
      expect(onRoof || hutTops.some((t) => Math.abs(bottom - t) < 0.01)).toBe(true);
      check(tanks, k, 0.85, 0.55);
    }
  });
});
