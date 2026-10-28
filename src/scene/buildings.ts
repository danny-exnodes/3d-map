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
import { type Style, toyParamsFor } from './style';
import { TOY, TOY_FACADE, toyFlatWidths, toyGlsl, toyRoofDeck } from './toyGeometry';
import { PLINTH_SHADE, toyColor } from './toyPalette';

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
  /** Đồ chơi (default) or the plain Khối look; Siêu thực is built on Khối. */
  style?: Style;
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

const mid = (s: [XZ, XZ]): XZ => [(s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2];

/**
 * The street end of a house: of the two short sides of its rectangle, the one nearer a road, with the
 * opposite (rear) side. `front` is oriented so that its right-hand side points away from the centre;
 * `sign` is +1 when the front lies towards +rect.axis, the prototypes' local +z (aFront).
 */
function streetEnd(rect: ReturnType<typeof minAreaRect>, roadDistance?: (x: number, z: number) => number) {
  const [c0, c1, c2, c3] = rect.corners;
  const d01 = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
  const sides: [XZ, XZ][] = d01 < rect.long - 1e-6 ? [[c0, c1], [c2, c3]] : [[c1, c2], [c3, c0]];
  const dist = (s: [XZ, XZ]) => roadDistance?.(...mid(s)) ?? 0;
  const [f, rear] = dist(sides[0]) <= dist(sides[1]) ? sides : [sides[1], sides[0]];
  const m = mid(f);
  const front: [XZ, XZ] = (f[1][0] - f[0][0]) * (rect.centre[1] - m[1]) - (f[1][1] - f[0][1]) * (rect.centre[0] - m[0]) > 0 ? [f[1], f[0]] : f;
  const sign = (m[0] - rect.centre[0]) * rect.axis[0] + (m[1] - rect.centre[1]) * rect.axis[1] >= 0 ? 1 : -1;
  return { front, rear, sign };
}

/** The rectangle scaled by `k` about its centre, same axis. */
export function shrinkRect(rect: ReturnType<typeof minAreaRect>, k: number): ReturnType<typeof minAreaRect> {
  const [cx, cz] = rect.centre;
  return {
    ...rect,
    corners: rect.corners.map(([x, z]) => [cx + (x - cx) * k, cz + (z - cz) * k] as XZ),
    long: rect.long * k,
    short: rect.short * k,
    area: rect.area * k * k,
  };
}

/** Simple enough to be a scaled box with a standard roof. */
function isPrototypeCandidate(b: Building, rings: XZ[][], fill: number, short: number): boolean {
  if (b.isPart || rings.length !== 1 || b.minHeight > 0.5 || fill < 0.88 || short < 2.5) return false;
  return b.roof === 'flat' || b.roof === 'gabled' || b.roof === 'hipped';
}

export function buildBuildings(list: Building[], proj: LocalProjection, opts: BuildOptions = {}): BuildingsResult {
  const style = opts.style ?? 'toy';
  const params = toyParamsFor(style);
  const mb = new MeshBuilder();
  const footprints = new SpatialGrid<XZ[]>(25);
  const details = new DetailCollector(params.pastel);
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
    if (params.pastel) {
      toyColor(b.color ?? '#f0e6d2', 'wall', facade);
      toyColor(b.roofColor ?? '#d2cbbb', 'roof', roofCol);
    } else {
      facade.set(b.color ?? '#f0e6d2');
      roofCol.set(b.roofColor ?? '#d2cbbb');
    }
    mb.setColor(facade).setSeed(seed).setBid(bid);
    footprints.insert(rings[0], rings[0]);

    const arch = b.archetype ?? 'generic';
    const fullRect = minAreaRect(rings[0]);
    const fill = area / Math.max(fullRect.area, 1e-6);

    // Ordinary boxy houses share prototypes; landmarks and complex shapes are modelled exactly (#22).
    const proto = !opts.exactOnly && isPrototypeCandidate(b, rings, fill, fullRect.short) && !isLandmark(b, area);
    // A prototype box has the footprint's area, not its rectangle's, so its corners do not land on neighbours;
    // doors, windows and balconies below use this same box.
    const rect = proto ? shrinkRect(fullRect, Math.sqrt(Math.min(1, fill))) : fullRect;
    const tubeDetail = (arch === 'tube' || arch === 'shophouse') && !b.isPart && y1 < 30 && rect.short > 2.5;
    // The door side of toy houses and the balcony side of tube houses.
    const ends = proto || tubeDetail ? streetEnd(rect, opts.roadDistance) : null;
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
        front: ends!.sign,
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

    // Street-level detail for houses (#5). Rooftop cubes of prototypes stay on the toy slab's deck.
    const protoDeck = proto ? { axis: rect.axis, ...toyRoofDeck(rect.short, rect.long, params) } : undefined;
    if (tubeDetail && ends) {
      const levels = Math.max(1, Math.round(y1 / LEVEL_H));
      const [a, c] = ends.front;
      // Toy houses: against the inset wall, between the bevels.
      const toy = proto ? { inset: params.inset, maxWidth: toyFlatWidths(rect.short, rect.long, params)[0] } : undefined;
      details.balconies(a, c, levels, LEVEL_H, h, toy);
      if (b.roof === 'flat') details.rooftop(rect.centre, mid(ends.rear), Math.atan2(-rect.axis[1], rect.axis[0]), y1, facade, h, protoDeck);
    } else if (arch === 'generic' && b.roof === 'flat' && y1 < 25 && area < 400 && rect.short > 3) {
      details.rooftop(rect.centre, rect.corners[2], Math.atan2(-rect.axis[1], rect.axis[0]), y1, facade, h, protoDeck);
    }
  });

  const geom = mb.empty ? new THREE.BufferGeometry() : mb.build(true, true);
  const material = createBuildingMaterial(undefined, false, style);
  // Same uniforms (night, selection, source view) for both; toy placement for the prototypes.
  const instanced = protos.build(createBuildingMaterial(material.userData.uniforms, true, style), params);
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
 * Their windows are laid out in the house's own frame instead, centred on each wall's flat part,
 * with a door on the street end of low houses (TOY_FACADE).
 * Other styles than Đồ chơi (STYLE_PLAIN) place prototypes with their own params and keep the plain
 * look: rectangular windows on a world grid, stronger brick and metal tints, no plinth band, no door.
 */
