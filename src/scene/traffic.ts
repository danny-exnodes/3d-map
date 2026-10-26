import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng } from '../data/rand';
import type { RoadClass } from '../data/types';
import { MeshBuilder, ribbon, type XZ } from './geometry';
import { pointAt, type RailPath, type RoadPath, TUNNEL_COVERED } from './roads';
import { FREE_SPEED, kindMix, loadColor, roadLoad, VEHICLE_KINDS, type VehicleKind, walkProfile } from './trafficModel';

export { hourProfile as densityAt } from './trafficModel';

interface Vehicle {
  path: number;
  d: number;
  dir: 1 | -1;
  /** Signed lateral offset from the road centre, on the right-hand side of travel. */
  lateral: number;
  /** Personal speed factor (riders differ). */
  pace: number;
  kind: VehicleKind;
  /** Index within the instanced mesh of its kind. */
  slot: number;
  /** Shown when the current road's load ratio exceeds it. */
  threshold: number;
}

interface Walker {
  path: number;
  d: number;
  dir: 1 | -1;
  lateral: number;
  speed: number;
  threshold: number;
}

/** Length (m) of each kind, for headlights and spacing. */
const LENGTH: Record<VehicleKind, number> = { moto: 1.9, car: 4.3, bus: 11, truck: 7.5, bicycle: 1.7 };
const PACE: Record<VehicleKind, number> = { moto: 1, car: 1.05, bus: 0.75, truck: 0.8, bicycle: 0.45 };

/** Box with its base at y0, centred on x/z, with one vertex colour. */
function box(w: number, h: number, l: number, y0: number, z = 0, shade = 1): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, l).translate(0, y0 + h / 2, z);
  const c = new Float32Array(g.getAttribute('position').count * 3).fill(shade);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.deleteAttribute('uv');
  return g;
}

/** Low-poly models, one per kind; the instance colour tints the shade 1 parts. */
function vehicleGeometry(kind: VehicleKind): THREE.BufferGeometry {
  switch (kind) {
    case 'moto':
      // Bike, then rider (torso, helmet) leaning slightly forward.
      return mergeGeometries([box(0.5, 0.55, 1.8, 0.25), box(0.12, 0.5, 0.12, 0, 0.75, 0.2), box(0.12, 0.5, 0.12, 0, -0.75, 0.2), box(0.45, 0.62, 0.32, 0.85, -0.1, 0.9), box(0.28, 0.28, 0.3, 1.47, -0.05, 0.35)])!;
    case 'bicycle':
      return mergeGeometries([box(0.12, 0.65, 1.65, 0.2, 0, 0.3), box(0.42, 0.6, 0.3, 0.9, -0.15, 1), box(0.24, 0.24, 0.26, 1.5, -0.1, 0.85)])!;
    case 'car':
      return mergeGeometries([box(1.8, 0.75, 4.3, 0.25), box(1.62, 0.6, 2.3, 1.0, -0.2, 0.45)])!;
    case 'bus':
      return mergeGeometries([box(2.5, 1.2, 11, 0.3), box(2.52, 1.0, 10.6, 1.5, 0, 0.35), box(2.5, 0.35, 11, 2.5)])!;
    case 'truck':
      return mergeGeometries([box(2.3, 1.9, 2.2, 0.35, 2.6, 1), box(2.4, 2.5, 5.2, 0.45, -1.2, 0.85)])!;
  }
}

const PALETTE: Record<VehicleKind, string[]> = {
  moto: ['#e9e9e9', '#1f2024', '#c0392b', '#2e86de', '#8e44ad', '#d35400', '#7f8c8d', '#e84393'],
  bicycle: ['#2d3436', '#0984e3', '#00b894', '#fdcb6e', '#d63031'],
  car: ['#f2f2f2', '#2b2d33', '#bdc3c7', '#c0392b', '#2e86de', '#7f8c8d', '#ffffff', '#1e3799'],
  bus: ['#27ae60', '#2e86de', '#16a085', '#e67e22'],
  truck: ['#f0f0f0', '#2980b9', '#c0392b', '#f39c12'],
};
const CLOTHES = ['#2d3436', '#0984e3', '#d63031', '#fdcb6e', '#00b894', '#e17055', '#f5f6fa', '#6c5ce7'];

