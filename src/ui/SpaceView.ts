import { Map as MapLibreMap, Marker } from 'maplibre-gl';

/**
 * Space view (#24, #29): from the 3D model up to orbit and back in one continuous move.
 *
 * The globe (MapLibre, globe projection) is created and warmed up in the background after a
 * build, so nothing loads at the moment of the switch. It starts exactly at the 3D camera
 * (same centre, distance, pitch, bearing and field of view); while it flies out, the 3D camera
 * follows it frame by frame and the model cross-fades into satellite imagery of the same place.
 * Coming back runs the same in reverse and ends on the saved camera.
 *
 * Imagery: Sentinel-2 cloudless 2016 by EOX (CC BY 4.0) up close, NASA GIBS Blue Marble
 * (public domain) for the whole Earth.
 */
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg';
const EOX = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg';

export interface MapPose {
  lon: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
  fov?: number;
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export class SpaceView {
  private el: HTMLDivElement;
  private map: MapLibreMap | null = null;
  private spin = 0;
  private marker: Marker | null = null;
  open = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'space-view';
    this.el.innerHTML = '<canvas class="stars"></canvas><div class="space-map"></div><div class="space-hint">Kéo để xoay trái đất · bấm 🌍 để quay về</div>';
    parent.appendChild(this.el);
  }

  private drawStars() {
    const c = this.el.querySelector<HTMLCanvasElement>('.stars')!;
    const w = (c.width = this.el.clientWidth), h = (c.height = this.el.clientHeight);
    const g = c.getContext('2d')!;
    g.fillStyle = '#02030a';
    g.fillRect(0, 0, w, h);
    let s = 7;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < (w * h) / 900; i++) {
      const a = r() ** 3;
      g.fillStyle = `rgba(${200 + r() * 55},${210 + r() * 45},255,${0.25 + a * 0.75})`;
      g.fillRect(r() * w, r() * h, a > 0.6 ? 2 : 1, a > 0.6 ? 2 : 1);
    }
  }

  /**
   * Builds the globe out of sight and loads the imagery around `pose` and of the whole Earth,
   * so the later switch has nothing left to load.
   */
  async prepare(pose: MapPose) {

    const map = this.ensureMap();
    await this.ready;
    map.jumpTo({ center: [pose.lon, pose.lat], zoom: pose.zoom, pitch: pose.pitch, bearing: pose.bearing });
    this.placeMarker(map, pose);
    // Whole-Earth tiles into the HTTP cache.
    for (let z = 0; z <= 2; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) void fetch(GIBS.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))).catch(() => {});
  }

  private placeMarker(map: MapLibreMap, p: MapPose) {
    if (this.marker) this.marker.setLngLat([p.lon, p.lat]);
    else this.marker = new Marker({ color: '#ff7a45' }).setLngLat([p.lon, p.lat]).addTo(map);
  }

  /** Resolves once the globe style is loaded (camera calls before that fail in MapLibre). */
  private ready: Promise<void> | null = null;

  private ensureMap() {
    if (this.map) return this.map;
    const map = new MapLibreMap({
      container: this.el.querySelector<HTMLDivElement>('.space-map')!,
      style: {
        version: 8,
        projection: { type: 'globe' },
        sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 0.5, 9, 0] },
        sources: {
          earth: { type: 'raster', tiles: [GIBS], tileSize: 256, maxzoom: 8, attribution: 'NASA EOSDIS GIBS (Blue Marble)' },
          s2: { type: 'raster', tiles: [EOX], tileSize: 256, maxzoom: 15, attribution: 'Sentinel-2 cloudless 2016 by EOX (CC BY 4.0)' },
        },
        layers: [
          { id: 'earth', type: 'raster', source: 'earth' },
          { id: 's2', type: 'raster', source: 's2', paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0, 7.5, 1] } },
        ],
      },
      center: [0, 0],
      zoom: 2,
      maxPitch: 85,
      fadeDuration: 0,
      attributionControl: { compact: true },
    });
    this.ready = new Promise((r) => map.once('load', () => r()));
    void this.ready.then(() => map.setVerticalFieldOfView(35));
    map.on('mousedown', () => this.stopSpin());
    map.on('touchstart', () => this.stopSpin());
    map.on('mouseup', () => this.open && this.startSpin());
    map.on('touchend', () => this.open && this.startSpin());
    this.map = map;
    this.drawStars();
    return map;
  }

  private pose(): MapPose {
    const m = this.map!;
    const c = m.getCenter();
    return { lon: c.lng, lat: c.lat, zoom: m.getZoom(), pitch: m.getPitch(), bearing: m.getBearing() };
  }

  private startSpin() {
    this.stopSpin();
    let last = performance.now();
    const step = (t: number) => {
      const m = this.map!;
      const c = m.getCenter();
      // One turn in about 90 s.
      m.setCenter([c.lng + ((t - last) / 1000) * 4, c.lat]);
      last = t;
      this.spin = requestAnimationFrame(step);
    };
    this.spin = requestAnimationFrame(step);
  }

  private stopSpin() {
    cancelAnimationFrame(this.spin);
    this.spin = 0;
  }

  private setOpacity(o: number) {
    this.el.style.opacity = String(o);
    this.el.classList.toggle('on', o > 0.5);
  }

  /**
   * Takes over from the 3D camera at `from` and flies to orbit. `follow` is called with the globe
   * camera every frame while the model is still visible underneath.
   */
  async show(from: MapPose, follow: (p: MapPose) => void) {
    const map = this.ensureMap();
    this.open = true;
    await this.ready;
    if (from.fov) map.setVerticalFieldOfView(from.fov);
    map.resize();
    map.jumpTo({ center: [from.lon, from.lat], zoom: from.zoom, pitch: from.pitch, bearing: from.bearing });
    this.placeMarker(map, from);
    this.el.classList.add('active');
    const start = performance.now();
    const fadeMs = 1600;
    const onMove = () => {
      const k = Math.min(1, (performance.now() - start) / fadeMs);
      this.setOpacity(ease(k));
      if (k < 1) follow(this.pose());
    };
    map.on('move', onMove);
    map.flyTo({ center: [from.lon, from.lat * 0.6], zoom: 1.4, pitch: 0, bearing: 0, duration: 5200, curve: 1.5, essential: true });
    await new Promise((r) => map.once('moveend', r));
    map.off('move', onMove);
    this.setOpacity(1);
    if (this.open) this.startSpin();
  }

  /** Flies back down to `to` (the saved 3D camera); `follow` drives the model as it fades back in. */
  async hide(to: MapPose, follow: (p: MapPose) => void) {
    const map = this.map;
    if (!map || !this.open) return;
    this.open = false;
    this.stopSpin();
    const onMove = () => {
      const p = this.pose();
      // The model fades back in over the last two zoom levels of the descent.
      const k = Math.min(1, Math.max(0, (to.zoom - p.zoom) / 2));
      this.setOpacity(ease(k));
      if (k < 1) follow(p);
    };
    map.on('move', onMove);
    map.flyTo({ center: [to.lon, to.lat], zoom: to.zoom, pitch: to.pitch, bearing: to.bearing, duration: 4800, curve: 1.5, essential: true });
    await new Promise((r) => map.once('moveend', r));
    map.off('move', onMove);
    this.setOpacity(0);
    this.el.classList.remove('active');
  }
}