export function createBuildingMaterial(shared?: BuildingUniforms, toyProto = false, style: Style = 'toy'): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  // uLit: share of windows lit at the current hour (#25).
  const uniforms: BuildingUniforms = shared ?? { uNight: { value: 0 }, uSourceView: { value: 0 }, uSelected: { value: -1 }, uLit: { value: 0.35 } };
  mat.userData.uniforms = uniforms;
  mat.userData.isBuildingMaterial = true;
  mat.userData.style = style;
  const plain = style !== 'toy';
  const defines: Record<string, string> = {};
  if (toyProto) {
    mat.userData.toyProto = true;
    defines.TOY_PROTO = '';
  }
  if (plain) defines.STYLE_PLAIN = '';
  if (toyProto || plain) mat.defines = defines;
  // Never share a compiled program between the exact and the toy material, nor between styles.
  mat.customProgramCacheKey = () => (toyProto ? 'buildings-toy' : 'buildings') + (plain ? `-${style}` : '');
  const F = TOY_FACADE;
  const door = F.door;
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
        // Flat: interpolating a per-building constant adds noise that speckles the window hashes.
        flat varying float vSeed;
        varying float vRoof;
        #ifdef TOY_PROTO
        ${toyGlsl(toyParamsFor(style))}
        attribute float aFront;
        ${TOY_FACADE_VARYINGS}
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
          vToyLocal = transformed * toyScale();
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
          vToyDir = aBevel.xy;
          vToyFace = vec4(toyFlatWidths(toyScale()), toyScale().y, aFront);
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
        flat varying float vSeed;
        varying float vRoof;
        #ifdef TOY_PROTO
        ${TOY_FACADE_VARYINGS}
        #endif
        float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
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
        #ifdef STYLE_PLAIN
          if (matCode > 1.5 && matCode < 2.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.13, 0.07), 0.55);
          if (matCode > 2.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.38, 0.41, 0.45), 0.6);
        #else
          if (matCode > 1.5 && matCode < 2.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.13, 0.07), 0.275);
          if (matCode > 2.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.38, 0.41, 0.45), 0.3);
        #endif
        if (uSourceView > 0.5) {
          diffuseColor.rgb = src < 0.5 ? vec3(${hexToVec(HEIGHT_SOURCE_COLORS[0])}) : src < 1.5 ? vec3(${hexToVec(HEIGHT_SOURCE_COLORS[1])})
            : src < 2.5 ? vec3(${hexToVec(HEIGHT_SOURCE_COLORS[2])}) : vec3(${hexToVec(HEIGHT_SOURCE_COLORS[3])});
        }
        winMask = 0.0; winLit = 0.0; winColor = vec3(0.0); winBright = 0.0;
        bool glassWall = matCode > 0.5 && matCode < 1.5;
        bool facade = vRoof < 0.5 && abs(bN.y) < 0.3 && vWPos.y > 0.6;
        vec2 cell = vec2(0.0);
        float frameMask = 0.0;
        #if defined(TOY_PROTO) && !defined(STYLE_PLAIN)
          // Toy walls, in the house's local metres: the sides face ±x and run along z, the ends face ±z
          // and run along x. Window columns are centred on each face's flat part (TS twin:
          // toyWindowColumns) and stop where the bevels start.
          float side = abs(vToyDir.x) > abs(vToyDir.y) ? 1.0 : 0.0;
          float flatW = mix(vToyFace.x, vToyFace.y, side);
          float u = mix(vToyLocal.x, vToyLocal.z, side);
          float aaM = max(fwidth(u), fwidth(vWPos.y)) * 1.5;
          // A door on the street end of a low house (TS twin: toyDoorWidth).
          float doorW = min(${glf(door.width)}, ${glf(door.fill)} * flatW);
          bool door = side < 0.5 && vToyDir.y * vToyFace.w > 0.0 && vToyFace.z <= ${glf(door.maxWall)} && doorW >= ${glf(door.min)};
          facade = facade && abs(u) < 0.5 * flatW;
          if (facade) {
            float n = max(1.0, floor(flatW / ${glf(F.column)}));
            float colW = flatW / n;
            float k = min(1.0, max(colW - ${glf(2 * F.gap)}, 0.0) / ${glf(F.window + 2 * F.frame)});
            if (k * ${glf(F.window)} < ${glf(F.minWindow)}) k = 0.0;
            float col = clamp(floor((u + 0.5 * flatW) / colW), 0.0, n - 1.0);
            float uc = u + 0.5 * flatW - (col + 0.5) * colW;
            float storey = floor(vWPos.y / 3.3);
            // Offset per face, so that opposite walls do not share one lit pattern.
            cell = vec2(col + 17.0 * (2.0 * side + step(0.0, mix(vToyDir.y, vToyDir.x, side))), storey);
            // Same shapes as the exact mesh, in metres: glazing, or a rounded window with a light frame.
            vec2 p = vec2(uc, vWPos.y - storey * 3.3 - (glassWall ? 0.5 : 0.57) * 3.3);
            vec2 hs = glassWall ? vec2(min(1.44, 0.5 * colW - 0.05), 0.42 * 3.3) : vec2(0.5 * ${glf(F.window)} * k, 0.25 * 3.3);
            float rad = glassWall ? 0.0 : 0.5 * min(hs.x, hs.y);
            vec2 q = abs(p) - hs + rad;
            float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
            if (glassWall || k > 0.0) winMask = 1.0 - smoothstep(-aaM, aaM, sd);
            if (!glassWall && k > 0.0) frameMask = (1.0 - smoothstep(${glf(F.frame)} * k - aaM, ${glf(F.frame)} * k + aaM, sd)) * (1.0 - winMask);
            // The door takes the ground-floor window of its column.
            if (door && storey < 0.5 && abs((col + 0.5) * colW - 0.5 * flatW) < 0.25 * colW) { winMask = 0.0; frameMask = 0.0; }
          }
        #else
          if (facade) {
            vec2 t = normalize(vec2(-bN.z, bN.x));
            float u = dot(vWPos.xz, t);
            float cellW = 3.2;
            float cellH = 3.3;
            cell = vec2(floor(u / cellW), floor(vWPos.y / cellH));
            vec2 f = vec2(fract(u / cellW), fract(vWPos.y / cellH));
            float aa = fwidth(u / cellW) * 1.5;
            float wx0 = glassWall ? 0.05 : 0.22, wx1 = glassWall ? 0.95 : 0.78;
            float wy0 = glassWall ? 0.08 : 0.32, wy1 = glassWall ? 0.92 : 0.82;
            if (glassWall) {
              float mx = smoothstep(wx0 - aa, wx0 + aa, f.x) * (1.0 - smoothstep(wx1 - aa, wx1 + aa, f.x));
              float my = smoothstep(wy0, wy0 + 0.04, f.y) * (1.0 - smoothstep(wy1, wy1 + 0.04, f.y));
              winMask = mx * my;
            } else {
              #ifdef STYLE_PLAIN
                // Plain rectangles.
                float mx = smoothstep(wx0 - aa, wx0 + aa, f.x) * (1.0 - smoothstep(wx1 - aa, wx1 + aa, f.x));
                float my = smoothstep(wy0, wy0 + 0.04, f.y) * (1.0 - smoothstep(wy1, wy1 + 0.04, f.y));
                winMask = mx * my;
              #else
                // Rounded box in cell space (corner radius 0.25 of the short side) with a light frame around the glass.
                vec2 hs = 0.5 * vec2(wx1 - wx0, wy1 - wy0);
                float rad = 0.25 * 2.0 * min(hs.x, hs.y);
                vec2 q = abs(f - 0.5 * vec2(wx0 + wx1, wy0 + wy1)) - hs + rad;
                float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
                winMask = 1.0 - smoothstep(-aa, aa, sd);
                frameMask = (1.0 - smoothstep(0.08 - aa, 0.08 + aa, sd)) * (1.0 - winMask);
              #endif
            }
          }
        #endif
        if (facade) {
          float r = h21(cell + fract(vSeed) * 97.0);
          float floorDark = step(0.82, h21(vec2(cell.y, fract(vSeed) * 31.0)));
          winLit = step(r, uLit) * (1.0 - floorDark);
          winBright = 0.3 + 0.7 * h21(cell * 1.7 + 3.1);
          winColor = mix(vec3(1.0, 0.72, 0.42), vec3(0.9, 0.93, 1.0), step(0.8, h21(cell.yx + fract(vSeed))));
          #ifdef STYLE_PLAIN
            vec3 glass = mix(vec3(0.42, 0.52, 0.62), vec3(0.08, 0.1, 0.16), uNight);
          #else
            vec3 glass = mix(vec3(${hexToVec('#93a9c4')}), vec3(0.08, 0.1, 0.16), uNight);
          #endif
          if (glassWall) {
            // Curtain wall: bluish, a little brighter towards the top (sky reflection).
            glass = mix(vec3(0.30, 0.45, 0.62) + 0.12 * clamp(vWPos.y / 120.0, 0.0, 1.0), vec3(0.06, 0.08, 0.14), uNight);
            winLit = step(r, uLit * 1.25) * (1.0 - floorDark);
          }
          #ifdef STYLE_PLAIN
            diffuseColor.rgb = mix(diffuseColor.rgb, glass, winMask * (glassWall ? 0.9 : 0.75));
          #else
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${hexToVec('#fffaf0')}), frameMask);
            diffuseColor.rgb = mix(diffuseColor.rgb, glass, winMask * (glassWall ? 0.9 : 1.0));
          #endif
        }
        #if defined(TOY_PROTO) && !defined(STYLE_PLAIN)
          if (door && facade) {
            // Wooden door from the plinth top, rounded at the top, with a small gold knob; never lit at night.
            vec2 p = vec2(u, vWPos.y - ${glf(TOY.plinthH + door.height / 2)});
            vec2 hs = vec2(0.5 * doorW, ${glf(door.height / 2)});
            float rad = p.y > 0.0 ? 0.4 * hs.x : 0.0;
            vec2 q = abs(p) - hs + rad;
            float doorMask = 1.0 - smoothstep(-aaM, aaM, length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad);
            float knob = 1.0 - smoothstep(-aaM, aaM, length(p - vec2(0.3 * doorW, -0.05)) - ${glf(door.knob)});
            diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(${hexToVec('#a8704c')}), vec3(${hexToVec('#f2c14e')}), knob), doorMask);
            winMask *= 1.0 - doorMask;
          }
        #endif
        // Plinth band on the exact toy mesh; toy prototypes have a real plinth, Khối has none. The 📏 view keeps its colours.
        #if !defined(TOY_PROTO) && !defined(STYLE_PLAIN)
        if (abs(bN.y) < 0.3 && vWPos.y < ${TOY.plinthH.toFixed(2)} && uSourceView < 0.5) diffuseColor.rgb *= ${PLINTH_SHADE.toFixed(2)};
        #endif
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

/** Varyings of the toy facade: local position (m), plan direction of the vertex (aBevel.xy) and, per house, the flat widths of the ends and sides, the wall height and aFront. */
const TOY_FACADE_VARYINGS = `varying vec3 vToyLocal;
        varying vec2 vToyDir;
        flat varying vec4 vToyFace;`;

/** GLSL float literal. */
const glf = (x: number) => x.toFixed(4);

/** Linear-space GLSL vec3 literal for a hex colour. */
function hexToVec(hex: string): string {
  const c = new THREE.Color(hex);
  return `${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)}`;
}
