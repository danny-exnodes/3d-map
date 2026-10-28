import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createBuildingMaterial } from '../src/scene/buildings';

/** The building shaders as three would compile them (the onBeforeCompile patch applied to Lambert). */
function compiled(toyProto: boolean) {
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  createBuildingMaterial(undefined, toyProto).onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader;
}

describe('building shader', () => {
  it('leaves the height-source colours alone in the plinth band', () => {
    const { fragmentShader } = compiled(false);
    const band = fragmentShader.split('\n').find((l) => l.includes('vWPos.y <') && l.includes('diffuseColor.rgb *='));
    expect(band).toContain('uSourceView < 0.5');
  });

  it('keeps the per-building seed constant across a face (no speckled windows)', () => {
    for (const toy of [false, true]) {
      const { vertexShader, fragmentShader } = compiled(toy);
      expect(vertexShader).toMatch(/flat varying float vSeed;/);
      expect(fragmentShader).toMatch(/flat varying float vSeed;/);
    }
  });

  it('declares the toy facade varyings the same way in both shaders, and only for prototypes', () => {
    const toy = compiled(true);
    for (const v of ['varying vec3 vToyLocal;', 'varying vec2 vToyDir;', 'flat varying vec4 vToyFace;']) {
      expect(toy.vertexShader).toContain(v);
      expect(toy.fragmentShader).toContain(v);
    }
    expect(toy.vertexShader).toContain('attribute float aFront;');
    // The bevel gate (vDiag) is gone: windows are bounded by each face's flat width instead.
    expect(toy.fragmentShader).not.toContain('vDiag');
    expect(toy.fragmentShader).toMatch(/abs\(u\) < 0\.5 \* flatW/);
  });
});
