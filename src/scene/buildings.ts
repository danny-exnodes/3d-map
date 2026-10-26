import * as THREE from 'three';
import { hashString } from '../data/rand';
import type { Building } from '../data/types';
import type { LocalProjection } from '../geo/projection';
import { flatPolygon, merge, MeshBuilder, type XZ } from './geometry';
import { SpatialGrid } from './spatial';

/** Integer codes of HeightSource stored in aSeed (see the "theo nguồn chiều cao" view, #3). */
export const HEIGHT_SOURCE_CODE: Record<Building['heightSource'], number> = { osm: 0, gob: 1, overture: 2, heuristic: 3 };
export const HEIGHT_SOURCE_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#9ca3af'];

export interface BuildingsResult {
  mesh: THREE.Mesh;
  material: THREE.MeshLambertMaterial;
  footprints: SpatialGrid<XZ[]>;
  count: number;
}

const signedArea = (r: XZ[]) => {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, z1] = r[i];
    const [x2, z2] = r[(i + 1) % r.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
};

/** Removes consecutive near-duplicate points. */
function clean(r: XZ[]): XZ[] {
  const out: XZ[] = [];
  for (const p of r) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05) out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 0.05) out.pop();
  return out;
}

export function buildBuildings(list: Building[], proj: LocalProjection, onProgress?: (f: number) => void): BuildingsResult {
  const walls = new MeshBuilder();
  const roofs: THREE.BufferGeometry[] = [];
  const footprints = new SpatialGrid<XZ[]>(25);
  const facade = new THREE.Color();
  let count = 0;

  list.forEach((b, idx) => {
    if (idx % 200 === 0) onProgress?.(idx / list.length);
    const rings = b.polygon.map((r) => clean(r.map((p) => proj.project(p)))).filter((r) => r.length >= 3);
    if (!rings.length) return;
    const outerArea = Math.abs(signedArea(rings[0]));
    if (outerArea < 4) return;
    count++;

    // aSeed packs the height-source code (integer part) with a per-building random seed (fraction).
    const seed = HEIGHT_SOURCE_CODE[b.heightSource] + (hashString(b.id) % 10007) / 10008;
    const y0 = b.minHeight;
    const y1 = b.height;
    facade.set(b.color ?? '#f0e6d2');
    walls.setColor(facade).setSeed(seed);

    rings.forEach((ring, ri) => {
      // Outer rings must have negative signed area (outward = right of travel), holes positive.
      const r = (ri === 0) === signedArea(ring) > 0 ? ring.slice().reverse() : ring;
      for (let i = 0; i < r.length; i++) {
        const [ax, az] = r[i];
        const [bx, bz] = r[(i + 1) % r.length];
        walls.quad({ x: ax, y: y0, z: az }, { x: bx, y: y0, z: bz }, { x: bx, y: y1, z: bz }, { x: ax, y: y1, z: az });
      }
    });
    footprints.insert(rings[0], rings[0]);

    const roofColor = b.roofColor ?? '#d2cbbb';
    if ((b.roof === 'gabled' || b.roof === 'hipped') && rings.length === 1 && rings[0].length === 4) {
      pitchedRoof(walls, rings[0], y1, b.roof, facade, new THREE.Color(roofColor), seed);
    } else {
      const g = flatPolygon(rings, y1, roofColor);
      if (g) {
        g.setAttribute('aSeed', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(seed), 1));
        roofs.push(g);
      }
      if (y0 > 0.5) {
        const under = flatPolygon(rings, y0, '#8d877c');
        if (under) {
          under.scale(1, -1, 1); // flip to face down …
          under.translate(0, 2 * y0, 0); // … and move back into place
          under.setAttribute('aSeed', new THREE.Float32BufferAttribute(new Float32Array(under.attributes.position.count), 1));
          roofs.push(under);
        }
      }
    }
  });

  const geom = merge([walls.build(true), ...roofs]) ?? new THREE.BufferGeometry();
  const material = createBuildingMaterial();
  const mesh = new THREE.Mesh(geom, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'buildings';
  onProgress?.(1);
  return { mesh, material, footprints, count };
}

