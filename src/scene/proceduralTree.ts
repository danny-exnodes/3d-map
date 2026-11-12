/**
 * Hero trees (#55): a handful of full-detail procedural trees (EZ-Tree) around the building the
 * user has selected, in place of the cheap placeholder cylinder+blob used everywhere else in the
 * scene (`landscape.ts:buildTrees`). Geometry is expensive to grow (branch simulation), so it is
 * cached as raw typed-array buffers in IndexedDB, keyed by preset+seed; materials are built once
 * per preset per session and shared across every hero tree using that preset.
 */
import * as THREE from 'three';
import { Tree } from '@dgreenheck/ez-tree';
import { cacheGet, cacheSet } from '../data/cache';

/** 2-3 generic presets (v1 scope: no Vietnam-specific species, see issue #55). */
export const HERO_PRESETS = ['Oak Small', 'Ash Small', 'Pine Small'] as const;
export type HeroPreset = (typeof HERO_PRESETS)[number];

const CACHE_NS = 'hero-tree';
const CACHE_TTL_MS = 180 * 24 * 3600 * 1000;

/** Deterministic seed from a tree's position, so the same spot keeps the same shape across reloads. */
export function heroSeed(x: number, z: number): number {
  let h = 2166136261;
  h = Math.imul(h ^ Math.round(x * 10), 16777619);
  h = Math.imul(h ^ Math.round(z * 10), 16777619);
  h = Math.imul(h ^ (h >>> 15), 16777619);
  return h >>> 0;
}

export function heroPreset(seed: number): HeroPreset {
  return HERO_PRESETS[seed % HERO_PRESETS.length];
}

export interface GeoBuffers {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  index: Uint32Array;
}

interface HeroGeometry {
  branches: GeoBuffers;
  leaves: GeoBuffers;
}

export function toBuffers(g: THREE.BufferGeometry): GeoBuffers {
  const index = g.getIndex();
  return {
    position: new Float32Array(g.getAttribute('position').array),
    normal: new Float32Array(g.getAttribute('normal').array),
    uv: new Float32Array(g.getAttribute('uv').array),
    index: index ? new Uint32Array(index.array) : new Uint32Array(0),
  };
}

export function fromBuffers(b: GeoBuffers): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(b.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(b.normal, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(b.uv, 2));
  if (b.index.length) g.setIndex(new THREE.BufferAttribute(b.index, 1));
  return g;
}

function byteSize(h: HeroGeometry): number {
  const s = (b: GeoBuffers) => b.position.byteLength + b.normal.byteLength + b.uv.byteLength + b.index.byteLength;
  return s(h.branches) + s(h.leaves);
}

/** Geometry only (no material): cached across reloads, one entry per (preset, seed). */
async function heroGeometry(preset: HeroPreset, seed: number): Promise<HeroGeometry> {
  const key = `${preset}:${seed}`;
  const cached = await cacheGet<HeroGeometry>(CACHE_NS, key);
  if (cached) return cached;
  const tree = new Tree();
  tree.loadPreset(preset);
  tree.options.seed = seed;
  tree.generate();
  const value: HeroGeometry = { branches: toBuffers(tree.branchesMesh.geometry), leaves: toBuffers(tree.leavesMesh.geometry) };
  void cacheSet(CACHE_NS, key, value, CACHE_TTL_MS, byteSize(value));
  return value;
}

const materialCache = new Map<HeroPreset, { branches: THREE.Material; leaves: THREE.Material }>();

/** Materials are built once per preset (bundled base64 textures, no network) and shared. */
function heroMaterials(preset: HeroPreset): { branches: THREE.Material; leaves: THREE.Material } {
  let m = materialCache.get(preset);
  if (m) return m;
  const tree = new Tree();
  tree.loadPreset(preset);
  tree.generate();
  m = { branches: tree.branchesMesh.material as THREE.Material, leaves: tree.leavesMesh.material as THREE.Material };
  materialCache.set(preset, m);
  return m;
}

/** A full-detail hero tree at local (x, z); caller positions/adds it and disposes geometry on removal. */
export async function heroTreeGroup(x: number, z: number): Promise<THREE.Group> {
  const seed = heroSeed(x, z);
  const preset = heroPreset(seed);
  const [geo, mats] = await Promise.all([heroGeometry(preset, seed), Promise.resolve(heroMaterials(preset))]);
  const branches = new THREE.Mesh(fromBuffers(geo.branches), mats.branches);
  const leaves = new THREE.Mesh(fromBuffers(geo.leaves), mats.leaves);
  branches.castShadow = branches.receiveShadow = true;
  leaves.castShadow = true;
  const group = new THREE.Group();
  group.name = 'hero-tree';
  group.add(branches, leaves);
  group.position.set(x, 0, z);
  return group;
}

/** Test hook: forget the in-memory per-preset material cache (independent of the IndexedDB geometry cache). */
export function _resetHeroMaterialsForTests() {
  materialCache.clear();
}

/** Disposes only the geometry (shared materials stay alive for the next hero tree of that preset). */
export function disposeHeroTreeGroup(group: THREE.Group) {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
  });
}
