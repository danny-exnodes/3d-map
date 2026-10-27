import * as THREE from 'three';
import { hashString } from '../data/rand';
import type { Building } from '../data/types';
import type { LocalProjection } from '../geo/projection';
import { LEVEL_H } from '../data/buildings';
import { DetailCollector } from './details';
import { MeshBuilder, type XZ } from './geometry';
import { PrototypeCollector } from './prototypes';
import { buildRoof, flatCap, minAreaRect } from './roofs';
import { SpatialGrid } from './spatial';
import { TOY_GLSL } from './toyGeometry';
import { toyColor } from './toyPalette';

/** Integer codes of HeightSource stored in aSeed (see the "theo nguồn chiều cao" view, #3). */
export const HEIGHT_SOURCE_CODE: Record<Building['heightSource'], number> = { osm: 0, gob: 1, overture: 2, heuristic: 3 };
export const HEIGHT_SOURCE_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#9ca3af'];

export interface BuildingsResult {
  /** Exactly modelled buildings (landmarks, complex shapes, parts). */
  mesh: THREE.Mesh;
  /** Ordinary houses drawn from shared prototypes (#22). */
  instanced: THREE.InstancedMesh[];
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
  /** Model every building exactly (no prototypes), e.g. for comparison. */
  exactOnly?: boolean;
}

export interface BuildingUniforms {
  uNight: { value: number };
  uSourceView: { value: number };
  uSelected: { value: number };
  uLit: { value: number };
}

/** Kinds that are public, civic or national landmarks and deserve exact geometry. */
const LANDMARK_KINDS = new Set([
  'government', 'public', 'civic', 'townhall', 'church', 'cathedral', 'chapel', 'temple', 'pagoda', 'shrine', 'mosque', 'religious',
  'school', 'university', 'college', 'kindergarten', 'hospital', 'train_station', 'transportation', 'stadium', 'sports_hall', 'museum',
  'theatre', 'palace', 'castle', 'monument', 'memorial', 'mausoleum', 'market', 'grandstand', 'library', 'fire_station', 'police',
]);

/** Public buildings, national landmarks and big buildings are modelled exactly from their data (#22). */
export function isLandmark(b: Building, area: number): boolean {
  if (LANDMARK_KINDS.has(b.kind) || b.archetype === 'civic' || b.archetype === 'temple' || b.archetype === 'church') return true;
  if (b.height > 40 || area > 2500) return true;
  return !!b.name && area > 600;
}

/** Simple enough to be a scaled box with a standard roof. */
function isPrototypeCandidate(b: Building, rings: XZ[][], fill: number, short: number): boolean {
  if (b.isPart || rings.length !== 1 || b.minHeight > 0.5 || fill < 0.88 || short < 2.5) return false;
  return b.roof === 'flat' || b.roof === 'gabled' || b.roof === 'hipped';
}