/** Free-flow speed for the kind on a road class, m/s. */
const speedOf = (kind: VehicleKind, cls: RoadClass) => (kind === 'bicycle' ? 4 : FREE_SPEED[cls] * PACE[kind]);

const SIDEWALK_ROADS = new Set<RoadClass>(['primary', 'secondary', 'tertiary', 'residential']);

export class Traffic {
  readonly group = new THREE.Group();
  readonly bodies = new Map<VehicleKind, THREE.InstancedMesh>();
  readonly lights: THREE.InstancedMesh;
  readonly walkers: THREE.InstancedMesh | null = null;
  readonly trains: THREE.InstancedMesh | null = null;
  readonly overlay: THREE.Mesh | null = null;
  private vehicles: Vehicle[] = [];
  private people: Walker[] = [];
  private ends = new Map<string, { path: number; atStart: boolean }[]>();
  private trainState: { path: number; d: number; dir: 1 | -1; speed: number }[] = [];
  private overlayRanges: { path: number; start: number; count: number }[] = [];
  /** Per path: share of its peak load shown now, and speed ratio. */
  private ratio: Float32Array;
  private speedRatio: Float32Array;
  private boost: Float32Array;
  private peak: Float32Array;
  private night = 0;
  private walk = 0.5;
  private r = rng(99);
  private tmp = new THREE.Object3D();
  private pos = new THREE.Vector3();
  private dir = new THREE.Vector3();
  stats = { vehicles: 0, segments: 0, flow: 1, people: 0, byKind: {} as Record<VehicleKind, number> };

