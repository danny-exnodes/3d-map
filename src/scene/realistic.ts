import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * "Siêu thực" view (#19): swaps every material of the built city for a physically based one
 * with procedural detail (facades, glass, roofs, asphalt, pavers, grass, water, foliage),
 * adds an atmospheric sky that also lights the scene (image-based lighting), and restores
 * the original materials when the mode is left. Everything is generated in shaders from
 * world position, so no textures are downloaded and it works offline.
 */

/** Uniforms shared by all realistic materials. */
export const realUniforms = {
  uTime: { value: 0 },
  /** 0 dry … 1 soaked (rain): roads get darker and glossy. */
  uWet: { value: 0 },
  /** Sky colours mirrored by window glass (cheap planar reflection). */
  uSkyTop: { value: new THREE.Color('#5b8fd0') },
  uSkyHorizon: { value: new THREE.Color('#cfe0f0') },
};

const NOISE = /* glsl */ `
uniform float uTime;
uniform float uWet;
varying vec3 vWPos;
varying vec3 vWNormal;
float rHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float rNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(rHash(i), rHash(i + vec2(1.0, 0.0)), u.x), mix(rHash(i + vec2(0.0, 1.0)), rHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float rFbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * rNoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
// Bump mapping from a procedural height (screen-space derivatives, no tangents needed).
vec3 rBump(vec3 pos, vec3 n, float h) {
  vec3 dx = dFdx(pos), dy = dFdy(pos);
  vec3 r1 = cross(dy, n), r2 = cross(n, dx);
  float det = dot(dx, r1);
  vec3 g = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  vec3 r = abs(det) * n - g;
  // Edge-on or degenerate pixels: keep the geometric normal (a NaN here would spread through bloom).
  return dot(r, r) > 1e-24 && abs(det) > 1e-12 ? normalize(r) : n;
}
// 1 while a pattern of period 1 in x is resolved on screen, fading to 0 before it aliases (moiré).
float rAA(float x) { return 1.0 - smoothstep(0.1, 0.3, fwidth(x)); }
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
// What a vertical glass pane mirrors: sky above the horizon, darker street below; Fresnel-weighted.
vec3 rGlass(vec3 interior) {
  vec3 v = normalize(vWPos - cameraPosition);
  vec3 r = reflect(v, normalize(vWNormal));
  vec3 sky = r.y > 0.0 ? mix(uSkyHorizon, uSkyTop, pow(r.y, 0.5)) : uSkyHorizon * 0.35;
  float fres = 0.12 + 0.78 * pow(1.0 - abs(dot(v, normalize(vWNormal))), 4.0);
  return mix(interior, sky, fres);
}
float rRough; float rMetal; float rH;
`;

const VERT_DECL = /* glsl */ `
varying vec3 vWPos;
varying vec3 vWNormal;
`;
const VERT_BODY = /* glsl */ `
{
  vec4 rwp = vec4(transformed, 1.0);
  vec3 rwn = objectNormal;
  #ifdef USE_INSTANCING
    rwp = instanceMatrix * rwp;
    rwn = mat3(instanceMatrix) * rwn;
  #endif
  vWPos = (modelMatrix * rwp).xyz;
  vWNormal = normalize(mat3(modelMatrix) * rwn);
}
`;

/** Fragment code run right after the base colour is known. Sets rRough, rMetal and rH. */
const SURFACES = {
  asphalt: /* glsl */ `
    vec2 p = vWPos.xz;
    float n = rFbm(p * 0.25);
    float grain = rNoise(p * 7.0);
    diffuseColor.rgb *= 0.74 + 0.32 * n + 0.1 * grain;
    // Patched repairs and oil stains along the lanes.
    float patchM = smoothstep(0.6, 0.64, rFbm(p * 0.045 + 3.0));
    diffuseColor.rgb *= 1.0 - 0.14 * patchM;
    diffuseColor.rgb *= 1.0 - 0.35 * uWet;
    rRough = mix(0.93, 0.22 + 0.2 * n, uWet);
    rH = grain * 0.025;
  `,
  pavers: /* glsl */ `
    vec2 p = vWPos.xz / 0.42;
    vec2 cell = floor(p);
    p.x += mod(cell.y, 2.0) * 0.5;
    vec2 f = fract(p);
    float grout = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
    float g = mix(1.0, smoothstep(0.02, 0.07, grout), rAA(p.x));
    diffuseColor.rgb *= mix(0.62, 1.0, g) * (0.88 + 0.22 * rHash(floor(p))) * (0.9 + 0.15 * rFbm(vWPos.xz * 0.3));
    diffuseColor.rgb *= 1.0 - 0.3 * uWet;
    rRough = mix(0.85, 0.35, uWet);
    rH = g * 0.02;
  `,
  greens: /* glsl */ `
    vec2 p = vWPos.xz;
    float greenness = diffuseColor.g - max(diffuseColor.r, diffuseColor.b);
    if (greenness > 0.05) {
      // Lawn: two scales of colour variation, dry patches, blade grain.
      float n = rFbm(p * 0.12);
      vec3 lush = vec3(0.13, 0.25, 0.05), dry = vec3(0.32, 0.33, 0.13);
      vec3 grass = mix(lush, dry, smoothstep(0.45, 0.8, rFbm(p * 0.035 + 7.0)) * 0.7);
      grass *= 0.75 + 0.5 * n;
      float blade = mix(0.5, rNoise(p * 16.0), rAA(p.x * 16.0));
      diffuseColor.rgb = mix(diffuseColor.rgb * 0.45, grass, 0.75) * (0.85 + 0.3 * blade);
      rRough = 0.97;
      rH = blade * 0.04;
    } else {
      // Plazas and car parks: concrete slabs.
      vec2 f = fract(p / 3.0);
      float joint = smoothstep(0.0, 0.015, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
      diffuseColor.rgb *= (0.8 + 0.3 * rFbm(p * 0.4)) * mix(0.75, 1.0, joint);
      rRough = mix(0.9, 0.4, uWet);
      rH = joint * 0.02;
    }
  `,
  soil: /* glsl */ `
    vec2 p = vWPos.xz;
    float n = rFbm(p * 0.08);
    diffuseColor.rgb *= 0.7 + 0.45 * n;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.36, 0.33, 0.27), 0.35 * rFbm(p * 0.5 + 9.0));
    rRough = 0.97;
    rH = rNoise(p * 5.0) * 0.03;
  `,
  concrete: /* glsl */ `
    vec2 p = vWPos.xz + vWPos.y * 0.7;
    float n = rFbm(p * 0.3);
    diffuseColor.rgb *= 0.78 + 0.3 * n;
    // Dark rain streaks running down vertical concrete.
    if (abs(vWNormal.y) < 0.5) diffuseColor.rgb *= 1.0 - 0.18 * smoothstep(0.55, 0.9, rNoise(vec2(dot(vWPos.xz, vec2(0.7, 0.7)) * 2.0, vWPos.y * 0.08)));
    rRough = 0.9;
    rH = rNoise(p * 6.0) * 0.02;
  `,
  foliage: /* glsl */ `
    vec2 p = vWPos.xz * 2.6 + vWPos.y * 1.9;
    float leaf = rNoise(p) * 0.6 + rNoise(p * 2.7) * 0.4;
    diffuseColor.rgb *= 0.7 + 0.55 * leaf;
    rRough = 0.85;
    rH = leaf * 0.35;
  `,
  bark: /* glsl */ `
    float n = rNoise(vec2((vWPos.x + vWPos.z) * 9.0, vWPos.y * 6.0));
    diffuseColor.rgb *= 0.7 + 0.4 * n;
    rRough = 0.95;
    rH = n * 0.05;
  `,
  paint: /* glsl */ `
    rRough = 0.32; rMetal = 0.45;
  `,
  plain: '',
};
type Surface = keyof typeof SURFACES;

interface SurfaceOptions {
  roughness?: number;
  metalness?: number;
  envMapIntensity?: number;
}

/** A MeshStandardMaterial that mirrors `orig`'s parameters and adds the given procedural surface. */
function surfaceMaterial(orig: THREE.Material, surface: Surface, o: SurfaceOptions = {}): THREE.MeshStandardMaterial {
  const src = orig as THREE.MeshLambertMaterial;
  const mat = new THREE.MeshStandardMaterial({
    color: src.color?.clone() ?? new THREE.Color(1, 1, 1),
    vertexColors: src.vertexColors,
    depthWrite: src.depthWrite,
    transparent: src.transparent,
    opacity: src.opacity,
    side: src.side,
    polygonOffset: src.polygonOffset,
    polygonOffsetFactor: src.polygonOffsetFactor,
    polygonOffsetUnits: src.polygonOffsetUnits,
    roughness: o.roughness ?? 0.85,
    metalness: o.metalness ?? 0,
    envMapIntensity: o.envMapIntensity ?? 1,
  });
  Object.assign(mat.userData, orig.userData);
  const code = SURFACES[surface];
  if (code) {
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, realUniforms);
      injectVertex(shader);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${NOISE}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\nrRough = roughness; rMetal = metalness; rH = 0.0;\n{${code}}`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rRough;')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = rMetal;')
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\nnormal = rBump(-vViewPosition, normal, rH * rFade());`);
      addFade(shader);
    };
    mat.customProgramCacheKey = () => `real-${surface}`;
  }
  return mat;
}

