import * as THREE from 'three';
import { PLINTH_SHADE } from './toyPalette';

/**
 * Toy prototypes with corner-preserving scaling (#32). Ordinary houses are GPU-instanced from a
 * few unit meshes scaled per house; a plain rounded box would get oval, stretched corners. So each
 * vertex stores which corner it hangs from and its offset from that corner in metres, and is
 * placed at `corner × (size/2 − r) + r·dir + offset` for the house's real size: the bevels keep
 * their real size on every house. The vertex shader (TOY_GLSL) and the CPU bake for GLB export
 * (bakeToyInstance) run the same maths.
 *
 * Vertex attributes of a toy unit:
 * - `aCorner` (vec3): anchor per axis. x, z: −1/0/+1 = −size/2, centre, +size/2 (hipped ridge ends
 *   use ±0.5); y: 0 = bottom, 1 = top (size.y).
 * - `aOffset` (vec3): offset from the anchor, in metres.
 * - `aBevel` (vec3): xy = plan direction (x, z) of the rounded corner the vertex sits on, scaled
 *   by the bevel radius r (equal to aCorner.xz on sharp vertices, which makes r cancel out);
 *   z = 1 when `normal` is a unit-box normal (pitched-roof slopes), 0 when it is in metres.
 * - `aChimney` (float): 1 on chimney vertices.
 * - `position`: the vertex placed for a reference size, divided by it. Only bounds and picking use it.
 *
 * Everything stays inside the true footprint, so neighbouring row houses never overlap: the
 * plinth is the footprint, the body is inset by TOY.inset, roofs reach back out to the footprint.
 */

/** Toy proportions (m). The radius is the mockup's 1.1 m on a 4.4 m house. */
export const TOY = { inset: 0.3, plinthH: 0.7, radius: 1.1, roofBevel: 0.7, segments: 2 } as const;

/** Flat roof slab thickness (m). */
const SLAB = 0.9;
/**
 * The body's walls go up to the wall top, so every roof covers the line TOY.inset in from the
 * footprint at or above y = 0: roof surfaces turn upwards a little outside it, LIP_INSET in.
 */
const LIP_INSET = TOY.inset - 0.05;
/** Eave lip: an arc of radius roofBevel turning up from vertical until it is LIP_INSET in, where its top meets the wall top. */
const LIP_TURN = Math.acos(1 - LIP_INSET / TOY.roofBevel);
const LIP_DROP = TOY.roofBevel * Math.sin(LIP_TURN);
/**
 * Pitched slopes run from the lip top to a ridge strip LIP_INSET each side of the centre (hipped
 * ridges end at a quarter of the length), so each slope's run is (size − 2·SLOPE_INSET)/2 across
 * and (size − 2·SLOPE_INSET)/4 at a hip end.
 */
const SLOPE_INSET = 2 * LIP_INSET;
/** Chimney (gabled roofs only), metres from the ridge line and from the +z end; it starts down at the lip and tops the ridge. */
const CHIMNEY = { x0: 0.45, x1: 1.05, z0: 1.4, z1: 2.0, top: 0.5 };
/** Gable ends a little darker than the slopes, like the shaded wall triangles of real houses. */
const GABLE_SHADE = 0.86;
const CHIMNEY_SHADE = 0.9;

/**
 * Bevel radius r of a prototype with footprint sx × sz: TOY.radius, clamped so that the body
 * (footprint − 2·inset) keeps r ≤ 0.45 × its extent and the plinth and roofs, whose corners are
 * concentric arcs of radius r + inset, keep r + inset ≤ 0.45 × the footprint.
 * GLSL twin: toyRadius in TOY_GLSL.
 */
export function toyRadius(sx: number, sz: number): number {
  return Math.min(TOY.radius, Math.max(0, 0.45 * Math.min(sx, sz) - TOY.inset));
}

/**
 * Places a toy vertex for a house of the given size (m): per horizontal axis
 * `corner × (size/2 − r) + r × dir + offset`, vertically `corner.y × size.y + offset.y`.
 * `dir` is the vertex's aBevel.xy and defaults to the corner itself (a sharp vertex).
 * GLSL twin: toyPlace in TOY_GLSL.
 */
export function placeToyVertex(corner: THREE.Vector3, offset: THREE.Vector3, size: THREE.Vector3, out = new THREE.Vector3(), dir?: THREE.Vector2): THREE.Vector3 {
  const r = toyRadius(size.x, size.z);
  const dx = dir ? dir.x : corner.x;
  const dz = dir ? dir.y : corner.z;
  return out.set(corner.x * (size.x / 2 - r) + r * dx + offset.x, corner.y * size.y + offset.y, corner.z * (size.z / 2 - r) + r * dz + offset.z);
}

