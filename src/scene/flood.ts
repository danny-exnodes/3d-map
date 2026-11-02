import * as THREE from 'three';
import type { FloodPoint } from '../data/flood';
import type { LocalProjection } from '../geo/projection';

const MAX_DISCS = 64;

/**
 * Flood points on the ground: one instanced mesh of flat translucent discs, each with a name label.
 * Names come from a remote feed, so they only ever reach the DOM through `textContent`.
 */
export class FloodLayer {
  readonly group = new THREE.Group();
  readonly mesh: THREE.InstancedMesh;
  private drawn: { p: FloodPoint; pos: THREE.Vector3 }[] = [];
  private labels: HTMLElement[] = [];
  private readonly layer?: HTMLElement;
  private readonly v = new THREE.Vector3();

  constructor(
    private readonly proj: LocalProjection,
    private readonly half: number,
    opts: { labelLayer?: HTMLElement } = {},
  ) {
    const geo = new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_DISCS);
    this.mesh.name = 'flood';
    this.mesh.count = 0;
    this.mesh.renderOrder = -3;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.layer = opts.labelLayer;
  }

  /** Draws the flooded points (level ≥ 1) whose centre lies inside the model, at most 64. */
  setPoints(points: FloodPoint[]) {
    this.drawn = [];
    const m = new THREE.Matrix4();
    for (const p of points) {
      if (this.drawn.length >= MAX_DISCS) break;
      if (p.level < 1) continue;
      const [x, z] = this.proj.project([p.lon, p.lat]);
      if (Math.abs(x) > this.half || Math.abs(z) > this.half) continue;
      const pos = new THREE.Vector3(x, 0.3, z);
      const r = Math.min(Math.max(p.radiusM, 1), this.half);
      this.mesh.setMatrixAt(this.drawn.length, m.makeScale(r, 1, r).setPosition(pos));
      this.drawn.push({ p, pos });
    }
    this.mesh.count = this.drawn.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  get count(): number {
    return this.drawn.length;
  }

  updateLabels(camera: THREE.Camera) {
    const layer = this.layer;
    if (!layer) return;
    while (this.labels.length < this.drawn.length) {
      const el = document.createElement('div');
      el.className = 'poi-label flood-label';
      layer.appendChild(el);
      this.labels.push(el);
    }
    const w = layer.clientWidth;
    const h = layer.clientHeight;
    this.labels.forEach((el, i) => {
      const hit = this.drawn[i];
      if (!hit) return void (el.style.display = 'none');
      this.v.copy(hit.pos).project(camera);
      const visible = this.v.z < 1 && Math.abs(this.v.x) < 1.05 && Math.abs(this.v.y) < 1.05;
      el.style.display = visible ? '' : 'none';
      if (el.textContent !== hit.p.name) el.textContent = hit.p.name;
      if (visible) el.style.transform = `translate(${((this.v.x + 1) / 2) * w}px, ${((1 - this.v.y) / 2) * h}px) translate(-50%, -100%)`;
    });
  }

  dispose() {
    for (const el of this.labels) el.remove();
    this.labels = [];
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
