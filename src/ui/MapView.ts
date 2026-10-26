import { type GeoJSONSource, LngLat, Map as MapLibreMap, Marker, NavigationControl, ScaleControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// Let Vite bundle MapLibre's module worker (its default URL lookup breaks after bundling).
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(workerUrl);
import type { BBox } from '../data/types';

const STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** 2D map where the user searches a place and drags a rectangle to choose the area. */
export class MapView {
  readonly map: MapLibreMap;
  private drawing = false;
  private start: LngLat | null = null;
  private marker: Marker | null = null;
  bbox: BBox | null = null;
  onChange?: (b: BBox | null) => void;

  constructor(container: HTMLElement, center: [number, number] = [105.8196, 21.0032], zoom = 15) {
    this.map = new MapLibreMap({ container, style: STYLE, center, zoom, attributionControl: { compact: true } });
    this.map.addControl(new NavigationControl({ showCompass: true }), 'bottom-right');
    this.map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.map.on('load', () => {
      this.map.addSource('selection', { type: 'geojson', data: EMPTY });
      this.map.addLayer({ id: 'sel-fill', type: 'fill', source: 'selection', paint: { 'fill-color': '#ff7a45', 'fill-opacity': 0.18 } });
      this.map.addLayer({ id: 'sel-line', type: 'line', source: 'selection', paint: { 'line-color': '#ff7a45', 'line-width': 2 } });
      if (this.bbox) this.render();
    });

    const canvas = this.map.getCanvasContainer();
    this.map.on('mousedown', (e) => {
      if (!this.drawing) return;
      e.preventDefault();
      this.start = e.lngLat;
    });
    this.map.on('mousemove', (e) => {
      if (!this.drawing || !this.start) return;
      this.setBBox(this.fromCorners(this.start, e.lngLat), false);
    });
    this.map.on('mouseup', (e) => {
      if (!this.drawing || !this.start) return;
      const b = this.fromCorners(this.start, e.lngLat);
      this.start = null;
      this.setDrawing(false);
      if (Math.abs(b.east - b.west) > 1e-5 && Math.abs(b.north - b.south) > 1e-5) this.setBBox(b);
    });
    canvas.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') this.setDrawing(false);
    });
  }

  private fromCorners(a: LngLat, b: LngLat): BBox {
    return {
      west: Math.min(a.lng, b.lng),
      east: Math.max(a.lng, b.lng),
      south: Math.min(a.lat, b.lat),
      north: Math.max(a.lat, b.lat),
    };
  }

  setDrawing(on: boolean) {
    this.drawing = on;
    if (on) this.map.dragPan.disable();
    else this.map.dragPan.enable();
    this.map.getCanvas().style.cursor = on ? 'crosshair' : '';
  }

  get isDrawing() {
    return this.drawing;
  }

  setBBox(b: BBox | null, notify = true) {
    this.bbox = b;
    this.render();
    if (notify) this.onChange?.(b);
  }

  private render() {
    const src = this.map.getSource('selection') as GeoJSONSource | undefined;
    if (!src) return;
    const b = this.bbox;
    src.setData(
      b
        ? {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'Polygon',
              coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]],
            },
          }
        : EMPTY,
    );
  }

  flyTo(lon: number, lat: number, label?: string, zoom = 16) {
    this.map.flyTo({ center: [lon, lat], zoom, essential: true });
    this.marker?.remove();
    if (label) {
      const el = document.createElement('div');
      el.className = 'place-marker';
      el.innerHTML = `<span class="dot"></span><span class="txt"></span>`;
      el.querySelector('.txt')!.textContent = label;
      this.marker = new Marker({ element: el, anchor: 'top' }).setLngLat([lon, lat]).addTo(this.map);
    }
  }

  fitBBox(b: BBox) {
    this.map.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 80, duration: 800 });
  }

  /** A default ~800×800 m rectangle around the current map centre. */
  bboxAroundCenter(halfMeters = 400): BBox {
    const c = this.map.getCenter();
    const dLat = halfMeters / 110_574;
    const dLon = halfMeters / (111_320 * Math.cos((c.lat * Math.PI) / 180));
    return { south: c.lat - dLat, north: c.lat + dLat, west: c.lng - dLon, east: c.lng + dLon };
  }

  resize() {
    this.map.resize();
  }
}
