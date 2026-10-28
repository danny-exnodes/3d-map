import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateDemoCity } from '../src/data/demo';
import { buildCity } from '../src/scene/buildCity';
import { createBuildingMaterial } from '../src/scene/buildings';
import { deserializeObjects, serializeObject } from '../src/scene/serialize';
import { parseStyle, STYLE_LABEL, STYLES, toyParamsFor } from '../src/scene/style';
import { bakeToyInstance, bakeToyInstances, TOY, toyDepthMaterial, toyFlatRoofUnit, toyPitchedRoofUnit, toyWallsUnit } from '../src/scene/toyGeometry';

const m = (w: number, h: number, l: number, y = 0) => new THREE.Matrix4().compose(new THREE.Vector3(0, y, 0), new THREE.Quaternion(), new THREE.Vector3(w, h, l));
const box = (g: THREE.BufferGeometry) => (g.computeBoundingBox(), g.boundingBox!);
const positions = (g: THREE.BufferGeometry) => Array.from(g.getAttribute('position').array);

describe('styles', () => {
  it('lists the three styles with their Vietnamese names', () => {
    expect(STYLES).toEqual(['toy', 'block', 'real']);
    expect(STYLE_LABEL).toEqual({ toy: 'Đồ chơi', block: 'Khối', real: 'Siêu thực' });
  });

  it('parses ?style= and stored values, old colour modes included', () => {
    expect(parseStyle('toy')).toBe('toy');
    expect(parseStyle('block')).toBe('block');
    expect(parseStyle('real')).toBe('real');
    expect(parseStyle('color')).toBe('block');
    expect(parseStyle('mono')).toBe('block');
    expect(parseStyle(null)).toBeNull();
    expect(parseStyle('x')).toBeNull();
  });

  it('gives Khối and Siêu thực no bevels, plinth, inset or chimneys and plain colours', () => {
    for (const s of ['block', 'real'] as const) {
      expect(toyParamsFor(s)).toEqual({ inset: 0, radius: 0, plinthH: 0, roofBevel: 0, chimneys: false, pastel: false });
    }
  });

  it('gives Đồ chơi today’s toy proportions', () => {
    const p = toyParamsFor('toy');
    expect(p).toEqual({ inset: TOY.inset, radius: TOY.radius, plinthH: TOY.plinthH, roofBevel: TOY.roofBevel, chimneys: true, pastel: true });
  });
});

describe('Khối geometry', () => {
  const block = toyParamsFor('block');

  it('bakes a 10 × 6 m house 9 m tall to exactly its box: no plinth, no rounding', () => {
    const b = box(bakeToyInstance(toyWallsUnit(block), m(10, 9, 6), undefined, block));
    const size = b.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(10, 6);
    expect(size.y).toBeCloseTo(9, 6);
    expect(size.z).toBeCloseTo(6, 6);
    expect(b.min.y).toBeCloseTo(0, 6);
  });

  it('puts the roofs on the footprint, flat lid at the wall top, sharp ridge, no chimney', () => {
    const flat = box(bakeToyInstance(toyFlatRoofUnit(block), m(10, 1, 6, 9), undefined, block));
    expect(flat.min.y).toBeCloseTo(9, 6);
    expect(flat.max.y).toBeCloseTo(9, 6);
    expect(flat.max.x - flat.min.x).toBeCloseTo(10, 6);
    expect(flat.max.z - flat.min.z).toBeCloseTo(6, 6);
    for (const hipped of [false, true]) {
      const g = bakeToyInstance(toyPitchedRoofUnit(hipped, block), m(6, 2, 10, 9), 0.123, block);
      expect(positions(g).every(Number.isFinite)).toBe(true);
      const b = box(g);
      expect(b.min.y).toBeCloseTo(9, 6);
      expect(b.max.y).toBeCloseTo(11, 6);
      expect(b.max.x - b.min.x).toBeCloseTo(6, 6);
      expect(b.max.z - b.min.z).toBeCloseTo(10, 6);
      expect(Array.from(toyPitchedRoofUnit(hipped, block).getAttribute('aRoof').array).some((v) => v > 1.5)).toBe(false);
    }
  });

  it('bakes an instanced Khối mesh with the params it was built with', () => {
    const unit = toyWallsUnit(block);
    const im = new THREE.InstancedMesh(unit, new THREE.MeshLambertMaterial(), 1);
    im.setMatrixAt(0, m(10, 9, 6));
    const b = box(bakeToyInstances(im, block).geometry);
    expect(b.max.x - b.min.x).toBeCloseTo(10, 6);
    expect(b.max.z - b.min.z).toBeCloseTo(6, 6);
  });
});

