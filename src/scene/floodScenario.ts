import * as THREE from 'three';
import { FLOOD_MASK_MAX_DIST, floodSpreadMetres } from './floodMask';

/**
 * "Mưa · triều · ngập" (idea from e-City, saigon-citylab.vercel.app): a flat sheet of muddy water
 * over the whole model, `depth` metres above the ground.
 *
 * It is an illustration, not a hydraulic model: the model is flat (no DEM), so every street gets
 * the same depth. The UI says so next to the control. `setMask` (optional, `floodMask.ts`) adds a
 * gradient from real rivers/canals/lakes so the sheet reads stronger near them; it never drops the
 * look to fully dry (`FLOOD_COVERAGE_FLOOR`), so the base "ngập khắp nơi" guarantee still holds.
 */

/** Deepest water the slider offers, m. */
export const FLOOD_MAX = 1.5;
export const FLOOD_STEP = 0.05;

/** Quick picks. The labels only name a scene; the depths are not measurements. */
export const FLOOD_PRESETS: readonly { id: string; label: string; depth: number }[] = [
  { id: 'dry', label: 'Khô', depth: 0 },
  { id: 'tide', label: 'Triều cường', depth: 0.3 },
  { id: 'rain', label: 'Mưa lớn', depth: 0.5 },
  { id: 'rain-tide', label: 'Mưa lớn + triều', depth: 1 },
];

export const FLOOD_NOTE = 'Minh hoạ, không phải mô phỏng thuỷ lực: mô hình phẳng, không dùng địa hình (DEM). Nơi nào cũng coi như ngập, chỉ rõ hơn gần sông, kênh, hồ thật.';

/** Clamps to [0, FLOOD_MAX] and snaps to FLOOD_STEP. */
export function clampFlood(depth: number): number {
  if (!Number.isFinite(depth)) return 0;
  const d = Math.min(FLOOD_MAX, Math.max(0, depth));
  return Math.round(d / FLOOD_STEP) * FLOOD_STEP;
}

/** `?flood=0.5` (metres; "50cm" and "0,5" work too). Null when absent or not a number. */
export function parseFloodDepth(s: string | null | undefined): number | null {
  if (s == null) return null;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(cm|m)?\s*$/i.exec(s);
  if (!m) return null;
  const v = Number(m[1].replace(',', '.'));
  return clampFlood(m[2]?.toLowerCase() === 'cm' ? v / 100 : v);
}

/** "0,3 m", "1 m", "Khô". */
export function floodLabel(depth: number): string {
  const d = clampFlood(depth);
  if (d === 0) return 'Khô';
  return `${d.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} m`;
}

/**
 * Speed factor for traffic on flooded ground-level streets: normal up to 10 cm, then motorbikes and
 * cars slow to a crawl (riders push their bikes) by about half a metre.
 */
export function floodPace(depth: number): number {
  const t = Math.min(1, Math.max(0, (depth - 0.1) / 0.4));
  return 1 - 0.85 * t * t * (3 - 2 * t);
}

/**
 * Flood water colour: a murky blue-grey. Brown read as bare earth over the light Toy ground in daylight,
 * so the water vanished; blue-grey stays water-like in all three styles.
 */
const WATER_COLOR = '#4a7180';

/** Murky flood water: blue-grey, see-through near the ground, darker at night; small moving ripples. */
export class FloodWater {
  readonly mesh: THREE.Mesh;
  private target = 0;
  private depth = 0;
  private time = { value: 0 };
  private sky = { value: new THREE.Color('#9fd3f2') };
  private spread = { value: floodSpreadMetres(0) };
  private maskSize: { value: THREE.Vector2 };
  private maskTex: { value: THREE.DataTexture };
  private material: THREE.MeshStandardMaterial;

