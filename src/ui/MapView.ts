import { type GeoJSONSource, LngLat, Map as MapLibreMap, Marker, NavigationControl, ScaleControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// Let Vite bundle MapLibre's module worker (its default URL lookup breaks after bundling).
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(workerUrl);
import { DEFAULT_LOCATION } from '../config';
import type { BBox } from '../data/types';

import { OFM_STYLE } from '../data/openfreemap';

/** OpenFreeMap dark style (OSM data, no key, no rate limit — #17). */
const STYLE = OFM_STYLE;
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** 2D map where the user searches a place and drags a rectangle to choose the area. */
export class MapView {
  readonly map: MapLibreMap;
  private drawing = false;
  private start: LngLat | null = null;
  private marker: Marker | null = null;
  bbox: BBox | null = null;
  private ward: GeoJSON.Feature | null = null;
  onChange?: (b: BBox | null) => void;

  constructor(
    container: HTMLElement,
    center: [number, number] = [DEFAULT_LOCATION.lon, DEFAULT_LOCATION.lat],
    zoom = 15,
    basemap: 'carto' | 'offline' = 'carto',
  ) {
    // The offline style needs no network (preview build): a plain background, no tiles.
    const style = basemap === 'offline' ? { version: 8 as const, sources: {}, layers: [{ id: 'bg', type: 'background' as const, paint: { 'background-color': '#0d0f17' } }] } : STYLE;
    this.map = new MapLibreMap({ container, style, center, zoom, attributionControl: { compact: true } });
    this.map.addControl(new NavigationControl({ showCompass: true }), 'bottom-right');
    this.map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    // Prefer Vietnamese names on the basemap.
    this.map.on('style.load', () => {
      for (const layer of this.map.getStyle().layers ?? []) {
        if (layer.type === 'symbol' && this.map.getLayoutProperty(layer.id, 'text-field')) {
          this.map.setLayoutProperty(layer.id, 'text-field', ['coalesce', ['get', 'name:vi'], ['get', 'name']]);
        }
      }
    });
    this.map.on('load', () => {
      this.map.addSource('selection', { type: 'geojson', data: EMPTY });
      this.map.addLayer({ id: 'sel-fill', type: 'fill', source: 'selection', paint: { 'fill-color': '#ff7a45', 'fill-opacity': 0.18 } });
      this.map.addLayer({ id: 'sel-line', type: 'line', source: 'selection', paint: { 'line-color': '#ff7a45', 'line-width': 2 } });
      // Ward outline for the offline download picker (#18).
      this.map.addSource('ward', { type: 'geojson', data: this.ward ?? EMPTY });
      this.map.addLayer({ id: 'ward-fill', type: 'fill', source: 'ward', paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.08 } }, 'sel-fill');
      this.map.addLayer({ id: 'ward-line', type: 'line', source: 'ward', paint: { 'line-color': '#60a5fa', 'line-width': 2, 'line-dasharray': [2, 1] } }, 'sel-fill');
      if (this.bbox) this.render();
    });

    const canvas = this.map.getCanvasContainer();
    // Shift+drag draws a rectangle directly (instead of MapLibre's box zoom), and the ▭ mode
    // draws with mouse or finger (#23).
    this.map.boxZoom.disable();
    const begin = (e: { lngLat: LngLat; preventDefault(): void; originalEvent: Event }) => {
      const shift = (e.originalEvent as MouseEvent).shiftKey;
      if (!this.drawing && !shift) return;
      if (shift && !this.drawing) this.setDrawing(true);
      e.preventDefault();
      this.start = e.lngLat;
    };
    const move = (e: { lngLat: LngLat }) => {
      if (!this.drawing || !this.start) return;
      this.setBBox(this.fromCorners(this.start, e.lngLat), false);
    };
    const end = (e: { lngLat: LngLat }) => {
      if (!this.drawing || !this.start) return;
      const b = this.fromCorners(this.start, e.lngLat);
      this.start = null;
      this.setDrawing(false);
      if (Math.abs(b.east - b.west) > 1e-5 && Math.abs(b.north - b.south) > 1e-5) this.setBBox(b);
      else this.render();
    };
    this.map.on('mousedown', begin);
    this.map.on('mousemove', move);
    this.map.on('mouseup', end);
    this.map.on('touchstart', (e) => e.points.length === 1 && begin(e));
    this.map.on('touchmove', (e) => this.drawing && this.start && (e.preventDefault(), move(e)));
    this.map.on('touchend', (e) => end(e));
    this.enableBodyDrag();
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
    if (on) (this.map.dragPan.disable(), this.map.touchZoomRotate.disable());
    else (this.map.dragPan.enable(), this.map.touchZoomRotate.enable());
    this.map.getCanvas().style.cursor = on ? 'crosshair' : '';
    this.updateHandles();
  }

  /** Area limit (km²): bigger selections are drawn in red. */
  maxKm2 = Infinity;

  private handles: Marker[] = [];

  /**
   * Draggable corner handles resize the selection, the centre handle moves it. Markers work
   * with mouse and touch alike.
   */
  private updateHandles() {
    const b = this.bbox;
    if (!b || this.drawing) {
      for (const h of this.handles) h.remove();
      this.handles = [];
      return;
    }
    if (!this.handles.length) {
      const make = (cls: string, title: string) => {
        const el = document.createElement('div');
        el.className = `sel-handle ${cls}`;
        el.title = title;
        return new Marker({ element: el, draggable: true }).setLngLat([0, 0]).addTo(this.map);
      };
      // 0 SW, 1 SE, 2 NE, 3 NW, 4 centre.
      for (let i = 0; i < 4; i++) this.handles.push(make('corner', 'Kéo để đổi kích thước vùng'));
      this.handles.push(make('centre', 'Kéo để di chuyển vùng'));
      this.handles.forEach((h, i) => {
        h.on('dragstart', () => (this.dragFrom = this.bbox && { ...this.bbox }));
        h.on('drag', () => this.dragHandle(i, h.getLngLat(), false));
        h.on('dragend', () => this.dragHandle(i, h.getLngLat(), true));
      });
    }
    this.placeHandles();
  }

  /** Moves the handles to the selection's corners and centre, except the one being dragged. */
  private placeHandles(skip = -1) {
    const b = this.bbox;
    if (!b || this.handles.length < 5) return;
    const pts: [number, number][] = [[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [(b.west + b.east) / 2, (b.south + b.north) / 2]];
    this.handles.forEach((h, i) => i !== skip && h.setLngLat(pts[i]));
  }

  /** Selection when the current drag started: the anchor corner comes from it, not from the moving box. */
  private dragFrom: BBox | null = null;

  private dragHandle(i: number, p: LngLat, done: boolean) {
    const b = this.dragFrom ?? this.bbox;
    if (!b) return;
    let n: BBox;
    if (i === 4) {
      const dx = p.lng - (b.west + b.east) / 2, dy = p.lat - (b.south + b.north) / 2;
      n = { west: b.west + dx, east: b.east + dx, south: b.south + dy, north: b.north + dy };
    } else {
      // The opposite corner stays put.
      const opp = [[b.east, b.north], [b.west, b.north], [b.west, b.south], [b.east, b.south]][i];
      n = { west: Math.min(p.lng, opp[0]), east: Math.max(p.lng, opp[0]), south: Math.min(p.lat, opp[1]), north: Math.max(p.lat, opp[1]) };
    }
    this.commitMove(n, done, done ? -1 : i);
  }

  private commitMove(n: BBox, done: boolean, skip = -1) {
    this.bbox = n;
    this.render(false);
    this.placeHandles(skip);
    if (done) {
      this.dragFrom = null;
      this.onChange?.(n);
    } else this.onPreview?.(n);
  }

  /** Dragging inside the selection moves it (mouse and one finger). */
  private enableBodyDrag() {
    let from: { p: LngLat; b: BBox } | null = null;
    const inside = (p: LngLat) => !!this.bbox && p.lng >= this.bbox.west && p.lng <= this.bbox.east && p.lat >= this.bbox.south && p.lat <= this.bbox.north;
    const down = (e: { lngLat: LngLat; preventDefault(): void; originalEvent: Event }) => {
      if (this.drawing || (e.originalEvent as MouseEvent).shiftKey || !this.bbox || !inside(e.lngLat)) return;
      e.preventDefault();
      from = { p: e.lngLat, b: { ...this.bbox } };
      this.map.dragPan.disable();
      this.map.getCanvas().style.cursor = 'grabbing';
    };
    const move = (e: { lngLat: LngLat }) => {
      if (!from) {
        if (!this.drawing) this.map.getCanvas().style.cursor = this.bbox && inside(e.lngLat) ? 'grab' : '';
        return;
      }
      const dx = e.lngLat.lng - from.p.lng, dy = e.lngLat.lat - from.p.lat;
      const b = from.b;
      this.commitMove({ west: b.west + dx, east: b.east + dx, south: b.south + dy, north: b.north + dy }, false);
    };
    const up = () => {
      if (!from) return;
      const moved = this.bbox;
      const same = moved && moved.west === from.b.west && moved.south === from.b.south;
      from = null;
      this.map.dragPan.enable();
      this.map.getCanvas().style.cursor = '';
      if (moved && !same) this.commitMove(moved, true);
    };
    this.map.on('mousedown', down);
    this.map.on('mousemove', move);
    this.map.on('mouseup', up);
    this.map.on('touchstart', (e) => e.points.length === 1 && down(e));
    this.map.on('touchmove', (e) => from && (e.preventDefault(), move(e)));
    this.map.on('touchend', up);
  }

  /** Called while a handle is being dragged (no rebuild yet). */
  onPreview?: (b: BBox) => void;

  get isDrawing() {
    return this.drawing;
  }

  setBBox(b: BBox | null, notify = true) {
    this.bbox = b;
    this.render();
    if (notify) this.onChange?.(b);
  }

  private render(handles = true) {
    if (handles) this.updateHandles();
    const src = this.map.getSource('selection') as GeoJSONSource | undefined;
    if (!src) return;
    const b = this.bbox;
    const tooBig = !!b && areaKm2(b) > this.maxKm2;
    this.map.setPaintProperty('sel-fill', 'fill-color', tooBig ? '#ef4444' : '#ff7a45');
    this.map.setPaintProperty('sel-line', 'line-color', tooBig ? '#ef4444' : '#ff7a45');
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

  /** Outlines a ward (MultiPolygon coordinates) or clears it. */
  setWard(polygon: number[][][][] | null) {
    this.ward = polygon ? { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: polygon } } : null;
    (this.map.getSource('ward') as GeoJSONSource | undefined)?.setData(this.ward ?? EMPTY);
  }

  /** Last place shown with a labelled marker (search result, own position, default place). */
  place: { lon: number; lat: number; label: string } | null = null;

  flyTo(lon: number, lat: number, label?: string, zoom = 16) {
    if (label) this.place = { lon, lat, label };
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
    return bboxAround(c.lng, c.lat, halfMeters);
  }

  resize() {
    this.map.resize();
  }

  /** Keeps the map sized to its pane (split view resizes it, #23). */
  observeResize() {
    new ResizeObserver(() => this.map.resize()).observe(this.map.getContainer());
  }
}

/** Square bbox of ±halfMeters around a point. */
export function bboxAround(lon: number, lat: number, halfMeters = 400): BBox {
  const dLat = halfMeters / 110_574;
  const dLon = halfMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
}

function areaKm2(b: BBox): number {
  const lat = ((b.south + b.north) / 2) * (Math.PI / 180);
  return (b.east - b.west) * 111.32 * Math.cos(lat) * (b.north - b.south) * 110.574;
}
