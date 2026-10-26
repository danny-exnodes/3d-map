import * as THREE from 'three';

/** Display styles. Only 'color' and 'mono' exist today; the type leaves room for more (issue #7). */
export type ColorMode = 'color' | 'mono';

export const MONO_TINT = new THREE.Color('#ece6da');

/** Shared by every patched material so switching modes is a single uniform write. */
export const colorModeUniforms = {
  uMono: { value: 0 },
  uMonoTint: { value: MONO_TINT.clone() },
};

const LUMA = new THREE.Vector3(0.299, 0.587, 0.114);

/** CPU version of the shader formula, used for GLB export. */
export function monoColor(c: THREE.Color, amount = 1, out = new THREE.Color()): THREE.Color {
  const l = LUMA.x * c.r + LUMA.y * c.g + LUMA.z * c.b;
  const k = 0.55 + 0.45 * l;
  return out.setRGB(
    c.r + (MONO_TINT.r * k - c.r) * amount,
    c.g + (MONO_TINT.g * k - c.g) * amount,
    c.b + (MONO_TINT.b * k - c.b) * amount,
  );
}

/**
 * Injects the mono blend right after the diffuse colour is known. Emissive light (windows,
 * street lamps) is untouched, so a monochrome model still glows warm at night.
 */
export function patchMaterial(mat: THREE.Material) {
  if (mat.userData.monoPatched || (mat as THREE.MeshBasicMaterial).isMeshBasicMaterial) return;
  if (!(mat instanceof THREE.MeshLambertMaterial || mat instanceof THREE.MeshStandardMaterial)) return;
  mat.userData.monoPatched = true;
  const prev = mat.onBeforeCompile.bind(mat);
  const prevKey = mat.customProgramCacheKey();
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.uMono = colorModeUniforms.uMono;
    shader.uniforms.uMonoTint = colorModeUniforms.uMonoTint;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uMono;\nuniform vec3 uMonoTint;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float monoL = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          diffuseColor.rgb = mix(diffuseColor.rgb, uMonoTint * (0.55 + 0.45 * monoL), uMono);
        }`,
      );
  };
  mat.customProgramCacheKey = () => `${prevKey}|mono`;
  mat.needsUpdate = true;
}

export function patchObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (Array.isArray(m)) m.forEach(patchMaterial);
    else if (m) patchMaterial(m);
  });
}

/** Neutral version of a sky colour for mono mode. */
export function monoSky(c: THREE.Color, amount: number): THREE.Color {
  const l = LUMA.x * c.r + LUMA.y * c.g + LUMA.z * c.b;
  return c.clone().lerp(new THREE.Color(l * 0.96, l * 0.97, l), amount);
}

/** Bakes the mono look into a (cloned) scene graph so exported files match the screen. */
export function bakeMono(root: THREE.Object3D) {
  const c = new THREE.Color();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const col = mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    const inst = o as THREE.InstancedMesh;
    const perVertexOrInstance = !!col || !!(inst.isInstancedMesh && inst.instanceColor);
    if (col) {
      mesh.geometry = mesh.geometry.clone();
      const a = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      for (let i = 0; i < a.count; i++) {
        monoColor(c.setRGB(a.getX(i), a.getY(i), a.getZ(i)), 1, c);
        a.setXYZ(i, c.r, c.g, c.b);
      }
    }
    if (inst.isInstancedMesh && inst.instanceColor) {
      inst.instanceColor = inst.instanceColor.clone() as THREE.InstancedBufferAttribute;
      for (let i = 0; i < inst.count; i++) {
        inst.getColorAt(i, c);
        inst.setColorAt(i, monoColor(c, 1, c));
      }
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const baked = mats.map((m) => {
      const mm = m.clone() as THREE.MeshLambertMaterial;
      // Colour lives in the vertex/instance attribute when present; the material colour is a white multiplier then.
      if (!perVertexOrInstance && mm.color && !(m as THREE.MeshBasicMaterial).isMeshBasicMaterial) monoColor(mm.color, 1, mm.color);
      return mm;
    });
    mesh.material = Array.isArray(mesh.material) ? baked : baked[0];
  });
}