export function buildBuildings(list: Building[], proj: LocalProjection, opts: BuildOptions = {}): BuildingsResult {
  const mb = new MeshBuilder();
  const footprints = new SpatialGrid<XZ[]>(25);
  const details = new DetailCollector();
  const facade = new THREE.Color();
  const roofCol = new THREE.Color();
  const ids: string[] = [];
  const protos = new PrototypeCollector();
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
    toyColor(b.color ?? '#f0e6d2', 'wall', facade);
    toyColor(b.roofColor ?? '#d2cbbb', 'roof', roofCol);
    mb.setColor(facade).setSeed(seed).setBid(bid);
    footprints.insert(rings[0], rings[0]);

    const arch = b.archetype ?? 'generic';
    const rect = minAreaRect(rings[0]);
    const fill = area / Math.max(rect.area, 1e-6);

    // Ordinary boxy houses share prototypes; landmarks and complex shapes are modelled exactly (#22).
    const proto = !opts.exactOnly && isPrototypeCandidate(b, rings, fill, rect.short) && !isLandmark(b, area);
    if (proto) {
      const pitchedRoof = b.roof === 'gabled' || b.roof === 'hipped';
      const lowPitch = arch === 'industrial' || arch === 'tube' || arch === 'shophouse';
      protos.add({
        centre: rect.centre,
        angle: Math.atan2(rect.axis[0], rect.axis[1]),
        w: rect.short,
        l: rect.long,
        height: y1,
        roof: pitchedRoof ? (b.roof as 'gabled' | 'hipped') : 'flat',
        rise: b.roofHeight ?? Math.min(rect.short * (lowPitch ? 0.16 : 0.4), lowPitch ? 3 : 5),
        facade: facade.clone(),
        roofColor: roofCol.clone(),
        seed,
        bid,
      });
    }
    // Tall blocks get a wider podium and a set-back tower (khối đế), when the shape allows it.
    const podium = !proto && !b.isPart && rings.length === 1 && y0 === 0 && y1 > 30 && area > 600 && fill > 0.75 && (arch === 'apartment' || arch === 'office');
    if (podium) {
      const ph = LEVEL_H * (3 + (h % 2));
      const tower = scaleRing(rings[0], rect.centre, 0.72);
      walls(mb, rings, 0, ph);
      mb.setColor(roofCol);
      flatCap(mb, rings, ph);
      mb.setColor(facade);
      walls(mb, [tower], ph, y1);
      buildRoof(mb, { shape: b.roof, rings: [tower], y: y1, roof: roofCol, facade, height: b.roofHeight });
    } else if (!proto) {
      walls(mb, rings, y0, y1);
      buildRoof(mb, { shape: b.roof, rings, y: y1, roof: roofCol, facade, height: b.roofHeight, lowPitch: arch === 'industrial' || arch === 'tube' || arch === 'shophouse' });
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
  // Same uniforms (night, selection, source view) for both; toy placement for the prototypes.
  const instanced = protos.build(createBuildingMaterial(material.userData.uniforms, true));
  const mesh = new THREE.Mesh(geom, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'buildings';
  opts.onProgress?.(1);
  return { mesh, instanced, material, footprints, details: details.build(), count, ids };
}

const V = (p: XZ, y: number) => new THREE.Vector3(p[0], y, p[1]);

/**
 * Lambert material with procedural windows: glazing by day, randomly lit
 * windows at night. Window grid is derived from world position so it needs no UVs.
 * With `toyProto`, it places the vertices of instanced toy prototypes for each house's real
 * size (TOY_PROTO, see toyGeometry.ts); such meshes take toyDepthMaterial() for their shadows.
 */
export function createBuildingMaterial(shared?: BuildingUniforms, toyProto = false): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  // uLit: share of windows lit at the current hour (#25).
  const uniforms: BuildingUniforms = shared ?? { uNight: { value: 0 }, uSourceView: { value: 0 }, uSelected: { value: -1 }, uLit: { value: 0.35 } };
  mat.userData.uniforms = uniforms;
  mat.userData.isBuildingMaterial = true;
  if (toyProto) {
    mat.userData.toyProto = true;
    mat.defines = { TOY_PROTO: '' };
  }
  // Never share a compiled program between the exact and the toy material.
  mat.customProgramCacheKey = () => (toyProto ? 'buildings-toy' : 'buildings');
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms.uNight;
    shader.uniforms.uSourceView = uniforms.uSourceView;
    shader.uniforms.uSelected = uniforms.uSelected;
    shader.uniforms.uLit = uniforms.uLit;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aSeed;
        attribute float aBid;
        uniform float uSelected;
        varying float vSelected;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        varying float vSeed;
        varying float vRoof;
        #ifdef TOY_PROTO
        ${TOY_GLSL}
        #endif`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        #ifdef TOY_PROTO
          objectNormal *= toyNormalScale(toyScale());
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef TOY_PROTO
          transformed = toyTransformed();
        #endif`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec4 bp = vec4(transformed, 1.0);
          vec3 bn = objectNormal;
          #ifdef USE_INSTANCING
            bp = instanceMatrix * bp;
            bn = mat3(instanceMatrix) * bn;
          #endif
          vWPos = (modelMatrix * bp).xyz;
          vWNormal = normalize(mat3(modelMatrix) * bn);
        }
        vSeed = aSeed;
        // Toy roof units never get windows; the exact mesh has no aRoof attribute.
        #ifdef TOY_PROTO
          vRoof = aRoof;
        #else
          vRoof = 0.0;
        #endif
        vSelected = abs(aBid - uSelected) < 0.5 ? 1.0 : 0.0;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uNight;
        uniform float uSourceView;
        uniform float uLit;
        varying float vSelected;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        varying float vSeed;
        varying float vRoof;
        float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float vn(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y); }
        float fbm3(vec2 p) { return 0.5 * vn(p) + 0.3 * vn(p * 2.1 + 7.0) + 0.2 * vn(p * 4.3 + 3.0); }
        float winMask; float winLit; vec3 winColor; float winBright;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Geometric normal from derivatives: exact for flat faces, also for scaled prototypes.
        vec3 bN = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
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
        winMask = 0.0; winLit = 0.0; winColor = vec3(0.0); winBright = 0.0;
        if (vRoof < 0.5 && abs(bN.y) < 0.3 && vWPos.y > 0.6) {
          vec2 t = normalize(vec2(-bN.z, bN.x));
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
          winLit = step(r, uLit) * (1.0 - floorDark);
          winBright = 0.3 + 0.7 * h21(cell * 1.7 + 3.1);
          winColor = mix(vec3(1.0, 0.72, 0.42), vec3(0.9, 0.93, 1.0), step(0.8, h21(cell.yx + fract(vSeed))));
          vec3 glass = mix(vec3(0.42, 0.52, 0.62), vec3(0.08, 0.1, 0.16), uNight);
          if (glassWall) {
            // Curtain wall: bluish, a little brighter towards the top (sky reflection).
            glass = mix(vec3(0.30, 0.45, 0.62) + 0.12 * clamp(vWPos.y / 120.0, 0.0, 1.0), vec3(0.06, 0.08, 0.14), uNight);
            winLit = step(r, uLit * 1.25) * (1.0 - floorDark);
          }
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, winMask * (glassWall ? 0.9 : 0.75));
        }
        // Weathering so walls and roofs read as plaster, concrete and metal rather than plastic (#28):
        // less saturated paint, blotches, rain streaks under each floor, dark splash zone at the foot.
        {
          float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          diffuseColor.rgb = mix(vec3(l), diffuseColor.rgb, 0.82);
          float seedOff = fract(vSeed) * 61.0;
          if (abs(bN.y) < 0.3) {
            vec2 t2 = normalize(vec2(-bN.z, bN.x));
            float u2 = dot(vWPos.xz, t2);
            diffuseColor.rgb *= 0.88 + 0.2 * fbm3(vec2(u2, vWPos.y) * 0.35 + seedOff);
            float fy = fract(vWPos.y / 3.3);
            float streak = smoothstep(0.55, 0.95, vn(vec2(u2 * 1.4, floor(vWPos.y / 3.3) + seedOff))) * (1.0 - fy);
            diffuseColor.rgb *= 1.0 - 0.16 * streak;
            diffuseColor.rgb *= 1.0 + 0.06 * (1.0 - smoothstep(0.0, 0.06, fy));
          } else {
            diffuseColor.rgb *= 0.8 + 0.3 * fbm3(vWPos.xz * 0.3 + seedOff);
          }
          // Ambient occlusion where walls meet the ground.
          diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(0.0, 2.2, vWPos.y));
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.32, 0.08), vSelected * 0.85);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += winColor * winMask * winLit * winBright * uNight * 0.75;
        // Selected building (#10): warm accent tint + glow.
        totalEmissiveRadiance += vec3(0.55, 0.14, 0.0) * vSelected;`,
      );
  };
  return mat;
}

/** Linear-space GLSL vec3 literal for a hex colour. */
function hexToVec(hex: string): string {
  const c = new THREE.Color(hex);
  return `${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)}`;
}
