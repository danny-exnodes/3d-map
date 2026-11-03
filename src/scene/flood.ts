import * as THREE from 'three';
import type { FloodPoint } from '../data/flood';
import type { LocalProjection } from '../geo/projection';

const MAX_DISCS = 64;

/**
 * Water look on the plain disc material: the edge fades out instead of ending in a hard circle, and slow
 * ripples drift across in world space so neighbouring discs move as one surface. `uTime` is in seconds.
 */
function waterDisc(mat: THREE.MeshBasicMaterial, uTime: { value: number }) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDisc;\nvarying vec2 vWater;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vDisc = position.xz;
        vec4 waterPos = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          waterPos = instanceMatrix * waterPos;
        #endif
        vWater = (modelMatrix * waterPos).xz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec2 vDisc;\nvarying vec2 vWater;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Unit disc: full water inside half the radius, fading to nothing at the rim.
        float edge = 1.0 - smoothstep(0.5, 1.0, length(vDisc));
        vec2 w = vWater;
        float ripple = sin(w.x * 0.35 + uTime * 0.8) * sin(w.y * 0.3 - uTime * 0.6)
          + 0.5 * sin((w.x - w.y) * 0.8 + uTime * 1.4);
        diffuseColor.rgb += vec3(0.08, 0.12, 0.16) * smoothstep(0.5, 1.4, ripple);
        diffuseColor.a *= edge * (0.88 + 0.12 * ripple);`,
      );
  };
}

/**
 * Flood points on the ground: one instanced mesh of flat translucent discs, each with a name label.
 * Discs are clipped at the model's edges (a TP.HCM zone can be 900 m wide), which needs the renderer's
 * `localClippingEnabled`. Names come from a remote feed, so they only ever reach the DOM through `textContent`.
 */
export class FloodLayer {
  readonly group = new THREE.Group();
  readonly mesh: THREE.InstancedMesh;
  private drawn: { p: FloodPoint; pos: THREE.Vector3 }[] = [];
  private labels: HTMLElement[] = [];
  private readonly layer?: HTMLElement;
  private readonly v = new THREE.Vector3();
  private readonly uTime = { value: 0 };

  constructor(
    private readonly proj: LocalProjection,
    private readonly halfW: number,
    private readonly halfD: number,
    opts: { labelLayer?: HTMLElement } = {},
  ) {
    const geo = new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2);
    const clippingPlanes = [
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), halfW),
      new THREE.Plane(new THREE.Vector3(1, 0, 0), halfW),
      new THREE.Plane(new THREE.Vector3(0, 0, -1), halfD),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), halfD),
    ];
    const mat = new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false, clippingPlanes });
    waterDisc(mat, this.uTime);
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
      if (Math.abs(x) > this.halfW || Math.abs(z) > this.halfD) continue;
      const pos = new THREE.Vector3(x, 0.3, z);
      const r = Math.max(p.radiusM, 1);
      this.mesh.setMatrixAt(this.drawn.length, m.makeScale(r, 1, r).setPosition(pos));
      this.drawn.push({ p, pos });
    }
    this.mesh.count = this.drawn.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  get count(): number {
    return this.drawn.length;
  }

  /** Called every frame: moves the ripples, then places the labels. */
  updateLabels(camera: THREE.Camera) {
    this.uTime.value = performance.now() / 1000;
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