/** Chimney rule: a chimney is dropped (collapsed into the roof) when this holds. GLSL twin: toyNoChimney. */
function noChimney(seed: number): boolean {
  const f = Math.fround(Math.fround(seed) * 13);
  return f - Math.floor(f) > 0.6;
}

/**
 * Divisor that turns a stored normal into the normal of the placed vertex (before rotation):
 * metric normals stay as they are, unit-box slope normals are divided by the slope's real run,
 * size − 2·SLOPE_INSET on x and z. GLSL twin: the beginnormal chunk in createBuildingMaterial,
 * which multiplies by size / divisor because three's instancing then divides by size again.
 */
function normalDivisor(size: THREE.Vector3, unit: number, out: THREE.Vector3): THREE.Vector3 {
  if (unit < 0.5) return out.set(1, 1, 1);
  return out.set(Math.max(size.x - 2 * SLOPE_INSET, 0.1), size.y, Math.max(size.z - 2 * SLOPE_INSET, 0.1));
}

/** GLSL twin of the functions above, for instanced toy meshes (needs USE_INSTANCING and aSeed). */
export const TOY_GLSL = /* glsl */ `
attribute vec3 aCorner;
attribute vec3 aOffset;
attribute vec3 aBevel;
attribute float aChimney;
vec3 toyScale() {
  return max(vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz)), vec3(1e-4));
}
// TS twin: toyRadius.
float toyRadius(vec3 s) { return clamp(0.45 * min(s.x, s.z) - ${TOY.inset.toFixed(4)}, 0.0, ${TOY.radius.toFixed(4)}); }
// TS twin: placeToyVertex.
vec3 toyPlace(vec3 corner, vec3 offset, vec2 dir, vec3 s) {
  float r = toyRadius(s);
  return vec3(corner.x * (s.x * 0.5 - r) + r * dir.x + offset.x, corner.y * s.y + offset.y, corner.z * (s.z * 0.5 - r) + r * dir.y + offset.z);
}
// TS twin: noChimney.
bool toyNoChimney(float seed) { return fract(seed * 13.0) > 0.6; }
// TS twin: normalDivisor (three's instancing maths divides by s afterwards, hence the extra s).
vec3 toyNormalScale(vec3 s) {
  return s / mix(vec3(1.0), max(s - vec3(${(2 * SLOPE_INSET).toFixed(4)}, 0.0, ${(2 * SLOPE_INSET).toFixed(4)}), vec3(0.1, 1e-4, 0.1)), aBevel.z);
}
// Unit-box position that instanceMatrix maps to the placed vertex; chimneys collapse to the roof centre.
vec3 toyTransformed() {
  vec3 s = toyScale();
  vec3 p = toyPlace(aCorner, aOffset, aBevel.xy, s);
  if (aChimney > 0.5 && toyNoChimney(aSeed)) p = vec3(0.0);
  return p / s;
}
`;

let toyDepth: THREE.MeshDepthMaterial | null = null;

/** Shadow-map material for toy prototype meshes (customDepthMaterial): the same placement, so shadows match the rounded shapes. Shared by all of them. */
export function toyDepthMaterial(): THREE.MeshDepthMaterial {
  if (toyDepth) return toyDepth;
  const mat = new THREE.MeshDepthMaterial();
  mat.customProgramCacheKey = () => 'buildings-toy-depth';
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n        attribute float aSeed;\n        ${TOY_GLSL}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n        transformed = toyTransformed();');
  };
  return (toyDepth = mat);
}

type V3 = [number, number, number];

interface ToyVertex {
  c: V3;
  o: V3;
  /** Plan direction of the rounded corner; defaults to c.xz (sharp). */
  d?: [number, number];
  n: V3;
  /** `n` is a unit-box normal (pitched-roof slopes). */
  unit?: boolean;
  shade?: number;
  chimney?: boolean;
}

/** Indexed toy unit under construction. Triangles are wound to face their vertices' normals. */
class ToyMesh {
  private attrs: Record<'position' | 'normal' | 'color' | 'aCorner' | 'aOffset' | 'aBevel' | 'aChimney', number[]> = {
    position: [], normal: [], color: [], aCorner: [], aOffset: [], aBevel: [], aChimney: [],
  };
  private index: number[] = [];
  /** Vertices placed at the reference size, to wind triangles. */
  private placed: THREE.Vector3[] = [];
  private normals: THREE.Vector3[] = [];

