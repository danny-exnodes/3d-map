import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateDemoCity } from '../src/data/demo';
import { buildCity } from '../src/scene/buildCity';
import { Realism, wetness } from '../src/scene/realistic';
import { toyParamsFor } from '../src/scene/style';
import { applyTint } from '../src/scene/traffic';
import { bakeToyInstance, toyDepthMaterial, toyGlsl } from '../src/scene/toyGeometry';

const bbox = { south: 20.9992, west: 105.8152, north: 21.0068, east: 105.8238 };
const PROTOS = ['buildings-walls', 'buildings-roof-flat', 'buildings-roof-gabled', 'buildings-roof-hipped'];

/** The shaders three would compile for a material (its onBeforeCompile applied to the standard program). */
function compiled(mat: THREE.Material) {
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader;
}

describe('Siêu thực (#19)', () => {
  it('swaps every lit material for a PBR one and restores the originals', () => {
    const { group } = buildCity(generateDemoCity(bbox), () => {}, 'real');
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
    const walls = group.getObjectByName('buildings-walls') as THREE.Mesh;
    expect((walls.material as THREE.Material).userData.uniforms).toBe((before.get(buildings)!.mat as THREE.Material).userData.uniforms);
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

  it('keeps every house where and as big as in Khối: the realistic shader places the instances the same way', () => {
    const data = generateDemoCity(bbox);
    const block = buildCity(data, () => {}, 'block').group;
    const real = buildCity(data, () => {}, 'real').group;
    new Realism({} as THREE.WebGLRenderer).apply(real);
    const box = (g: THREE.BufferGeometry) => (g.computeBoundingBox(), g.boundingBox!);
    const near = (a: THREE.Box3, b: THREE.Box3) => a.min.distanceTo(b.min) < 0.01 && a.max.distanceTo(b.max) < 0.01;
    const m = new THREE.Matrix4();
    let houses = 0;
    for (const name of PROTOS) {
      const b = block.getObjectByName(name) as THREE.InstancedMesh;
      const r = real.getObjectByName(name) as THREE.InstancedMesh;
      expect(r.count, name).toBe(b.count);
      const mat = r.material as THREE.MeshStandardMaterial;
      expect(mat.isMeshStandardMaterial, name).toBe(true);
      expect(mat.defines, name).toHaveProperty('TOY_PROTO');
      // With the Khối params each unit's `position` is already the exact unit box, so the shape alone does not
      // show a missing placement. What this guards: the realistic material keeps the Khối material's vertex
      // side (TOY_PROTO, the same placement and normal code with the Khối params) and the toy depth material.
      const { vertexShader } = compiled(mat);
      expect(vertexShader).toContain(toyGlsl(toyParamsFor('block')));
      expect(vertexShader).toMatch(/#include <begin_vertex>\s*#ifdef TOY_PROTO\s*transformed = toyTransformed\(\);/);
      expect(vertexShader).toMatch(/#include <beginnormal_vertex>\s*#ifdef TOY_PROTO\s*objectNormal \*= toyNormalScale\(toyScale\(\)\);/);
      // Shadows keep the Khối placement too.
      expect(r.customDepthMaterial).toBe(toyDepthMaterial(toyParamsFor('block')));
      // Each house's world box, placed with the params of the realistic material, equals its Khối box.
      const params = toyParamsFor(mat.userData.style);
      const bSeed = b.geometry.getAttribute('aSeed'), rSeed = r.geometry.getAttribute('aSeed');
      for (let i = 0; i < r.count; i++) {
        const rb = box(bakeToyInstance(r.geometry, (r.getMatrixAt(i, m), m), rSeed.getX(i), params));
        const bb = box(bakeToyInstance(b.geometry, (b.getMatrixAt(i, m), m), bSeed.getX(i), toyParamsFor('block')));
        expect(near(rb, bb), `${name} #${i}`).toBe(true);
        houses++;
      }
    }
    expect(houses).toBeGreaterThan(50);
    // Exactly modelled buildings keep their geometry.
    const exact = (g: THREE.Group) => box((g.getObjectByName('buildings') as THREE.Mesh).geometry);
    expect(near(exact(real), exact(block))).toBe(true);
  });

  it('reset() disposes the realistic materials and the original materials and geometries it replaced', () => {
    const { group } = buildCity(generateDemoCity(bbox), () => {}, 'real');
    const disposed = new Set<object>();
    const watch = (x: THREE.Material | THREE.BufferGeometry) => x.addEventListener('dispose', () => disposed.add(x));
    const originals: (THREE.Material | THREE.BufferGeometry)[] = [];
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) originals.push(mat);
      if (m.name === 'crowns') originals.push(m.geometry);
    });
    originals.forEach(watch);
    const realism = new Realism({} as THREE.WebGLRenderer);
    realism.apply(group);
    const swapped: THREE.Material[] = [];
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) swapped.push(...(Array.isArray(m.material) ? m.material : [m.material]));
    });
    swapped.forEach(watch);
    realism.reset();
    for (const x of [...originals, ...swapped]) expect(disposed.has(x), (x as THREE.Material).type).toBe(true);
    // Nothing is left to restore.
    const crowns = group.getObjectByName('crowns') as THREE.Mesh;
    realism.restore();
    expect((crowns.material as THREE.Material).type).toBe('MeshStandardMaterial');
  });

  it('gives exported water its shaded colour, not white', () => {
    const { group } = buildCity(generateDemoCity(bbox), () => {}, 'real');
    new Realism({} as THREE.WebGLRenderer).apply(group);
    const water = (group.getObjectByName('water') as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(water.color.getHexString()).not.toBe('ffffff');
    // Deep blue-green, as the shader draws it.
    expect(water.color.b).toBeGreaterThan(water.color.r);
    expect(water.color.g).toBeGreaterThan(water.color.r);
    expect(Math.max(water.color.r, water.color.g, water.color.b)).toBeLessThan(0.4);
  });

  it('keeps painted vehicles and plain pedestrians in separate programs', () => {
    const g = new THREE.Group();
    for (const name of ['vehicles', 'pedestrians']) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), applyTint(new THREE.MeshLambertMaterial({ vertexColors: true })));
      mesh.name = name;
      g.add(mesh);
    }
    new Realism({} as THREE.WebGLRenderer).apply(g);
    const [v, p] = g.children.map((c) => (c as THREE.Mesh).material as THREE.Material);
    expect(v.customProgramCacheKey()).not.toBe(p.customProgramCacheKey());
    // Both still take the instance colour only where the vertex is tinted.
    for (const mat of [v, p]) expect(compiled(mat).vertexShader).toContain('attribute float tint;');
  });

  it('wets the roads in rain and more in a storm', () => {
    expect([wetness(0), wetness(1), wetness(2)]).toEqual([0, 0.6, 1]);
  });
});
