import * as THREE from 'three';
import { hashString, rng } from '../data/rand';
import type { RoadClass } from '../data/types';
import { MeshBuilder, ribbon } from './geometry';
import { pointAt, type RailPath, type RoadPath, TUNNEL_COVERED } from './roads';

const BASE_SPEED: Record<RoadClass, number> = {
  motorway: 17, primary: 11, secondary: 10, tertiary: 8.5, residential: 6, service: 4, path: 0,
};

type VehicleKind = 'car' | 'bike' | 'bus';
interface Vehicle {
  path: number;
  d: number;
  dir: 1 | -1;
  lane: number;
  speed: number;
  kind: VehicleKind;
  /** Activation threshold in [0,1): shown when density > threshold. */
  threshold: number;
}

const SIZE: Record<VehicleKind, [number, number, number]> = {
  bike: [0.7, 1.3, 1.9],
  car: [1.8, 1.45, 4.2],
  bus: [2.5, 3.1, 11],
};

/** 0..1 congestion factor (1 = free flow) for a road at a given hour. */
export function flowFactor(roadId: string, hour: number): number {
  const rush = Math.exp(-((hour - 8) ** 2) / 1.5) + Math.exp(-((hour - 17.5) ** 2) / 2);
  const night = hour < 5 || hour > 23 ? 0.1 : 0;
  const local = (hashString(roadId) % 1000) / 1000;
  return Math.min(1, Math.max(0.1, 1 - rush * (0.25 + local * 0.6) + night));
}

/** How busy the streets are (0..1) at a given hour. */
export function densityAt(hour: number): number {
  const day = Math.exp(-((hour - 8) ** 2) / 3) * 0.9 + Math.exp(-((hour - 18) ** 2) / 4) + 0.55 * Math.exp(-((hour - 13) ** 2) / 10);
  return Math.min(1, 0.12 + day);
}

export class Traffic {
  readonly group = new THREE.Group();
  readonly bodies: THREE.InstancedMesh;
  readonly lights: THREE.InstancedMesh;
  readonly trains: THREE.InstancedMesh | null = null;
  readonly overlay: THREE.Mesh | null = null;
  private vehicles: Vehicle[] = [];
  private ends = new Map<string, { path: number; atStart: boolean }[]>();
  private trainState: { path: number; d: number; dir: 1 | -1; speed: number }[] = [];
  private overlayRanges: { road: string; start: number; count: number }[] = [];
  private hour = 12;
  private night = 0;
  private r = rng(99);
  private tmp = new THREE.Object3D();
  private pos = new THREE.Vector3();
  private dir = new THREE.Vector3();
  stats = { vehicles: 0, segments: 0, flow: 1 };

  constructor(private readonly paths: RoadPath[], private readonly rails: RailPath[], maxVehicles = 900) {
    this.group.name = 'traffic';
    const drivable = paths.map((p, i) => ({ p, i })).filter(({ p }) => BASE_SPEED[p.road.cls] > 0 && p.length > 8);
    for (const { p, i } of drivable) {
      for (const [pt, atStart] of [[p.pts[0], true], [p.pts[p.pts.length - 1], false]] as const) {
        const k = `${pt[0].toFixed(1)},${pt[1].toFixed(1)}`;
        let l = this.ends.get(k);
        if (!l) this.ends.set(k, (l = []));
        l.push({ path: i, atStart });
      }
    }

    // Spawn proportional to lane-km.
    const weights = drivable.map(({ p }) => p.length * p.road.lanes * (p.road.cls === 'service' ? 0.2 : p.road.cls === 'residential' ? 0.5 : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    const n = Math.min(maxVehicles, Math.round(total / 28));
    const r = this.r;
    for (let k = 0; k < n && drivable.length; k++) {
      let x = r() * total;
      let j = 0;
      while (j < weights.length - 1 && x > weights[j]) x -= weights[j++];
      const { p, i } = drivable[j];
      const roll = r();
      const kind: VehicleKind = roll < 0.45 ? 'bike' : roll < 0.93 || p.road.cls === 'residential' ? 'car' : 'bus';
      const dir: 1 | -1 = p.road.oneway || r() < 0.5 ? 1 : -1;
      this.vehicles.push({
        path: i,
        d: r() * p.length,
        dir,
        lane: Math.floor(r() * Math.max(1, p.road.oneway ? p.road.lanes : p.road.lanes / 2)),
        speed: BASE_SPEED[p.road.cls] * (kind === 'bus' ? 0.75 : 0.8 + r() * 0.4),
        kind,
        threshold: r(),
      });
    }

    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.bodies = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial(), Math.max(1, this.vehicles.length));
    // Shadow maps are rendered on demand, so moving vehicles must not cast shadows.
    this.bodies.castShadow = false;
    this.bodies.name = 'vehicles';
    const palette = ['#e8e8e8', '#2b2d33', '#c0392b', '#2e86de', '#f1c40f', '#7f8c8d', '#d35400', '#ffffff'];
    const busColors = ['#27ae60', '#2e86de', '#16a085'];
    this.vehicles.forEach((v, i) => {
      const c = v.kind === 'bus' ? busColors[i % busColors.length] : palette[Math.floor(r() * palette.length)];
      this.bodies.setColorAt(i, new THREE.Color(c));
    });
    this.bodies.count = this.vehicles.length;

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
    this.lights.name = 'vehicleLights';
    this.group.add(this.bodies, this.lights);

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

  private buildOverlay(): THREE.Mesh | null {
    const mb = new MeshBuilder();
    for (const p of this.paths) {
      if (p.road.cls === 'path' || p.road.cls === 'service' || p.road.cls === 'residential') continue;
      const start = mb.positions.length / 3;
      const y = p.heights.map((h) => h + 0.12);
      ribbon(mb.setColor('#2ecc71'), p.pts, y, Math.min(p.road.width * 0.35, 3.5));
      this.overlayRanges.push({ road: p.road.id, start, count: mb.positions.length / 3 - start });
    }
    if (mb.empty) return null;
    const m = new THREE.Mesh(
      mb.build(),
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }),
    );
    m.renderOrder = -4;
    m.visible = false;
    m.name = 'trafficOverlay';
    this.stats.segments = this.overlayRanges.length;
    return m;
  }

