import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { CityData, ProgressFn } from '../data/types';
import { bboxSizeMeters, LocalProjection } from '../geo/projection';
import { buildBuildings } from './buildings';
import { buildLandscape, type LandscapeResult } from './landscape';
import { buildRoads } from './roads';
import { lighting, sunState, type SunState } from './sun';
import { Traffic } from './traffic';

export interface BuildStats {
  buildings: number;
  trees: number;
  vehicles: number;
  seconds: number;
  areaKm2: number;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export class CityScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private sun = new THREE.DirectionalLight('#ffffff', 2.5);
  private hemi = new THREE.HemisphereLight('#bcd8ff', '#d8c9a8', 1.2);
  private city = new THREE.Group();
  private traffic: Traffic | null = null;
  private landscape: LandscapeResult | null = null;
  private buildingUniforms: { uNight: { value: number } } | null = null;
  private rain: THREE.Points | null = null;
  private timer = new THREE.Timer();
  private size = { width: 1000, depth: 1000 };
  private proj: LocalProjection | null = null;
  private labels: { el: HTMLElement; pos: THREE.Vector3 }[] = [];
  private raf = 0;
  private pixelMode = false;
  private cloud = 0;
  data: CityData | null = null;
  sunInfo: SunState | null = null;
  onFrame?: () => void;