describe('Đồ chơi geometry stays as it was', () => {
  const toy = toyParamsFor('toy');

  it('bakes the same vertices with toy params as with the defaults', () => {
    for (const [unit, def] of [
      [toyWallsUnit(toy), toyWallsUnit()],
      [toyFlatRoofUnit(toy), toyFlatRoofUnit()],
      [toyPitchedRoofUnit(false, toy), toyPitchedRoofUnit(false)],
      [toyPitchedRoofUnit(true, toy), toyPitchedRoofUnit(true)],
    ]) {
      expect(positions(bakeToyInstance(unit, m(4.5, 9, 16), 0.42, toy))).toEqual(positions(bakeToyInstance(def, m(4.5, 9, 16), 0.42)));
    }
  });

  it('keeps the toy plinth on the footprint and the rounded body inset (as in toyGeometry.test)', () => {
    const p = bakeToyInstance(toyWallsUnit(toy), m(4.4, 9, 10), undefined, toy).getAttribute('position');
    let best = Infinity;
    for (let i = 0; i < p.count; i++) if (p.getY(i) > TOY.plinthH + 1e-3) best = Math.min(best, Math.hypot(4.4 / 2 - TOY.inset - p.getX(i), 10 / 2 - TOY.inset - p.getZ(i)));
    expect(best).toBeCloseTo(TOY.radius * (Math.SQRT2 - 1), 1);
  });
});

describe('Khối build', () => {
  const compiled = (toyProto: boolean, style: 'toy' | 'block') => {
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
    const mat = createBuildingMaterial(undefined, toyProto, style);
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    return { mat, shader };
  };

  it('places Khối prototypes with zero bevels in the shader and keeps the plain look apart from the toy program', () => {
    const block = compiled(true, 'block');
    expect(block.mat.defines).toEqual({ TOY_PROTO: '', STYLE_PLAIN: '' });
    expect(block.shader.vertexShader).toContain('clamp(0.45 * min(s.x, s.z) - 0.0000, 0.0, 0.0000)');
    const toy = compiled(true, 'toy');
    expect(toy.mat.defines).toEqual({ TOY_PROTO: '' });
    expect(toy.shader.vertexShader).toContain(`- ${TOY.inset.toFixed(4)}, 0.0, ${TOY.radius.toFixed(4)})`);
    expect(block.mat.customProgramCacheKey()).not.toBe(toy.mat.customProgramCacheKey());
    expect(compiled(false, 'block').mat.customProgramCacheKey()).not.toBe(compiled(false, 'toy').mat.customProgramCacheKey());
  });

  it('keeps the style across the worker boundary, shadows included', () => {
    const bbox = { south: 20.9992, west: 105.8152, north: 21.0068, east: 105.8238 };
    const built = buildCity(generateDemoCity(bbox), () => {}, 'block');
    const g = deserializeObjects(structuredClone(serializeObject(built.group).objects));
    const walls = g.getObjectByName('buildings-walls') as THREE.InstancedMesh;
    expect((walls.material as THREE.Material).userData.style).toBe('block');
    expect((walls.material as THREE.Material).defines).toHaveProperty('STYLE_PLAIN');
    expect(walls.customDepthMaterial).toBe(toyDepthMaterial(toyParamsFor('block')));
    expect(walls.customDepthMaterial).not.toBe(toyDepthMaterial());
    // No plinth band, no chimney: Khối walls have fewer vertices than toy ones.
    const toyWalls = buildCity(generateDemoCity(bbox)).group.getObjectByName('buildings-walls') as THREE.InstancedMesh;
    expect(walls.geometry.getAttribute('position').count).toBeLessThan(toyWalls.geometry.getAttribute('position').count);
  });
});