  constructor(private ref: THREE.Vector3) {}

  v(x: ToyVertex): number {
    const d = x.d ?? [x.c[0], x.c[2]];
    const p = placeToyVertex(new THREE.Vector3(...x.c), new THREE.Vector3(...x.o), this.ref, new THREE.Vector3(), new THREE.Vector2(...d));
    const n = new THREE.Vector3(...x.n).normalize();
    const a = this.attrs;
    a.position.push(p.x / this.ref.x, p.y / this.ref.y, p.z / this.ref.z);
    a.normal.push(n.x, n.y, n.z);
    const k = x.shade ?? 1;
    a.color.push(k, k, k);
    a.aCorner.push(...x.c);
    a.aOffset.push(...x.o);
    a.aBevel.push(d[0], d[1], x.unit ? 1 : 0);
    a.aChimney.push(x.chimney ? 1 : 0);
    this.placed.push(p);
    // Wind against the placed normal (unit-box normals divided by the reference run).
    this.normals.push(n.clone().divide(normalDivisor(this.ref, x.unit ? 1 : 0, new THREE.Vector3())));
    return this.placed.length - 1;
  }

  tri(a: number, b: number, c: number) {
    const [pa, pb, pc] = [this.placed[a], this.placed[b], this.placed[c]];
    const face = new THREE.Vector3().subVectors(pb, pa).cross(new THREE.Vector3().subVectors(pc, pa));
    const want = this.normals[a].clone().add(this.normals[b]).add(this.normals[c]);
    if (face.dot(want) < 0) this.index.push(a, c, b);
    else this.index.push(a, b, c);
  }

  /** Convex polygon, fanned from its first vertex. */
  poly(ids: number[]) {
    for (let i = 1; i + 1 < ids.length; i++) this.tri(ids[0], ids[i], ids[i + 1]);
  }