  constructor(private readonly container: HTMLElement, private readonly labelLayer: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
    this.controls = new MapControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.screenSpacePanning = false;

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target, this.hemi, this.city);
    this.scene.fog = new THREE.Fog('#9fd3f2', 2000, 6000);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.2, 0.5, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.loop();
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = this.pixelMode ? 0.3 : Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
  }

  async build(data: CityData, onProgress: ProgressFn): Promise<BuildStats> {
    const t0 = performance.now();
    this.clear();
    this.data = data;
    const proj = (this.proj = new LocalProjection(data.bbox));
    this.size = bboxSizeMeters(data.bbox);

    onProgress('build', 0.05, 'Đường & cầu');
    await nextFrame();
    const roads = buildRoads(data.roads, data.rails, proj);
    this.city.add(roads.group);

    onProgress('build', 0.25, 'Nhà cửa');
    await nextFrame();
    const b = buildBuildings(data.buildings, proj);
    this.city.add(b.mesh);
    this.buildingUniforms = b.material.userData.uniforms;

    onProgress('build', 0.6, 'Cây, sông, đèn đường');
    await nextFrame();
    this.landscape = buildLandscape(data, proj, roads.paths, b.footprints, roads.lampSpots);
    this.city.add(this.landscape.group);

    onProgress('build', 0.85, 'Giao thông');
    await nextFrame();
    this.traffic = new Traffic(roads.paths, roads.railPaths);
    this.scene.add(this.traffic.group);

    for (const p of data.pois) {
      const [x, z] = proj.project(p.pos);
      const el = document.createElement('div');
      el.className = 'poi-label';
      el.textContent = p.name;
      this.labelLayer.appendChild(el);
      this.labels.push({ el, pos: new THREE.Vector3(x, 25, z) });
    }

    const ext = Math.max(this.size.width, this.size.depth);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -ext * 0.65;
    cam.right = cam.top = ext * 0.65;
    cam.near = 1;
    cam.far = ext * 4;
    cam.updateProjectionMatrix();
    this.scene.fog = new THREE.Fog('#9fd3f2', ext * 1.6, ext * 5);
    this.controls.maxDistance = ext * 3;
    this.controls.minDistance = 20;
    this.resetView();

    onProgress('build', 1, 'Xong');
    return {
      buildings: b.count,
      trees: this.landscape.treeCount,
      vehicles: this.traffic.stats.vehicles,
      seconds: (performance.now() - t0) / 1000,
      areaKm2: (this.size.width * this.size.depth) / 1e6,
    };
  }

  clear() {
    const dispose = (o: THREE.Object3D) =>
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    dispose(this.city);
    this.city.clear();
    if (this.traffic) {
      dispose(this.traffic.group);
      this.scene.remove(this.traffic.group);
      this.traffic = null;
    }
    for (const l of this.labels) l.el.remove();
    this.labels = [];
    this.setRain(false);
  }

  /** Apply time of day. `localHour` is the clock hour at the area (drives traffic density). */
  setTime(date: Date, localHour: number) {
    if (!this.proj) return;
    const s = (this.sunInfo = sunState(date, this.proj.lat0, this.proj.lon0));
    const L = lighting(s, this.cloud);
    const ext = Math.max(this.size.width, this.size.depth);
    this.sun.position.copy(s.direction).multiplyScalar(ext * 1.5);
    this.sun.target.position.set(0, 0, 0);
    if (s.direction.y > 0.02) {
      this.sun.color.copy(L.sunColor);
      this.sun.intensity = L.sunIntensity;
    } else {
      // Moonlight: a dim, cool key light from a fixed high angle so night scenes keep their shape.
      this.sun.position.set(-0.4, 0.8, -0.45).normalize().multiplyScalar(ext * 1.5);
      this.sun.color.set('#8fa2ff');
      this.sun.intensity = 0.55 * s.night;
    }
    this.hemi.intensity = L.hemiIntensity;
    this.hemi.color.copy(L.hemiSky);
    this.hemi.groundColor.copy(L.hemiGround);
    this.scene.background = L.sky;
    (this.scene.fog as THREE.Fog).color.copy(L.sky);
    this.bloom.strength = 0.06 + s.night * 0.4;
    this.bloom.threshold = s.night > 0.5 ? 0.8 : 0.95;
    // Warm sodium glow on streets after dark.
    this.city.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
      if (!Array.isArray(m) && m?.userData?.streetGlow) m.emissive.setRGB(0.32, 0.17, 0.06).multiplyScalar(s.night * m.userData.streetGlow);
    });
    if (this.buildingUniforms) this.buildingUniforms.uNight.value = s.night;
    if (this.landscape?.lampBulbs) this.landscape.lampBulbs.visible = s.night > 0.35;
    this.traffic?.setHour(localHour);
    this.traffic?.setNight(s.night);
  }

  setCloud(c: number) {
    this.cloud = Math.min(1, Math.max(0, c));
  }

  setRain(on: boolean) {
    if (!on) {
      if (this.rain) {
        this.scene.remove(this.rain);
        this.rain.geometry.dispose();
        (this.rain.material as THREE.Material).dispose();
        this.rain = null;
      }
      return;
    }
    if (this.rain) return;
    const n = 6000;
    const pos = new Float32Array(n * 3);
    const { width, depth } = this.size;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * width;
      pos[i * 3 + 1] = Math.random() * 220;
      pos[i * 3 + 2] = (Math.random() - 0.5) * depth;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rain = new THREE.Points(g, new THREE.PointsMaterial({ color: '#cfe3ff', size: 1.2, transparent: true, opacity: 0.6 }));
    this.rain.name = 'rain';
    this.scene.add(this.rain);
  }

  setTrafficOverlay(v: boolean) {
    this.traffic?.setOverlayVisible(v);
  }

  get trafficStats() {
    return this.traffic?.stats ?? { vehicles: 0, segments: 0, flow: 1 };
  }

  setPixelMode(on: boolean) {
    this.pixelMode = on;
    this.renderer.domElement.classList.toggle('pixelated', on);
    this.resize();
  }

  resetView() {
    const ext = Math.max(this.size.width, this.size.depth);
    this.controls.target.set(0, 0, 0);
    // Default: looking from the south-east, ~50° tilt like a diorama.
    this.camera.position.set(ext * 0.55, ext * 0.72, ext * 0.62);
    this.controls.update();
  }

  topView() {
    const ext = Math.max(this.size.width, this.size.depth);
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(0, ext * 1.4, 0.01);
    this.controls.update();
  }

  zoom(factor: number) {
    const off = this.camera.position.clone().sub(this.controls.target).multiplyScalar(factor);
    this.camera.position.copy(this.controls.target).add(off);
    this.controls.update();
  }

  rotate(deg: number) {
    const off = this.camera.position.clone().sub(this.controls.target);
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180);
    this.camera.position.copy(this.controls.target).add(off);
    this.controls.update();
  }

  /** Camera bearing (deg from north, clockwise) and tilt from vertical (deg). */
  get view() {
    const off = this.camera.position.clone().sub(this.controls.target);
    const bearing = ((Math.atan2(-off.x, off.z) * 180) / Math.PI + 360) % 360;
    const tilt = (Math.acos(off.y / off.length()) * 180) / Math.PI;
    return { bearing, tilt };
  }

  async exportGLB(): Promise<Blob> {
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(this.city, { binary: true });
    return new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
  }

  screenshot(): string {
    return this.renderer.domElement.toDataURL('image/png');
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.controls.update();
    this.traffic?.update(dt);
    if (this.rain) {
      const p = this.rain.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        let y = p.getY(i) - dt * 60;
        if (y < 0) y += 220;
        p.setY(i, y);
      }
      p.needsUpdate = true;
    }
    this.composer.render();
    this.updateLabels();
    this.onFrame?.();
  };

  private updateLabels() {
    if (!this.labels.length) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const v = new THREE.Vector3();
    for (const l of this.labels) {
      v.copy(l.pos).project(this.camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      l.el.style.display = visible ? '' : 'none';
      if (visible) l.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.clear();
    this.renderer.dispose();
  }
}
