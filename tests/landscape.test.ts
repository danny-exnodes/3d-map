import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateDemoCity } from '../src/data/demo';
import { buildCity } from '../src/scene/buildCity';

const bbox = { south: 20.9992, west: 105.8152, north: 21.0068, east: 105.8238 };

describe('toy landscape', () => {
  it('draws bushes as extra crowns without new meshes and keeps crowns smooth', () => {
    const city = generateDemoCity(bbox);
    // The demo has no parks, so add one covering the north-west quarter.
    const { south, west, north, east } = bbox;
    const [mx, my] = [(west + east) / 2, (south + north) / 2];
    city.areas.push({ id: 'test/park', kind: 'park', polygon: [[[west, my], [mx, my], [mx, north], [west, north]]] });
    const { group, trees } = buildCity(city);
    const crowns = group.getObjectByName('crowns') as THREE.InstancedMesh;
    const trunks = group.getObjectByName('trunks') as THREE.InstancedMesh;
    expect(crowns.count).toBeGreaterThan(trunks.count);
    expect(crowns.count).toBeLessThanOrEqual(trunks.count + 300);
    expect(trees).toBe(trunks.count);
    expect((crowns.material as THREE.MeshLambertMaterial).flatShading).toBe(false);
    const g = crowns.geometry;
    expect((g.index ? g.index.count : g.getAttribute('position').count) / 3).toBeLessThanOrEqual(20);
  });

  it('keeps night bulbs cheap', () => {
    const { group } = buildCity(generateDemoCity(bbox));
    const bulbs = group.getObjectByName('lampBulbs') as THREE.InstancedMesh;
    const g = bulbs.geometry;
    // Hundreds of lamps: 80 triangles per bulb (8 × 6 sphere) instead of 168.
    expect((g.index ? g.index.count : g.getAttribute('position').count) / 3).toBeLessThanOrEqual(80);
  });

  it('keeps the water matte so the moon does not bloom on it', () => {
    const { group } = buildCity(generateDemoCity(bbox));
    const water = group.getObjectByName('water') as THREE.Mesh;
    expect((water.material as THREE.MeshStandardMaterial).roughness).toBeGreaterThanOrEqual(0.6);
  });
});
