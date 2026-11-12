import 'fake-indexeddb/auto';
import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetCacheForTests, cacheClear } from '../src/data/cache';
import { _resetHeroMaterialsForTests, fromBuffers, heroPreset, HERO_PRESETS, heroSeed, heroTreeGroup, toBuffers } from '../src/scene/proceduralTree';

// `Tree.generate()` loads bundled textures via `THREE.TextureLoader`, which needs `document`/`Image`
// and so cannot run in vitest's Node environment (no jsdom in this project, see CLAUDE.md). This fake
// stands in for the branch-growth simulation so the cache-aware wrapper around it can still be tested.
let generateCalls = 0;
vi.mock('@dgreenheck/ez-tree', () => {
  class FakeMesh {
    constructor(public geometry: THREE.BufferGeometry) {}
    material = {};
  }
  class Tree {
    options: { seed: number } = { seed: 0 };
    branchesMesh!: FakeMesh;
    leavesMesh!: FakeMesh;
    loadPreset(_name: string) {}
    generate() {
      generateCalls++;
      const n = 1 + (Math.abs(this.options.seed) % 5);
      this.branchesMesh = new FakeMesh(new THREE.BoxGeometry(1, n, 1));
      this.leavesMesh = new FakeMesh(new THREE.BoxGeometry(1, n * 2, 1));
    }
  }
  return { Tree };
});

beforeEach(async () => {
  _resetCacheForTests();
  await cacheClear();
  _resetHeroMaterialsForTests();
  generateCalls = 0;
});

describe('heroSeed / heroPreset', () => {
  it('is deterministic for the same spot', () => {
    expect(heroSeed(123.4, -56.7)).toBe(heroSeed(123.4, -56.7));
  });

  it('picks one of the fixed v1 presets', () => {
    for (let i = 0; i < 20; i++) expect(HERO_PRESETS).toContain(heroPreset(heroSeed(i * 7, i * 3)));
  });
});

describe('geometry buffer round-trip', () => {
  it('rebuilds an equivalent BufferGeometry from its typed-array buffers', () => {
    const g = new THREE.BoxGeometry(2, 3, 4);
    const g2 = fromBuffers(toBuffers(g));
    expect([...g2.getAttribute('position').array]).toEqual([...g.getAttribute('position').array]);
    expect(g2.getIndex()!.array.length).toBe(g.getIndex()!.array.length);
  });
});

describe('heroTreeGroup', () => {
  it('builds a group with a branch mesh and a leaf mesh at (x, z)', async () => {
    const g = await heroTreeGroup(10, 20);
    expect(g.name).toBe('hero-tree');
    expect(g.children.length).toBe(2);
    expect(g.position.x).toBe(10);
    expect(g.position.z).toBe(20);
  });

  it('keeps the same shape and does not regenerate on a second call for the same spot', async () => {
    const a = await heroTreeGroup(5, 5);
    const callsAfterFirst = generateCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    // The geometry cache write is fire-and-forget (project convention, see data/cache.ts callers);
    // give it a tick to land before relying on it being there for the second call.
    await new Promise((r) => setTimeout(r, 10));
    const b = await heroTreeGroup(5, 5);
    expect(generateCalls).toBe(callsAfterFirst);
    const posA = (a.children[0] as THREE.Mesh).geometry.getAttribute('position').array;
    const posB = (b.children[0] as THREE.Mesh).geometry.getAttribute('position').array;
    expect([...posB]).toEqual([...posA]);
  });
});
