import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Building, CityData, ProgressFn } from '../data/types';
import { bboxSizeMeters, LocalProjection } from '../geo/projection';
import { cityWorker } from '../worker/client';
import { buildCity } from './buildCity';
import { bakeMono, type ColorMode, colorModeUniforms, monoSky, patchObject } from './colorMode';
import type { RailPath, RoadPath } from './roads';
import { Realism, realUniforms } from './realistic';
import { deserializeObjects } from './serialize';
import { createLampPools, litShare } from './nightLights';
import { lighting, sunState, type SunState } from './sun';
import { Traffic } from './traffic';

export interface BuildStats {
  buildings: number;
  trees: number;
  vehicles: number;
  seconds: number;
  areaKm2: number;
}

/** Phones and small tablets get lighter defaults (#23). */
export const MOBILE = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export class CityScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  /** Ambient occlusion, only in the realistic view (#19). */
  private gtao: GTAOPass;
  private realism: Realism;
  private hemiBase = 1.2;
  private sunDir = new THREE.Vector3(0, 1, 0);
  private night = 0;
  private wet = 0;
  private lightDirty = false;
  private lastLightUpdate = 0;
  private light = lighting(sunState(new Date(), 10.8, 106.7), 0);
  private sun = new THREE.DirectionalLight('#ffffff', 2.5);
  private hemi = new THREE.HemisphereLight('#bcd8ff', '#d8c9a8', 1.2);
  private city = new THREE.Group();
  private traffic: Traffic | null = null;
  private lampBulbs: THREE.InstancedMesh | null = null;
  /** Small procedural detail, only drawn when the camera is close (LOD, #5). */
  private details: THREE.Object3D[] = [];
  private buildingUniforms: { uNight: { value: number }; uSourceView: { value: number }; uSelected: { value: number }; uLit: { value: number } } | null = null;
  private lampPools: THREE.InstancedMesh | null = null;
  private buildingsMesh: THREE.Mesh | null = null;
  private protoMeshes: THREE.InstancedMesh[] = [];
  private buildingIds: string[] = [];
  private buildingById = new Map<string, Building>();
  private raycaster = new THREE.Raycaster();
  /** Called with the picked building (or null) when the user clicks the model (#10). */
  onPick?: (b: Building | null) => void;
  private sourceView = false;
  private rain: THREE.Points | null = null;
  private timer = new THREE.Timer();
  private size = { width: 1000, depth: 1000 };
  private proj: LocalProjection | null = null;
  private labels: { el: HTMLElement; pos: THREE.Vector3 }[] = [];
  private raf = 0;
  private pixelMode = false;
  // Phones: lower resolution cap; their screens are dense enough (#23).
  private maxPixelRatio = Math.min(window.devicePixelRatio, MOBILE ? 1.5 : 2);
  private pixelRatio = this.maxPixelRatio;
  private fpsWindow = { start: performance.now(), frames: 0 };
  /** Skip rendering (used by the benchmark to measure pure build cost). */
  paused = false;
  /** Durations (ms) of the synchronous main-thread steps of the last build (benchmark). */
  mainThreadSlices: Record<string, number> = {};
  /** Average FPS over the last 2 s window. */
  fps = 0;
  private cloud = 0;
  private colorMode: ColorMode = 'color';
  private modeFrom = 0;
  private modeChangedAt = 0;
  private lastSky = new THREE.Color('#9fd3f2');
  data: CityData | null = null;
  sunInfo: SunState | null = null;
  onFrame?: () => void;

  constructor(private readonly container: HTMLElement, private readonly labelLayer: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(this.maxPixelRatio);
    this.renderer.shadowMap.enabled = true;
    // Shadows only change with the sun or the model, so render them on demand (#8).
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
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
    this.gtao = new GTAOPass(this.scene, this.camera, 512, 512);
    this.gtao.updateGtaoMaterial({ radius: 6, distanceExponent: 1.5, thickness: 4, scale: 1.2, samples: 12 });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6 });
    this.gtao.blendIntensity = 0.9;
    this.gtao.enabled = false;
    this.composer.addPass(this.gtao);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.2, 0.5, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.realism = new Realism(this.renderer);
    this.scene.add(this.realism.sky);

    new ResizeObserver(() => this.resize()).observe(container);
    // Click (not drag) on the model picks a building.
    let down: { x: number; y: number } | null = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) this.pick(e.clientX, e.clientY);
      down = null;
    });
    this.resize();
    this.loop();
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = this.pixelMode ? 0.3 : this.pixelRatio;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
  }

  /** Ambient occlusion is the most expensive part of the realistic view; drop it on slow devices. */
  private adaptRealism() {
    if (this.colorMode !== 'real') return;
    if (this.fps < 30 && this.gtao.enabled && this.pixelRatio <= 1) this.gtao.enabled = false;
  }

  async build(data: CityData, onProgress: ProgressFn): Promise<BuildStats> {
    const t0 = performance.now();
    this.clear();
    this.mainThreadSlices = {};
    this.data = data;
    const proj = (this.proj = new LocalProjection(data.bbox));
    this.size = bboxSizeMeters(data.bbox);

    // Geometry is generated off the main thread when module workers are available (#8).
    let built: { group: THREE.Group; paths: RoadPath[]; railPaths: RailPath[]; buildings: number; trees: number; buildingIds: string[] };
    const report = (f: number, d: string) => onProgress('build', Math.min(0.9, f), d);
    if (cityWorker.available) {
      try {
        const r = await cityWorker.build(data, report);
        const t = performance.now();
        built = { ...r, group: deserializeObjects(r.objects) };
        this.mainThreadSlices.deserialize = performance.now() - t;
      } catch (e) {
        console.warn('Worker build failed, building inline', e);
        await nextFrame();
        const t = performance.now();
        built = buildCity(data, report);
        this.mainThreadSlices.inlineBuild = performance.now() - t;
      }
    } else {
      await nextFrame();
      const t = performance.now();
      built = buildCity(data, report);
      this.mainThreadSlices.inlineBuild = performance.now() - t;
    }
    this.city.add(built.group);
    const buildingsMesh = built.group.getObjectByName('buildings') as THREE.Mesh | undefined;
    this.buildingUniforms = (buildingsMesh?.material as THREE.Material | undefined)?.userData.uniforms ?? null;
    this.buildingsMesh = buildingsMesh ?? null;
    this.protoMeshes = [];
    built.group.traverse((o) => o.name.startsWith('buildings-') && this.protoMeshes.push(o as THREE.InstancedMesh));
    this.buildingIds = built.buildingIds;
    this.buildingById = new Map(data.buildings.map((b) => [b.id, b]));
    if (this.buildingUniforms) this.buildingUniforms.uSourceView.value = this.sourceView ? 1 : 0;
    this.lampBulbs = (built.group.getObjectByName('lampBulbs') as THREE.InstancedMesh | undefined) ?? null;
    this.lampPools = this.lampBulbs ? createLampPools(this.lampBulbs) : null;
    if (this.lampPools) built.group.add(this.lampPools);
    this.details = [];
    built.group.traverse((o) => o.name.startsWith('detail-') && this.details.push(o));

    onProgress('build', 0.92, 'Giao thông');
    await nextFrame();
    const tTraffic = performance.now();
    const attractors = data.pois.filter((p) => /market|school|college|university|hospital|place_of_worship|stadium/.test(p.kind)).map((p) => proj.project(p.pos));
    this.traffic = new Traffic(built.paths, built.railPaths, attractors, MOBILE ? 1100 : 2400, MOBILE ? 300 : 700);
    this.mainThreadSlices.traffic = performance.now() - tTraffic;
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
    const mapSize = ext > 1200 || MOBILE ? 2048 : 4096;
    if (this.sun.shadow.mapSize.x !== mapSize) {
      this.sun.shadow.mapSize.set(mapSize, mapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.renderer.shadowMap.needsUpdate = true;
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

    patchObject(this.city);
    patchObject(this.traffic.group);
    if (this.colorMode === 'real') this.applyRealism(true);

    onProgress('build', 1, 'Xong');
    return {
      buildings: built.buildings,
      trees: built.trees,
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
    this.realism.reset();
    dispose(this.city);
    this.city.clear();
    this.buildingsMesh = null;
    this.protoMeshes = [];
    this.buildingIds = [];
    this.buildingById.clear();
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
    const L = (this.light = lighting(s, this.cloud));
    const ext = Math.max(this.size.width, this.size.depth);
    this.sun.position.copy(s.direction).multiplyScalar(ext * 1.5);
    this.sun.target.position.set(0, 0, 0);
    if (s.direction.y > 0) {
      this.sun.color.copy(L.sunColor);
      this.sun.intensity = L.sunIntensity;
    } else {
      // Moonlight: a dim, cool key light from a fixed high angle so night scenes keep their shape.
      // It fades in from zero as the sun sinks, so the switch of light direction is invisible (#22).
      this.sun.position.set(-0.4, 0.8, -0.45).normalize().multiplyScalar(ext * 1.5);
      this.sun.color.set('#8fa2ff');
      this.sun.intensity = (this.colorMode === 'real' ? 0.3 : 0.55) * THREE.MathUtils.smoothstep(-s.direction.y, 0.01, 0.25);
    }
    this.hemiBase = L.hemiIntensity;
    this.hemi.intensity = this.colorMode === 'real' ? L.hemiIntensity * 0.15 : L.hemiIntensity;
    this.sunDir.copy(s.direction);
    this.night = s.night;
    this.hemi.color.copy(L.hemiSky);
    this.hemi.groundColor.copy(L.hemiGround);
    // Shadows and image-based lighting are expensive; they are refreshed from the render loop at a
    // limited rate instead of on every slider event (#22).
    this.lightDirty = true;
    this.lastSky.copy(L.sky);
    this.applySky();
    this.bloom.strength = 0.06 + s.night * 0.4;
    this.bloom.threshold = s.night > 0.5 ? 0.8 : 0.95;
    this.applyStreetGlow();
    if (this.buildingUniforms) this.buildingUniforms.uNight.value = s.night;
    if (this.lampBulbs) this.lampBulbs.visible = s.night > 0.35;
    if (this.lampPools) {
      this.lampPools.visible = s.night > 0.3;
      (this.lampPools.material as THREE.ShaderMaterial).uniforms.uIntensity.value = THREE.MathUtils.smoothstep(s.night, 0.3, 0.8) * (this.colorMode === 'real' ? 0.9 : 0.6);
    }
    if (this.buildingUniforms) this.buildingUniforms.uLit.value = litShare(localHour);
    this.traffic?.setHour(localHour);
    this.traffic?.setNight(s.night);
  }

  private applySky() {
    const sky = monoSky(this.lastSky, colorModeUniforms.uMono.value);
    this.scene.background = sky;
    (this.scene.fog as THREE.Fog).color.copy(sky);
  }

  setColorMode(mode: ColorMode) {
    if (mode === this.colorMode) return;
    const wasReal = this.colorMode === 'real';
    this.colorMode = mode;
    if (wasReal !== (mode === 'real')) this.applyRealism(mode === 'real');
    this.modeFrom = colorModeUniforms.uMono.value;
    this.modeChangedAt = performance.now();
  }

  /** Switches between the stylised and the physically based look (#19). */
  private applyRealism(on: boolean) {
    if (on) {
      this.realism.apply(this.city);
      if (this.traffic) this.realism.apply(this.traffic.group);
      this.realism.update(this.scene, this.sunDir, this.night, this.cloud, this.light);
    } else {
      this.realism.restore();
      this.scene.environment = null;
      this.realism.sky.visible = false;
    }
    this.gtao.enabled = on;
    this.sun.shadow.radius = on ? 3 : 1;
    this.hemi.intensity = on ? this.hemiBase * 0.15 : this.hemiBase;
    this.renderer.shadowMap.needsUpdate = true;
    // Street glow emissive lives on the material, so re-apply it to the swapped materials.
    this.applyStreetGlow();
  }

  /** Warm sodium glow on streets after dark (dimmer in the realistic view, which has less ambient light). */
  private applyStreetGlow() {
    // Lamp pools carry most of the street light now; keep only a faint overall tint.
    const k = this.night * (this.colorMode === 'real' ? 0.1 : 0.35);
    this.city.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
      if (!Array.isArray(m) && m?.userData?.streetGlow) m.emissive.setRGB(0.32, 0.17, 0.06).multiplyScalar(k * m.userData.streetGlow);
    });
  }

  get currentColorMode() {
    return this.colorMode;
  }

  /** Raycasts the buildings mesh at a screen point and selects the building under it. */
  pick(clientX: number, clientY: number): Building | null {
    if (!this.buildingsMesh) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    // Exact buildings carry the id per vertex, prototype instances per instance (#22).
    const hit = this.raycaster.intersectObjects([this.buildingsMesh, ...this.protoMeshes], false)[0];
    const bidAttr = (hit?.object as THREE.Mesh | undefined)?.geometry.getAttribute('aBid');
    const bid = !hit || !bidAttr ? -1 : hit.instanceId !== undefined ? Math.round(bidAttr.getX(hit.instanceId)) : hit.face ? Math.round(bidAttr.getX(hit.face.a)) : -1;
    const b = bid >= 0 ? (this.buildingById.get(this.buildingIds[bid]) ?? null) : null;
    this.select(b ? bid : -1);
    this.onPick?.(b);
    return b;
  }

  select(bid: number) {
    if (this.buildingUniforms) this.buildingUniforms.uSelected.value = bid;
  }

  /** Colour buildings by where their height comes from (#3). */
  setSourceView(on: boolean) {
    this.sourceView = on;
    if (this.buildingUniforms) this.buildingUniforms.uSourceView.value = on ? 1 : 0;
  }

  setCloud(c: number) {
    this.cloud = Math.min(1, Math.max(0, c));
  }

  setRain(on: boolean) {
    this.wet = on ? 1 : 0;
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
    return this.traffic?.stats ?? { vehicles: 0, segments: 0, flow: 1, people: 0, byKind: {} as Record<string, number> };
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
    let root: THREE.Object3D = this.city;
    if (this.colorMode === 'mono') {
      root = this.city.clone(true);
      bakeMono(root);
    }
    const result = await exporter.parseAsync(root, { binary: true });
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
    // Ease towards the target colour mode over ~300 ms of wall-clock time (frame-rate independent).
    const u = colorModeUniforms.uMono;
    const target = this.colorMode === 'mono' ? 1 : 0;
    if (u.value !== target) {
      const t = Math.min(1, (performance.now() - this.modeChangedAt) / 300);
      u.value = this.modeFrom + (target - this.modeFrom) * t;
      this.applySky();
    }
    this.traffic?.update(dt);
    const now = performance.now();
    if (this.lightDirty && now - this.lastLightUpdate > 120) {
      this.lightDirty = false;
      this.lastLightUpdate = now;
      this.renderer.shadowMap.needsUpdate = true;
      if (this.colorMode === 'real') this.realism.update(this.scene, this.sunDir, this.night, this.cloud, this.light);
    }
    realUniforms.uTime.value = this.timer.getElapsed();
    realUniforms.uWet.value += (this.wet - realUniforms.uWet.value) * Math.min(1, dt * 0.5);
    if (this.realism.sky.visible) this.realism.sky.position.copy(this.camera.position);
    if (this.details.length) {
      const near = this.camera.position.distanceTo(this.controls.target) < 700;
      if (this.details[0].visible !== near) {
        for (const d of this.details) d.visible = near;
        this.renderer.shadowMap.needsUpdate = true;
      }
    }
    if (this.rain) {
      const p = this.rain.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        let y = p.getY(i) - dt * 60;
        if (y < 0) y += 220;
        p.setY(i, y);
      }
      p.needsUpdate = true;
    }
    if (this.paused) return;
    this.composer.render();
    this.adaptPixelRatio();
    this.updateLabels();
    this.onFrame?.();
  };

  /** Lower the pixel ratio step by step while FPS stays under 40 (#8). */
  private adaptPixelRatio() {
    const w = this.fpsWindow;
    w.frames++;
    const now = performance.now();
    if (now - w.start < 2000) return;
    this.fps = (w.frames * 1000) / (now - w.start);
    w.start = now;
    w.frames = 0;
    this.adaptRealism();
    if (this.pixelMode || !this.data) return;
    if (this.fps < 40 && this.pixelRatio > 1) {
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.25);
      this.resize();
    } else if (this.fps > 58 && this.pixelRatio < this.maxPixelRatio) {
      this.pixelRatio = Math.min(this.maxPixelRatio, this.pixelRatio + 0.25);
      this.resize();
    }
  }

  /** Draw calls / triangles of one scene render, without post-processing passes (benchmark). */
  measureRender() {
    const info = this.renderer.info;
    info.autoReset = false;
    info.reset();
    this.renderer.render(this.scene, this.camera);
    const r = { calls: info.render.calls, triangles: info.render.triangles };
    info.autoReset = true;
    return r;
  }

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
