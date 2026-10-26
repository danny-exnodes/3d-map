import * as THREE from 'three';

/**
 * Share of windows lit at a local hour (#25): most homes light up after dusk, fewer after 22h,
 * a few through the night, some again before dawn.
 */
export function litShare(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const evening = Math.exp(-((h - 20) ** 2) / 6);
  const morning = Math.exp(-((h - 5.5) ** 2) / 0.8);
  return 0.06 + 0.32 * evening + 0.12 * morning;
}

/**
 * Pools of light thrown on the ground by street lamps: one flat quad per lamp with a radial
 * falloff, additive blending, no depth writes. Cheap enough for thousands of lamps.
 */
export function createLampPools(bulbs: THREE.InstancedMesh, lampHeight = 6): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uIntensity: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vCol;
      void main() {
        vUv = uv * 2.0 - 1.0;
        vCol = instanceColor;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uIntensity;
      varying vec2 vUv;
      varying vec3 vCol;
      void main() {
        float r = length(vUv);
        if (r > 1.0) discard;
        // Bright core under the lamp, long soft tail.
        float a = exp(-r * r * 4.5) * 0.85 + (1.0 - r) * 0.15;
        gl_FragColor = vec4(vCol * a * uIntensity, 1.0);
      }`,
  });
  const n = bulbs.count;
  const pools = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  // Mix of old sodium lamps (orange) and newer LED (white), as in Vietnamese cities.
  const sodium = new THREE.Color(1.0, 0.55, 0.22);
  const led = new THREE.Color(0.85, 0.88, 1.0);
  for (let i = 0; i < n; i++) {
    bulbs.getMatrixAt(i, m);
    m.decompose(p, q, s);
    const radius = 9 + ((i * 7919) % 5);
    m.compose(p.setY(p.y - lampHeight + 0.09), new THREE.Quaternion(), s.set(radius * 2, 1, radius * 2));
    pools.setMatrixAt(i, m);
    pools.setColorAt(i, (i * 2654435761) % 10 < 6 ? sodium : led);
  }
  pools.name = 'lampPools';
  pools.renderOrder = -3;
  pools.frustumCulled = false;
  pools.visible = false;
  return pools;
}
