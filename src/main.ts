import './style.css';
import { generateDemoCity } from './data/demo';
import { fetchOverpass, parseOverpass } from './data/osm';
import type { BBox, CityData, ProgressStep } from './data/types';
import { bboxAreaKm2 } from './geo/projection';
import { CityScene } from './scene/CityScene';
import { compassLabel } from './scene/sun';
import { searchPlaces, type Place } from './services/geocode';
import { fetchWeather } from './services/weather';
import { DEFAULT_AREA_HALF_M, DEFAULT_LOCATION, EXAMPLE_BBOX } from './config';
import { getBrowserPosition, permissionDenied, resolveStartLocation } from './services/location';
import { bboxAround, MapView } from './ui/MapView';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number, d = 0) => n.toLocaleString('vi-VN', { maximumFractionDigits: d, minimumFractionDigits: d });
const MAX_KM2 = 4;
const EXAMPLE = EXAMPLE_BBOX;

const mapView = new MapView($('map'));
let city: CityScene | null = null;
let busy = false;
const osmCache = new Map<string, CityData>();

// ---------- Map view ----------

function onBBox(b: BBox | null) {
  const btn = $<HTMLButtonElement>('btn-build');
  if (!b) {
    $('area-label').textContent = 'Chưa chọn vùng';
    $('area-hint').textContent = 'Bấm ▭ rồi kéo chuột để vẽ một khu (tối đa ~4 km²).';
    btn.disabled = true;
    return;
  }
  const km2 = bboxAreaKm2(b);
  $('area-label').textContent = `Vùng đã vẽ · ${fmt(km2, 2)} km²`;
  $('area-hint').textContent =
    km2 > MAX_KM2
      ? `Vùng quá lớn — hãy chọn ≤ ${MAX_KM2} km² để trình duyệt dựng mượt.`
      : locationNotice || 'Sẵn sàng. Bấm “Dựng 3D” để tải dữ liệu và dựng mô hình.';
  btn.disabled = km2 > MAX_KM2 || busy;
  history.replaceState(null, '', `#bbox=${[b.south, b.west, b.north, b.east].map((v) => v.toFixed(5)).join(',')}`);
}
mapView.onChange = onBBox;

$('btn-draw').addEventListener('click', () => {
  locationNotice = '';
  mapView.setDrawing(!mapView.isDrawing);
  $('btn-draw').classList.toggle('on', mapView.isDrawing);
});
mapView.map.on('mouseup', () => $('btn-draw').classList.toggle('on', mapView.isDrawing));
$('btn-center').addEventListener('click', () => mapView.setBBox(mapView.bboxAroundCenter()));
$('btn-clear').addEventListener('click', () => mapView.setBBox(null));
$('btn-locate').addEventListener('click', async () => {
  $('btn-locate').classList.add('on');
  const p = (await permissionDenied()) ? null : await getBrowserPosition();
  $('btn-locate').classList.remove('on');
  if (p) goTo(p.lat, p.lon, 'Vị trí của bạn');
  else {
    goTo(DEFAULT_LOCATION.lat, DEFAULT_LOCATION.lon, DEFAULT_LOCATION.label);
    setLocationNotice(`Không lấy được vị trí — đang hiển thị ${DEFAULT_LOCATION.label}.`);
  }
});

/** Centre the map on a point with a marker and a pre-selected area (no automatic build). */
function goTo(lat: number, lon: number, label: string) {
  mapView.flyTo(lon, lat, label, 15.5);
  mapView.setBBox(bboxAround(lon, lat, DEFAULT_AREA_HALF_M));
}

