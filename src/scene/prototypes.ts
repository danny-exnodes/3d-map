import * as THREE from 'three';
import { MeshBuilder, type XZ } from './geometry';
import { pitched } from './roofs';

/**
 * Prototype instancing for ordinary buildings (#22). Most houses in a Vietnamese city are boxes
 * with a flat, gabled or hipped roof, so they share four unit meshes (walls, flat cap, gable,
 * hip) and each house is only a transform plus colour, seed and id. Windows are generated from
 * world position in the shader, so they keep their real size however a prototype is scaled;
 * normals come from screen-space derivatives (flat shading), so non-uniform scaling is safe.
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

/** Unit walls: x, z in [-0.5, 0.5], y in [0, 1]. */
function unitWalls(): THREE.BufferGeometry {
  const mb = new MeshBuilder().setColor('#ffffff');
  const c: XZ[] = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = c[i];
    const [bx, bz] = c[(i + 1) % 4];
    // Outward faces: counter-clockwise seen from outside.
    mb.quad({ x: bx, y: 0, z: bz }, { x: ax, y: 0, z: az }, { x: ax, y: 1, z: az }, { x: bx, y: 1, z: bz });
  }
  return mb.build();
}

function unitCap(): THREE.BufferGeometry {
  const mb = new MeshBuilder().setColor('#ffffff');
  mb.quad({ x: -0.5, y: 1, z: 0.5 }, { x: 0.5, y: 1, z: 0.5 }, { x: 0.5, y: 1, z: -0.5 }, { x: -0.5, y: 1, z: -0.5 });
  return mb.build();
}

/** Unit pitched roof on a 1 × 2 base (ridge along z, so it can be scaled to any proportions), rise 1. */
function unitPitched(hipped: boolean): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  const white = new THREE.Color('#ffffff');
  // Gable ends slightly darker than the slopes, like the shaded wall triangles of real houses.
  pitched(mb, [[-0.5, -1], [-0.5, 1], [0.5, 1], [0.5, -1]], 0, 1, hipped, white, new THREE.Color(0.86, 0.86, 0.86));
  return mb.build();
}

export class PrototypeCollector {
  private items: ProtoInstance[] = [];

  add(i: ProtoInstance) {
    this.items.push(i);
  }

  get count() {
    return this.items.length;
  }

  /** One InstancedMesh per prototype that has instances. */
  build(material: THREE.Material): THREE.InstancedMesh[] {
    const groups: { name: string; geo: () => THREE.BufferGeometry; list: ProtoInstance[]; roof: boolean; m: (i: ProtoInstance) => THREE.Matrix4 }[] = [];
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const mat = (i: ProtoInstance, y: number, sx: number, sy: number, sz: number) =>
      new THREE.Matrix4().compose(new THREE.Vector3(i.centre[0], y, i.centre[1]), q.setFromAxisAngle(up, i.angle), new THREE.Vector3(sx, sy, sz));
    // Eaves stick out 0.35 m, as in the exact roofs.
    groups.push({ name: 'buildings-walls', geo: unitWalls, list: this.items, roof: false, m: (i) => mat(i, 0, i.w, i.height, i.l) });
    groups.push({ name: 'buildings-roof-flat', geo: unitCap, list: this.items.filter((i) => i.roof === 'flat'), roof: true, m: (i) => mat(i, 0, i.w, i.height, i.l) });
    for (const roof of ['gabled', 'hipped'] as const) {
      groups.push({
        name: `buildings-roof-${roof}`,
        geo: () => unitPitched(roof === 'hipped'),
        list: this.items.filter((i) => i.roof === roof),
        roof: true,
        m: (i) => mat(i, i.height, i.w + 0.7, i.rise, (i.l + 0.7) / 2),
      });
    }
    const out: THREE.InstancedMesh[] = [];
    for (const g of groups) {
      if (!g.list.length) continue;
      const geo = g.geo();
      geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(g.list.map((i) => i.seed)), 1));
      geo.setAttribute('aBid', new THREE.InstancedBufferAttribute(new Float32Array(g.list.map((i) => i.bid)), 1));
      const mesh = new THREE.InstancedMesh(geo, material, g.list.length);
      g.list.forEach((it, k) => {
        mesh.setMatrixAt(k, g.m(it));
        mesh.setColorAt(k, g.roof ? it.roofColor : it.facade);
      });
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = g.name;
      out.push(mesh);
    }
    return out;
  }
}
