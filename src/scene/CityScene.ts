import * as THREE from 'three';
import { LocationPin } from './locationPin';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { HorizontalTiltShiftShader } from 'three/examples/jsm/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/examples/jsm/shaders/VerticalTiltShiftShader.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Building, CityData, ProgressFn } from '../data/types';
import { bboxSizeMeters, LocalProjection } from '../geo/projection';
import { cityWorker } from '../worker/client';
import { buildCity } from './buildCity';
import type { RailPath, RoadPath } from './roads';
import { deserializeObjects } from './serialize';
import { createLampPools, litShare } from './nightLights';
import { armLightning, idleLightning, isFlashing, type LightningState, nextLightning, type WeatherPreset, weatherPreset } from './weather';
import { dominantMood, isRising, moodLighting, type Mood } from './moods';
import { sunState, type SunState } from './sun';
import { CloudLayer, SkyDome } from './sky';
import { Realism, realUniforms, wetness } from './realistic';
import { type Style, toyParamsFor } from './style';
import { bakeToyInstances } from './toyGeometry';
import { tiltShiftStrength } from './tiltShift';
import { Boats, boatRoutes } from './boats';
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
  /** Ambient occlusion, only in Siêu thực (#19). */
  private gtao: GTAOPass;
  private realism: Realism;
  /** The mood lighting of the last setTime, for the Siêu thực sky and environment light. */
  private light: ReturnType<typeof moodLighting> | null = null;
  /** Where uWet is heading (wetness of the weather's rain). */
  private wet = 0;
  private sunDir = new THREE.Vector3(0, 1, 0);
  private night = 0;
  private lightDirty = false;
  private lastLightUpdate = 0;
  private sun = new THREE.DirectionalLight('#ffffff', 2.5);
  private hemi = new THREE.HemisphereLight('#bcd8ff', '#d8c9a8', 1.2);
  private city = new THREE.Group();
  private traffic: Traffic | null = null;
  private boats: Boats | null = null;
  private boatTime = 0;
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
  private rainLevel: 0 | 1 | 2 = 0;
  private weather: WeatherPreset = weatherPreset('clear');
  private fogBase = { near: 2000, far: 6000 };
  private hemiBase = 1.2;
  private lastTime: { date: Date; hour: number } | null = null;
  private lightning: LightningState = idleLightning();
  private reduceMotion = false;
  private slate = new THREE.Color('#6b7480');
  private timer = new THREE.Timer();
  private size = { width: 1000, depth: 1000 };
  private proj: LocalProjection | null = null;
  private pin = new LocationPin();
  private pinAt: [number, number] | null = null;

  /** Shows the animated location pin at a place (when it lies in or near the model), or hides it. */
  setPin(lonLat: [number, number] | null) {
    this.pinAt = lonLat;
    this.placePin();
  }

  private placePin() {
    const p = this.pinAt, proj = this.proj;
    if (!p || !proj) return this.pin.hide();
    const [x, z] = proj.project(p);
    // Within the model, plus a margin.
    if (Math.abs(x) > this.size.width / 2 + 150 || Math.abs(z) > this.size.depth / 2 + 150) return this.pin.hide();
    this.pin.set(x, z);
  }
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
  private tiltH: ShaderPass;
  private tiltV: ShaderPass;
  private tiltBase = { h: 2 / 512, v: 2 / 512 };
  private viewOff = new THREE.Vector3();
  private mood: Mood = 'noon';
  private lastSky = new THREE.Color('#9fd3f2');
  private dome = new SkyDome(this.lastSky);
  private white = new THREE.Color('#ffffff');
  private cloudLight = new THREE.Color('#ffffff');
  private clouds: CloudLayer | null = null;
  private builtStyle: Style = 'toy';
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
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target, this.hemi, this.city, this.pin.group, this.dome.mesh);
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reduceMotion = motion.matches;
    motion.addEventListener('change', (e) => {
      this.reduceMotion = e.matches;
      if (e.matches) this.endFlash();
    });
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
    this.tiltH = new ShaderPass(HorizontalTiltShiftShader);
    this.tiltV = new ShaderPass(VerticalTiltShiftShader);
    this.tiltH.uniforms.r.value = this.tiltV.uniforms.r.value = 0.5;
    this.composer.addPass(this.tiltH);
    this.composer.addPass(this.tiltV);
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
    this.tiltBase = { h: 2 / w, v: 2 / h };
  }

  /** Ambient occlusion is the most expensive part of Siêu thực; drop it on slow devices. */
  private adaptRealism() {
    if (this.builtStyle === 'real' && this.fps < 30 && this.gtao.enabled && this.pixelRatio <= 1) this.gtao.enabled = false;
  }

  /** The style of the model on screen (the last successful build's). */
  get style(): Style {
    return this.builtStyle;
  }

  /** Builds the model in a style (style.ts); switching style means building again from the same data. */
  async build(data: CityData, onProgress: ProgressFn, style: Style = 'toy'): Promise<BuildStats> {
    const t0 = performance.now();
    this.clear();
    this.mainThreadSlices = {};
    this.data = data;
    const pastel = toyParamsFor(style).pastel;
    const proj = (this.proj = new LocalProjection(data.bbox));
    this.size = bboxSizeMeters(data.bbox);

    // Geometry is generated off the main thread when module workers are available (#8).
    let built: { group: THREE.Group; paths: RoadPath[]; railPaths: RailPath[]; buildings: number; trees: number; buildingIds: string[] };
    const report = (f: number, d: string) => onProgress('build', Math.min(0.9, f), d);
    if (cityWorker.available) {
      try {
        const r = await cityWorker.build(data, style, report);
        const t = performance.now();
        built = { ...r, group: deserializeObjects(r.objects) };
        this.mainThreadSlices.deserialize = performance.now() - t;
      } catch (e) {
        console.warn('Worker build failed, building inline', e);
        await nextFrame();
        const t = performance.now();
        built = buildCity(data, report, style);
        this.mainThreadSlices.inlineBuild = performance.now() - t;
      }
    } else {
      await nextFrame();
      const t = performance.now();
      built = buildCity(data, report, style);
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
    this.traffic = new Traffic(built.paths, built.railPaths, attractors, MOBILE ? 1100 : 2400, MOBILE ? 300 : 700, pastel);
    this.mainThreadSlices.traffic = performance.now() - tTraffic;
    this.scene.add(this.traffic.group);
    this.boats = new Boats(boatRoutes(data, proj), 4321, pastel);
    this.scene.add(this.boats.group);

    for (const p of data.pois) {
      const [x, z] = proj.project(p.pos);
      const el = document.createElement('div');
      el.className = 'poi-label';
      el.textContent = p.name;
      this.labelLayer.appendChild(el);
      this.labels.push({ el, pos: new THREE.Vector3(x, 25, z) });
    }

    this.placePin();
    const ext = Math.max(this.size.width, this.size.depth);
    const mapSize = ext > 1200 || MOBILE ? 2048 : 4096;
    if (this.sun.shadow.mapSize.x !== mapSize) {
      this.sun.shadow.mapSize.set(mapSize, mapSize);
      this.sun.shadow.dispose();
    }
    this.renderer.shadowMap.needsUpdate = true;
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -ext * 0.65;
    cam.right = cam.top = ext * 0.65;
    cam.near = 1;
    cam.far = ext * 4;
    cam.updateProjectionMatrix();
    this.fogBase = { near: ext * 1.6, far: ext * 5 };
    this.scene.fog = new THREE.Fog('#9fd3f2', this.fogBase.near * this.weather.fogScale, this.fogBase.far * this.weather.fogScale);
    this.clouds = new CloudLayer(ext);
    this.clouds.setCover(this.cloud);
    this.clouds.setLight(this.cloudLight);
    this.scene.add(this.clouds.mesh);
    this.controls.maxDistance = ext * 3;
    this.controls.minDistance = 20;
    this.resetView();
    // Siêu thực is the Khối model with realistic materials, under three's sky instead of the dome.
    const real = style === 'real';
    if (real) this.realism.apply(this.city, this.traffic.group);
    this.dome.mesh.visible = !real;
    this.gtao.enabled = real;
    if (!real) {
      this.realism.sky.visible = false;
      this.scene.environment = null;
    }

    onProgress('build', 1, 'Xong');
    this.builtStyle = style;
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
    if (this.boats) {
      this.scene.remove(this.boats.group);
      this.boats.dispose();
      this.boats = null;
    }
    for (const l of this.labels) l.el.remove();
    this.labels = [];
    if (this.clouds) {
      this.scene.remove(this.clouds.mesh);
      this.clouds.dispose();
      this.clouds = null;
    }
    this.disposeRain();
  }

  /** Apply time of day. `localHour` is the clock hour at the area (drives traffic density). */
  setTime(date: Date, localHour: number) {
    if (!this.proj) return;
    this.lastTime = { date, hour: localHour };
    const s = (this.sunInfo = sunState(date, this.proj.lat0, this.proj.lon0));
    const rising = isRising(date, this.proj.lat0, this.proj.lon0);
    const L = (this.light = moodLighting(s, rising, this.cloud));
    // Siêu thực gets its ambient light from the sky (environment map), so the other lights are dimmer.
    const real = this.builtStyle === 'real';
    this.mood = dominantMood(s, rising);
    this.renderer.toneMappingExposure = L.exposure * this.weather.exposure;
    const ext = Math.max(this.size.width, this.size.depth);
    this.sun.position.copy(s.direction).multiplyScalar(ext * 1.5);
    this.sun.target.position.set(0, 0, 0);
    if (s.direction.y > 0) {
      this.sun.color.copy(L.sunColor);
      this.sun.intensity = L.sunIntensity * (1 - this.weather.dim);
    } else {
      // Moonlight: a dim, cool key light from a fixed high angle so night scenes keep their shape.
      // It fades in from zero as the sun sinks, so the switch of light direction is invisible (#22).
      this.sun.position.set(-0.4, 0.8, -0.45).normalize().multiplyScalar(ext * 1.5);
      this.sun.color.set('#8fa2ff');
      this.sun.intensity = (real ? 0.3 : 0.55) * THREE.MathUtils.smoothstep(-s.direction.y, 0.01, 0.25) * (1 - this.weather.dim);
    }
    this.hemiBase = L.hemiIntensity * (1 - this.weather.hemiDim) * (real ? 0.15 : 1);
    this.hemi.intensity = this.hemiBase;
    this.sunDir.copy(s.direction);
    this.night = s.night;
    this.hemi.color.copy(L.hemiSky);
    this.hemi.groundColor.copy(L.hemiGround);
    // Shadows and image-based lighting are expensive; they are refreshed from the render loop at a
    // limited rate instead of on every slider event (#22).
    this.lightDirty = true;
    this.lastSky.copy(L.sky);
    // Storm clouds grey the whole sky; at night the slate darkens with it.
    this.lastSky.lerp(this.slate.clone().multiplyScalar(1 - 0.85 * s.night), this.weather.grey);
    this.applySky();
    this.bloom.strength = 0.06 + s.night * 0.4;
    this.bloom.threshold = s.night > 0.5 ? 0.8 : 0.95;
    this.applyStreetGlow();
    if (this.buildingUniforms) this.buildingUniforms.uNight.value = s.night;
    if (this.lampBulbs) this.lampBulbs.visible = s.night > 0.35;
    if (this.lampPools) {
      this.lampPools.visible = s.night > 0.3;
      (this.lampPools.material as THREE.ShaderMaterial).uniforms.uIntensity.value = THREE.MathUtils.smoothstep(s.night, 0.3, 0.8) * (real ? 0.75 : 0.45);
    }
    if (this.buildingUniforms) this.buildingUniforms.uLit.value = litShare(localHour);
    this.traffic?.setHour(localHour);
    this.traffic?.setNight(s.night);
  }

  private applySky() {
    this.scene.background = this.lastSky;
    (this.scene.fog as THREE.Fog).color.copy(this.lastSky);
    this.cloudLight.copy(this.lastSky).lerp(this.white, 0.55);
    this.clouds?.setLight(this.cloudLight);
    this.dome.update(this.lastSky, this.sunDir, this.night, this.camera.position);
  }

  /** Warm sodium glow on streets after dark (dimmer in Siêu thực, which has less ambient light). */
  private applyStreetGlow() {
    // Lamp pools carry most of the street light now; keep only a faint overall tint.
    const k = this.night * (this.builtStyle === 'real' ? 0.1 : 0.35);
    this.city.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
      if (!Array.isArray(m) && m?.userData?.streetGlow) m.emissive.setRGB(0.32, 0.17, 0.06).multiplyScalar(k * m.userData.streetGlow);
    });
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
    this.clouds?.setCover(this.cloud);
  }

  /** Apply a weather look: clouds, rain, fog distance, light dimming, lightning. */
  setWeather(p: WeatherPreset) {
    this.weather = p;
    this.wet = wetness(p.rain);
    this.setCloud(p.cloud);
    this.setRain(p.rain);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = this.fogBase.near * p.fogScale;
    fog.far = this.fogBase.far * p.fogScale;
    this.lightning = armLightning(this.lightning, p.lightning, performance.now());
    if (this.lastTime) this.setTime(this.lastTime.date, this.lastTime.hour);
  }

  private disposeRain() {
    this.rainLevel = 0;
    if (!this.rain) return;
    this.scene.remove(this.rain);
    this.rain.geometry.dispose();
    (this.rain.material as THREE.Material).dispose();
    this.rain = null;
  }

  private setRain(level: 0 | 1 | 2) {
    if (level === this.rainLevel && (this.rain !== null) === (level > 0)) return;
    this.disposeRain();
    this.rainLevel = level;
    if (level === 0) return;
    const n = level === 2 ? 12000 : 6000;
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

  /** Stop a running flash right away and put the lights back. */
  private endFlash() {
    if (!isFlashing(this.lightning)) return;
    this.lightning = { ...this.lightning, flashEnd: 0, lastEnd: performance.now(), flashAt: performance.now() + 4000 };
    this.hemi.intensity = this.hemiBase;
    this.clouds?.setLight(this.cloudLight);
  }

  private updateLightning(now: number) {
    if (this.reduceMotion) return;
    const was = isFlashing(this.lightning);
    this.lightning = nextLightning(this.lightning, now, Math.random());
    const is = isFlashing(this.lightning);
    if (is === was) return;
    this.hemi.intensity = is ? this.hemiBase + 2.5 : this.hemiBase;
    this.clouds?.setLight(is ? this.white : this.cloudLight);
  }

  /**
   * Live speeds from Google Routes (#11): one route along each of the longest main roads (up to
   * `maxRoutes`), matched onto every road of the model. Returns how many roads got a reading.
   */
  async applyGoogleTraffic(key: string, maxRoutes = 16, signal?: AbortSignal): Promise<number> {
    const { routeTraffic, matchRoad } = await import('../data/googleTraffic');
    const t = this.traffic, proj = this.proj;
    if (!t || !proj) return 0;
    const major = t.paths
      .filter((p) => ['motorway', 'primary', 'secondary', 'tertiary'].includes(p.road.cls) && p.length > 120)
      .sort((a, b) => b.length - a.length)
      .slice(0, maxRoutes);
    const pieces: { speed: import('../data/googleTraffic').Speed; line: [number, number][] }[] = [];
    for (const p of major) {
      const got = await routeTraffic(proj.unproject(...p.pts[0]), proj.unproject(...p.pts[p.pts.length - 1]), key, signal);
      for (const x of got) pieces.push({ speed: x.speed, line: x.line.map((q) => proj.project(q)) });
    }
    const speeds = new Map<number, number>();
    t.paths.forEach((p, i) => {
      if (p.road.cls === 'path' || p.road.cls === 'service') return;
      const r = matchRoad(p.pts, pieces);
      if (r !== null) speeds.set(i, r);
    });
    t.setObserved(speeds, 'Google');
    return speeds.size;
  }

  setTrafficOverlay(v: boolean) {
    this.traffic?.setOverlayVisible(v);
  }

  get trafficStats() {
    return this.traffic?.stats ?? { vehicles: 0, segments: 0, flow: 1, people: 0, byKind: {} as Record<string, number>, observed: 0 };
  }

  setPixelMode(on: boolean) {
    this.pixelMode = on;
    this.renderer.domElement.classList.toggle('pixelated', on);
    this.resize();
  }

  /**
   * The camera as a MapLibre camera (centre, zoom, pitch, bearing) for the same field of view and
   * viewport height, so the globe can take over seamlessly (#29). `pose` defaults to the current one.
   */
  mapPose(pose = this.saveView()) {
    if (!this.proj) return null;
    const off = pose.pos.clone().sub(pose.target);
    const d = off.length();
    const [lon, lat] = this.proj.unproject(pose.target.x, pose.target.z);
    const h = this.container.clientHeight || 1;
    const fov = (this.camera.fov * Math.PI) / 180;
    const mpp = (d * 2 * Math.tan(fov / 2)) / h;
    const zoom = Math.log2((2 * Math.PI * 6378137 * Math.cos((lat * Math.PI) / 180)) / (512 * mpp));
    const bearing = ((Math.atan2(-off.x, off.z) * 180) / Math.PI + 360) % 360;
    const pitch = (Math.acos(off.y / d) * 180) / Math.PI;
    return { lon, lat, zoom, pitch, bearing, fov: this.camera.fov };
  }

  /** Inverse of mapPose(): put the 3D camera where a MapLibre camera is. */
  applyMapPose(p: { lon: number; lat: number; zoom: number; pitch: number; bearing: number }) {
    if (!this.proj) return;
    const [x, z] = this.proj.project([p.lon, p.lat]);
    const h = this.container.clientHeight || 1;
    const fov = (this.camera.fov * Math.PI) / 180;
    const mpp = (2 * Math.PI * 6378137 * Math.cos((p.lat * Math.PI) / 180)) / (512 * 2 ** p.zoom);
    const d = (mpp * h) / (2 * Math.tan(fov / 2));
    const b = (p.bearing * Math.PI) / 180, t = (p.pitch * Math.PI) / 180;
    // The globe takes the camera far beyond the usual zoom limit.
    this.controls.maxDistance = Infinity;
    this.controls.maxPolarAngle = Math.PI / 2;
    this.controls.target.set(x, 0, z);
    this.camera.position.set(x - Math.sin(b) * Math.sin(t) * d, Math.cos(t) * d, z + Math.cos(b) * Math.sin(t) * d);
    this.camera.far = Math.max(20000, d * 3);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /** Puts back a saved camera exactly. */
  restoreView(v: { pos: THREE.Vector3; target: THREE.Vector3 }) {
    this.camera.position.copy(v.pos);
    this.controls.target.copy(v.target);
    this.camera.far = 20000;
    this.controls.maxDistance = Math.max(this.size.width, this.size.depth) * 3;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /** Current camera pose, to come back to it later (space view, #24). */
  saveView() {
    return { pos: this.camera.position.clone(), target: this.controls.target.clone() };
  }

  /** Smoothly moves the camera (ease in-out). */
  animateCamera(pos: THREE.Vector3, target: THREE.Vector3, ms: number): Promise<void> {
    const p0 = this.camera.position.clone(), t0 = this.controls.target.clone();
    const start = performance.now();
    return new Promise((done) => {
      const step = () => {
        const k = Math.min(1, (performance.now() - start) / ms);
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        this.camera.position.lerpVectors(p0, pos, e);
        this.controls.target.lerpVectors(t0, target, e);
        this.controls.update();
        if (k < 1) requestAnimationFrame(step);
        else done();
      };
      step();
    });
  }

  /** Straight up above the model, for the take-off into space. */
  get skyPose() {
    const ext = Math.max(this.size.width, this.size.depth);
    return { pos: new THREE.Vector3(this.controls.target.x, ext * 4, this.controls.target.z + 0.01), target: this.controls.target.clone() };
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

  get currentMood(): Mood {
    return this.mood;
  }

  /** Camera bearing (deg from north, clockwise) and tilt from vertical (deg). */
  get view() {
    const off = this.viewOffset();
    const bearing = ((Math.atan2(-off.x, off.z) * 180) / Math.PI + 360) % 360;
    return { bearing, tilt: this.tiltDeg(off) };
  }

  /** Camera minus target, in a scratch vector (read every frame). */
  private viewOffset() {
    return this.viewOff.subVectors(this.camera.position, this.controls.target);
  }

  private tiltDeg(off = this.viewOffset()) {
    return (Math.acos(off.y / off.length()) * 180) / Math.PI;
  }

  async exportGLB(): Promise<Blob> {
    const exporter = new GLTFExporter();
    const root = this.city.clone();
    // Toy houses are shaped in the vertex shader, which a .glb cannot carry: bake each instance to real geometry.
    const toy: THREE.InstancedMesh[] = [];
    root.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).geometry.getAttribute('aCorner')) toy.push(o as THREE.InstancedMesh);
    });
    for (const im of toy) {
      im.parent!.add(bakeToyInstances(im, toyParamsFor(this.builtStyle)));
      im.removeFromParent();
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
    this.traffic?.update(dt);
    if (this.boats) this.boats.update(dt, (this.boatTime += dt));
    this.clouds?.update(dt);
    this.dome.mesh.position.copy(this.camera.position);
    this.pin.update(dt, this.camera);
    const now = performance.now();
    if (this.lightDirty && now - this.lastLightUpdate > 120) {
      this.lightDirty = false;
      this.lastLightUpdate = now;
      this.renderer.shadowMap.needsUpdate = true;
      if (this.builtStyle === 'real' && this.light) this.realism.update(this.scene, this.sunDir, this.night, this.cloud, this.light, this.lastSky, this.weather.grey);
    }
    if (this.builtStyle === 'real') {
      realUniforms.uTime.value = this.timer.getElapsed();
      realUniforms.uWet.value += (this.wet - realUniforms.uWet.value) * Math.min(1, dt * 0.5);
      this.realism.sky.position.copy(this.camera.position);
    }
    if (this.details.length) {
      const near = this.camera.position.distanceTo(this.controls.target) < 700;
      if (this.details[0].visible !== near) {
        for (const d of this.details) d.visible = near;
        this.renderer.shadowMap.needsUpdate = true;
      }
    }
    if (this.weather.lightning) this.updateLightning(now);
    if (this.rain) {
      const p = this.rain.geometry.attributes.position as THREE.BufferAttribute;
      const half = this.size.width / 2;
      const drift = dt * 60 * this.weather.slant;
      for (let i = 0; i < p.count; i++) {
        let y = p.getY(i) - dt * 60;
        if (y < 0) y += 220;
        let x = p.getX(i) + drift;
        if (x > half) x -= this.size.width;
        p.setX(i, x);
        p.setY(i, y);
      }
      p.needsUpdate = true;
    }
    if (this.paused) return;
    // Pixel mode stays as it was: no tilt-shift blur.
    const tilt = this.pixelMode ? 0 : tiltShiftStrength(this.tiltDeg());
    this.tiltH.enabled = this.tiltV.enabled = tilt > 0;
    this.tiltH.uniforms.h.value = this.tiltBase.h * tilt;
    this.tiltV.uniforms.v.value = this.tiltBase.v * tilt;
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
    this.scene.remove(this.dome.mesh, this.realism.sky);
    this.dome.dispose();
    this.realism.dispose();
    this.gtao.dispose();
    this.renderer.dispose();
  }
}