let locationNotice = '';
function setLocationNotice(text: string) {
  locationNotice = text;
  onBBox(mapView.bbox);
}
$('btn-example').addEventListener('click', () => {
  showMap();
  mapView.setBBox(EXAMPLE);
  mapView.fitBBox(EXAMPLE);
  mapView.flyTo(105.8196, 21.0032, 'Ngã Tư Sở', 15.3);
});
$('btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});

// Search (debounced, Nominatim).
const input = $<HTMLInputElement>('search');
const results = $<HTMLUListElement>('search-results');
let searchTimer = 0;
let searchAbort: AbortController | null = null;
let places: Place[] = [];
input.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = input.value.trim();
  if (q.length < 3) {
    results.hidden = true;
    return;
  }
  searchTimer = window.setTimeout(async () => {
    searchAbort?.abort();
    searchAbort = new AbortController();
    try {
      places = await searchPlaces(q, searchAbort.signal);
      results.innerHTML = '';
      for (const [i, p] of places.entries()) {
        const li = document.createElement('li');
        li.textContent = p.name;
        li.dataset.i = String(i);
        results.appendChild(li);
      }
      results.hidden = places.length === 0;
    } catch {
      /* aborted or offline */
    }
  }, 450);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && places[0]) choosePlace(places[0]);
  if (e.key === 'Escape') results.hidden = true;
});
results.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest('li');
  if (li) choosePlace(places[Number(li.dataset.i)]);
});
function choosePlace(p: Place) {
  results.hidden = true;
  input.value = p.name.split(',')[0];
  mapView.flyTo(p.lon, p.lat, input.value);
}
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== input && !$('map-view').hidden) {
    e.preventDefault();
    input.focus();
  }
});

// ---------- Progress ----------

const STEP_ORDER: ProgressStep[] = ['osm', 'merge', 'build'];
const STEP_WEIGHT: Record<ProgressStep, [number, number]> = { osm: [0, 0.55], merge: [0.55, 0.65], build: [0.65, 1] };
let t0 = 0;
function progress(step: ProgressStep, f: number, detail?: string) {
  const [a, b] = STEP_WEIGHT[step];
  const pct = Math.round((a + (b - a) * f) * 100);
  $('p-pct').textContent = String(pct);
  $('p-bar').style.width = `${pct}%`;
  $('p-time').textContent = `${fmt((performance.now() - t0) / 1000, 1)} s`;
  const idx = STEP_ORDER.indexOf(step);
  document.querySelectorAll<HTMLLIElement>('.steps li').forEach((li) => {
    const i = STEP_ORDER.indexOf(li.dataset.step as ProgressStep);
    li.classList.toggle('done', i < idx || (i === idx && f >= 1));
    li.classList.toggle('active', i === idx && f < 1);
    if (i === idx && detail) li.querySelector('span')!.textContent = detail;
  });
}

function resetProgress(title: string) {
  t0 = performance.now();
  $('progress').hidden = false;
  $('p-error').hidden = true;
  $('p-title').textContent = title;
  document.querySelectorAll('.steps li').forEach((li) => {
    li.classList.remove('done', 'active');
    li.querySelector('span')!.textContent = '';
  });
  progress('osm', 0);
}

// ---------- Build ----------

async function loadData(b: BBox): Promise<CityData> {
  const k = [b.south, b.west, b.north, b.east].map((v) => v.toFixed(5)).join(',');
  const cached = osmCache.get(k);
  if (cached) return cached;
  progress('osm', 0.1, 'đang tải…');
  // Overpass gives no progress events, so animate a pseudo progress while waiting.
  let fake = 0.1;
  const timer = setInterval(() => progress('osm', (fake = Math.min(0.9, fake + 0.04)), 'đang tải…'), 300);
  try {
    const raw = await fetchOverpass(b, undefined, (ep) => progress('osm', fake, new URL(ep).host));
    clearInterval(timer);
    progress('osm', 1, `${fmt(raw.elements.length)} đối tượng`);
    progress('merge', 0.2);
    const data = parseOverpass(b, raw);
    progress('merge', 1, `${fmt(data.buildings.length)} nhà`);
    osmCache.set(k, data);
    return data;
  } finally {
    clearInterval(timer);
  }
}

