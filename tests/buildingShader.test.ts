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
});
