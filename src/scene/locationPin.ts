import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Animated "you are here" pin for the 3D view (v0.0.5): a bobbing map pin over a pulsing ring
 * on the ground. Drawn on top of everything (no depth test) so it stays visible behind houses,
 * and scaled with the camera distance so it reads the same at any zoom.
 */
export class LocationPin {
  readonly group = new THREE.Group();
  private head: THREE.Group;
  private rings: THREE.Mesh[] = [];
  private t = 0;

  constructor(color = '#2f7bff') {
    this.group.name = 'location-pin';
    this.group.visible = false;
    const top = (m: THREE.Material) => Object.assign(m, { depthTest: false, depthWrite: false, transparent: true });
    this.head = new THREE.Group();
    // Teardrop (a sphere on an inverted cone, tip at y = 0) with a white dot, merged into one
    // mesh with vertex colours so the pin costs a single draw call.
    const paint = (g: THREE.BufferGeometry, hex: string) => {
      const c = new THREE.Color(hex);
      const n = g.attributes.position.count;
      g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => [c.r, c.g, c.b][i % 3]), 3));
      return g.index ? g.toNonIndexed() : g;
    };
    const ball = new THREE.SphereGeometry(1, 24, 16).translate(0, 2.2, 0);
    const cone = new THREE.ConeGeometry(0.86, 1.9, 24, 1, true).rotateX(Math.PI).translate(0, 1.15, 0);
    const dot = new THREE.SphereGeometry(0.42, 16, 12).scale(1, 1, 0.3).translate(0, 2.25, 0.9);
    const geo = mergeGeometries([paint(ball, color), paint(cone, color), paint(dot, '#ffffff')]);
    const headMesh = new THREE.Mesh(geo, top(new THREE.MeshBasicMaterial({ vertexColors: true })));
    headMesh.renderOrder = 20;
    this.head.add(headMesh);
    for (let i = 0; i < 1; i++) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 48), top(new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })));
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 19;
      this.rings.push(ring);
      this.group.add(ring);
    }
    this.group.add(this.head);
  }

  set(x: number, z: number) {
    this.group.position.set(x, 0.3, z);
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }

  update(dt: number, camera: THREE.Camera) {
    if (!this.group.visible) return;
    this.t += dt;
    const s = THREE.MathUtils.clamp(camera.position.distanceTo(this.group.position) / 70, 1.5, 40);
    this.group.scale.setScalar(s);
    this.head.position.y = 0.6 + Math.abs(Math.sin(this.t * 2.4)) * 0.9;
    // Billboard the head around the vertical axis so the white dot faces the camera.
    this.head.rotation.y = Math.atan2(camera.position.x - this.group.position.x, camera.position.z - this.group.position.z);
    this.rings.forEach((r, i) => {
      const k = (this.t * 0.6 + i * 0.5) % 1;
      r.scale.setScalar(1 + k * 4);
      (r.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k);
    });
  }
}