function injectVertex(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_BODY}`);
}

// Bump strength fades out with distance so far surfaces do not shimmer.
const FADE = /* glsl */ `float rFade() { return clamp(1.0 - length(vViewPosition) / 900.0, 0.0, 1.0); }`;

/**
 * River/lake water: murky green-brown like Sông Sài Gòn, small animated waves built from
 * two scrolling noise layers, sky reflections from the environment map, sun glints.
 */
function waterMaterial(orig: THREE.Material): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    vertexColors: false,
    roughness: 0.04,
    metalness: 0,
    // Sky reflections carry the look of water; the scene-wide environment level is low.
    envMapIntensity: 3.5,
    depthWrite: (orig as THREE.MeshStandardMaterial).depthWrite,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, realUniforms);
    injectVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE}
        float waveH(vec2 p) {
          float t = uTime;
          return rFbm(p * 0.09 + vec2(t * 0.03, t * 0.018)) * 0.9
            + rNoise(p * 0.55 + vec2(-t * 0.22, t * 0.15)) * 0.25
            + rNoise(p * 2.1 + vec2(t * 0.5, -t * 0.35)) * 0.07;
        }`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec2 p = vWPos.xz;
          float silt = rFbm(p * 0.01 + 5.0);
          diffuseColor.rgb = mix(vec3(0.07, 0.1, 0.07), vec3(0.15, 0.13, 0.07), silt);
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec2 p = vWPos.xz;
          float e = 0.35;
          float hx = waveH(p + vec2(e, 0.0)) - waveH(p - vec2(e, 0.0));
          float hz = waveH(p + vec2(0.0, e)) - waveH(p - vec2(0.0, e));
          float k = 1.4 * clamp(1.0 - length(vViewPosition) / 2500.0, 0.25, 1.0);
          vec3 nW = normalize(vec3(-hx * k, 1.0, -hz * k));
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        }`,
      );
  };
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    prev(shader, r);
    addFade(shader);
  };
  mat.customProgramCacheKey = () => 'real-water';
  return mat;
}

/**
 * Building facades and roofs: plaster with blotches and rain streaks, floor slabs, recessed
 * framed windows with reflective glass, shop fronts / rolling shutters on the ground floor,
 * AC units, curtain walls, brick, metal panels; flat concrete roofs with stains, corrugated
 * tôn (with rust) or clay tile on pitched roofs. Shares uNight/uSourceView/uSelected with the
 * stylised material so the rest of the app drives both the same way.
 */
function buildingMaterial(orig: THREE.Material): THREE.MeshStandardMaterial {
  const uniforms = orig.userData.uniforms as { uNight: { value: number }; uSourceView: { value: number }; uSelected: { value: number } };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  mat.userData.uniforms = uniforms;
  mat.userData.isBuildingMaterial = true;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms.uNight;
    shader.uniforms.uSourceView = uniforms.uSourceView;
    shader.uniforms.uSelected = uniforms.uSelected;
    Object.assign(shader.uniforms, realUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        ${VERT_DECL}
        attribute float aSeed;
        attribute float aBid;
        uniform float uSelected;
        varying float vSelected;
        varying float vSeed;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        ${VERT_BODY}
        vSeed = aSeed;
        vSelected = abs(aBid - uSelected) < 0.5 ? 1.0 : 0.0;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        ${NOISE}
        uniform float uNight;
        uniform float uSourceView;
        varying float vSelected;
        varying float vSeed;
        float winMask; float winLit; vec3 winColor;
        float box(vec2 f, vec2 a, vec2 b, float aa) {
          vec2 s = smoothstep(a - aa, a + aa, f) * (1.0 - smoothstep(b - aa, b + aa, f));
          return s.x * s.y;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float code = floor(vSeed + 0.001);
        float src = mod(code, 4.0);
        float matCode = floor(code / 4.0 + 0.001);
        float rnd = fract(vSeed);
        rRough = 0.9; rMetal = 0.0; rH = 0.0;
        winMask = 0.0; winLit = 0.0; winColor = vec3(0.0);
        vec3 base = diffuseColor.rgb;
        if (uSourceView > 0.5) {
          base = src < 0.5 ? vec3(0.016, 0.61, 0.21) : src < 1.5 ? vec3(0.046, 0.25, 0.92) : src < 2.5 ? vec3(0.91, 0.37, 0.004) : vec3(0.33, 0.35, 0.40);
        }
        if (abs(vWNormal.y) < 0.3) {
          // ---- Walls ----
          vec2 t = normalize(vec2(-vWNormal.z, vWNormal.x));
          float u = dot(vWPos.xz, t);
          float y = vWPos.y;
          float cellW = 3.2, cellH = 3.3;
          vec2 cell = vec2(floor(u / cellW), floor(y / cellH));
          vec2 f = vec2(fract(u / cellW), fract(y / cellH));
          float aa = clamp(fwidth(u / cellW) * 1.2, 0.002, 0.2);
          float r = rHash(cell + rnd * 97.0);
          bool glassWall = matCode > 0.5 && matCode < 1.5;
          bool ground = cell.y < 0.5 && !glassWall;
          // Plaster: large blotches, fine grain, rain streaks under every slab, splash zone.
          float blot = rFbm(vec2(u, y) * 0.3 + rnd * 50.0);
          float grain = rNoise(vec2(u, y) * 11.0);
          base *= 0.84 + 0.24 * blot;
          float streak = smoothstep(0.55, 0.92, rNoise(vec2(u * 1.3, cell.y + rnd * 7.0))) * (1.0 - f.y);
          base *= 1.0 - 0.2 * streak;
          base *= mix(0.72, 1.0, smoothstep(0.0, 1.4, y));
          rH += grain * 0.012;
          if (matCode > 1.5 && matCode < 2.5) {
            // Exposed brick with mortar joints.
            vec2 bp = vec2(u / 0.25, y / 0.075);
            bp.x += mod(floor(bp.y), 2.0) * 0.5;
            vec2 bf = fract(bp);
            float mortar = mix(0.85, smoothstep(0.0, 0.08, min(min(bf.x, 1.0 - bf.x), min(bf.y, 1.0 - bf.y) * 3.0)), rAA(bp.y));
            base = mix(vec3(0.55, 0.53, 0.5), mix(vec3(0.42, 0.14, 0.07), vec3(0.55, 0.22, 0.12), rHash(floor(bp))), mortar);
            rH += mortar * 0.03;
          } else if (matCode > 2.5) {
            // Metal cladding panels with vertical seams.
            float seam = smoothstep(0.0, 0.04, abs(fract(u / 0.6) - 0.5) * 2.0);
            base = mix(base, vec3(0.42, 0.45, 0.49), 0.65) * mix(0.7, 1.0, seam);
            rMetal = 0.7; rRough = 0.35;
            rH += seam * 0.01;
          }
          if (glassWall) {
            // Curtain wall: spandrel band at each slab, aluminium mullions, mirror-like glass.
            float mull = 1.0 - box(vec2(fract(u / 1.6), f.y), vec2(0.03, 0.0), vec2(0.97, 1.0), aa * 2.0);
            float spandrel = 1.0 - smoothstep(0.1, 0.12, f.y);
            vec3 glass = mix(vec3(0.10, 0.17, 0.21), vec3(0.16, 0.22, 0.25), rHash(vec2(cell.y, rnd)));
            glass = mix(rGlass(glass) * vec3(0.75, 0.9, 1.0), glass, uNight);
            base = mix(glass, vec3(0.3, 0.32, 0.34), max(mull, spandrel * 0.8));
            float isGlass = (1.0 - mull) * (1.0 - spandrel);
            rMetal = mix(0.6, 0.0, isGlass); rRough = mix(0.35, 0.1, isGlass);
            rH += mull * 0.04;
            winMask = isGlass;
            winLit = step(r, 0.55) * (1.0 - step(0.82, rHash(vec2(cell.y, rnd * 31.0))));
            winColor = mix(vec3(1.0, 0.85, 0.6), vec3(0.9, 0.95, 1.0), step(0.5, rHash(cell.yx)));
          } else if (ground) {
            // Ground floor: open shop fronts and rolling shutters (cửa cuốn).
            float m = box(f, vec2(0.05, 0.0), vec2(0.95, 0.82), aa);
            if (r < 0.45) {
              float ribs = 0.5 + 0.5 * sin(y * 6.2831 / 0.09) * rAA(y / 0.09);
              vec3 shutter = mix(vec3(0.62, 0.63, 0.64), vec3(0.25, 0.4, 0.55), step(0.3, r));
              base = mix(base, shutter * (0.85 + 0.15 * ribs), m);
              rMetal = mix(rMetal, 0.6, m); rRough = mix(rRough, 0.45, m);
              rH += m * ribs * 0.008 - m * 0.05;
            } else {
              vec3 inside = mix(vec3(0.22, 0.18, 0.14), vec3(0.45, 0.38, 0.3), rNoise(vec2(u * 2.0, y * 3.0)));
              base = mix(base, inside, m);
              rRough = mix(rRough, 0.1, m);
              base = mix(base, mix(rGlass(inside), inside, uNight), m * 0.6);
              winMask = m; winLit = step(0.2, r); winColor = vec3(1.0, 0.82, 0.55);
            }
            // Sign board above the opening.
            float sign = box(f, vec2(0.05, 0.84), vec2(0.95, 0.97), aa) * step(0.35, rHash(cell + 3.1));
            vec3 signCol = vec3(rHash(cell + 1.0), rHash(cell + 2.0), rHash(cell + 4.0));
            base = mix(base, signCol * 0.8 + 0.1, sign);
            rH += sign * 0.06;
          } else {
            // Upper floors: slab ledge, recessed framed windows with reflective glass, AC units.
            float ledge = 1.0 - smoothstep(0.05, 0.075, f.y);
            base *= 1.0 + 0.08 * ledge;
            rH += ledge * 0.05;
            float hw = mix(0.2, 0.32, rHash(vec2(rnd, 1.7)));
            vec2 a0 = vec2(0.5 - hw, 0.3), a1 = vec2(0.5 + hw, 0.85);
            float frame = box(f, a0 - vec2(0.035, 0.03), a1 + vec2(0.035, 0.03), aa);
            float win = box(f, a0, a1, aa);
            float sill = box(f, vec2(a0.x - 0.05, a0.y - 0.06), vec2(a1.x + 0.05, a0.y - 0.03), aa);
            vec3 frameCol = mix(vec3(0.85, 0.85, 0.82), vec3(0.2, 0.2, 0.22), step(0.6, rHash(vec2(rnd, 9.0))));
            base = mix(base, frameCol, (frame - win) * 0.9);
            base = mix(base, base * 1.12, sill);
            // Glass: dark with a hint of curtains, glossy, slightly metallic so it mirrors the sky.
            vec3 curtain = mix(vec3(0.55, 0.5, 0.42), vec3(0.3, 0.38, 0.45), rHash(cell + 7.0));
            vec3 glass = mix(vec3(0.05, 0.06, 0.07), curtain * 0.35, step(0.55, rHash(cell + 5.0)) * smoothstep(0.6, 0.9, f.y));
            glass = mix(rGlass(glass), glass, uNight);
            base = mix(base, glass, win);
            rRough = mix(rRough, 0.12, win);
            rH += (frame - win) * 0.015 + sill * 0.02;
            winMask = win;
            winLit = step(r, 0.42) * (1.0 - step(0.82, rHash(vec2(cell.y, rnd * 31.0))));
            winColor = mix(vec3(1.0, 0.78, 0.45), vec3(0.95, 0.95, 1.0), step(0.75, rHash(cell.yx + rnd)));
            // Air-conditioner boxes beside some windows.
            float ac = box(f, vec2(0.84, 0.32), vec2(0.97, 0.5), aa) * step(0.7, rHash(cell + 11.0));
            base = mix(base, vec3(0.82, 0.82, 0.8), ac);
            rH += ac * 0.08;
          }
        } else if (vWNormal.y > 0.97) {
          // ---- Flat roofs: weathered concrete, damp stains, waterproofing patches ----
          vec2 p = vWPos.xz;
          float n = rFbm(p * 0.25 + rnd * 40.0);
          base = mix(base, vec3(0.5, 0.49, 0.46), 0.55) * (0.72 + 0.4 * n);
          float stain = smoothstep(0.55, 0.75, rFbm(p * 0.08 + rnd * 13.0));
          base = mix(base, base * vec3(0.55, 0.58, 0.5), stain * 0.7);
          float membrane = smoothstep(0.7, 0.72, rFbm(p * 0.05 + 21.0)) * step(0.5, rnd);
          base = mix(base, vec3(0.35, 0.36, 0.38), membrane);
          rRough = mix(0.95, 0.3, uWet);
          rH = rNoise(p * 6.0) * 0.03;
        } else {
          // ---- Pitched roofs ----
          vec2 d = normalize(vWNormal.xz);
          vec2 across = vec2(-d.y, d.x);
          float a = dot(vWPos.xz, across);
          float s = dot(vWPos.xz, d);
          float redness = base.r - base.b;
          if (redness > 0.18 && base.r > 0.35) {
            // Clay tiles: overlapping rows, each tile slightly different.
            vec2 tp = vec2(a / 0.22, s / 0.3);
            tp.x += mod(floor(tp.y), 2.0) * 0.5;
            vec2 tf = fract(tp);
            base *= 0.8 + 0.35 * rHash(floor(tp)) ;
            float tileAA = rAA(tp.y);
            base *= mix(0.83, mix(0.65, 1.0, tf.y) * mix(0.85, 1.0, smoothstep(0.0, 0.15, min(tf.x, 1.0 - tf.x))), tileAA);
            base *= 0.8 + 0.3 * rFbm(vWPos.xz * 0.2);
            rRough = 0.8;
            rH = tf.y * 0.05 * tileAA;
          } else {
            // Corrugated metal sheet (tôn) with rust.
            float wave = 0.5 + 0.5 * sin(a * 6.2831 / 0.19) * rAA(a / 0.19);
            float rust = smoothstep(0.55, 0.85, rFbm(vWPos.xz * 0.4 + rnd * 30.0));
            base = mix(base, vec3(0.42, 0.22, 0.12), rust * 0.6) * (0.88 + 0.12 * wave);
            // Painted sheet is a dielectric; bare zinc where the paint is gone.
            rMetal = mix(0.15, 0.05, rust); rRough = mix(0.42, 0.85, rust);
            rH = wave * 0.03;
          }
        }
        diffuseColor.rgb = mix(base, vec3(1.0, 0.32, 0.08), vSelected * 0.85);`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = rMetal;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = rBump(-vViewPosition, normal, rH * rFade());')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += winColor * winMask * winLit * uNight * 1.6;
        totalEmissiveRadiance += vec3(0.55, 0.14, 0.0) * vSelected;`,
      );
    addFade(shader);
  };
  mat.customProgramCacheKey = () => 'real-buildings';
  return mat;
}

/** rFade() needs vViewPosition, which the standard shader declares after <common>. */
function addFade(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.fragmentShader = shader.fragmentShader
    .replace('void main() {', `${FADE}\nvoid main() {`)
    // One NaN pixel would be smeared over the whole frame by the bloom blur.
    .replace('#include <dithering_fragment>', '#include <dithering_fragment>\nif (any(isnan(gl_FragColor))) gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);');
}

/** Leafy crown made of a few lumpy blobs, darker at the bottom (self-shadowing), soft normals. */
function crownGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const blobs: [number, number, number, number][] = [
    [0, 4.6, 0, 1.45], [0.9, 4.0, 0.3, 1.1], [-0.8, 4.1, 0.5, 1.05], [0.2, 3.9, -0.95, 1.1], [-0.3, 5.3, -0.2, 0.95], [0.5, 4.9, 0.8, 0.85],
  ];
  const centre = new THREE.Vector3(0, 4.4, 0);
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  blobs.forEach(([x, y, z, r], bi) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      // Lumpy surface: a few sine lobes per blob.
      const k = 1 + 0.16 * Math.sin(v.x * 3.1 + bi) * Math.sin(v.y * 2.7 + bi * 2) * Math.sin(v.z * 3.3 - bi);
      v.multiplyScalar(k).add(new THREE.Vector3(x, y, z));
      pos.setXYZ(i, v.x, v.y, v.z);
      const shade = THREE.MathUtils.clamp(0.45 + (v.y - 3.0) / 3.2, 0.4, 1.15);
      colors.set([shade, shade, shade], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.deleteAttribute('uv');
    g.computeVertexNormals();
    // Blend towards normals of the whole crown so it lights like foliage, not facets.
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < nor.count; i++) {
      v.fromBufferAttribute(pos, i).sub(centre).normalize();
      n.fromBufferAttribute(nor, i).lerp(v, 0.65).normalize();
      nor.setXYZ(i, n.x, n.y, n.z);
    }
    parts.push(g);
  });
  return mergeGeometries(parts)!;
}

/** Original state of an object while the realistic look is applied. */
interface Saved {
  mesh: THREE.Mesh;
  material: THREE.Material | THREE.Material[];
  geometry?: THREE.BufferGeometry;
}

export class Realism {
  readonly sky = new Sky();
  private envScene = new THREE.Scene();
  private envDome: THREE.ShaderMaterial;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private lastEnv = { dir: new THREE.Vector3(), cloud: -1, night: -1 };
  private saved: Saved[] = [];
  private crown: THREE.BufferGeometry | null = null;
  active = false;

  constructor(renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    {
      const s = this.sky;
      const u = s.material.uniforms;
      u.turbidity.value = 4;
      u.rayleigh.value = 2;
      u.mieCoefficient.value = 0.006;
      u.mieDirectionalG.value = 0.82;
      u.cloudCoverage.value = 0.35;
      u.cloudDensity.value = 0.5;
      // The sky model is HDR and calibrated for a darker exposure; scale it down and keep it under
      // the bloom threshold, otherwise the whole sky bleeds over the city as a milky haze.
      s.material.fragmentShader = s.material.fragmentShader.replace('#include <tonemapping_fragment>', 'gl_FragColor.rgb = min(gl_FragColor.rgb * 0.2, vec3(1.1));\n#include <tonemapping_fragment>');
    }
    this.sky.scale.setScalar(9000);
    this.sky.name = 'sky';
    // Ground layers do not write depth, so the sky must be drawn before them.
    this.sky.renderOrder = -100;
    this.sky.visible = false;
    // Image-based lighting comes from a controlled sky gradient rather than the Preetham sky:
    // its HDR radiance floods every surface with haze. The sun itself is the directional light.
    this.envDome = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uGround: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunCol: { value: new THREE.Color() },
      },
      vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 uZenith, uHorizon, uGround, uSunCol; uniform vec3 uSunDir; varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec3 c = d.y > 0.0 ? mix(uHorizon, uZenith, pow(d.y, 0.6)) : mix(uHorizon, uGround, pow(-d.y, 0.4));
          c += uSunCol * pow(max(dot(d, uSunDir), 0.0), 6.0);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), this.envDome));
  }

  /** Swaps materials of everything under the given roots. Idempotent. */
  apply(...roots: THREE.Object3D[]) {
    for (const root of roots) {
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || mesh.userData.real || o === this.sky) return;
        const replaced = this.replacementFor(mesh);
        if (!replaced) return;
        this.saved.push({ mesh, material: mesh.material, geometry: replaced.geometry ? mesh.geometry : undefined });
        mesh.userData.real = true;
        mesh.material = replaced.material;
        if (replaced.geometry) mesh.geometry = replaced.geometry;
      });
    }
    this.active = true;
  }

  /** Restores the stylised materials. */
  restore() {
    for (const s of this.saved) {
      const now = s.mesh.material;
      (Array.isArray(now) ? now : [now]).forEach((m) => m.dispose());
      s.mesh.material = s.material;
      if (s.geometry) s.mesh.geometry = s.geometry;
      delete s.mesh.userData.real;
    }
    this.saved = [];
    this.active = false;
  }

  /** Forget saved state of meshes that were disposed with the city (new build). */
  reset() {
    for (const s of this.saved) {
      const now = s.mesh.material;
      (Array.isArray(now) ? now : [now]).forEach((m) => m.dispose());
      (Array.isArray(s.material) ? s.material : [s.material]).forEach((m) => m.dispose());
    }
    this.saved = [];
  }

  private replacementFor(mesh: THREE.Mesh): { material: THREE.Material | THREE.Material[]; geometry?: THREE.BufferGeometry } | null {
    const map = (m: THREE.Material): THREE.Material => {
      if ((m as THREE.MeshBasicMaterial).isMeshBasicMaterial) return m.clone();
      switch (mesh.name) {
        case 'buildings':
          return buildingMaterial(m);
        case 'roads':
          return surfaceMaterial(m, 'asphalt');
        case 'sidewalks':
          return surfaceMaterial(m, 'pavers');
        case 'markings':
          return surfaceMaterial(m, 'plain', { roughness: 0.6 });
        case 'greens':
          return surfaceMaterial(m, 'greens');
        case 'ground':
          return surfaceMaterial(m, 'soil');
        case 'water':
          return waterMaterial(m);
        case 'elevated':
        case 'pillars':
        case 'rails':
          return surfaceMaterial(m, 'concrete');
        case 'crowns':
          return surfaceMaterial(m, 'foliage', { envMapIntensity: 0.6 });
        case 'trunks':
          return surfaceMaterial(m, 'bark');
        case 'vehicles':
        case 'trains':
          return surfaceMaterial(m, 'paint');
        case 'lamps':
          return surfaceMaterial(m, 'plain', { roughness: 0.4, metalness: 0.7 });
        case 'detail-tanks':
          return surfaceMaterial(m, 'plain', { roughness: 0.18, metalness: 0.9 });
        case 'detail-railings':
          return surfaceMaterial(m, 'plain', { roughness: 0.4, metalness: 0.6 });
        default:
          return surfaceMaterial(m, mesh.name.startsWith('detail-') ? 'concrete' : 'plain');
      }
    };
    const material = Array.isArray(mesh.material) ? mesh.material.map(map) : map(mesh.material);
    let geometry: THREE.BufferGeometry | undefined;
    if (mesh.name === 'crowns') geometry = this.crown ??= crownGeometry();
    return { material, geometry };
  }

  /** Updates the sky and, when the light changed noticeably, the environment map. */
  update(scene: THREE.Scene, sunDir: THREE.Vector3, night: number, cloud: number, light: { sky: THREE.Color; hemiSky: THREE.Color; hemiGround: THREE.Color; sunColor: THREE.Color }) {
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(sunDir);
    u.cloudCoverage.value = 0.25 + cloud * 0.6;
    u.turbidity.value = 4 + cloud * 8;
    realUniforms.uSkyTop.value.copy(light.hemiSky).multiplyScalar(0.7);
    realUniforms.uSkyHorizon.value.copy(light.sky);
    const d = this.envDome.uniforms;
    d.uZenith.value.copy(light.hemiSky).multiplyScalar(0.9);
    d.uHorizon.value.copy(light.sky).lerp(light.hemiSky, 0.3);
    d.uGround.value.copy(light.hemiGround).multiplyScalar(0.45);
    d.uSunDir.value.copy(sunDir);
    d.uSunCol.value.copy(light.sunColor).multiplyScalar(sunDir.y > 0 ? 0.6 * (1 - cloud * 0.7) : 0);
    const e = this.lastEnv;
    const moved = e.dir.angleTo(sunDir) > THREE.MathUtils.degToRad(0.5) || Math.abs(e.cloud - cloud) > 0.05 || Math.abs(e.night - night) > 0.05;
    if (moved || !this.envRT) {
      e.dir.copy(sunDir);
      e.cloud = cloud;
      e.night = night;
      this.envRT?.dispose();
      this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 100);
    }
    scene.environment = this.envRT.texture;
    // IBL irradiance is π × radiance; keep it below the sun so shadows stay readable.
    scene.environmentIntensity = THREE.MathUtils.lerp(0.38, 0.2, night);
    this.sky.visible = night < 0.95;
  }

  dispose() {
    this.reset();
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.envDome.dispose();
    this.crown?.dispose();
  }
}