async function build(source: 'osm' | 'demo') {
  const b = mapView.bbox ?? (source === 'demo' ? mapView.bboxAroundCenter() : null);
  if (!b || busy) return;
  busy = true;
  $<HTMLButtonElement>('btn-build').disabled = true;
  $('btn-build').textContent = 'Đang dựng…';
  resetProgress(source === 'demo' ? 'Thành phố mẫu' : 'Vùng mới');
  try {
    let data: CityData;
    if (source === 'demo') {
      progress('osm', 1, 'bỏ qua (offline)');
      data = generateDemoCity(b);
      progress('merge', 1, `${fmt(data.buildings.length)} nhà`);
    } else {
      data = await loadData(b);
    }
    showCity();
    city ??= new CityScene($('canvas'), $('labels'));
    city.onFrame = updateHud;
    const stats = await city.build(data, progress);
    applyTime();
    const km2 = bboxAreaKm2(b);
    $('i-title').textContent = source === 'demo' ? 'Thành phố mẫu' : 'Vùng mới';
    $('i-stats').textContent = `${fmt(km2, 2)} km² · dựng xong trong ${fmt(stats.seconds, 1)} s · ${fmt(stats.buildings)} nhà · ${fmt(stats.trees)} cây · ${data.source}`;
    $('progress').hidden = true;
    loadWeather(b);
  } catch (e) {
    console.error(e);
    showMap();
    $('p-error').hidden = false;
    $('p-error').textContent = `Không tải được dữ liệu: ${(e as Error).message}. Thử lại sau, chọn vùng nhỏ hơn, hoặc bấm “Demo offline”.`;
  } finally {
    busy = false;
    $('btn-build').textContent = 'Dựng 3D';
    onBBox(mapView.bbox);
  }
}

$('btn-build').addEventListener('click', () => build('osm'));
$('btn-demo').addEventListener('click', () => build('demo'));

function showCity() {
  $('map-view').hidden = true;
  $('city-view').hidden = false;
}
function showMap() {
  $('city-view').hidden = true;
  $('map-view').hidden = false;
  playing = false;
  mapView.resize();
}
$('btn-back').addEventListener('click', showMap);

// ---------- Weather ----------

let weatherRain = false;
async function loadWeather(b: BBox) {
  try {
    const w = await fetchWeather((b.south + b.north) / 2, (b.west + b.east) / 2);
    $('w-temp').textContent = `${Math.round(w.temperature)}°`;
    $('w-label').textContent = w.label;
    document.querySelector('.w-icon')!.textContent = w.icon;
    $('w-time').textContent = `Lúc ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} · Open-Meteo`;
    city?.setCloud(w.cloudCover * 0.7);
    weatherRain = w.rain;
    setRain(w.rain);
    applyTime();
  } catch {
    document.querySelector('.w-icon')!.textContent = '🌡️';
    $('w-label').textContent = 'Không có dữ liệu thời tiết';
  }
}
function setRain(on: boolean) {
  city?.setRain(on);
  $('btn-rain').classList.toggle('on', on);
}
$('btn-rain').addEventListener('click', () => {
  weatherRain = !weatherRain;
  setRain(weatherRain);
});

// ---------- Time of day ----------

const slider = $<HTMLInputElement>('t-slider');
const dateInput = $<HTMLInputElement>('t-date');
const now = new Date();
dateInput.valueAsDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
// Start at the current clock time of the example area (Hà Nội, UTC+7).
slider.value = String((now.getUTCHours() * 60 + now.getUTCMinutes() + 7 * 60) % 1440);
let playing = false;

/** The slider shows local clock time at the area (UTC offset estimated from longitude). */
function areaUtcOffsetHours(): number {
  const b = city?.data?.bbox;
  return b ? Math.round((b.west + b.east) / 2 / 15) : -new Date().getTimezoneOffset() / 60;
}

function currentDate(): Date {
  const [y, m, d] = (dateInput.value || new Date().toISOString().slice(0, 10)).split('-').map(Number);
  const mins = Number(slider.value);
  return new Date(Date.UTC(y, m - 1, d, 0, mins) - areaUtcOffsetHours() * 3_600_000);
}

