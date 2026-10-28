import * as THREE from 'three';
import { rng } from '../data/rand';
import type { XZ } from './geometry';
import { toyDeckContains } from './toyGeometry';

/**
 * Procedural, deterministic street-level detail for Vietnamese archetypes (#5): balconies on
 * tube-house fronts, stair huts ("tum thang") and stainless water tanks on flat roofs.
 * Everything is instanced (a handful of draw calls) and hidden when the camera is far away.
 */
export class DetailCollector {
  private slabs: THREE.Matrix4[] = [];
  private rails: THREE.Matrix4[] = [];
  private railColors: THREE.Color[] = [];
  private huts: THREE.Matrix4[] = [];
  private hutColors: THREE.Color[] = [];
  private tanks: THREE.Matrix4[] = [];
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);

  private place(list: THREE.Matrix4[], x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number) {
    this.q.setFromAxisAngle(this.up, yaw);
    list.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(sx, sy, sz)));
  }

  /**
   * Balconies on every storey above the ground floor, centred on the front edge a→b
   * (wall outward normal = right of a→b, matching the wall winding). Toy houses pass `inset`, how far
   * their wall stands back from the edge, and `maxWidth`, the flat part of that wall between the bevels.
   */
  balconies(a: XZ, b: XZ, levels: number, floorH: number, seed: number, toy?: { inset: number; maxWidth: number }) {
    const r = rng(seed);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 2.5 || len > 9) return;
    const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
    const nx = -tz, nz = tx; // outward
    const yaw = Math.atan2(-tz, tx); // local x along the edge, local z outward
    const w = Math.min(len * (0.6 + r() * 0.25), toy?.maxWidth ?? Infinity);
    if (w < 0.6) return;
    const depth = 0.9 + r() * 0.4;
    const back = toy?.inset ?? 0;
    const mx = (a[0] + b[0]) / 2 - nx * back, mz = (a[1] + b[1]) / 2 - nz * back;
    // Light warm toy railings: cream, peach or sand.
    const railColor = new THREE.Color(r() < 0.5 ? '#f6efe3' : r() < 0.5 ? '#f3c9b5' : '#ecd2b4');
    for (let f = 1; f < Math.floor(levels); f++) {
      if (r() < 0.12) continue; // some storeys enclosed
      const y = f * floorH;
      this.place(this.slabs, mx + nx * depth * 0.5, y, mz + nz * depth * 0.5, yaw, w, 0.16, depth);
      this.place(this.rails, mx + nx * depth, y + 0.5, mz + nz * depth, yaw, w, 1.0, 0.06);
      this.railColors.push(railColor);
    }
  }

  /**
   * Stair hut + water tank on a flat roof; `back` is a point towards the rear of the plot. Toy prototypes pass
   * `deck`, their roof's usable area (toyRoofDeck of the shrunk box, long axis `axis`): a cube is pulled in
   * from the rear towards the middle and then scaled down until it lies inside it, or dropped.
   */
  rooftop(centre: XZ, back: XZ, axisYaw: number, roofY: number, facade: THREE.Color, seed: number, deck?: { axis: XZ; hx: number; hz: number; r: number }) {
    const r = rng(seed ^ 0x5bd1e995);
    const bx = back[0] - centre[0], bz = back[1] - centre[1];
    // Position and scale of a box of half-sizes (ax along the long axis, az across) wanted at `frac` of the way to the rear.
    const fit = (frac: number, ax: number, az: number): { x: number; z: number; s: number } | null => {
      if (!deck) return { x: centre[0] + bx * frac, z: centre[1] + bz * frac, s: 1 };
      for (const s of [1, 0.85, 0.7, 0.55]) {
        for (const t of [1, 0.5, 0]) {
          const u = bx * frac * t, v = bz * frac * t; // world offset from the centre
          const along = u * deck.axis[0] + v * deck.axis[1], across = -u * deck.axis[1] + v * deck.axis[0];
          // The deck's x is the short side (across), z the long side (along).
          if (toyDeckContains({ hx: deck.hx, hz: deck.hz, r: deck.r }, across, along, az * s, ax * s)) return { x: centre[0] + u, z: centre[1] + v, s };
        }
      }
      return null;
    };
    if (r() < 0.75) {
      const p = fit(0.45, 1.3, 1.4);
      if (p) {
        this.place(this.huts, p.x, roofY, p.z, axisYaw, 2.6 * p.s, 2.7 * p.s, 2.8 * p.s);
        this.hutColors.push(facade.clone().multiplyScalar(0.92));
        if (r() < 0.85) {
          const ts = Math.min(1, (2.6 * p.s) / 1.7);
          this.place(this.tanks, p.x, roofY + 2.7 * p.s + 0.55 * ts, p.z, axisYaw, ts, ts, ts);
        }
      }
    } else if (r() < 0.8) {
      const p = fit(0.3, 0.85, 0.55);
      if (p) this.place(this.tanks, p.x, roofY + 0.55 * p.s, p.z, axisYaw, p.s, p.s, p.s);
    }
  }

  get count() {
    return this.slabs.length + this.rails.length + this.huts.length + this.tanks.length;
  }

  build(): THREE.Group {
    const g = new THREE.Group();
    g.name = 'details';
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const add = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[], colors?: THREE.Color[]) => {
      if (!list.length) return;
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((mm, i) => inst.setMatrixAt(i, mm));
      colors?.forEach((c, i) => inst.setColorAt(i, c));
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.name = name;
      g.add(inst);
    };
    add('detail-balconies', box, new THREE.MeshLambertMaterial({ color: '#f4ead6' }), this.slabs);
    add('detail-railings', box.clone(), new THREE.MeshLambertMaterial(), this.rails, this.railColors);
    add('detail-huts', box.clone(), new THREE.MeshLambertMaterial(), this.huts, this.hutColors);
    // Horizontal stainless tank (bồn nước inox), matte toy grey-white: metal looks dark without an env map.
    const tank = new THREE.CylinderGeometry(0.55, 0.55, 1.7, 10).rotateZ(Math.PI / 2);
    add('detail-tanks', tank, new THREE.MeshLambertMaterial({ color: '#e9edf0' }), this.tanks);
    return g;
  }
}

