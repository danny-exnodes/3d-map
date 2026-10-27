import * as THREE from 'three';
import type { XZ } from './geometry';
import { toyDepthMaterial, toyFlatRoofUnit, toyPitchedRoofUnit, toyWallsUnit } from './toyGeometry';

/**
 * Prototype instancing for ordinary buildings (#22). Most houses in a Vietnamese city are boxes
 * with a flat, gabled or hipped roof, so they share four unit meshes (walls, flat slab, gable,
 * hip) and each house is only a transform plus colour, seed and id. The units are rounded toy
 * shapes whose vertices the shader places for each house's real size, so bevels never stretch
 * (toyGeometry.ts, #32). Windows are generated from world position in the shader, so they keep
 * their real size too.
 */
export type ProtoRoof = 'flat' | 'gabled' | 'hipped';

export interface ProtoInstance {
  centre: XZ;
  /** Heading of the long side (radians, from +z towards +x). */
  angle: number;
  /** Short side, long side (m). */
  w: number;
  l: number;
  /** Wall top (m). */
  height: number;
  roof: ProtoRoof;
  rise: number;
  facade: THREE.Color;
  roofColor: THREE.Color;
  seed: number;
  bid: number;
}

export class PrototypeCollector {
  private items: ProtoInstance[] = [];

  add(i: ProtoInstance) {
    this.items.push(i);
  }

  get count() {
    return this.items.length;
  }

  /** One InstancedMesh per prototype that has instances; `material` must be a toy building material. */
  build(material: THREE.Material): THREE.InstancedMesh[] {
    const groups: { name: string; geo: () => THREE.BufferGeometry; list: ProtoInstance[]; roof: boolean; m: (i: ProtoInstance) => THREE.Matrix4 }[] = [];
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const mat = (i: ProtoInstance, y: number, sx: number, sy: number, sz: number) =>
      new THREE.Matrix4().compose(new THREE.Vector3(i.centre[0], y, i.centre[1]), q.setFromAxisAngle(up, i.angle), new THREE.Vector3(sx, sy, sz));
    // Everything stays inside the footprint; the roofs' eaves and slab are part of the toy units.
    groups.push({ name: 'buildings-walls', geo: toyWallsUnit, list: this.items, roof: false, m: (i) => mat(i, 0, i.w, i.height, i.l) });
    groups.push({ name: 'buildings-roof-flat', geo: toyFlatRoofUnit, list: this.items.filter((i) => i.roof === 'flat'), roof: true, m: (i) => mat(i, i.height, i.w, 1, i.l) });
    for (const roof of ['gabled', 'hipped'] as const) {
      groups.push({
        name: `buildings-roof-${roof}`,
        geo: () => toyPitchedRoofUnit(roof === 'hipped'),
        list: this.items.filter((i) => i.roof === roof),
        roof: true,
        m: (i) => mat(i, i.height, i.w, i.rise, i.l),
      });
    }
    const out: THREE.InstancedMesh[] = [];
    for (const g of groups) {
      if (!g.list.length) continue;
      const geo = g.geo();
      geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(g.list.map((i) => i.seed)), 1));
      geo.setAttribute('aBid', new THREE.InstancedBufferAttribute(new Float32Array(g.list.map((i) => i.bid)), 1));
      const mesh = new THREE.InstancedMesh(geo, material, g.list.length);
      mesh.customDepthMaterial = toyDepthMaterial();
      g.list.forEach((it, k) => {
        mesh.setMatrixAt(k, g.m(it));
        mesh.setColorAt(k, g.roof ? it.roofColor : it.facade);
      });
      mesh.computeBoundingSphere();
      // The walls already cast the full-height box; a flat slab would only add its 0.3 m overhang to the shadow map.
      mesh.castShadow = g.name !== 'buildings-roof-flat';
      mesh.receiveShadow = true;
      mesh.name = g.name;
      out.push(mesh);
    }
    return out;
  }
}
