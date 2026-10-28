import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const MAX_CLOUDS = 48;
const DOME_RADIUS = 9000;

const ZENITH_DAY = new THREE.Color('#3f7fe0');
const ZENITH_NIGHT = new THREE.Color('#04061a');

/** Horizon stays the mood colour (fog blends into it); the zenith is the horizon pulled towards blue (RGB, so warm horizons never turn green). */
export function skyGradient(horizon: THREE.Color, night: number): { top: THREE.Color; horizon: THREE.Color } {
  const target = ZENITH_DAY.clone().lerp(ZENITH_NIGHT, night);
  const top = horizon.clone().lerp(target, 0.78 - 0.18 * night);
  return { top, horizon: horizon.clone() };
}

/** Number of clouds for a cover in 0..1: 0 → none, 1 → all 48. */
export function cloudCount(cover: number): number {
  return Math.round(MAX_CLOUDS * Math.min(1, Math.max(0, cover)));
}

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uHorizon;
uniform vec3 uTop;
uniform vec3 uSunDir;
uniform float uNight;
varying vec3 vDir;
float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
void main() {
  vec3 d = normalize(vDir);
  float e = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 1.0, pow(e, 0.35)));
  float s = max(dot(d, normalize(uSunDir)), 0.0);
  float glow = (pow(s, 6.0) * 0.18 + pow(s, 90.0) * 0.5) * (1.0 - uNight);
  col += mix(uHorizon, vec3(1.0, 0.95, 0.85), 0.5) * glow;
  vec3 g = d * 420.0;
  float star = step(0.998, hash(floor(g))) * step(length(fract(g) - 0.5), 0.3) * smoothstep(0.05, 0.3, d.y);
  col += vec3(star) * smoothstep(0.5, 0.9, uNight);
  gl_FragColor = vec4(col, 1.0);
}`;

/** Inverted sphere around the camera: vertical gradient, sun glow, night stars. Ignores fog and depth. */
export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly uniforms = {
    uHorizon: { value: new THREE.Color() },
    uTop: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uNight: { value: 0 },
  };

  constructor(horizon = new THREE.Color('#9fd3f2')) {
    this.uniforms.uHorizon.value.copy(horizon);
    this.uniforms.uTop.value.copy(skyGradient(horizon, 0).top);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 16), mat);
    this.mesh.name = 'sky';
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
  }

  update(horizon: THREE.Color, sunDir: THREE.Vector3, night: number, cameraPos: THREE.Vector3) {
    const g = skyGradient(horizon, night);
    this.uniforms.uHorizon.value.copy(g.horizon);
    this.uniforms.uTop.value.copy(g.top);
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uNight.value = night;
    this.mesh.position.copy(cameraPos);
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Low-poly clouds: one InstancedMesh of merged puffs, orbiting the model on a ring. */
export class CloudLayer {
  readonly mesh: THREE.InstancedMesh;
  private readonly ang: number[] = [];
  private readonly rad: number[] = [];
  private readonly pos: THREE.Vector3[] = [];
  private readonly scl: THREE.Vector3[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();

  constructor(extent: number) {
    const k = Math.min(2.5, Math.max(0.7, extent / 800));
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const puffs: THREE.BufferGeometry[] = [];
    for (const [x, y, z, r] of [[0, 0, 0, 1], [1.1, -0.1, 0.2, 0.75], [-1.0, -0.15, -0.1, 0.8], [0.2, 0.15, -0.9, 0.7]]) {
      const g = new THREE.IcosahedronGeometry(r, 0);
      g.translate(x, y, z);
      puffs.push(g);
    }
    const geo = mergeGeometries(puffs)!;
    puffs.forEach((g) => g.dispose());
    const mat = new THREE.MeshLambertMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.4, flatShading: true, fog: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_CLOUDS);
    this.mesh.name = 'clouds';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    for (let i = 0; i < MAX_CLOUDS; i++) {
      // A ring from 1.2x to 4x the extent; clouds orbit it, so none ever drifts over the model.
      this.ang.push(rnd() * Math.PI * 2);
      this.rad.push((1.2 + rnd() * 2.8) * extent);
      this.pos.push(new THREE.Vector3(0, (120 + rnd() * 140) * k, 0));
      const s = (110 + rnd() * 120) * k;
      this.scl.push(new THREE.Vector3(s, s * 0.4, s * 0.75));
    }
    this.setCover(0);
  }

  setCover(c: number) {
    this.mesh.count = cloudCount(c);
    this.mesh.visible = this.mesh.count > 0;
    this.write();
  }

  setLight(color: THREE.Color) {
    const m = this.mesh.material as THREE.MeshLambertMaterial;
    m.color.copy(color);
    m.emissive.copy(color);
  }

  update(dt: number) {
    if (this.mesh.count === 0) return;
    for (let i = 0; i < MAX_CLOUDS; i++) this.ang[i] += (dt * (4 + this.scl[i].x * 0.05)) / this.rad[i];
    this.write();
  }

  private write() {
    for (let i = 0; i < this.mesh.count; i++) {
      this.pos[i].x = Math.cos(this.ang[i]) * this.rad[i];
      this.pos[i].z = Math.sin(this.ang[i]) * this.rad[i];
      this.m.compose(this.pos[i], this.q, this.scl[i]);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
