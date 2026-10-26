import './style.css';
import { generateDemoCity } from './data/demo';
import { cacheClear, cacheUsage } from './data/cache';
import { loadCity } from './data/loader';
import type { BBox, CityData, ProgressStep } from './data/types';
import { bboxAreaKm2 } from './geo/projection';
import { CityScene } from './scene/CityScene';
import type { ColorMode } from './scene/colorMode';
import { compassLabel } from './scene/sun';
import { searchPlaces, type Place } from './services/geocode';
import { fetchWeather } from './services/weather';
import { cityWorker } from './worker/client';
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

// Data steps run in parallel, so each keeps its own fraction; the total is a weighted sum.
const STEP_WEIGHT: Record<ProgressStep, number> = { osm: 0.35, overture: 0.15, heights: 0.05, merge: 0.1, build: 0.35 };
const stepF: Record<ProgressStep, number> = { osm: 0, overture: 0, heights: 0, merge: 0, build: 0 };
let t0 = 0;
function progress(step: ProgressStep, f: number, detail?: string) {
  stepF[step] = Math.max(stepF[step], Math.min(1, f));
  const total = (Object.keys(STEP_WEIGHT) as ProgressStep[]).reduce((a, k) => a + STEP_WEIGHT[k] * stepF[k], 0);
  const pct = Math.round(total * 100);
  $('p-pct').textContent = String(pct);
  $('p-bar').style.width = `${pct}%`;
  $('p-time').textContent = `${fmt((performance.now() - t0) / 1000, 1)} s`;
  const li = document.querySelector<HTMLLIElement>(`.steps li[data-step="${step}"]`);
  if (!li) return;
  li.classList.toggle('done', stepF[step] >= 1);
  li.classList.toggle('active', stepF[step] < 1);
  if (detail) li.querySelector('span')!.textContent = detail;
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
  for (const k of Object.keys(stepF) as ProgressStep[]) stepF[k] = 0;
  progress('osm', 0);
}

// ---------- Build ----------

let loadAbort: AbortController | null = null;

/** Height grids: bundled under public/heights/, plus an on-demand endpoint in dev or when configured (#3, #4). */
const HEIGHTS_BASE = new URL(`${import.meta.env.BASE_URL}heights/`, location.href).href;
const HEIGHTS_API = (import.meta.env.VITE_HEIGHTS_API as string | undefined) || (import.meta.env.DEV ? new URL('/api/heights', location.href).href : undefined);

/** City data via the worker (OSM + Overture + heights), or inline when workers are unavailable. */
async function loadData(b: BBox, signal: AbortSignal): Promise<CityData> {
  const onProgress = (f: number, detail: string, step?: string) => progress((step as ProgressStep) ?? 'osm', f, detail);
  const opts = { heightsBase: HEIGHTS_BASE, heightsApi: HEIGHTS_API, overture: !/[?&]nooverture\b/.test(location.search) };
  if (cityWorker.available) return cityWorker.loadCity(b, opts, onProgress, signal);
  return loadCity(b, { ...opts, signal }, (p) => onProgress(p.f, p.detail, p.step));
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
      progress('overture', 1, 'bỏ qua');
      progress('heights', 1, 'bỏ qua');
      data = cityWorker.available ? await cityWorker.demo(b).catch(() => generateDemoCity(b)) : generateDemoCity(b);
      progress('merge', 1, `${fmt(data.buildings.length)} nhà`);
    } else {
      loadAbort = new AbortController();
      data = await loadData(b, loadAbort.signal);
    }
    showCity();
    city ??= new CityScene($('canvas'), $('labels'));
    city.onFrame = updateHud;
    city.setColorMode(colorMode);
    const bench = /[?&]bench\b/.test(location.search) ? startBench(city) : null;
    const stats = await city.build(data, progress);
    bench?.(stats.seconds, data);
    applyTime();
    const km2 = bboxAreaKm2(b);
    $('i-title').textContent = source === 'demo' ? 'Thành phố mẫu' : 'Vùng mới';
    $('i-stats').textContent = `${fmt(km2, 2)} km² · dựng xong trong ${fmt(stats.seconds, 1)} s · ${fmt(stats.buildings)} nhà · ${fmt(stats.trees)} cây · ${data.source}`;
    renderSourceStats(data);
    $('progress').hidden = true;
    loadWeather(b);
  } catch (e) {
    showMap();
    if ((e as Error).name === 'AbortError') {
      $('progress').hidden = true;
      return;
    }
    console.error(e);
    $('p-error').hidden = false;
    $('p-error').textContent = `Không tải được dữ liệu: ${(e as Error).message}. Thử lại sau, chọn vùng nhỏ hơn, hoặc bấm “Demo offline”.`;
  } finally {
    loadAbort = null;
    busy = false;
    $('btn-build').textContent = 'Dựng 3D';
    onBBox(mapView.bbox);
  }
}