  constructor(width: number, depth: number) {
    // A box whose bottom sits on the ground slab: its sides show the water column at the model's edge.
    const g = new THREE.BoxGeometry(width, 1, depth).translate(0, 0.5, 0);
    this.material = new THREE.MeshStandardMaterial({
      color: WATER_COLOR,
      roughness: 0.22,
      metalness: 0,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    // Default: distance 0 everywhere, so the mask contributes full coverage (same look as no mask at all).
    const defaultMask = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
    defaultMask.needsUpdate = true;
    this.maskTex = { value: defaultMask };
    this.maskSize = { value: new THREE.Vector2(width, depth) };
    const time = this.time, sky = this.sky, spread = this.spread, maskSize = this.maskSize, maskTex = this.maskTex;
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uFloodTime = time;
      shader.uniforms.uFloodSky = sky;
      shader.uniforms.uFloodSpread = spread;
      shader.uniforms.uFloodMaskSize = maskSize;
      shader.uniforms.uFloodMask = maskTex;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFloodPos;\nvarying float vFloodTop;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvFloodPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvFloodTop = step(0.5, normal.y);',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uFloodTime;
          uniform vec3 uFloodSky;
          uniform float uFloodSpread;
          uniform vec2 uFloodMaskSize;
          uniform sampler2D uFloodMask;
          varying vec3 vFloodPos;
          varying float vFloodTop;`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          if (vFloodTop > 0.5) {
            vec2 p = vFloodPos.xz;
            float t = uFloodTime;
            float dx = sin(p.x * 0.9 + t * 1.7) * 0.04 + sin((p.x + p.y) * 2.3 - t * 2.1) * 0.025;
            float dz = cos(p.y * 0.8 - t * 1.3) * 0.04 + sin((p.x - p.y) * 1.9 + t * 1.9) * 0.025;
            normal = normalize((viewMatrix * vec4(normalize(vec3(dx, 1.0, dz)), 0.0)).xyz);
          }`,
        )
        // The surface mirrors the sky at grazing angles (Fresnel), which is what makes it read as water.
        .replace(
          '#include <opaque_fragment>',
          `float floodFres = vFloodTop * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
          outgoingLight = mix(outgoingLight, uFloodSky, vFloodTop * (0.06 + 0.3 * floodFres));
          // Slow light/dark bands drifting over the surface.
          vec2 fp = vFloodPos.xz;
          float band = sin(fp.x * 0.35 + uFloodTime * 0.9) * sin(fp.y * 0.3 - uFloodTime * 0.7);
          outgoingLight *= 1.0 + vFloodTop * 0.16 * band;
          diffuseColor.a = mix(diffuseColor.a, 0.9, floodFres);
          // Fades toward the shore the farther the ground is from a real river/canal/lake (floodMask.ts);
          // never below 0.45 so the sheet still reads as flooded away from any mapped water.
          vec2 floodUv = vFloodPos.xz / uFloodMaskSize + 0.5;
          float floodDist = texture2D(uFloodMask, floodUv).r * ${FLOOD_MASK_MAX_DIST.toFixed(1)};
          float floodT = clamp(floodDist / max(uFloodSpread, 1.0), 0.0, 1.0);
          float floodSmooth = 1.0 - floodT * floodT * (3.0 - 2.0 * floodT);
          diffuseColor.a *= 0.45 + 0.55 * floodSmooth;
          #include <opaque_fragment>`,
        );
    };
    this.material.customProgramCacheKey = () => 'flood-water';
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'flood';
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    this.mesh.scale.y = 0.001;
  }

  /**
   * Shapes the sheet by distance to real water (`floodMaskGrid`, `floodMask.ts`): `resolution` x
   * `resolution`, row-major z then x, over the model's own [-hx,hx] x [-hz,hz]. Call again after a
   * rebuild (new area); omit when the area has no mapped water, which leaves the default (no change).
   */
  setMask(grid: Uint8Array, resolution: number) {
    const tex = new THREE.DataTexture(grid, resolution, resolution, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.maskTex.value.dispose();
    this.maskTex.value = tex; // same uniform object, so no shader recompile
  }

  /** Water rises or drains toward this depth over a couple of seconds. */
  setDepth(depth: number, immediate = false) {
    this.target = clampFlood(depth);
    if (immediate) this.depth = this.target;
    this.apply();
  }

  /** Current (animated) depth, m. */
  get level(): number {
    return this.depth;
  }

  /** The sky colour the surface reflects (the scene background). */
  setSky(c: THREE.Color) {
    this.sky.value.copy(c);
  }

  /** Night darkens the water so it does not glow under the moon. */
  setNight(night: number) {
    this.material.color.set(WATER_COLOR).multiplyScalar(1 - 0.55 * night);
  }

  /** Returns true while the level is still moving. */
  update(dt: number, reduceMotion = false): boolean {
    if (!reduceMotion) this.time.value += dt;
    if (this.depth === this.target) return false;
    const step = Math.max(0.02, Math.abs(this.target - this.depth) * 1.5) * dt;
    this.depth = Math.abs(this.target - this.depth) <= step || reduceMotion ? this.target : this.depth + Math.sign(this.target - this.depth) * step;
    this.apply();
    return true;
  }

  private apply() {
    this.mesh.visible = this.depth > 0.005;
    this.mesh.scale.y = Math.max(0.001, this.depth);
    this.spread.value = floodSpreadMetres(this.depth);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.maskTex.value.dispose();
  }
}
