import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Flight } from '../data/flights';
import type { LocalProjection } from '../geo/projection';

/** Planes are drawn about 4x their real size; a ~40 m airliner would be a speck over a 1-2 km model. */
const SCALE = 4;
/** A plane with no report for this long is gone. */
const STALE_MS = 60_000;
/** One instanced mesh, 60 triangles a plane: 100 planes stay far below 10,000 triangles. */
const MAX_PLANES = 100;
const MAX_LABELS = 6;
/** Pick radius around a plane's centre (m, drawn size). */
const PICK_RADIUS = 22 * SCALE;
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON_EQ = 111_320;

/** Horizontal distance from the model centre: true inside the model, squeezed towards 3x its half-size outside. */
export function displayRadius(d: number, half: number): number {
  if (d <= half) return d;
  return half + 2 * half * (1 - Math.exp(-(d - half) / (4 * half)));
}

/** 0 m -> 150 m, 12 km and up -> 900 m; low flights keep more of the spread. */
export function displayAltitude(altM: number): number {
  const t = Math.min(1, Math.max(0, altM / 12_000));
  return 150 + 750 * Math.sqrt(t);
}

/** Where the plane is `now` (epoch ms), flying on from its last report along its track at its ground speed. */
export function deadReckon(f: Flight, now: number): { lat: number; lon: number } {
  const dt = Math.max(0, (now - f.seenAt) / 1000);
  const dist = f.gsMs * dt;
  const t = (f.trackDeg * Math.PI) / 180;
  const lat = f.lat + (dist * Math.cos(t)) / M_PER_DEG_LAT;
  const lon = f.lon + (dist * Math.sin(t)) / (M_PER_DEG_LON_EQ * Math.cos((f.lat * Math.PI) / 180));
  return { lat, lon };
}

/** A chunky box; length along +x (the nose), so a plane's heading is a rotation about y. */
function part(l: number, h: number, w: number, x: number, y: number, z: number, hex: string): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(l, h, w).toNonIndexed();
  g.translate(x, y, z);
  const c = new THREE.Color(hex);
  const col = new Float32Array(g.getAttribute('position').count * 3);
  for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

/** Toy: white with a pastel stripe and tail; Khối and Siêu thực: plain white and grey. */
function planeGeometry(toy: boolean): THREE.BufferGeometry {
  const body = '#f6f6f2';
  const wing = toy ? '#ffffff' : '#d4d7db';
  const accent = toy ? '#ff7a9c' : '#a9aeb6';
  return mergeGeometries([
    part(40, 6, 6, 0, 0, 0, body),
    part(42, 0.8, 6.2, 0, -0.5, 0, accent), // stripe along the belly line
    part(9, 1.4, 38, -2, -0.6, 0, wing),
    part(5, 1.2, 14, -17, 0.5, 0, wing),
    part(7, 7, 1.4, -17, 4.5, 0, accent),
  ])!;
}

/**
 * The live planes: one instanced mesh, positions dead-reckoned every frame between polls, a callsign
 * label on the nearest few. Callsign and type come from a remote host, so they only ever reach the DOM
 * through `textContent`.
 */
export class Aircraft {
  readonly group = new THREE.Group();
  readonly mesh: THREE.InstancedMesh;
  private flights: Flight[] = [];
  private active: { f: Flight; pos: THREE.Vector3 }[] = [];
  private labels: HTMLElement[] = [];
  private readonly layer?: HTMLElement;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly one = new THREE.Vector3(SCALE, SCALE, SCALE);
  private readonly v = new THREE.Vector3();

  constructor(
    private readonly proj: LocalProjection,
    private readonly half: number,
    opts: { toy?: boolean; labelLayer?: HTMLElement } = {},
  ) {
    this.mesh = new THREE.InstancedMesh(planeGeometry(opts.toy ?? true), new THREE.MeshLambertMaterial({ vertexColors: true }), MAX_PLANES);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.group.add(this.mesh);
    this.layer = opts.labelLayer;
  }

  /** Replaces the set of planes (the nearest to the centre when there are more than can be drawn). */
  setFlights(fs: Flight[], now: number) {
    const d2 = (f: Flight) => {
      const p = deadReckon(f, now);
      const [x, z] = this.proj.project([p.lon, p.lat]);
      return x * x + z * z;
    };
    this.flights = fs.length <= MAX_PLANES ? fs.slice() : fs.map((f) => ({ f, k: d2(f) })).sort((a, b) => a.k - b.k).slice(0, MAX_PLANES).map((e) => e.f);
  }

  get count(): number {
    return this.flights.length;
  }

  update(now: number, camera: THREE.Camera) {
    this.active = [];
    for (const f of this.flights) {
      if (now - f.seenAt > STALE_MS) continue;
      const p = deadReckon(f, now);
      let [x, z] = this.proj.project([p.lon, p.lat]);
      const d = Math.hypot(x, z);
      if (d > 0) {
        const k = displayRadius(d, this.half) / d;
        x *= k;
        z *= k;
      }
      const pos = new THREE.Vector3(x, displayAltitude(f.altM), z);
      this.q.setFromAxisAngle(this.up, Math.PI / 2 - (f.trackDeg * Math.PI) / 180);
      this.m.compose(pos, this.q, this.one);
      this.mesh.setMatrixAt(this.active.length, this.m);
      this.active.push({ f, pos });
    }
    this.mesh.count = this.active.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.updateLabels(camera);
  }

  private updateLabels(camera: THREE.Camera) {
    const layer = this.layer;
    if (!layer) return;
    const near = this.active
      .filter((a) => a.f.callsign)
      .map((a) => ({ a, d: a.pos.distanceToSquared(camera.position) }))
      .sort((p, q) => p.d - q.d)
      .slice(0, MAX_LABELS);
    while (this.labels.length < near.length) {
      const el = document.createElement('div');
      el.className = 'poi-label plane-label';
      layer.appendChild(el);
      this.labels.push(el);
    }
    const w = layer.clientWidth;
    const h = layer.clientHeight;
    this.labels.forEach((el, i) => {
      const hit = near[i];
      if (!hit) return void (el.style.display = 'none');
      this.v.copy(hit.a.pos).project(camera);
      const visible = this.v.z < 1 && Math.abs(this.v.x) < 1.05 && Math.abs(this.v.y) < 1.05;
      el.style.display = visible ? '' : 'none';
      if (el.textContent !== hit.a.f.callsign) el.textContent = hit.a.f.callsign;
      if (visible) el.style.transform = `translate(${((this.v.x + 1) / 2) * w}px, ${((1 - this.v.y) / 2) * h}px) translate(-50%, -100%)`;
    });
  }

  /** The plane nearest along the ray among those it passes within the pick radius of. */
  pick(ray: THREE.Raycaster): Flight | null {
    let best: Flight | null = null;
    let bestT = Infinity;
    for (const { f, pos } of this.active) {
      if (ray.ray.distanceSqToPoint(pos) > PICK_RADIUS * PICK_RADIUS) continue;
      const t = this.v.copy(pos).sub(ray.ray.origin).dot(ray.ray.direction);
      if (t > 0 && t < bestT) {
        best = f;
        bestT = t;
      }
    }
    return best;
  }

  dispose() {
    for (const el of this.labels) el.remove();
    this.labels = [];
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