$('btn-build').addEventListener('click', () => build('osm'));
$('btn-cancel').addEventListener('click', () => loadAbort?.abort());
// Drawing a new area cancels a download in flight.
mapView.map.on('mousedown', () => mapView.isDrawing && loadAbort?.abort());
$('btn-cache').addEventListener('click', async () => {
  const u = await cacheUsage();
  if (!confirm(`Xoá ${fmt(u.entries)} mục (${fmt(u.bytes / 1048576, 1)} MB) dữ liệu đã lưu trên máy?`)) return;
  await cacheClear();
});
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

// ---------- Data sources (#3) ----------

function renderSourceStats(data: CityData) {
  const st = data.stats;
  const el = $('i-sources');
  if (!st) {
    el.textContent = '';
    return;
  }
  const n = data.buildings.length || 1;
  const pct = (v: number) => `${fmt((v / n) * 100)}%`;
  const fp = [`${fmt(st.footprints.osm)} OSM`, st.footprints.overture ? `${fmt(st.footprints.overture)} Overture` : ''].filter(Boolean).join(' + ');
  const h = st.heights;
  const measured = h.osm + h.gob + h.overture;
  el.innerHTML = '';
  const line1 = document.createElement('div');
  line1.textContent = `Footprint: ${fp}`;
  const line2 = document.createElement('div');
  line2.textContent = `Chiều cao: ${pct(measured)} từ dữ liệu (Google 2.5D ${pct(h.gob)} · OSM ${pct(h.osm)}${h.overture ? ` · Overture ${pct(h.overture)}` : ''}), ${pct(h.heuristic)} ước lượng`;
  const line3 = document.createElement('div');
  line3.className = 'attrib';
  line3.textContent = st.attributions.join(' · ');
  el.append(line1, line2, line3);
}

let sourceView = false;
$('btn-sources').addEventListener('click', () => {
  sourceView = !sourceView;
  city?.setSourceView(sourceView);
  $('btn-sources').classList.toggle('on', sourceView);
  $('legend-sources').hidden = !sourceView;
});

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
// Colour / monochrome (#7): remembered per browser, overridable with ?style=mono|color.
const COLOR_KEY = 'tinymap:colorMode';
function initialColorMode(): ColorMode {
  const q = /[?&]style=(mono|color)\b/.exec(location.search)?.[1];
  if (q) return q as ColorMode;
  try {
    return localStorage.getItem(COLOR_KEY) === 'mono' ? 'mono' : 'color';
  } catch {
    return 'color';
  }
}
let colorMode = initialColorMode();
function applyColorMode() {
  city?.setColorMode(colorMode);
  const btn = $('btn-mono');
  btn.classList.toggle('on', colorMode === 'mono');
  btn.textContent = colorMode === 'mono' ? '◐ Đơn sắc' : '◑ Có màu';
}
$('btn-mono').addEventListener('click', () => {
  colorMode = colorMode === 'mono' ? 'color' : 'mono';
  try {
    localStorage.setItem(COLOR_KEY, colorMode);
  } catch {
    /* ignore */
  }
  applyColorMode();
});
applyColorMode();

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

// ---------- Benchmark (?demo&bench, used by CI — issue #8) ----------

/** Starts collecting long tasks; returns a function to call once the build finished. */
function startBench(scene: CityScene) {
  const longTasks: number[] = [];
  let obs: PerformanceObserver | null = null;
  try {
    obs = new PerformanceObserver((list) => list.getEntries().forEach((e) => longTasks.push(e.duration)));
    obs.observe({ type: 'longtask', buffered: false });
  } catch {
    /* longtask unsupported */
  }
  // Rendering is paused while building so long tasks measure build work only.
  scene.paused = true;
  return async (buildSeconds: number, data: CityData) => {
    obs?.disconnect();
    // Let one frame run so view-dependent state (detail LOD) matches what the user sees.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const render = scene.measureRender();
    scene.paused = false;
    await new Promise((r) => setTimeout(r, 4500));
    (window as unknown as { __bench: unknown }).__bench = {
      buildMs: Math.round(buildSeconds * 1000),
      // Longest synchronous step of our own build code on the main thread.
      mainThreadMaxMs: Math.round(Math.max(0, ...Object.values(scene.mainThreadSlices))),
      mainThreadSlices: scene.mainThreadSlices,
      // All long tasks in the window (includes MapLibre etc.); informational only.
      longTasks: longTasks.map(Math.round),
      drawCalls: render.calls,
      triangles: render.triangles,
      buildings: data.buildings.length,
      fps: Math.round(scene.fps * 10) / 10,
      worker: cityWorker.available,
    };
  };
}

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