  setHour(hour: number) {
    this.hour = hour;
    const density = densityAt(hour);
    let visible = 0;
    for (const v of this.vehicles) if (v.threshold < density) visible++;
    this.stats.vehicles = visible;
    if (!this.overlay) return;
    const col = this.overlay.geometry.attributes.color as THREE.BufferAttribute;
    const c = new THREE.Color();
    let sum = 0;
    for (const rg of this.overlayRanges) {
      const f = flowFactor(rg.road, hour);
      sum += f;
      c.set(f > 0.75 ? '#2ecc71' : f > 0.5 ? '#f1c40f' : f > 0.3 ? '#e67e22' : '#e74c3c');
      for (let i = rg.start; i < rg.start + rg.count; i++) col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
    this.stats.flow = this.overlayRanges.length ? sum / this.overlayRanges.length : 1;
  }

  setNight(night: number) {
    this.night = night;
    this.lights.visible = night > 0.3;
    if (this.overlay) {
      const mat = this.overlay.material as THREE.MeshBasicMaterial;
      mat.color.setScalar(0.9 + night * 0.25);
    }
  }

  setOverlayVisible(v: boolean) {
    if (this.overlay) this.overlay.visible = v;
  }

  update(dt: number) {
    const density = densityAt(this.hour);
    const showLights = this.lights.visible;
    const t = this.tmp;
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      if (v.threshold >= density) {
        t.scale.setScalar(0);
        t.updateMatrix();
        this.bodies.setMatrixAt(i, t.matrix);
        if (showLights) {
          this.lights.setMatrixAt(i * 2, t.matrix);
          this.lights.setMatrixAt(i * 2 + 1, t.matrix);
        }
        continue;
      }
      let p = this.paths[v.path];
      const flow = flowFactor(p.road.id, this.hour);
      v.d += v.speed * flow * dt * v.dir;
      if (v.d > p.length || v.d < 0) {
        this.advance(v);
        p = this.paths[v.path];
      }
      const laneW = 3.1;
      const lanes = p.road.oneway ? p.road.lanes : Math.max(1, p.road.lanes / 2);
      const offFromCentre = p.road.oneway ? -(p.road.width / 2) + (v.lane + 0.5) * laneW : (v.lane + 0.5) * laneW;
      const lateral = Math.min(offFromCentre, p.road.width / 2 - 0.6) * (lanes > 0 ? 1 : 0);
      pointAt(p, v.d, lateral * v.dir, this.pos, this.dir);
      if (v.dir < 0) this.dir.negate();
      if (this.pos.y < TUNNEL_COVERED) {
        // Inside a covered tunnel: not visible from above.
        t.scale.setScalar(0);
        t.updateMatrix();
        this.bodies.setMatrixAt(i, t.matrix);
        if (showLights) {
          this.lights.setMatrixAt(i * 2, t.matrix);
          this.lights.setMatrixAt(i * 2 + 1, t.matrix);
        }
        continue;
      }
      const [w, h, l] = SIZE[v.kind];
      t.position.copy(this.pos).setY(this.pos.y + 0.05);
      t.rotation.set(0, Math.atan2(this.dir.x, this.dir.z), 0);
      t.scale.set(w, h, l);
      t.updateMatrix();
      this.bodies.setMatrixAt(i, t.matrix);
      if (showLights) {
        const fx = this.dir.x * (l / 2 + 0.05);
        const fz = this.dir.z * (l / 2 + 0.05);
        t.scale.set(w * 0.9, 0.25, 0.12);
        t.position.set(this.pos.x + fx, this.pos.y + h * 0.45, this.pos.z + fz);
        t.updateMatrix();
        this.lights.setMatrixAt(i * 2, t.matrix);
        t.position.set(this.pos.x - fx, this.pos.y + h * 0.5, this.pos.z - fz);
        t.updateMatrix();
        this.lights.setMatrixAt(i * 2 + 1, t.matrix);
      }
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    if (showLights) this.lights.instanceMatrix.needsUpdate = true;
    this.updateTrains(dt);
  }

  private advance(v: Vehicle) {
    const p = this.paths[v.path];
    const end = v.d > p.length ? p.pts[p.pts.length - 1] : p.pts[0];
    const k = `${end[0].toFixed(1)},${end[1].toFixed(1)}`;
    const options = (this.ends.get(k) ?? []).filter((o) => {
      if (o.path === v.path) return false;
      const road = this.paths[o.path].road;
      return o.atStart || !road.oneway;
    });
    if (options.length) {
      const o = options[Math.floor(this.r() * options.length)];
      const np = this.paths[o.path];
      v.path = o.path;
      v.dir = o.atStart ? 1 : -1;
      v.d = o.atStart ? 0.01 : np.length - 0.01;
      const lanes = Math.max(1, np.road.oneway ? np.road.lanes : np.road.lanes / 2);
      v.lane = Math.min(v.lane, Math.floor(lanes) - 1);
      v.speed = BASE_SPEED[np.road.cls] * (v.kind === 'bus' ? 0.75 : 0.8 + this.r() * 0.4);
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
