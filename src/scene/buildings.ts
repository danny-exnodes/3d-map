import * as THREE from 'three';
import { hashString } from '../data/rand';
import type { Building } from '../data/types';
import type { LocalProjection } from '../geo/projection';
import { LEVEL_H } from '../data/buildings';
import { DetailCollector } from './details';
import { MeshBuilder, type XZ } from './geometry';
import { buildRoof, flatCap, minAreaRect } from './roofs';
import { SpatialGrid } from './spatial';

/** Integer codes of HeightSource stored in aSeed (see the "theo nguồn chiều cao" view, #3). */
export const HEIGHT_SOURCE_CODE: Record<Building['heightSource'], number> = { osm: 0, gob: 1, overture: 2, heuristic: 3 };
export const HEIGHT_SOURCE_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#9ca3af'];

export interface BuildingsResult {
  mesh: THREE.Mesh;
  material: THREE.MeshLambertMaterial;
  footprints: SpatialGrid<XZ[]>;
  details: THREE.Group;
  count: number;
  /** Index i of aBid → building (for picking, #10). */
  ids: string[];
}

/** Facade material codes packed into aSeed (see the shader). */
const MATERIAL_CODE: Record<NonNullable<Building['material']> | 'none', number> = { none: 0, glass: 1, brick: 2, metal: 3, concrete: 0 };

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

/** Orients rings for wall emission: outer ring negative signed area (outward = right of travel), holes positive. */
const orient = (ring: XZ[], outer: boolean) => ((outer === signedArea(ring) > 0) ? ring.slice().reverse() : ring);

function walls(mb: MeshBuilder, rings: XZ[][], y0: number, y1: number) {
  rings.forEach((ring, ri) => {
    const r = orient(ring, ri === 0);
    for (let i = 0; i < r.length; i++) {
      const [ax, az] = r[i];
      const [bx, bz] = r[(i + 1) % r.length];
      mb.quad({ x: ax, y: y0, z: az }, { x: bx, y: y0, z: bz }, { x: bx, y: y1, z: bz }, { x: ax, y: y1, z: az });
    }
  });
}

const scaleRing = (r: XZ[], c: XZ, k: number): XZ[] => r.map(([x, z]) => [c[0] + (x - c[0]) * k, c[1] + (z - c[1]) * k]);

export interface BuildOptions {
  onProgress?: (f: number) => void;
  /** Distance (m) from a point to the nearest road, used to find a house's street front. */
  roadDistance?: (x: number, z: number) => number;
}