  /** Quads between two rows of vertices (closed rows wrap around). */
  band(lo: number[], hi: number[], closed: boolean) {
    const n = lo.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const j = (i + 1) % n;
      this.poly([lo[i], hi[i], hi[j], lo[j]]);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const sizes = { position: 3, normal: 3, color: 3, aCorner: 3, aOffset: 3, aBevel: 3, aChimney: 1 };
    for (const [name, size] of Object.entries(sizes)) g.setAttribute(name, new THREE.Float32BufferAttribute(this.attrs[name as keyof typeof sizes], size));
    g.setIndex(this.index);
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * One horizontal ring around the rounded plan: four corner arcs of TOY.segments segments.
 * `grow` is the arc radius beyond the body's (r): 0 on the body, TOY.inset on the footprint edge.
 * `normal(dx, dz)` gives the vertex normal from the plan direction.
 */
function ring(m: ToyMesh, cy: number, oy: number, grow: number, normal: (dx: number, dz: number) => V3, shade = 1): number[] {
  const ids: number[] = [];
  for (let q = 0; q < 4; q++) {
    const cx = q === 0 || q === 3 ? 1 : -1;
    const cz = q < 2 ? 1 : -1;
    for (let k = 0; k <= TOY.segments; k++) {
      const t = ((q + k / TOY.segments) * Math.PI) / 2;
      const dx = Math.cos(t), dz = Math.sin(t);
      ids.push(m.v({ c: [cx, cy, cz], o: [grow * dx - TOY.inset * cx, oy, grow * dz - TOY.inset * cz], d: [dx, dz], n: normal(dx, dz), shade }));
    }
  }
  return ids;
}

const side = (dx: number, dz: number): V3 => [dx, 0, dz];
const up = (): V3 => [0, 1, 0];
const down = (): V3 => [0, -1, 0];

/**
 * Walls: a plinth on the true footprint (darker), then the body inset by TOY.inset with rounded
 * vertical edges, up to the wall top. Its top is always inside a roof (slab or eave lip), so it gets
 * no cap and no bevel.
 */
export function toyWallsUnit(): THREE.BufferGeometry {
  const m = new ToyMesh(new THREE.Vector3(10, 10, 10));
  const { inset, plinthH } = TOY;
  m.band(ring(m, 0, 0, inset, side, PLINTH_SHADE), ring(m, 0, plinthH, inset, side, PLINTH_SHADE), true);
  // The ledge on top of the plinth, out to the body.
  m.band(ring(m, 0, plinthH, inset, up, PLINTH_SHADE), ring(m, 0, plinthH, 0, up, PLINTH_SHADE), true);
  m.band(ring(m, 0, plinthH, 0, side), ring(m, 1, 0, 0, side), true);
  return m.build();
}

/**
 * Flat roof: a slab SLAB thick whose top is the wall top, from the footprint edge in to LIP_INSET at
 * the top. One band whose normals turn from the side to straight up, so the whole edge shades round.
 */
export function toyFlatRoofUnit(): THREE.BufferGeometry {
  const m = new ToyMesh(new THREE.Vector3(10, 1, 10));
  const { inset } = TOY;
  const top = ring(m, 0, 0, inset - LIP_INSET, up);
  m.band(ring(m, 0, -SLAB, inset, side), top, true);
  m.poly(top);
  m.poly(ring(m, 0, -SLAB, inset, down));
  return m.build();
}

/**
 * Pitched roof over the footprint, ridge along z, wall top at y = 0 and ridge at y = size.y (the rise).
 * A thick rounded eave lip on every eave hangs LIP_DROP under the wall top, the slopes are planar,
 * and the ridge is a strip whose normals turn from one slope to the other, so it shades round.
 * Gabled roofs have vertical gable ends and a chimney; hipped roofs slope at the ends to a ridge
 * half the length of the house.
 */
export function toyPitchedRoofUnit(hipped: boolean): THREE.BufferGeometry {
  const m = new ToyMesh(new THREE.Vector3(10, 3, 10));
  const b = TOY.roofBevel;
  const n = TOY.segments;
  const ridgeHalf = SLOPE_INSET - LIP_INSET;
  const long = (sx: number): V3 => [sx, 0.5, 0];
  const end = (sz: number): V3 => [0, 0.25, sz];
  // Lip row k: inset from the eave line and height (k = 0 is the bottom, k = n the slope's start).
  const lip = (k: number) => {
    const phi = (k / n) * LIP_TURN;
    return { inset: b * (1 - Math.cos(phi)), y: -LIP_DROP + b * Math.sin(phi), t: k / n };
  };
  const blend = (a: V3, s: V3, t: number): V3 => {
    const sl = Math.hypot(...s);
    return [a[0] * (1 - t) + (s[0] / sl) * t, a[1] * (1 - t) + (s[1] / sl) * t, a[2] * (1 - t) + (s[2] / sl) * t];
  };
  const ridgeZ = hipped ? 0.5 : 1;
  const ridge: Record<string, number> = {};
  for (const sx of [1, -1]) {
    for (const cz of [1, -1]) ridge[`${sx},${cz}`] = m.v({ c: [0, 1, ridgeZ * cz], o: [sx * ridgeHalf, 0, 0], n: long(sx), unit: true });
  }
  // Long sides (±x): lip rows then the slope up to the ridge.
  const lipTops: Record<string, number> = {};
  for (const sx of [1, -1]) {
    const rows: number[][] = [];
    for (let k = 0; k <= n; k++) {
      const { inset, y, t } = lip(k);
      const mitre = hipped ? inset : 0;
      rows.push([1, -1].map((cz) => m.v({ c: [sx, 0, cz], o: [-sx * inset, y, -cz * mitre], n: blend([sx, 0, 0], long(sx), t), unit: true })));
    }
    for (let k = 0; k < n; k++) m.band(rows[k], rows[k + 1], false);
    m.poly([rows[n][0], rows[n][1], ridge[`${sx},-1`], ridge[`${sx},1`]]);
    lipTops[`${sx},1`] = rows[n][0];
    lipTops[`${sx},-1`] = rows[n][1];
  }
  // Ridge strip.
  m.poly([ridge['1,1'], ridge['1,-1'], ridge['-1,-1'], ridge['-1,1']]);
  for (const cz of [1, -1]) {
    if (hipped) {
      // Hip end: lip rows then a trapezoid up to the ridge end.
      const rows: number[][] = [];
      for (let k = 0; k <= n; k++) {
        const { inset, y, t } = lip(k);
        rows.push([1, -1].map((cx) => m.v({ c: [cx, 0, cz], o: [-cx * inset, y, -cz * inset], n: blend([0, 0, cz], end(cz), t), unit: true })));
      }
      for (let k = 0; k < n; k++) m.band(rows[k], rows[k + 1], false);
      const top = [1, -1].map((sx) => m.v({ c: [0, 1, 0.5 * cz], o: [sx * ridgeHalf, 0, 0], n: end(cz), unit: true }));
      m.poly([rows[n][0], rows[n][1], top[1], top[0]]);
    } else {
      // Gable end: the profile, fanned from the middle of its bottom edge.
      const nz: V3 = [0, 0, cz];
      const g = (c: V3, o: V3) => m.v({ c, o, n: nz, unit: true, shade: GABLE_SHADE });
      const profile: number[] = [];
      for (let k = 0; k <= n; k++) profile.push(g([1, 0, cz], [-lip(k).inset, lip(k).y, 0]));
      profile.push(g([0, 1, cz], [ridgeHalf, 0, 0]), g([0, 1, cz], [-ridgeHalf, 0, 0]));
      for (let k = n; k >= 0; k--) profile.push(g([-1, 0, cz], [lip(k).inset, lip(k).y, 0]));
      const mid = g([0, 0, cz], [0, -LIP_DROP, 0]);
      for (let i = 0; i + 1 < profile.length; i++) m.tri(mid, profile[i], profile[i + 1]);
    }
  }
  // Underside, seen from the street under the overhang.
  m.poly([[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([cx, cz]) => m.v({ c: [cx, 0, cz], o: [0, -LIP_DROP, 0], n: [0, -1, 0], unit: true })));
  if (!hipped) chimney(m);
  return m.build();
}

/** A box on the +x slope near the +z end, from inside the roof to CHIMNEY.top above the ridge. */
function chimney(m: ToyMesh) {
  const { x0, x1, z0, z1, top } = CHIMNEY;
  const at = (x: number, hi: boolean, z: number, n: V3) =>
    m.v({ c: [0, hi ? 1 : 0, 1], o: [x, hi ? top : -LIP_DROP, -z], n, unit: true, shade: CHIMNEY_SHADE, chimney: true });
  const faces: [V3, [number, number][]][] = [
    [[1, 0, 0], [[x1, z0], [x1, z1]]],
    [[-1, 0, 0], [[x0, z1], [x0, z0]]],
    [[0, 0, 1], [[x0, z0], [x1, z0]]],
    [[0, 0, -1], [[x1, z1], [x0, z1]]],
  ];
  for (const [n, [[ax, az], [bx, bz]]] of faces) m.poly([at(ax, false, az, n), at(bx, false, bz, n), at(bx, true, bz, n), at(ax, true, az, n)]);
  m.poly([at(x0, true, z0, [0, 1, 0]), at(x1, true, z0, [0, 1, 0]), at(x1, true, z1, [0, 1, 0]), at(x0, true, z1, [0, 1, 0])]);
}

/**
 * Bakes one instance of a toy unit to plain geometry (position, normal, color) in world space:
 * placement at the instance's scale, then its rotation and translation. With `seed` (the
 * instance's aSeed), chimneys follow the shader's rule. Used by the GLB export.
 */
export function bakeToyInstance(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, seed?: number): THREE.BufferGeometry {
  const t = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  matrix.decompose(t, q, s);
  s.set(Math.max(Math.abs(s.x), 1e-4), Math.max(Math.abs(s.y), 1e-4), Math.max(Math.abs(s.z), 1e-4));
  const corner = geo.getAttribute('aCorner'), offset = geo.getAttribute('aOffset'), bevel = geo.getAttribute('aBevel');
  const chimney = geo.getAttribute('aChimney'), normal = geo.getAttribute('normal');
  const dropChimney = seed !== undefined && noChimney(seed);
  const pos = new Float32Array(corner.count * 3), nor = new Float32Array(corner.count * 3);
  const c = new THREE.Vector3(), o = new THREE.Vector3(), d = new THREE.Vector2(), p = new THREE.Vector3(), n = new THREE.Vector3(), div = new THREE.Vector3();
  for (let i = 0; i < corner.count; i++) {
    c.fromBufferAttribute(corner, i);
    o.fromBufferAttribute(offset, i);
    d.set(bevel.getX(i), bevel.getY(i));
    placeToyVertex(c, o, s, p, d);
    if (dropChimney && chimney.getX(i) > 0.5) p.set(0, 0, 0);
    p.applyQuaternion(q).add(t).toArray(pos, i * 3);
    n.fromBufferAttribute(normal, i).divide(normalDivisor(s, bevel.getZ(i), div)).applyQuaternion(q).normalize().toArray(nor, i * 3);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', geo.getAttribute('color').clone());
  if (geo.index) out.setIndex(geo.index.clone());
  out.computeBoundingSphere();
  return out;
}
