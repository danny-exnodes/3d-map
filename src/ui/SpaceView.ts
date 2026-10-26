import { Map as MapLibreMap, Marker } from 'maplibre-gl';

/**
 * Space view (#24): rise from the 3D model into orbit and look at the whole Earth, which can be
 * spun by dragging and slowly turns on its own. Closing falls back down to the same place.
 * Globe projection from MapLibre, NASA GIBS Blue Marble imagery (public domain, CORS).
 */
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg';

export class SpaceView {
  private el: HTMLDivElement;
  private map: MapLibreMap | null = null;
  private spin = 0;
  private home: [number, number] = [0, 0];
  private marker: Marker | null = null;
  open = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'space-view';
    this.el.hidden = true;
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

  private ensureMap() {
    if (this.map) return this.map;
    const map = new MapLibreMap({
      container: this.el.querySelector<HTMLDivElement>('.space-map')!,
      style: {
        version: 8,
        projection: { type: 'globe' },
        sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 0.6, 10, 0] },
        sources: { earth: { type: 'raster', tiles: [GIBS], tileSize: 256, maxzoom: 8, attribution: 'Imagery © NASA EOSDIS GIBS (Blue Marble)' } },
        layers: [{ id: 'earth', type: 'raster', source: 'earth' }],
      },
      center: this.home,
      zoom: 12,
      attributionControl: { compact: true },
    });
    map.on('mousedown', () => this.stopSpin());
    map.on('touchstart', () => this.stopSpin());
    map.on('mouseup', () => this.startSpin());
    map.on('touchend', () => this.startSpin());
    this.map = map;
    return map;
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

  /** Fades in at the area and flies out to orbit. */
  async show(lon: number, lat: number, bearing: number) {
    this.home = [lon, lat];
    this.el.hidden = false;
    this.drawStars();
    const map = this.ensureMap();
    map.resize();
    map.jumpTo({ center: this.home, zoom: 11, bearing, pitch: 0 });
    (this.marker ??= new Marker({ color: '#ff7a45' }).setLngLat(this.home).addTo(map)).setLngLat(this.home);
    requestAnimationFrame(() => this.el.classList.add('on'));
    this.open = true;
    await new Promise((r) => setTimeout(r, 450));
    map.flyTo({ center: [lon, lat * 0.6], zoom: 1.4, bearing: 0, duration: 4200, curve: 1.6, essential: true });
    await new Promise((r) => map.once('moveend', r));
    if (this.open) this.startSpin();
  }

  /** Falls back down to the area, then fades out. */
  async hide(bearing: number) {
    if (!this.map || !this.open) return;
    this.open = false;
    this.stopSpin();
    this.map.flyTo({ center: this.home, zoom: 11, bearing, duration: 3800, curve: 1.6, essential: true });
    await new Promise((r) => this.map!.once('moveend', r));
    this.el.classList.remove('on');
    await new Promise((r) => setTimeout(r, 450));
    this.el.hidden = true;
  }
}