const clockLabel = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(Math.floor(mins % 60)).padStart(2, '0')}`;

function applyTime() {
  if (!city) return;
  const mins = Number(slider.value);
  city.setTime(currentDate(), mins / 60);
  const s = city.sunInfo!;
  $('t-clock').textContent = clockLabel(mins);
  $('t-sun').textContent = s.altitudeDeg > 0 ? `Mặt trời ${fmt(s.altitudeDeg)}°, hướng ${s.compass}` : s.night > 0.9 ? 'Ban đêm · đèn đã bật' : 'Hoàng hôn / bình minh';
  const ts = city.trafficStats;
  $('i-traffic').textContent = `🚗 ${fmt(ts.vehicles)} xe · ${fmt(ts.segments)} đoạn đường chính · ~${fmt(ts.flow * 100)}% tốc độ thông thường (mô phỏng)`;
  document.querySelector('#city-view .info')?.classList.toggle('night', s.night > 0.5);
}
slider.addEventListener('input', applyTime);
dateInput.addEventListener('change', applyTime);

$('btn-play').addEventListener('click', () => {
  playing = !playing;
  $('btn-play').textContent = playing ? '❚❚' : '▶';
});
let lastTick = performance.now();
function tick(t: number) {
  const dt = (t - lastTick) / 1000;
  lastTick = t;
  if (playing && city) {
    // One simulated hour per real second.
    slider.value = String((Number(slider.value) + dt * 60) % 1440);
    applyTime();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- 3D toolbar ----------

function updateHud() {
  if (!city) return;
  const { bearing, tilt } = city.view;
  $('t-view').innerHTML = `${fmt(bearing)}° ${compassLabel(bearing, true)}<br><small>nghiêng ${fmt(tilt)}°</small>`;
}

document.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((btn) =>
  btn.addEventListener('click', () => {
    if (!city) return;
    const a = btn.dataset.cam;
    if (a === 'in') city.zoom(0.75);
    else if (a === 'out') city.zoom(1.33);
    else if (a === 'left') city.rotate(-45);
    else if (a === 'right') city.rotate(45);
    else if (a === 'top') city.topView();
    else city.resetView();
  }),
);

let trafficOn = false;
$('btn-traffic').addEventListener('click', () => {
  trafficOn = !trafficOn;
  city?.setTrafficOverlay(trafficOn);
  $('btn-traffic').classList.toggle('on', trafficOn);
});
let pixelOn = false;
$('btn-pixel').addEventListener('click', () => {
  pixelOn = !pixelOn;
  city?.setPixelMode(pixelOn);
  $('btn-pixel').classList.toggle('on', pixelOn);
});

function download(href: string, name: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
}
$('btn-shot').addEventListener('click', () => city && download(city.screenshot(), 'tiny-map.png'));
$('btn-glb').addEventListener('click', async () => {
  if (!city) return;
  const url = URL.createObjectURL(await city.exportGLB());
  download(url, 'tiny-map.glb');
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

// ---------- Boot ----------

function bboxFromHash(): BBox | null {
  const m = /bbox=([-\d.,]+)/.exec(location.hash);
  if (!m) return null;
  const [south, west, north, east] = m[1].split(',').map(Number);
  return [south, west, north, east].every(Number.isFinite) ? { south, west, north, east } : null;
}

async function boot() {
  const fromUrl = bboxFromHash();
  if (fromUrl) {
    mapView.setBBox(fromUrl);
    mapView.map.once('load', () => mapView.fitBBox(fromUrl));
  } else if (!/[?&]demo\b/.test(location.search)) {
    const loc = await resolveStartLocation(DEFAULT_LOCATION);
    if (mapView.bbox) return; // the user already picked something while we waited
    const label = loc.source === 'default' ? DEFAULT_LOCATION.label : 'Vị trí của bạn';
    goTo(loc.lat, loc.lon, label);
    if (loc.source === 'default') setLocationNotice(`Không lấy được vị trí — đang hiển thị ${DEFAULT_LOCATION.label}.`);
  }
  if (/[?&]demo\b/.test(location.search)) build('demo');
}
boot();
