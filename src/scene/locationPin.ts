import * as THREE from 'three';

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
    const body = top(new THREE.MeshBasicMaterial({ color }));
    const white = top(new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    this.head = new THREE.Group();
    // Teardrop: a sphere on an inverted cone, tip at y = 0, with a white dot.
    const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), body);
    ball.position.y = 2.2;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.86, 1.9, 24, 1, true), body);
    cone.rotation.x = Math.PI;
    cone.position.y = 1.15;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), white);
    dot.position.set(0, 2.25, 0);
    dot.scale.z = 0.3;
    dot.position.z = 0.9;
    this.head.add(cone, ball, dot);
    this.head.renderOrder = 20;
    this.head.traverse((o) => (o.renderOrder = 20));
    for (let i = 0; i < 2; i++) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 48), top(new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })));
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 19;
      this.rings.push(ring);
      this.group.add(ring);
    }
    const base = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24), top(new THREE.MeshBasicMaterial({ color, opacity: 0.9 })));
    base.rotation.x = -Math.PI / 2;
    base.renderOrder = 19;
    this.group.add(base, this.head);
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
