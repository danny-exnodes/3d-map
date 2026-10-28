import * as THREE from 'three';
import { rng } from '../data/rand';
import type { XZ } from './geometry';

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

  /** Stair hut + water tank on a flat roof; `back` is a point towards the rear of the plot. */
  rooftop(centre: XZ, back: XZ, axisYaw: number, roofY: number, facade: THREE.Color, seed: number) {
    const r = rng(seed ^ 0x5bd1e995);
    const bx = back[0] - centre[0], bz = back[1] - centre[1];
    if (r() < 0.75) {
      const hx = centre[0] + bx * 0.45, hz = centre[1] + bz * 0.45;
      this.place(this.huts, hx, roofY, hz, axisYaw, 2.6, 2.7, 2.8);
      this.hutColors.push(facade.clone().multiplyScalar(0.92));
      if (r() < 0.85) this.place(this.tanks, hx, roofY + 2.7 + 0.55, hz, axisYaw, 1, 1, 1);
    } else if (r() < 0.8) {
      this.place(this.tanks, centre[0] + bx * 0.3, roofY + 0.55, centre[1] + bz * 0.3, axisYaw, 1, 1, 1);
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