export function buildBuildings(list: Building[], proj: LocalProjection, opts: BuildOptions = {}): BuildingsResult {
  const mb = new MeshBuilder();
  const footprints = new SpatialGrid<XZ[]>(25);
  const details = new DetailCollector();
  const facade = new THREE.Color();
  const roofCol = new THREE.Color();
  const ids: string[] = [];
  let count = 0;

  list.forEach((b, idx) => {
    if (idx % 200 === 0) opts.onProgress?.(idx / list.length);
    const rings = b.polygon.map((r) => clean(r.map((p) => proj.project(p)))).filter((r) => r.length >= 3);
    if (!rings.length) return;
    const area = Math.abs(signedArea(rings[0]));
    if (area < 4) return;
    count++;
    const bid = ids.length;
    ids.push(b.id);

    // aSeed = heightSource code + 4 × material code + per-building random fraction.
    const h = hashString(b.id);
    const seed = HEIGHT_SOURCE_CODE[b.heightSource] + 4 * MATERIAL_CODE[b.material ?? 'none'] + (h % 10007) / 10008;
    const y0 = b.minHeight;
    const y1 = b.height;
    facade.set(b.color ?? '#f0e6d2');
    roofCol.set(b.roofColor ?? '#d2cbbb');
    mb.setColor(facade).setSeed(seed).setBid(bid);
    footprints.insert(rings[0], rings[0]);

    const arch = b.archetype ?? 'generic';
    const rect = minAreaRect(rings[0]);
    const fill = area / Math.max(rect.area, 1e-6);

    // Tall blocks get a wider podium and a set-back tower (khối đế), when the shape allows it.
    const podium = !b.isPart && rings.length === 1 && y0 === 0 && y1 > 30 && area > 600 && fill > 0.75 && (arch === 'apartment' || arch === 'office');
    if (podium) {
      const ph = LEVEL_H * (3 + (h % 2));
      const tower = scaleRing(rings[0], rect.centre, 0.72);
      walls(mb, rings, 0, ph);
      mb.setColor(roofCol);
      flatCap(mb, rings, ph);
      mb.setColor(facade);
      walls(mb, [tower], ph, y1);
      buildRoof(mb, { shape: b.roof, rings: [tower], y: y1, roof: roofCol, facade, height: b.roofHeight });
    } else {
      walls(mb, rings, y0, y1);
      buildRoof(mb, { shape: b.roof, rings, y: y1, roof: roofCol, facade, height: b.roofHeight, lowPitch: arch === 'industrial' });
    }
    if (y0 > 0.5) {
      mb.setColor('#8d877c');
      const contour = rings[0];
      const tris = THREE.ShapeUtils.triangulateShape(contour.map(([x, z]) => new THREE.Vector2(x, z)), []);
      for (const [a, c, d] of tris) mb.triDown(V(contour[a], y0), V(contour[c], y0), V(contour[d], y0));
    }

    // Street-level detail for houses (#5).
    if ((arch === 'tube' || arch === 'shophouse') && !b.isPart && y1 < 30 && rect.short > 2.5) {
      const levels = Math.max(1, Math.round(y1 / LEVEL_H));
      const [c0, c1, c2, c3] = rect.corners;
      // The two short sides of the rectangle; the one nearer a road is the street front.
      const d01 = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
      const sides: [XZ, XZ][] = d01 < rect.long - 1e-6 ? [[c0, c1], [c2, c3]] : [[c1, c2], [c3, c0]];
      const mid = (s: [XZ, XZ]): XZ => [(s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2];
      const dist = (s: [XZ, XZ]) => opts.roadDistance?.(...mid(s)) ?? 0;
      const [front, rear] = dist(sides[0]) <= dist(sides[1]) ? sides : [sides[1], sides[0]];
      // Orient the front edge so that its right-hand side points away from the rectangle centre.
      const m = mid(front);
      const [a, c] = (front[1][0] - front[0][0]) * (rect.centre[1] - m[1]) - (front[1][1] - front[0][1]) * (rect.centre[0] - m[0]) > 0 ? [front[1], front[0]] : front;
      details.balconies(a, c, levels, LEVEL_H, h);
      if (b.roof === 'flat') details.rooftop(rect.centre, mid(rear), Math.atan2(-rect.axis[1], rect.axis[0]), y1, facade, h);
    } else if (arch === 'generic' && b.roof === 'flat' && y1 < 25 && area < 400 && rect.short > 3) {
      details.rooftop(rect.centre, rect.corners[2], Math.atan2(-rect.axis[1], rect.axis[0]), y1, facade, h);
    }
  });

  const geom = mb.empty ? new THREE.BufferGeometry() : mb.build(true, true);
  const material = createBuildingMaterial();
  const mesh = new THREE.Mesh(geom, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'buildings';
  opts.onProgress?.(1);
  return { mesh, material, footprints, details: details.build(), count, ids };
}

const V = (p: XZ, y: number) => new THREE.Vector3(p[0], y, p[1]);

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
        float code = floor(vSeed + 0.001);
        float src = mod(code, 4.0);
        float matCode = floor(code / 4.0 + 0.001);
        // Facade materials (#5): 1 glass curtain wall, 2 brick, 3 metal cladding.
        if (matCode > 1.5 && matCode < 2.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.13, 0.07), 0.55);
        if (matCode > 2.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.38, 0.41, 0.45), 0.6);
        if (uSourceView > 0.5) {
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
          bool glassWall = matCode > 0.5 && matCode < 1.5;
          float wx0 = glassWall ? 0.05 : 0.22, wx1 = glassWall ? 0.95 : 0.78;
          float wy0 = glassWall ? 0.08 : 0.32, wy1 = glassWall ? 0.92 : 0.82;
          float mx = smoothstep(wx0 - aa, wx0 + aa, f.x) * (1.0 - smoothstep(wx1 - aa, wx1 + aa, f.x));
          float my = smoothstep(wy0, wy0 + 0.04, f.y) * (1.0 - smoothstep(wy1, wy1 + 0.04, f.y));
          winMask = mx * my;
          float r = h21(cell + fract(vSeed) * 97.0);
          float floorDark = step(0.82, h21(vec2(cell.y, fract(vSeed) * 31.0)));
          winLit = step(r, 0.42) * (1.0 - floorDark);
          winColor = mix(vec3(1.0, 0.78, 0.45), vec3(0.95, 0.95, 1.0), step(0.75, h21(cell.yx + fract(vSeed))));
          vec3 glass = mix(vec3(0.42, 0.52, 0.62), vec3(0.08, 0.1, 0.16), uNight);
          if (glassWall) {
            // Curtain wall: bluish, a little brighter towards the top (sky reflection).
            glass = mix(vec3(0.30, 0.45, 0.62) + 0.12 * clamp(vWPos.y / 120.0, 0.0, 1.0), vec3(0.06, 0.08, 0.14), uNight);
            winLit = step(r, 0.55) * (1.0 - floorDark);
          }
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, winMask * (glassWall ? 0.9 : 0.75));
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
