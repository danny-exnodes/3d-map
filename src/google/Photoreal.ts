import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin, GoogleCloudAuthPlugin, ReorientationPlugin, TileCompressionPlugin, TilesFadePlugin } from '3d-tiles-renderer/plugins';
import { LocationPin } from '../scene/locationPin';

const DEG = Math.PI / 180;
const LOGO = 'https://maps.gstatic.com/mapfiles/api-3/images/google_white5_hdpi.png';

/**
 * Google Photorealistic 3D Tiles around a chosen place (v0.0.5). The tileset is re-oriented so
 * the place sits at the origin with +Y up, which lets the same MapControls as the OSM builder
 * drive the camera in metres.
 */
export class Photoreal {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 1, 160_000);
  readonly controls: MapControls;
  private tiles: TilesRenderer;
  private reorient: ReorientationPlugin;
  private pin = new LocationPin();
  private pinLonLat: [number, number] | null = null;
  private raycaster = new THREE.Raycaster();
  /** Ground height under the origin is unknown until the tiles load; found by ray casting. */
  private groundFound = false;
  private timer = new THREE.Timer();
  onMove?: (lon: number, lat: number, viewRadius: number) => void;
  onPick?: (lon: number, lat: number) => void;
  onAttributions?: (text: string) => void;
  onError?: (e: Error) => void;

  constructor(
    private canvas: HTMLCanvasElement,
    key: string,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.scene.background = new THREE.Color('#bcd3ea');
    this.controls = new MapControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = 0.47 * Math.PI;
    this.controls.minDistance = 20;
    this.controls.maxDistance = 20_000;
    this.controls.screenSpacePanning = false;

    this.tiles = new TilesRenderer();
    this.tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true, logoUrl: LOGO }));
    const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
    this.tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
    this.tiles.registerPlugin(new TileCompressionPlugin());
    this.tiles.registerPlugin(new TilesFadePlugin());
    this.reorient = new ReorientationPlugin({ up: '+y', recenter: true, lat: 0, lon: 0, height: 0 });
    this.tiles.registerPlugin(this.reorient);
    this.tiles.setCamera(this.camera);
    this.tiles.addEventListener('load-error', (e: { error?: Error }) => e.error && this.onError?.(e.error));
    this.scene.add(this.tiles.group, this.pin.group);

    canvas.addEventListener('pointerdown', (e) => (this.down = [e.clientX, e.clientY]));
    canvas.addEventListener('pointerup', (e) => {
      if (!this.down || Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) > 4) return;
      const hit = this.hitAt(e.clientX, e.clientY);
      if (hit) {
        const [lon, lat] = this.toLonLat(hit);
        this.onPick?.(lon, lat);
      }
    });
    this.controls.addEventListener('change', () => this.emitMove());
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    this.resize();
    this.renderer.setAnimationLoop(this.loop);
  }

  private down: [number, number] | null = null;

  /** Puts `lon, lat` at the origin and looks at it from `distance` metres. */
  goTo(lon: number, lat: number, distance = 650) {
    this.reorient.transformLatLonHeightToOrigin(lat * DEG, lon * DEG, 0);
    this.groundFound = false;
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(0, distance * 0.62, distance * 0.78);
    this.controls.update();
    this.placePin();
  }

  setPin(lonLat: [number, number] | null) {
    this.pinLonLat = lonLat;
    this.placePin();
  }

  private placePin() {
    if (!this.pinLonLat) return this.pin.hide();
    const v = this.fromLonLat(this.pinLonLat[0], this.pinLonLat[1]);
    if (v.length() > 30_000) return this.pin.hide();
    const g = this.groundY(v.x, v.z);
    this.pin.set(v.x, v.z);
    if (g != null) this.pin.group.position.y = g + 0.3;
  }

  /** Local position of a geographic point (on the ellipsoid; y is fixed up by ray casting). */
  private fromLonLat(lon: number, lat: number): THREE.Vector3 {
    const v = this.tiles.ellipsoid.getCartographicToPosition(lat * DEG, lon * DEG, 0, new THREE.Vector3());
    this.tiles.group.updateMatrixWorld();
    return v.applyMatrix4(this.tiles.group.matrixWorld);
  }

  private toLonLat(p: THREE.Vector3): [number, number] {
    this.tiles.group.updateMatrixWorld();
    const local = p.clone().applyMatrix4(this.tiles.group.matrixWorld.clone().invert());
    const c = this.tiles.ellipsoid.getPositionToCartographic(local, {});
    return [c.lon / DEG, c.lat / DEG];
  }

  private hitAt(cx: number, cy: number): THREE.Vector3 | null {
    const r = this.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), this.camera);
    (this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
    return this.raycaster.intersectObject(this.tiles.group, true)[0]?.point ?? null;
  }

  private groundY(x: number, z: number): number | null {
    this.raycaster.set(new THREE.Vector3(x, 3000, z), new THREE.Vector3(0, -1, 0));
    (this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
    return this.raycaster.intersectObject(this.tiles.group, true)[0]?.point.y ?? null;
  }

  private emitMove() {
    const [lon, lat] = this.toLonLat(this.controls.target);
    this.onMove?.(lon, lat, this.camera.position.distanceTo(this.controls.target));
  }

  private resize() {
    const p = this.canvas.parentElement!;
    const w = p.clientWidth, h = p.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.tiles.setResolutionFromRenderer(this.camera, this.renderer);
  }

  private lastAttr = '';
  private frames = 0;

  private loop = () => {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.controls.update();
    this.camera.updateMatrixWorld();
    this.tiles.update();
    this.frames++;
    if (!this.groundFound && this.frames % 15 === 0) {
      // Lift the orbit target (and pin) onto the real ground once tiles under it arrive.
      const g = this.groundY(this.controls.target.x, this.controls.target.z);
      if (g != null) {
        this.groundFound = true;
        const dy = g - this.controls.target.y;
        this.controls.target.y += dy;
        this.camera.position.y += dy;
        this.placePin();
      }
    }
    this.pin.update(dt, this.camera);
    this.renderer.render(this.scene, this.camera);
    if (this.frames % 30 === 0) {
      const text = this.tiles
        .getAttributions()
        .filter((a) => a.type === 'string')
        .map((a) => String(a.value))
        .join(' · ');
      if (text !== this.lastAttr) this.onAttributions?.((this.lastAttr = text));
    }
  };
}