  /**
   * @param attractors local x/z of markets, schools, hospitals… (raise traffic nearby)
   * @param maxVehicles cap on simulated vehicles (fewer on phones)
   */
  constructor(private readonly paths: RoadPath[], private readonly rails: RailPath[], attractors: XZ[] = [], maxVehicles = 2400, maxPeople = 700) {
    this.group.name = 'traffic';
    const n = paths.length;
    this.ratio = new Float32Array(n);
    this.speedRatio = new Float32Array(n).fill(1);
    this.boost = new Float32Array(n).fill(1);
    this.peak = new Float32Array(n);
    const drivable = paths.map((p, i) => ({ p, i })).filter(({ p }) => FREE_SPEED[p.road.cls] > 0 && p.length > 8);
    for (const { p, i } of drivable) {
      for (const [pt, atStart] of [[p.pts[0], true], [p.pts[p.pts.length - 1], false]] as const) {
        const k = endKey(pt);
        let l = this.ends.get(k);
        if (!l) this.ends.set(k, (l = []));
        l.push({ path: i, atStart });
      }
    }
    // Busier near attractors and where a street meets a major road.
    const major = new Set<string>();
    for (const { p } of drivable) if (['motorway', 'primary', 'secondary'].includes(p.road.cls)) for (const pt of [p.pts[0], p.pts[p.pts.length - 1]]) major.add(endKey(pt));
    for (const { p, i } of drivable) {
      const mid = p.pts[Math.floor(p.pts.length / 2)];
      let b = 1;
      for (const [ax, az] of attractors) if (Math.hypot(ax - mid[0], az - mid[1]) < 160) b += 0.12;
      if (major.has(endKey(p.pts[0])) || major.has(endKey(p.pts[p.pts.length - 1]))) b += 0.12;
      this.boost[i] = Math.min(1.5, b);
    }

    // Vehicles per road at its own busiest hour; the hour then shows a share of them.
    const want = drivable.map(({ p, i }) => {
      let best = 0;
      for (const h of [7.6, 17.8]) best = Math.max(best, roadLoad(p.road.cls, h, this.boost[i]).density);
      this.peak[i] = best;
      const lanes = Math.max(1, p.road.lanes);
      return (best * lanes * p.length) / 1000;
    });
    const total = want.reduce((a, b) => a + b, 0);
    const scale = total > maxVehicles ? maxVehicles / total : 1;
    const r = this.r;
    const perKind = Object.fromEntries(VEHICLE_KINDS.map((k) => [k, 0])) as Record<VehicleKind, number>;
    drivable.forEach(({ p, i }, j) => {
      const count = Math.floor(want[j] * scale + r());
      const mix = kindMix(p.road.cls);
      for (let c = 0; c < count; c++) {
        let roll = r();
        let kind: VehicleKind = 'moto';
        for (const k of VEHICLE_KINDS) {
          if (roll < mix[k]) {
            kind = k;
            break;
          }
          roll -= mix[k];
        }
        const dir: 1 | -1 = p.road.oneway || r() < 0.5 ? 1 : -1;
        this.vehicles.push({ path: i, d: r() * p.length, dir, lateral: 0, pace: 0.8 + r() * 0.4, kind, slot: perKind[kind]++, threshold: r() });
        this.placeInLane(this.vehicles[this.vehicles.length - 1]);
      }
    });

    for (const kind of VEHICLE_KINDS) {
      const m = new THREE.InstancedMesh(vehicleGeometry(kind), new THREE.MeshLambertMaterial({ vertexColors: true }), Math.max(1, perKind[kind]));
      m.count = perKind[kind];
      // Shadow maps are rendered on demand, so moving vehicles must not cast shadows.
      m.castShadow = false;
      m.name = 'vehicles';
      m.frustumCulled = false;
      this.bodies.set(kind, m);
      this.group.add(m);
    }
    for (const v of this.vehicles) {
      const pal = v.kind === 'moto' || v.kind === 'bicycle' ? CLOTHES : PALETTE[v.kind];
      this.bodies.get(v.kind)!.setColorAt(v.slot, new THREE.Color(pal[Math.floor(r() * pal.length)]));
    }

    const lightGeo = new THREE.BoxGeometry(1, 1, 1);
    this.lights = new THREE.InstancedMesh(lightGeo, new THREE.MeshBasicMaterial({ toneMapped: false }), Math.max(1, this.vehicles.length * 2));
    const head = new THREE.Color(3.2, 2.9, 2.2);
    const tail = new THREE.Color(3, 0.15, 0.1);
    for (let i = 0; i < this.vehicles.length; i++) {
      this.lights.setColorAt(i * 2, head);
      this.lights.setColorAt(i * 2 + 1, tail);
    }
    this.lights.count = this.vehicles.length * 2;
    this.lights.visible = false;
    this.lights.frustumCulled = false;
    this.lights.name = 'vehicleLights';
    this.group.add(this.lights);

    // Pedestrians on the sidewalks of city streets and on footpaths.
    const walkable = paths.map((p, i) => ({ p, i })).filter(({ p }) => (SIDEWALK_ROADS.has(p.road.cls) || p.road.cls === 'path') && p.length > 10 && !p.heights.some((h) => Math.abs(h) > 0.8));
    const wWant = walkable.map(({ p, i }) => (p.length / 100) * (p.road.cls === 'path' ? 3 : p.road.cls === 'residential' ? 2 : 4) * this.boost[i] ** 2);
    const wTotal = wWant.reduce((a, b) => a + b, 0);
    const wScale = wTotal > maxPeople ? maxPeople / wTotal : 1;
    walkable.forEach(({ p, i }, j) => {
      const count = Math.floor(wWant[j] * wScale + r());
      for (let c = 0; c < count; c++) {
        const side = r() < 0.5 ? -1 : 1;
        const lateral = p.road.cls === 'path' ? (r() - 0.5) * 1.2 : side * (p.road.width / 2 + 0.7 + r() * 1.1);
        this.people.push({ path: i, d: r() * p.length, dir: r() < 0.5 ? 1 : -1, lateral, speed: 1.1 + r() * 0.5, threshold: r() });
      }
    });
    if (this.people.length) {
      const body = mergeGeometries([box(0.42, 0.85, 0.26, 0.0, 0, 0.35), box(0.46, 0.65, 0.28, 0.85, 0, 1), box(0.24, 0.26, 0.24, 1.5, 0, 0.8)])!;
      this.walkers = new THREE.InstancedMesh(body, new THREE.MeshLambertMaterial({ vertexColors: true }), this.people.length);
      this.walkers.name = 'pedestrians';
      this.walkers.castShadow = false;
      this.walkers.frustumCulled = false;
      this.people.forEach((_, k) => this.walkers!.setColorAt(k, new THREE.Color(CLOTHES[Math.floor(r() * CLOTHES.length)])));
      this.group.add(this.walkers);
    }

    // Trains on rail lines longer than 200 m.
    const trainCars = 4;
    rails.forEach((rp, i) => {
      if (rp.length > 200) this.trainState.push({ path: i, d: r() * rp.length, dir: r() < 0.5 ? 1 : -1, speed: 14 });
    });
    if (this.trainState.length) {
      const geo = new THREE.BoxGeometry(2.9, 3.4, 18).translate(0, 1.7, 0);
      this.trains = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: '#f2f2f2' }), this.trainState.length * trainCars);
      this.trains.name = 'trains';
      this.group.add(this.trains);
    }

    this.overlay = this.buildOverlay();
    if (this.overlay) this.group.add(this.overlay);
    this.setHour(12);
  }

  /** Lane position: cars and buses in lanes, motorbikes and bicycles spread towards the kerb. */
  private placeInLane(v: Vehicle) {
    const p = this.paths[v.path];
    const half = p.road.width / 2;
    const two = !p.road.oneway;
    const usable = two ? half : p.road.width;
    const left = two ? 0 : -half;
    const r = this.r();
    let off: number;
    if (v.kind === 'moto' || v.kind === 'bicycle') off = left + usable * (0.35 + 0.6 * Math.sqrt(r));
    else {
      const lanes = Math.max(1, Math.floor(usable / 3.2));
      off = left + (Math.floor(r * lanes) + 0.5) * (usable / lanes);
    }
    v.lateral = Math.min(off, half - 0.5);
  }

  private buildOverlay(): THREE.Mesh | null {
    const mb = new MeshBuilder();
    this.paths.forEach((p, i) => {
      if (p.road.cls === 'path' || p.road.cls === 'service') return;
      const start = mb.positions.length / 3;
      const y = p.heights.map((h) => Math.max(h, 0) + 0.12);
      ribbon(mb.setColor('#2ecc71'), p.pts, y, Math.min(p.road.width * 0.35, 3.5));
      this.overlayRanges.push({ path: i, start, count: mb.positions.length / 3 - start });
    });
    if (mb.empty) return null;
    const m = new THREE.Mesh(
      mb.build(),
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }),
    );
    m.renderOrder = -4;
    m.visible = false;
    m.name = 'trafficOverlay';
    this.stats.segments = this.overlayRanges.filter((o) => this.paths[o.path].road.cls !== 'residential').length;
    return m;
  }

  setHour(hour: number) {

    this.walk = walkProfile(hour);
    for (let i = 0; i < this.paths.length; i++) {
      if (!this.peak[i]) continue;
      const load = roadLoad(this.paths[i].road.cls, hour, this.boost[i]);
      this.ratio[i] = Math.min(1, load.density / this.peak[i]);
      this.speedRatio[i] = load.speedRatio;
    }
    const byKind = Object.fromEntries(VEHICLE_KINDS.map((k) => [k, 0])) as Record<VehicleKind, number>;
    let visible = 0;
    for (const v of this.vehicles) if (v.threshold < this.ratio[v.path]) (visible++, byKind[v.kind]++);
    this.stats.vehicles = visible;
    this.stats.byKind = byKind;
    this.stats.people = this.people.filter((w) => w.threshold < this.walk * (1 - this.night * 0.6)).length;
    if (!this.overlay) return;
    const col = this.overlay.geometry.attributes.color as THREE.BufferAttribute;
    const c = new THREE.Color();
    let sum = 0, n = 0;
    for (const rg of this.overlayRanges) {
      const f = this.speedRatio[rg.path];
      if (this.paths[rg.path].road.cls !== 'residential') (sum += f, n++);
      c.set(loadColor(f));
      for (let i = rg.start; i < rg.start + rg.count; i++) col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
    this.stats.flow = n ? sum / n : 1;
  }

  setNight(night: number) {
    this.night = night;
    this.lights.visible = night > 0.3;
    if (this.overlay) (this.overlay.material as THREE.MeshBasicMaterial).color.setScalar(0.9 + night * 0.25);
  }

  setOverlayVisible(v: boolean) {
    if (this.overlay) this.overlay.visible = v;
  }

  update(dt: number) {
    const showLights = this.lights.visible;
    const t = this.tmp;
    const hide = () => {
      t.position.set(0, -1000, 0);
      t.scale.setScalar(0);
      t.updateMatrix();
    };
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      const mesh = this.bodies.get(v.kind)!;
      if (v.threshold >= this.ratio[v.path]) {
        hide();
        mesh.setMatrixAt(v.slot, t.matrix);
        if (showLights) (this.lights.setMatrixAt(i * 2, t.matrix), this.lights.setMatrixAt(i * 2 + 1, t.matrix));
        continue;
      }
      let p = this.paths[v.path];
      v.d += speedOf(v.kind, p.road.cls) * v.pace * this.speedRatio[v.path] * dt * v.dir;
      if (v.d > p.length || v.d < 0) {
        this.advance(v);
        p = this.paths[v.path];
      }
      pointAt(p, v.d, v.lateral * v.dir, this.pos, this.dir);
      if (v.dir < 0) this.dir.negate();
      if (this.pos.y < TUNNEL_COVERED) {
        // Inside a covered tunnel: not visible from above.
        hide();
        mesh.setMatrixAt(v.slot, t.matrix);
        if (showLights) (this.lights.setMatrixAt(i * 2, t.matrix), this.lights.setMatrixAt(i * 2 + 1, t.matrix));
        continue;
      }
      t.position.copy(this.pos).setY(this.pos.y + 0.05);
      t.rotation.set(0, Math.atan2(this.dir.x, this.dir.z), 0);
      t.scale.setScalar(1);
      t.updateMatrix();
      mesh.setMatrixAt(v.slot, t.matrix);
      if (showLights) {
        const l = LENGTH[v.kind];
        const fx = this.dir.x * (l / 2 + 0.05);
        const fz = this.dir.z * (l / 2 + 0.05);
        const w = v.kind === 'moto' || v.kind === 'bicycle' ? 0.25 : 1.6;
        const hy = v.kind === 'bus' || v.kind === 'truck' ? 0.9 : 0.6;
        t.scale.set(w, 0.22, 0.12);
        t.position.set(this.pos.x + fx, this.pos.y + hy, this.pos.z + fz);
        t.updateMatrix();
        this.lights.setMatrixAt(i * 2, t.matrix);
        t.position.set(this.pos.x - fx, this.pos.y + hy, this.pos.z - fz);
        t.updateMatrix();
        this.lights.setMatrixAt(i * 2 + 1, t.matrix);
      }
    }
    for (const m of this.bodies.values()) m.instanceMatrix.needsUpdate = true;
    if (showLights) this.lights.instanceMatrix.needsUpdate = true;
    this.updateWalkers(dt);
    this.updateTrains(dt);
  }

  private updateWalkers(dt: number) {
    if (!this.walkers) return;
    const t = this.tmp;
    const active = this.walk * (1 - this.night * 0.6);
    this.people.forEach((w, k) => {
      if (w.threshold >= active) {
        t.position.set(0, -1000, 0);
        t.scale.setScalar(0);
        t.updateMatrix();
        this.walkers!.setMatrixAt(k, t.matrix);
        return;
      }
      const p = this.paths[w.path];
      w.d += w.speed * dt * w.dir;
      if (w.d > p.length || w.d < 0) {
        w.dir = w.dir > 0 ? -1 : 1;
        w.d = Math.min(Math.max(w.d, 0), p.length);
      }
      pointAt(p, w.d, w.lateral, this.pos, this.dir);
      if (w.dir < 0) this.dir.negate();
      t.position.copy(this.pos);
      t.rotation.set(0, Math.atan2(this.dir.x, this.dir.z), 0);
      t.scale.setScalar(1);
      t.updateMatrix();
      this.walkers!.setMatrixAt(k, t.matrix);
    });
    this.walkers.instanceMatrix.needsUpdate = true;
  }

  /** At a junction, continue on a connected road, preferring busier (bigger) ones. */
  private advance(v: Vehicle) {
    const p = this.paths[v.path];
    const end = v.d > p.length ? p.pts[p.pts.length - 1] : p.pts[0];
    const options = (this.ends.get(endKey(end)) ?? []).filter((o) => {
      if (o.path === v.path) return false;
      const road = this.paths[o.path].road;
      if (road.cls === 'motorway' && (v.kind === 'bicycle' || v.kind === 'moto')) return false;
      return o.atStart || !road.oneway;
    });
    if (options.length) {
      const weights = options.map((o) => this.peak[o.path] * Math.max(1, this.paths[o.path].road.lanes) + 0.5);
      let x = this.r() * weights.reduce((a, b) => a + b, 0);
      let j = 0;
      while (j < options.length - 1 && x > weights[j]) x -= weights[j++];
      const o = options[j];
      const np = this.paths[o.path];
      v.path = o.path;
      v.dir = o.atStart ? 1 : -1;
      v.d = o.atStart ? 0.01 : np.length - 0.01;
      this.placeInLane(v);
    } else if (!p.road.oneway) {
      // Dead end: U-turn.
      v.dir = v.dir > 0 ? -1 : 1;
      v.d = Math.min(Math.max(v.d, 0.01), p.length - 0.01);
    } else {
      v.d = v.dir > 0 ? 0.01 : p.length - 0.01;
    }
  }

  private updateTrains(dt: number) {
    if (!this.trains) return;
    const t = this.tmp;
    this.trainState.forEach((s, ti) => {
      const rp = this.rails[s.path];
      // The train occupies [s.d - span, s.d] and shuttles between the line's ends.
      const span = 4 * 18.6;
      s.d += s.speed * dt * s.dir;
      if (s.d > rp.length) { s.d = rp.length; s.dir = -1; }
      if (s.d < span) { s.d = Math.min(span, rp.length); s.dir = 1; }
      for (let c = 0; c < 4; c++) {
        const d = s.d - 9.3 - c * 18.6;
        pointAt(rp, Math.min(Math.max(d, 0), rp.length), 0, this.pos, this.dir);
        t.position.copy(this.pos).setY(this.pos.y + 0.2);
        t.rotation.set(0, Math.atan2(this.dir.x, this.dir.z), 0);
        t.scale.setScalar(1);
        t.updateMatrix();
        this.trains!.setMatrixAt(ti * 4 + c, t.matrix);
      }
    });
    this.trains.instanceMatrix.needsUpdate = true;
  }

  get nightLevel() {
    return this.night;
  }
}

const endKey = (pt: XZ) => `${pt[0].toFixed(1)},${pt[1].toFixed(1)}`;
