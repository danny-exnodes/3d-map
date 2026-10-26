import * as THREE from 'three';
import { createBuildingMaterial } from './buildings';

/**
 * Plain-data description of the meshes built in the worker. Typed arrays are transferred,
 * not copied. Materials are described by kind + parameters because functions
 * (onBeforeCompile) cannot cross the worker boundary.
 */
export interface MaterialDesc {
  kind: 'lambert' | 'standard' | 'basic' | 'buildings';
  color: [number, number, number];
  params: Record<string, number | boolean>;
  userData: Record<string, number>;
}

export interface ObjectDesc {
  type: 'mesh' | 'instanced';
  name: string;
  attributes: Record<string, { array: Float32Array | Uint16Array | Uint32Array; itemSize: number }>;
  index?: Uint16Array | Uint32Array;
  groups: { start: number; count: number; materialIndex: number }[];
  materials: MaterialDesc[];
  renderOrder: number;
  castShadow: boolean;
  receiveShadow: boolean;
  visible: boolean;
  matrix: number[];
  count?: number;
  instanceMatrix?: Float32Array;
  instanceColor?: Float32Array;
}

const PARAM_KEYS = [
  'vertexColors', 'depthWrite', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'flatShading',
  'roughness', 'metalness', 'toneMapped', 'transparent', 'opacity', 'side',
] as const;

function describeMaterial(m: THREE.Material): MaterialDesc {
  const kind: MaterialDesc['kind'] = m.userData.isBuildingMaterial
    ? 'buildings'
    : (m as THREE.MeshStandardMaterial).isMeshStandardMaterial
      ? 'standard'
      : (m as THREE.MeshBasicMaterial).isMeshBasicMaterial
        ? 'basic'
        : 'lambert';
  const params: Record<string, number | boolean> = {};
  for (const k of PARAM_KEYS) {
    const v = (m as unknown as Record<string, unknown>)[k];
    if (typeof v === 'number' || typeof v === 'boolean') params[k] = v;
  }
  const userData: Record<string, number> = {};
  for (const [k, v] of Object.entries(m.userData)) if (typeof v === 'number') userData[k] = v;
  const c = (m as THREE.MeshLambertMaterial).color;
  return { kind, color: c ? [c.r, c.g, c.b] : [1, 1, 1], params, userData };
}

/** Flattens a built group into transferable descriptions (world matrices baked per object). */
export function serializeObject(root: THREE.Object3D): { objects: ObjectDesc[]; transfer: ArrayBuffer[] } {
  const objects: ObjectDesc[] = [];
  const transfer: ArrayBuffer[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const attributes: ObjectDesc['attributes'] = {};
    for (const [name, attr] of Object.entries(g.attributes)) {
      const a = attr as THREE.BufferAttribute;
      attributes[name] = { array: a.array as Float32Array, itemSize: a.itemSize };
      transfer.push(a.array.buffer as ArrayBuffer);
    }
    const desc: ObjectDesc = {
      type: (o as THREE.InstancedMesh).isInstancedMesh ? 'instanced' : 'mesh',
      name: o.name,
      attributes,
      index: g.index ? (g.index.array as Uint16Array | Uint32Array) : undefined,
      groups: g.groups.map((x) => ({ start: x.start, count: x.count, materialIndex: x.materialIndex ?? 0 })),
      materials: (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(describeMaterial),
      renderOrder: o.renderOrder,
      castShadow: o.castShadow,
      receiveShadow: o.receiveShadow,
      visible: o.visible,
      matrix: o.matrixWorld.toArray(),
    };
    if (g.index) transfer.push(g.index.array.buffer as ArrayBuffer);
    const inst = o as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      desc.count = inst.count;
      desc.instanceMatrix = inst.instanceMatrix.array as Float32Array;
      transfer.push(desc.instanceMatrix.buffer as ArrayBuffer);
      if (inst.instanceColor) {
        desc.instanceColor = inst.instanceColor.array as Float32Array;
        transfer.push(desc.instanceColor.buffer as ArrayBuffer);
      }
    }
    objects.push(desc);
  });
  // Shared geometries (e.g. trunks/crowns reuse nothing today) would list a buffer twice; dedupe.
  return { objects, transfer: [...new Set(transfer)] };
}

function createMaterial(d: MaterialDesc): THREE.Material {
  const m =
    d.kind === 'buildings'
      ? createBuildingMaterial()
      : d.kind === 'standard'
        ? new THREE.MeshStandardMaterial()
        : d.kind === 'basic'
          ? new THREE.MeshBasicMaterial()
          : new THREE.MeshLambertMaterial();
  m.setValues(d.params as THREE.MaterialParameters);
  (m as THREE.MeshLambertMaterial).color?.setRGB(d.color[0], d.color[1], d.color[2]);
  Object.assign(m.userData, d.userData);
  return m;
}

export function deserializeObjects(objects: ObjectDesc[]): THREE.Group {
  const group = new THREE.Group();
  for (const d of objects) {
    const g = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(d.attributes)) g.setAttribute(name, new THREE.BufferAttribute(a.array, a.itemSize));
    if (d.index) g.setIndex(new THREE.BufferAttribute(d.index, 1));
    for (const gr of d.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    g.computeBoundingSphere();
    const mats = d.materials.map(createMaterial);
    const material = mats.length === 1 ? mats[0] : mats;
    let obj: THREE.Mesh;
    if (d.type === 'instanced') {
      const inst = new THREE.InstancedMesh(g, material, d.count ?? 0);
      inst.instanceMatrix = new THREE.InstancedBufferAttribute(d.instanceMatrix!, 16);
      if (d.instanceColor) inst.instanceColor = new THREE.InstancedBufferAttribute(d.instanceColor, 3);
      inst.computeBoundingSphere();
      obj = inst;
    } else {
      obj = new THREE.Mesh(g, material);
    }
    obj.name = d.name;
    obj.renderOrder = d.renderOrder;
    obj.castShadow = d.castShadow;
    obj.receiveShadow = d.receiveShadow;
    obj.visible = d.visible;
    obj.matrixAutoUpdate = false;
    obj.matrix.fromArray(d.matrix);
    group.add(obj);
  }
  return group;
}
