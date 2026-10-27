import '../style.css';
import './google.css';
import { Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { DEFAULT_LOCATION } from '../config';
import { googleKey, setGoogleKey } from '../data/googleTraffic';
import { getBrowserPosition, permissionDenied } from '../services/location';
import { createTileSession, googleMapsLink, reverseGeocodeGoogle, searchPlace, tileUrl, viewportCopyright, type TileSession } from './gmaps';
import { Photoreal } from './Photoreal';

/**
 * Google version (v0.0.5): Google's 2D map and live traffic on the left, Google Photorealistic
 * 3D Tiles on the right, Google geocoding for search and addresses. Everything runs with the
 * user's own key; without one the page offers the OpenStreetMap builder at ./openstreetmap/.
 */
setWorkerUrl(workerUrl);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function status(text: string | null, error = false) {
  const el = $('g-status');
  el.hidden = !text;
  el.textContent = text ?? '';
  el.classList.toggle('error', error);
}

/** Start point: #at=lat,lon or #bbox=s,w,n,e (links from the OSM version), else the default. */
function startFromHash(): [number, number] | null {
  const at = /at=([-\d.]+),([-\d.]+)/.exec(location.hash);
  if (at) return [Number(at[2]), Number(at[1])];
  const b = /bbox=([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)/.exec(location.hash);
  if (b) return [(Number(b[2]) + Number(b[4])) / 2, (Number(b[1]) + Number(b[3])) / 2];
  return null;
}

function askKey(message?: string) {
  $('g-keybox').hidden = false;
  const input = $<HTMLInputElement>('g-keyinput');
  input.value = googleKey() ?? '';
  if (message) input.placeholder = message;
  input.focus();
}

$('g-keyform').addEventListener('submit', (e) => {
  e.preventDefault();
  const k = $<HTMLInputElement>('g-keyinput').value.trim();
  if (!k) return;
  setGoogleKey(k);
  // A fresh page start is the simplest way to re-create every Google session with the new key.
  location.reload();
});
$('g-key').addEventListener('click', () => askKey());

const key = googleKey();
if (!key) askKey();
else void start(key);

async function start(key: string) {
  const here = startFromHash() ?? [DEFAULT_LOCATION.lon, DEFAULT_LOCATION.lat];
  const view = new Photoreal($<HTMLCanvasElement>('g-canvas'), key);
  view.goTo(here[0], here[1]);
  const osmLink = (lon: number, lat: number) =>
    ($<HTMLAnchorElement>('g-osm').href = `./openstreetmap/#bbox=${(lat - 0.0036).toFixed(5)},${(lon - 0.0036).toFixed(5)},${(lat + 0.0036).toFixed(5)},${(lon + 0.0036).toFixed(5)}`);
  osmLink(here[0], here[1]);
  view.onError = () => status('Không tải được mô hình 3D Google. Kiểm tra key đã bật Map Tiles API và billing chưa (🔑 để đổi key).', true);
  view.onAttributions = (t) => ($('g-attr-text').textContent = t);

  // ---- 2D map ----
  let base: TileSession, traffic: TileSession | null = null;
  try {
    base = await createTileSession(key);
    traffic = await createTileSession(key, { layerTypes: ['layerTraffic'], overlay: true }).catch(() => null);
  } catch (e) {
    status(`${(e as Error).message}. Bật Map Tiles API cho key này, hoặc dùng bản OpenStreetMap.`, true);
    return;
  }
  const style: StyleSpecification = {
    version: 8,
    sources: {
      g: { type: 'raster', tiles: [tileUrl(key, base)], tileSize: 256, maxzoom: 22 },
      ...(traffic ? { t: { type: 'raster' as const, tiles: [tileUrl(key, traffic)], tileSize: 256, maxzoom: 22 } } : {}),
      view: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      { id: 'g', type: 'raster', source: 'g' },
      ...(traffic ? [{ id: 't', type: 'raster' as const, source: 't' }] : []),
      { id: 'view-fill', type: 'fill', source: 'view', paint: { 'fill-color': '#ff7a45', 'fill-opacity': 0.12 } },
      { id: 'view-line', type: 'line', source: 'view', paint: { 'line-color': '#ff7a45', 'line-width': 2 } },
    ],
  };
  const map = new MapLibreMap({ container: $('g-map'), style, center: here, zoom: 16, attributionControl: { compact: false, customAttribution: 'Google' } });
  map.addControl(new NavigationControl({ showCompass: true }), 'bottom-right');
  if (!traffic) $('g-traffic').hidden = true;
  $('g-traffic').addEventListener('click', () => {
    const on = !$('g-traffic').classList.contains('on');
    $('g-traffic').classList.toggle('on', on);
    map.setLayoutProperty('t', 'visibility', on ? 'visible' : 'none');
  });

  // Copyright line for the visible 2D area (required by the Map Tiles API terms).
  const attrib = async () => {
    const b = map.getBounds();
    const c = await viewportCopyright(key, base, map.getZoom(), { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() }).catch(() => '');
    const el = $('g-map').querySelector('.maplibregl-ctrl-attrib-inner');
    if (el) el.textContent = c ? `Map data ${c}` : 'Google';
  };
  map.on('moveend', attrib);
  map.once('load', attrib);

  // Where the 3D camera looks, drawn on the 2D map; the map follows when it leaves the screen.
  const target = new Marker({ color: '#ff7a45' }).setLngLat(here).addTo(map);
  let moveTimer = 0;
  view.onMove = (lon, lat, dist) => {
    clearTimeout(moveTimer);
    moveTimer = window.setTimeout(() => {
      target.setLngLat([lon, lat]);
      const r = Math.min(dist * 0.6, 5000);
      const dLat = r / 110_574, dLon = r / (111_320 * Math.cos((lat * Math.PI) / 180));
      const ring: [number, number][] = [];
      for (let i = 0; i <= 48; i++) ring.push([lon + dLon * Math.cos((i / 48) * 2 * Math.PI), lat + dLat * Math.sin((i / 48) * 2 * Math.PI)]);
      (map.getSource('view') as GeoJSONSource | undefined)?.setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } });
      if (!map.getBounds().contains([lon, lat])) map.easeTo({ center: [lon, lat], duration: 600 });
      history.replaceState(null, '', `#at=${lat.toFixed(5)},${lon.toFixed(5)}`);
      osmLink(lon, lat);
    }, 120);
  };
  const go = (lon: number, lat: number, dist?: number) => {
    view.goTo(lon, lat, dist);
    target.setLngLat([lon, lat]);
    map.easeTo({ center: [lon, lat], duration: 800 });
  };
  map.on('click', (e) => go(e.lngLat.lng, e.lngLat.lat));

  // ---- Search ----
  $('g-search').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $<HTMLInputElement>('g-q').value.trim();
    if (!q) return;
    try {
      const p = await searchPlace(key, q);
      if (!p) return status(`Không tìm thấy “${q}”.`);
      status(null);
      const span = p.bounds ? Math.max((p.bounds[2] - p.bounds[0]) * 110_574, 200) : 600;
      go(p.lon, p.lat, Math.min(span * 1.4, 8000));
      if (p.bounds) map.fitBounds([[p.bounds[1], p.bounds[0]], [p.bounds[3], p.bounds[2]]], { padding: 40, maxZoom: 18 });
    } catch (err) {
      status(`Tìm kiếm lỗi: ${(err as Error).message}. Key cần bật Maps JavaScript API và Geocoding API.`, true);
    }
  });

  // ---- Address on click ----
  let pickSeq = 0;
  view.onPick = async (lon, lat) => {
    const seq = ++pickSeq;
    $('g-info').hidden = false;
    $('g-info-addr').textContent = 'Đang tìm địa chỉ…';
    const link = googleMapsLink({ lat, lon });
    $<HTMLAnchorElement>('g-info-addr').href = link;
    $<HTMLAnchorElement>('g-info-link').href = link;
    $('g-info-sub').textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    try {
      const p = await reverseGeocodeGoogle(key, lat, lon);
      if (seq !== pickSeq) return;
      $('g-info-addr').textContent = p?.address ?? 'Google không có địa chỉ cho điểm này';
      if (p) {
        const l = googleMapsLink({ lat, lon, placeId: p.placeId });
        $<HTMLAnchorElement>('g-info-addr').href = l;
        $<HTMLAnchorElement>('g-info-link').href = l;
      }
    } catch (err) {
      if (seq === pickSeq) $('g-info-addr').textContent = `Không tra được địa chỉ (${(err as Error).message})`;
    }
  };
  const close = () => ($('g-info').hidden = true);
  $('g-info-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());

  // ---- Own position: animated pin in 3D, blue dot on the map ----
  let me: Marker | null = null;
  const showMe = (p: { lat: number; lon: number }) => {
    view.setPin([p.lon, p.lat]);
    const el = document.createElement('div');
    el.className = 'me-dot';
    me?.remove();
    me = new Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
  };
  $('g-locate').addEventListener('click', async () => {
    $('g-locate').classList.add('on');
    const p = await getBrowserPosition();
    $('g-locate').classList.remove('on');
    if (!p) return status('Không lấy được vị trí của bạn (trình duyệt chưa cho phép).');
    status(null);
    showMe(p);
    go(p.lon, p.lat);
  });
  if (!(await permissionDenied())) {
    const p = await getBrowserPosition();
    if (p) {
      showMe(p);
      if (!startFromHash()) go(p.lon, p.lat);
    }
  }
}