function pitchedRoof(mb: MeshBuilder, ring: XZ[], y: number, kind: 'gabled' | 'hipped', facade: THREE.Color, roof: THREE.Color, seed: number) {
  let [p0, p1, p2, p3] = ring;
  const d01 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const d12 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  // Make p0→p1 a long edge.
  if (d12 > d01) [p0, p1, p2, p3] = [p1, p2, p3, p0];
  const long = Math.max(d01, d12);
  const short = Math.min(d01, d12);
  const rise = Math.min(short * 0.42, 5);
  const mid = (a: XZ, b: XZ): XZ => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let r1 = mid(p1, p2);
  let r3 = mid(p3, p0);
  if (kind === 'hipped') {
    const k = Math.min(0.45, short / 2 / long);
    const a = r1;
    const b = r3;
    r1 = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    r3 = [b[0] + (a[0] - b[0]) * k, b[1] + (a[1] - b[1]) * k];
  }
  const P = (p: XZ, h = y) => new THREE.Vector3(p[0], h, p[1]);
  const R1 = P(r1, y + rise);
  const R3 = P(r3, y + rise);
  const cx = (p0[0] + p1[0] + p2[0] + p3[0]) / 4;
  const cz = (p0[1] + p1[1] + p2[1] + p3[1]) / 4;
  const centre = new THREE.Vector3(cx, y, cz);
  const tmp = new THREE.Vector3();
  const out = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    const n = tmp.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const m = new THREE.Vector3().add(a).add(b).add(c).divideScalar(3).sub(centre);
    if (n.dot(m) < 0) mb.tri(a, c, b);
    else mb.tri(a, b, c);
  };
  mb.setSeed(seed).setColor(roof);
  out(P(p0), P(p1), R1);
  out(P(p0), R1, R3);
  out(P(p2), P(p3), R3);
  out(P(p2), R3, R1);
  mb.setColor(kind === 'gabled' ? facade : roof);
  out(P(p1), P(p2), R1);
  out(P(p3), P(p0), R3);
}

/**
 * Lambert material with procedural windows: glazing by day, randomly lit
 * windows at night. Window grid is derived from world position so it needs no UVs.
 */
export function createBuildingMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const uniforms = { uNight: { value: 0 }, uSourceView: { value: 0 } };
  mat.userData.uniforms = uniforms;
  mat.userData.isBuildingMaterial = true;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms.uNight;
    shader.uniforms.uSourceView = uniforms.uSourceView;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aSeed;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        varying float vSeed;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * objectNormal);
        vSeed = aSeed;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uNight;
        uniform float uSourceView;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        varying float vSeed;
        float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float winMask; float winLit; vec3 winColor;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (uSourceView > 0.5) {
          float src = floor(vSeed + 0.001);
          diffuseColor.rgb = src < 0.5 ? vec3(${hexToVec(HEIGHT_SOURCE_COLORS[0])}) : src < 1.5 ? vec3(${hexToVec(HEIGHT_SOURCE_COLORS[1])})
            : src < 2.5 ? vec3(${hexToVec(HEIGHT_SOURCE_COLORS[2])}) : vec3(${hexToVec(HEIGHT_SOURCE_COLORS[3])});
        }
        winMask = 0.0; winLit = 0.0; winColor = vec3(0.0);
        if (abs(vWNormal.y) < 0.3 && vWPos.y > 0.6) {
          vec2 t = normalize(vec2(-vWNormal.z, vWNormal.x));
          float u = dot(vWPos.xz, t);
          float cellW = 3.2;
          float cellH = 3.3;
          vec2 cell = vec2(floor(u / cellW), floor(vWPos.y / cellH));
          vec2 f = vec2(fract(u / cellW), fract(vWPos.y / cellH));
          float aa = fwidth(u / cellW) * 1.5;
          float mx = smoothstep(0.22 - aa, 0.22 + aa, f.x) * (1.0 - smoothstep(0.78 - aa, 0.78 + aa, f.x));
          float my = smoothstep(0.32, 0.36, f.y) * (1.0 - smoothstep(0.82, 0.86, f.y));
          winMask = mx * my;
          float r = h21(cell + fract(vSeed) * 97.0);
          float floorDark = step(0.82, h21(vec2(cell.y, fract(vSeed) * 31.0)));
          winLit = step(r, 0.42) * (1.0 - floorDark);
          winColor = mix(vec3(1.0, 0.78, 0.45), vec3(0.95, 0.95, 1.0), step(0.75, h21(cell.yx + fract(vSeed))));
          vec3 glass = mix(vec3(0.42, 0.52, 0.62), vec3(0.08, 0.1, 0.16), uNight);
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, winMask * 0.75);
        }
        // Slight darkening towards the ground for depth.
        diffuseColor.rgb *= mix(0.82, 1.0, clamp(vWPos.y / 10.0, 0.0, 1.0));`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += winColor * winMask * winLit * uNight * 1.6;`,
      );
  };
  return mat;
}

/** Linear-space GLSL vec3 literal for a hex colour. */
function hexToVec(hex: string): string {
  const c = new THREE.Color(hex);
  return `${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)}`;
}
