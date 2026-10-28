import './style.css';
import { generateDemoCity } from './data/demo';
import { cacheClearUnpinned, cacheUsage } from './data/cache';
import { type CityId, deletePackage, downloadPackage, listPackages, loadWards, packageSize, registerServiceWorker, searchWards, type Ward, wardAreaKm2 } from './data/offline';
import { loadCity } from './data/loader';
import { removeOverlaps } from './data/overlap';
import type { BBox, Building, CityData, FootprintSource, HeightSource, ProgressStep } from './data/types';
import { bboxAreaKm2, pointInRing } from './geo/projection';
import { CityScene } from './scene/CityScene';
import { dominantMood, isRising, minuteForMood, MOOD_KEYS, MOOD_LABEL, MOODS, type Mood } from './scene/moods';
import { parseStyle, type Style, STYLE_LABEL, STYLES } from './scene/style';
import { compassLabel, sunState } from './scene/sun';
import { TOY_ROOFS, TOY_WALLS } from './scene/toyPalette';
import { reverseGeocode, searchPlaces, type Place } from './services/geocode';
import { googleKey, setGoogleKey } from './data/googleTraffic';
import { kindFromLive, parseWeatherKind, WEATHER_ICON, WEATHER_KINDS, WEATHER_LABEL, type WeatherKind, weatherPreset } from './scene/weather';
import { fetchWeather, type Weather } from './services/weather';
import { cityWorker } from './worker/client';
import { fetchFlights, type Flight, flightsRelay } from './data/flights';
import { APP_ROOT, DEFAULT_AREA_HALF_M, DEFAULT_LOCATION, EXAMPLE_BBOX } from './config';
import { getBrowserPosition, permissionDenied, resolveStartLocation } from './services/location';
import { bboxAround, MapView } from './ui/MapView';
import { SpaceView } from './ui/SpaceView';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number, d = 0) => n.toLocaleString('vi-VN', { maximumFractionDigits: d, minimumFractionDigits: d });
const MAX_KM2 = 4;
const EXAMPLE = EXAMPLE_BBOX;
const PREVIEW = import.meta.env.VITE_PREVIEW === '1';
interface SnapshotEntry {
  id: string;
  name: string;
  bbox: BBox;
  created: string;
}

const mapView = new MapView($('map'), undefined, undefined, PREVIEW ? 'offline' : 'carto');
let city: CityScene | null = null;
let busy = false;

// ---------- Map view ----------

function onBBox(b: BBox | null) {
  const btn = $<HTMLButtonElement>('btn-build');
  if (!b) {
    $('area-label').textContent = 'Chưa chọn vùng';
    $('area-hint').textContent = 'Bấm ▭ rồi kéo chuột để vẽ một khu (tối đa ~4 km²).';
    btn.disabled = true;
    highlightMood();
    return;
  }
  const km2 = bboxAreaKm2(b);
  $('area-label').textContent = `Vùng đã vẽ · ${fmt(km2, 2)} km²`;
  $('area-hint').textContent =
    km2 > MAX_KM2
      ? `Vùng quá lớn — hãy chọn ≤ ${MAX_KM2} km² để trình duyệt dựng mượt.`
      : locationNotice || 'Sẵn sàng. Bấm “Dựng 3D” để tải dữ liệu và dựng mô hình.';
  btn.disabled = km2 > MAX_KM2 || busy;
  highlightMood();
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
  if (p) (gpsPos = p), void updatePin();
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
const HEIGHTS_BASE = new URL('heights/', APP_ROOT).href;
const HEIGHTS_API = (import.meta.env.VITE_HEIGHTS_API as string | undefined) || (import.meta.env.DEV ? new URL('/api/heights', location.href).href : undefined);

// OSM source (#17): Overture's OSM-derived data by default, Overpass on request.
const OSM_KEY = 'tinymap:osmSource';
function osmSource(): 'overture' | 'overpass' {
  if (/[?&]osm=overpass\b/.test(location.search)) return 'overpass';
  try {
    return localStorage.getItem(OSM_KEY) === 'overpass' ? 'overpass' : 'overture';
  } catch {
    return 'overture';
  }
}
{
  const box = $<HTMLInputElement>('opt-overpass');
  box.checked = osmSource() === 'overpass';
  box.addEventListener('change', () => {
    try {
      localStorage.setItem(OSM_KEY, box.checked ? 'overpass' : 'overture');
    } catch {
      /* ignore */
    }
  });
}

/** City data via the worker (OSM + Overture + heights), or inline when workers are unavailable. */
async function loadData(b: BBox, signal: AbortSignal): Promise<CityData> {
  const onProgress = (f: number, detail: string, step?: string) => progress((step as ProgressStep) ?? 'osm', f, detail);
  const opts = {
    heightsBase: HEIGHTS_BASE,
    heightsApi: HEIGHTS_API,
    overture: !/[?&]nooverture\b/.test(location.search),
    osmSource: osmSource(),
  };
  if (cityWorker.available) return cityWorker.loadCity(b, opts, onProgress, signal);
  return loadCity(b, { ...opts, signal }, (p) => onProgress(p.f, p.detail, p.step));
}

async function build(source: 'osm' | 'demo' | 'snapshot', snapshot?: SnapshotEntry) {
  const b = snapshot?.bbox ?? mapView.bbox ?? (source === 'demo' ? mapView.bboxAroundCenter() : null);
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
    } else if (source === 'snapshot' && snapshot) {
      const res = await fetch(new URL(`snapshots/${snapshot.id}.json`, APP_ROOT));
      if (!res.ok) throw new Error(`snapshot ${snapshot.id}: HTTP ${res.status}`);
      data = (await res.json()) as CityData;
      removeOverlaps(data);
    } else {
      loadAbort = new AbortController();
      data = await loadData(b, loadAbort.signal);
    }
    showCity();
    city ??= new CityScene($('canvas'), $('labels'));
    setLayout(layout);
    city.onFrame = updateHud;
    city.onPick = showBuildingInfo;
    city.onPickPlane = showPlaneInfo;
    // A new area: the old planes and their poll belong to the previous one.
    resetFlights();
    const bench = /[?&]bench\b/.test(location.search) ? startBench(city) : null;
    if (bench) {
      // Pin the clock so the benchmark does not depend on when it runs (dusk and night cost more).
      slider.value = '720';
    }
    const stats = await city.build(data, progress, style);
    bench?.(stats.seconds, data);
    applyWeather();
    applyTime();
    syncFlights();
    const km2 = bboxAreaKm2(b);
    $('i-title').textContent = snapshot ? snapshot.name : source === 'demo' ? 'Thành phố mẫu' : 'Vùng mới';
    $('i-stats').textContent = `${fmt(km2, 2)} km² · dựng xong trong ${fmt(stats.seconds, 1)} s · ${fmt(stats.buildings)} nhà · ${fmt(stats.trees)} cây · ${data.source}`;
    renderSourceStats(data);
    void updatePin();
    setTimeout(prepareSpace, 1500);
    $('progress').hidden = true;
    if (PREVIEW) {
      document.querySelector('.w-icon')!.textContent = '🌡️';
      $('w-label').textContent = 'Không có thời tiết trong bản xem thử';
      $('w-time').textContent = snapshot ? `Dữ liệu chụp ngày ${snapshot.created}` : '';
      autoCard = { icon: '🌡️', label: 'Không có thời tiết trong bản xem thử' };
      showWeatherCard();
    } else if (!BENCH) {
      weatherBox = b;
      loadWeather(b);
    }
  } catch (e) {
    if (!PREVIEW) showMap();
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
    // The style was changed while building (or loading, aborted or not).
    applyStyleIfShown();
  }
}

$('btn-build').addEventListener('click', () => build('osm'));
$('btn-cancel').addEventListener('click', () => loadAbort?.abort());
// Drawing a new area cancels a download in flight.
mapView.map.on('mousedown', () => mapView.isDrawing && loadAbort?.abort());
$('btn-cache').addEventListener('click', async () => {
  const u = await cacheUsage();
  const free = u.bytes - u.pinnedBytes;
  const keep = u.pinnedBytes ? ` Bản đồ offline đã tải (${fmt(u.pinnedBytes / 1048576, 1)} MB) được giữ lại.` : '';
  if (!confirm(`Xoá ${fmt(free / 1048576, 1)} MB dữ liệu đệm trên máy?${keep}`)) return;
  await cacheClearUnpinned();
});

// ---------- Offline packages per ward (#18) ----------

const BASE_URL = APP_ROOT;
let offCity: CityId = 'hcm';
let offWard: Ward | null = null;
let offAbort: AbortController | null = null;
const offResults = $<HTMLUListElement>('off-results');
const offSearch = $<HTMLInputElement>('off-search');
const kindLabel = (w: Ward) => (w.kind === 'phuong' ? 'phường' : w.kind === 'xa' ? 'xã' : '');

async function renderWardResults() {
  offResults.innerHTML = '<li class="muted">Đang tải danh sách…</li>';
  try {
    const list = await loadWards(offCity, BASE_URL);
    const found = searchWards(list.wards, offSearch.value, 40);
    offResults.innerHTML = '';
    for (const w of found) {
      const li = document.createElement('li');
      li.innerHTML = '<span></span><small></small>';
      li.firstElementChild!.textContent = w.name;
      li.lastElementChild!.textContent = `${fmt(wardAreaKm2(w), 1)} km²`;
      li.classList.toggle('on', w.id === offWard?.id);
      li.addEventListener('click', () => selectWard(w));
      offResults.appendChild(li);
    }
    if (!found.length) offResults.innerHTML = '<li class="muted">Không tìm thấy phường/xã nào.</li>';
  } catch {
    offResults.innerHTML = '<li class="muted">Không tải được danh sách phường (cần mạng lần đầu).</li>';
  }
}

function selectWard(w: Ward) {
  offWard = w;
  mapView.setWard(w.polygon);
  mapView.fitBBox(w.bbox);
  $('off-selected').hidden = false;
  $('off-name').textContent = w.name;
  const saved = listPackages().find((p) => p.id === w.id);
  $('off-info').textContent = `${kindLabel(w) ? kindLabel(w) + ' · ' : ''}${fmt(wardAreaKm2(w), 1)} km² · ${packageSize(w.bbox)} ô dữ liệu` + (saved ? ` · đã tải ${fmt(saved.bytes / 1048576, 1)} MB` : '');
  $('off-download').textContent = saved ? 'Tải lại' : 'Tải về máy';
  $('off-status').textContent = '';
  for (const li of offResults.children) li.classList.remove('on');
}

function renderSaved() {
  const ul = $<HTMLUListElement>('off-saved');
  ul.innerHTML = '';
  const list = listPackages().sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  for (const p of list) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><span><small></small> <button class="ghost" title="Xoá gói offline">🗑</button></span>';
    li.querySelector('span')!.textContent = p.name;
    li.querySelector('small')!.textContent = `${fmt(p.bytes / 1048576, 1)} MB`;
    li.addEventListener('click', async () => {
      const w = (await loadWards(p.city, BASE_URL).catch(() => null))?.wards.find((x) => x.id === p.id);
      if (w) selectWard(w);
      else mapView.fitBBox(p.bbox);
    });
    li.querySelector('button')!.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Xoá bản đồ offline của ${p.name}?`)) return;
      await deletePackage(p.id);
      renderSaved();
      if (offWard?.id === p.id) selectWard(offWard);
    });
    ul.appendChild(li);
  }
  if (!list.length) ul.innerHTML = '<li class="muted">Chưa có phường nào. Chọn một phường ở trên rồi bấm “Tải về máy”.</li>';
  cacheUsage().then((u) => {
    $('off-usage').textContent = u.pinnedBytes ? `Dữ liệu offline trong bộ nhớ đệm: ${fmt(u.pinnedBytes / 1048576, 1)} MB` : '';
  });
}

$('btn-offline').addEventListener('click', () => {
  const panel = $('offline');
  panel.hidden = !panel.hidden;
  $('btn-offline').classList.toggle('on', !panel.hidden);
  if (!panel.hidden) {
    renderWardResults();
    renderSaved();
    offSearch.focus();
  } else mapView.setWard(null);
});
$('off-close').addEventListener('click', () => $('btn-offline').click());
$<HTMLSelectElement>('off-city').addEventListener('change', (e) => {
  offCity = (e.target as HTMLSelectElement).value as CityId;
  renderWardResults();
});
let offTimer = 0;
offSearch.addEventListener('input', () => {
  clearTimeout(offTimer);
  offTimer = window.setTimeout(renderWardResults, 120);
});
$('off-pick').addEventListener('click', () => {
  if (!offWard) return;
  const b = offWard.bbox;
  // A buildable area: the whole ward when small enough, else 800 m around its centre.
  const sel = bboxAreaKm2(b) <= MAX_KM2 ? b : bboxAround((b.west + b.east) / 2, (b.south + b.north) / 2, DEFAULT_AREA_HALF_M);
  mapView.setBBox(sel);
  mapView.fitBBox(sel);
});
$('off-download').addEventListener('click', async () => {
  const w = offWard;
  if (!w) return;
  if (offAbort) {
    offAbort.abort();
    return;
  }
  const btn = $('off-download');
  const status = $('off-status');
  offAbort = new AbortController();
  btn.textContent = 'Huỷ';
  $('off-progress').hidden = false;
  status.textContent = 'Đang tải…';
  try {
    const pkg = await downloadPackage(offCity, w, {
      heightsBase: HEIGHTS_BASE,
      signal: offAbort.signal,
      onProgress: (done, total) => {
        $('off-bar').style.width = `${(done / Math.max(1, total)) * 100}%`;
        status.textContent = `Đang tải ${done}/${total}`;
      },
    });
    status.textContent = `Xong: ${fmt(pkg.bytes / 1048576, 1)} MB. Có thể dựng 3D mọi khu trong ${w.name} khi không có mạng.`;
  } catch (e) {
    status.textContent = (e as Error).name === 'AbortError' ? 'Đã huỷ.' : `Lỗi khi tải: ${(e as Error).message}`;
  } finally {
    offAbort = null;
    $('off-progress').hidden = true;
    btn.textContent = listPackages().some((p) => p.id === w.id) ? 'Tải lại' : 'Tải về máy';
    renderSaved();
  }
});
if (import.meta.env.PROD && !PREVIEW) registerServiceWorker(BASE_URL);
$('btn-demo').addEventListener('click', () => build('demo'));

// ---------- Layout (#23): map | 3D side by side on wide screens, tabs on phones ----------

type Layout = 'map' | 'city' | 'split';
let layout: Layout = 'map';
const wide = () => window.innerWidth >= 900;
const SPLIT_KEY = 'tinymap:split';

function setLayout(l: Layout) {
  layout = l;
  const main = document.querySelector('main')!;
  main.dataset.layout = l;
  $('map-view').hidden = l === 'city';
  $('city-view').hidden = l === 'map';
  $('splitter').hidden = l !== 'split';
  document.body.classList.toggle('has-city', !!city);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
    b.classList.toggle('on', b.dataset.tab === (l === 'city' ? 'city' : 'map'));
    if (b.dataset.tab === 'city') b.disabled = !city;
  }
  if (l === 'map') playing = false;
  highlightMood();
  applyStyleIfShown();
  onViewChange();
}
function showCity() {
  // The preview build has no map pane.
  setLayout(wide() && !PREVIEW ? 'split' : 'city');
}
function showMap() {
  closeBuildingInfo();
  setLayout(wide() && city ? 'split' : 'map');
}
$('btn-back').addEventListener('click', () => {
  if (!wide()) return showMap();
  setLayout(layout === 'split' ? 'city' : 'split');
});
for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
  b.addEventListener('click', () => setLayout(b.dataset.tab === 'city' ? 'city' : 'map'));
}
window.addEventListener('resize', () => {
  if (!city || PREVIEW) return;
  if (!wide() && layout === 'split') setLayout('city');
  else if (wide() && layout !== 'split') setLayout('split');
});
{
  // Draggable divider; the share is remembered.
  const main = document.querySelector('main')!;
  const apply = (f: number) => main.style.setProperty('--split', `${(Math.min(0.8, Math.max(0.2, f)) * 100).toFixed(2)}%`);
  try {
    const saved = Number(localStorage.getItem(SPLIT_KEY));
    if (saved) apply(saved);
  } catch {
    /* ignore */
  }
  const sp = $('splitter');
  let f = 0.42;
  sp.addEventListener('pointerdown', (e) => {
    sp.setPointerCapture(e.pointerId);
    sp.classList.add('drag');
  });
  sp.addEventListener('pointermove', (e) => {
    if (!sp.hasPointerCapture(e.pointerId)) return;
    const r = main.getBoundingClientRect();
    f = (e.clientX - r.left) / r.width;
    apply(f);
  });
  sp.addEventListener('pointerup', (e) => {
    sp.releasePointerCapture(e.pointerId);
    sp.classList.remove('drag');
    try {
      localStorage.setItem(SPLIT_KEY, String(f));
    } catch {
      /* ignore */
    }
  });
  sp.addEventListener('dblclick', () => (apply((f = 0.5)), localStorage.setItem(SPLIT_KEY, '0.5')));
}
// Info card: tap the title to expand it on phones.
$('i-title').addEventListener('click', () => document.querySelector('#city-view .info')?.classList.toggle('open'));
// ---------- Space view (#24) ----------
let space: SpaceView | null = null;
let spaceBusy = false;
let savedView: { pos: import('three').Vector3; target: import('three').Vector3 } | null = null;
$('btn-space').addEventListener('click', async () => {
  if (!city?.data || spaceBusy) return;
  spaceBusy = true;
  space ??= new SpaceView($('city-view'));
  const c = city;
  try {
    if (!space.open) {
      $('btn-space').classList.add('on');
      savedView = c.saveView();
      const from = c.mapPose()!;
      await space.show(from, (p) => c.applyMapPose(p));
    } else if (savedView) {
      const to = c.mapPose(savedView)!;
      await space.hide(to, (p) => c.applyMapPose(p));
      c.restoreView(savedView);
      $('btn-space').classList.remove('on');
    }
  } finally {
    spaceBusy = false;
  }
});
/** Warms the globe up in the background once a model is on screen (#29). */
function prepareSpace() {
  if (!city?.data || PREVIEW) return;
  const pose = city.mapPose();
  if (!pose) return;
  space ??= new SpaceView($('city-view'));
  space.prepare(pose);
}
// ---------- Live traffic from Google (#11) ----------
$('btn-gtraffic').addEventListener('click', async (e) => {
  e.preventDefault();
  if (!city?.data) return;
  let key = googleKey();
  if (!key || (e as MouseEvent).shiftKey) {
    key = prompt(
      'Dán Google Maps Platform API key (bật Routes API và billing).\n' +
        'Key chỉ lưu trong trình duyệt này. Mỗi lần lấy dữ liệu gọi tối đa 16 tuyến (khoảng 0,16 USD).\n' +
        'Việc tuân thủ điều khoản Google Maps Platform thuộc về chủ key. Để trống để xoá key.',
      key ?? '',
    );
    if (key === null) return;
    setGoogleKey(key.trim() || null);
    if (!key.trim()) return void ($('g-status').textContent = 'Đã xoá key.');
  }
  $('g-status').textContent = 'đang lấy…';
  try {
    const n = await city.applyGoogleTraffic(key.trim());
    $('g-status').textContent = n ? `${fmt(n)} đoạn đường theo Google · Traffic © Google · ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}` : 'Google không trả dữ liệu cho khu này.';
    applyTime();
  } catch (err) {
    $('g-status').textContent = `Lỗi: ${(err as Error).message.slice(0, 120)}`;
  }
});
mapView.maxKm2 = MAX_KM2;
mapView.observeResize();

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
  const fp = [
    `${fmt(st.footprints.osm)} OSM`,
    st.footprints.overture ? `${fmt(st.footprints.overture)} Overture` : '',
    st.footprints.gob ? `${fmt(st.footprints.gob)} suy ra từ ảnh vệ tinh` : '',
  ].filter(Boolean).join(' + ');
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

// ---------- Building info (#10) ----------

const ARCHETYPE_VI: Record<string, string> = {
  tube: 'Nhà ống', shophouse: 'Nhà phố (shophouse)', villa: 'Biệt thự', apartment: 'Chung cư', office: 'Văn phòng / cao ốc',
  civic: 'Công trình công cộng', industrial: 'Nhà xưởng', temple: 'Chùa / đền', church: 'Nhà thờ', generic: 'Nhà',
};
const HEIGHT_SOURCE_VI: Record<HeightSource, string> = {
  osm: 'OpenStreetMap (tag)', gob: 'Google Open Buildings 2.5D', overture: 'Overture (số tầng)', heuristic: 'Ước lượng',
};
const FOOTPRINT_VI: Record<FootprintSource, string> = {
  osm: 'OpenStreetMap',
  overture: 'Overture Maps',
  gob: 'Suy ra từ ảnh vệ tinh (Google 2.5D)',
  demo: 'Thành phố mẫu',
};

const ROOF_VI: Record<string, string> = { flat: 'bằng', gabled: 'hai mái', hipped: 'bốn mái', pyramidal: 'chóp', dome: 'vòm', skillion: 'một mái', round: 'tròn', onion: 'củ hành' };
/** Building whose address is being looked up; a late answer for another one is dropped. */
let selectedId = '';

function showBuildingInfo(b: Building | null) {
  const panel = $('building-info');
  if (!b) {
    panel.hidden = true;
    return;
  }
  $('bi-title').textContent = b.name || ARCHETYPE_VI[b.archetype ?? 'generic'];
  $('bi-kind').textContent = [b.name ? ARCHETYPE_VI[b.archetype ?? 'generic'] : '', b.kind !== 'yes' ? `building=${b.kind}` : ''].filter(Boolean).join(' · ');
  const facts: [string, string][] = [
    ['Cao', `${fmt(b.height, 0)} m`],
    ['Tầng', b.levels ? fmt(b.levels) : `~${fmt(Math.max(1, Math.round(b.height / 3.3)))}`],
    ['Mái', ROOF_VI[b.roof] ?? b.roof],
  ];
  const sources: [string, string][] = [
    ['Chiều cao', HEIGHT_SOURCE_VI[b.heightSource] + (b.minHeight ? ` · từ ${fmt(b.minHeight, 1)} m` : '')],
    ['Footprint', FOOTPRINT_VI[b.footprintSource]],
  ];
  const fill = (dl: HTMLElement, rows: [string, string][]) => {
    dl.innerHTML = '';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
  };
  fill($('bi-facts'), facts);
  fill($('bi-src'), sources);
  const [clon, clat] = centroidOf(b);
  const gmaps = `https://www.google.com/maps/search/?api=1&query=${clat.toFixed(6)},${clon.toFixed(6)}`;
  $<HTMLAnchorElement>('bi-gmaps').href = gmaps;
  const addr = $<HTMLAnchorElement>('bi-addr');
  addr.href = gmaps;
  addr.textContent = b.address ?? 'Đang tìm địa chỉ…';
  const link = $<HTMLAnchorElement>('bi-edit');
  const osm = /^(way|relation)\/(\d+)$/.exec(b.id);
  if (osm) {
    link.href = `https://www.openstreetmap.org/edit?${osm[1]}=${osm[2]}`;
    link.textContent = b.heightSource === 'osm' ? 'Sửa trên OSM ↗' : 'Thêm chiều cao trên OSM ↗';
    link.hidden = false;
  } else if (b.footprintSource === 'overture') {
    link.href = `https://www.openstreetmap.org/edit#map=20/${clat.toFixed(6)}/${clon.toFixed(6)}`;
    link.textContent = 'Vẽ nhà này lên OSM ↗';
    link.hidden = false;
  } else link.hidden = true;
  panel.hidden = false;
  if (!b.address) lookupAddress(b);
}

/** Fills the address row from Nominatim when the building has no addr:* tags (#28). */
function centroidOf(b: Building): [number, number] {
  const ring = b.polygon[0];
  return [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];
}

async function lookupAddress(b: Building) {
  const ring = b.polygon[0];
  const [lon, lat] = centroidOf(b);
  const shown = selectedId = b.id;
  const cell = () => (selectedId === shown ? $('bi-addr') : undefined);
  try {
    const r = await reverseGeocode(lat, lon);
    const c = cell();
    if (!c || $('building-info').hidden) return;
    c.title = 'Mở vị trí này trên Google Maps';
    if (!r) c.textContent = `Chưa có địa chỉ · ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    else {
      const exact = r.osmId === b.id || pointInRing(r.lon, r.lat, ring);
      c.textContent = r.address + (exact ? '' : ' (gần đúng)');
      c.title = 'Địa chỉ: OpenStreetMap Nominatim · bấm để mở Google Maps';
    }
  } catch {
    const c = cell();
    if (c) c.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} (không tra được địa chỉ khi offline)`;
  }
}
/**
 * Animated pin in 3D (v0.0.5): the device position when the browser gives it without asking
 * again, otherwise the place last shown on the map (search result or default place).
 */
let gpsPos: { lat: number; lon: number } | null = null;
async function updatePin() {
  if (!city) return;
  if (!gpsPos && !PREVIEW && !(await permissionDenied())) gpsPos = await getBrowserPosition();
  const p = gpsPos ?? mapView.place ?? DEFAULT_LOCATION;
  city.setPin(p ? [p.lon, p.lat] : null);
}

function closeBuildingInfo() {
  $('building-info').hidden = true;
  closePlaneInfo();
  city?.select(-1);
}
$('bi-close').addEventListener('click', closeBuildingInfo);
document.addEventListener('keydown', (e) => e.key === 'Escape' && !weatherMenuOpen() && closeBuildingInfo());

// ---------- Weather ----------

/** The bench pins the weather to clear and never touches the network. */
const BENCH = /[?&]bench\b/.test(location.search);
const WEATHER_KEY = 'tinymap:weather';
function storedWeather(): WeatherKind | null {
  try {
    return parseWeatherKind(localStorage.getItem(WEATHER_KEY));
  } catch {
    return null;
  }
}
let weatherKind: WeatherKind = parseWeatherKind(new URLSearchParams(location.search).get('weather')) ?? storedWeather() ?? 'auto';
let liveWeather: Weather | null = null;
let weatherBox: BBox | null = null;
/** What the weather card shows in Tự động when there is no live reading. */
let autoCard = { icon: '☀️', label: 'Thời tiết' };

const effectiveKind = (): WeatherKind => (BENCH ? 'clear' : weatherKind);

function showWeatherCard() {
  const kind = effectiveKind();
  const manual = kind !== 'auto';
  document.querySelector('.w-icon')!.textContent = manual ? WEATHER_ICON[kind] : autoCard.icon;
  $('w-label').textContent = manual ? `${WEATHER_LABEL[kind]} (chọn tay)` : autoCard.label;
  $('btn-weather').textContent = WEATHER_ICON[kind];
  $('btn-weather').title = `Thời tiết: ${WEATHER_LABEL[kind]}`;
  document.querySelectorAll<HTMLButtonElement>('#weather-menu button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.kind === kind)));
}

function applyWeather() {
  showWeatherCard();
  if (!city) return;
  const kind = effectiveKind();
  if (kind !== 'auto') return city.setWeather(weatherPreset(kind));
  if (!liveWeather) return city.setWeather(weatherPreset('clear'));
  const k = kindFromLive(liveWeather);
  const p = weatherPreset(k);
  // Plain clear and cloudy skies follow the measured cloud cover, as before.
  if (k === 'clear' || k === 'cloudy') p.cloud = liveWeather.cloudCover * 0.7;
  city.setWeather(p);
}

async function loadWeather(b: BBox) {
  try {
    const w = await fetchWeather((b.south + b.north) / 2, (b.west + b.east) / 2);
    liveWeather = w;
    $('w-temp').textContent = `${Math.round(w.temperature)}°`;
    $('w-time').textContent = `Lúc ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} · Open-Meteo`;
    autoCard = { icon: w.icon, label: w.label };
  } catch {
    autoCard = { icon: '🌡️', label: 'Không có dữ liệu thời tiết' };
  }
  applyWeather();
}

const weatherMenu = $('weather-menu');
function weatherMenuOpen() {
  return !weatherMenu.hidden;
}
const weatherBtn = $('btn-weather');
for (const kind of WEATHER_KINDS) {
  const item = document.createElement('button');
  item.setAttribute('role', 'menuitemradio');
  item.dataset.kind = kind;
  item.textContent = `${WEATHER_ICON[kind]} ${WEATHER_LABEL[kind]}`;
  item.addEventListener('click', () => {
    weatherKind = kind;
    try {
      localStorage.setItem(WEATHER_KEY, kind);
    } catch {
      /* storage blocked */
    }
    closeWeatherMenu();
    applyWeather();
    applyTime();
    if (kind === 'auto' && !liveWeather && weatherBox && !PREVIEW) void loadWeather(weatherBox).then(applyTime);
  });
  weatherMenu.append(item);
}
function openWeatherMenu() {
  const r = weatherBtn.getBoundingClientRect();
  weatherMenu.hidden = false;
  const w = weatherMenu.offsetWidth;
  weatherMenu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  weatherMenu.style.top = `${Math.min(r.bottom + 6, innerHeight - weatherMenu.offsetHeight - 8)}px`;
  weatherBtn.setAttribute('aria-expanded', 'true');
  weatherMenu.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
}
function closeWeatherMenu(refocus = true) {
  if (weatherMenu.hidden) return;
  weatherMenu.hidden = true;
  weatherBtn.setAttribute('aria-expanded', 'false');
  if (refocus) weatherBtn.focus();
}
weatherBtn.addEventListener('click', () => (weatherMenu.hidden ? openWeatherMenu() : closeWeatherMenu()));
document.addEventListener('keydown', (e) => {
  if (!weatherMenuOpen()) return;
  if (e.key === 'Escape') closeWeatherMenu();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = [...weatherMenu.querySelectorAll<HTMLButtonElement>('button')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  }
});
document.addEventListener('pointerdown', (e) => {
  if (!weatherMenu.hidden && !weatherMenu.contains(e.target as Node) && !weatherBtn.contains(e.target as Node)) closeWeatherMenu(false);
});
showWeatherCard();

// ---------- Style: Đồ chơi / Khối / Siêu thực ----------

const STYLE_KEY = 'tinymap:style';
/** The stored style; master's `tinymap:colorMode` is read once and becomes it. */
function storedStyle(): Style | null {
  try {
    const s = parseStyle(localStorage.getItem(STYLE_KEY));
    if (s) return s;
    const old = parseStyle(localStorage.getItem('tinymap:colorMode'));
    localStorage.removeItem('tinymap:colorMode');
    if (old) localStorage.setItem(STYLE_KEY, old);
    return old;
  } catch {
    return null;
  }
}
/** `?style=` wins over storage; the bench measures Đồ chơi unless `?style=` asks for another. */
const urlStyle = parseStyle(new URLSearchParams(location.search).get('style'));
let style: Style = urlStyle ?? (BENCH ? 'toy' : storedStyle()) ?? 'toy';

function showStyle() {
  document.querySelectorAll<HTMLButtonElement>('#style-picker button').forEach((b) => {
    b.classList.toggle('on', b.dataset.style === style);
    b.setAttribute('aria-pressed', String(b.dataset.style === style));
  });
  $('btn-style').textContent = STYLE_LABEL[style];
  $('btn-style').title = `Kiểu mô hình: ${STYLE_LABEL[style]} (bấm để đổi)`;
}

function setStyle(s: Style) {
  style = s;
  try {
    localStorage.setItem(STYLE_KEY, s);
  } catch {
    /* storage blocked */
  }
  showStyle();
  applyStyleIfShown();
}

/**
 * Rebuilds when the 3D view shows a model in another style than the chosen one. While the 3D view is
 * hidden the choice is only remembered: it applies to the next build, or when the 3D view is shown again.
 */
function applyStyleIfShown() {
  if (city?.data && !$('city-view').hidden && city.style !== style) void rebuildInStyle();
}

/** Builds the model again from the data already loaded, keeping camera, time, mood and weather. */
async function rebuildInStyle() {
  const c = city;
  if (!c?.data || busy) return;
  busy = true;
  const buttons = ['btn-style', 'btn-build', 'btn-demo'].map((id) => $<HTMLButtonElement>(id));
  for (const b of buttons) b.disabled = true;
  closeBuildingInfo();
  stopFlights();
  const view = c.saveView();
  let ok = false;
  try {
    await c.build(c.data, () => {}, style);
    c.restoreView(view);
    c.setTrafficOverlay(trafficOn);
    applyWeather();
    applyTime();
    syncFlights();
    ok = true;
  } catch (e) {
    // The scene was cleared: say so, as a failed build does.
    console.error(e);
    resetProgress('Đổi kiểu mô hình');
    showMap();
    $('p-error').hidden = false;
    $('p-error').textContent = `Không dựng lại được mô hình: ${(e as Error).message}. Thử lại, hoặc bấm “Dựng 3D”.`;
  } finally {
    busy = false;
    for (const b of buttons) b.disabled = false;
    onBBox(mapView.bbox);
  }
  // Picked again while building.
  if (ok) applyStyleIfShown();
}

document.querySelectorAll<HTMLButtonElement>('#style-picker button').forEach((b) => b.addEventListener('click', () => setStyle(b.dataset.style as Style)));
$('btn-style').addEventListener('click', () => setStyle(STYLES[(STYLES.indexOf(style) + 1) % STYLES.length]));
showStyle();

// ---------- Live planes ----------

const FLIGHTS_KEY = 'tinymap:flights';
/** adsb.fi radius around the area centre (nm) and the poll period. */
const FLIGHTS_NM = 40;
const FLIGHTS_POLL_MS = 15_000;
const FLIGHTS_SOURCE = 'adsb.fi';
const flightsSource = (() => {
  try {
    return flightsRelay(location.search, localStorage, import.meta.env.DEV);
  } catch {
    return flightsRelay(location.search, null, import.meta.env.DEV);
  }
})();
function storedFlights(): boolean | null {
  try {
    const v = localStorage.getItem(FLIGHTS_KEY);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}
let flightsOn = !BENCH && !!flightsSource && (storedFlights() ?? true);
let flightList: Flight[] = [];
let flightsTimer = 0;
let flightsAbort: AbortController | null = null;
let flightsLine = '';

function showFlightsLine() {
  const el = $('i-flights');
  const btn = $<HTMLButtonElement>('btn-flights');
  btn.hidden = BENCH;
  btn.disabled = !flightsSource;
  btn.classList.toggle('on', flightsOn);
  btn.setAttribute('aria-pressed', String(flightsOn));
  btn.title = flightsSource ? `Máy bay thật (${FLIGHTS_SOURCE}): ${flightsOn ? 'đang bật' : 'đang tắt'}` : 'Chưa cấu hình nguồn chuyến bay';
  const text = BENCH ? '' : !flightsSource ? '✈ Chưa cấu hình nguồn chuyến bay' : flightsOn ? flightsLine : '';
  el.textContent = text;
  el.hidden = !text;
}

function stopFlights() {
  clearTimeout(flightsTimer);
  flightsAbort?.abort();
  flightsAbort = null;
}

/** A new area: the old planes belong to somewhere else. */
function resetFlights() {
  stopFlights();
  flightList = [];
  flightsLine = '';
  city?.setFlights([]);
  closePlaneInfo();
}

/** Starts or stops planes and polling to match the toggle, the visible view and the tab. */
function syncFlights() {
  const c = city;
  if (!c?.data) return;
  flightsViewKey = viewKey();
  stopFlights();
  showFlightsLine();
  if (!flightsOn || !flightsSource || BENCH) {
    void c.setPlanes(false);
    closePlaneInfo();
    return;
  }
  void c.setPlanes(true).catch(console.error);
  if ($('city-view').hidden || document.visibilityState !== 'visible') return;
  void pollFlights();
}

async function pollFlights() {
  const c = city;
  const relay = flightsSource;
  if (!c?.data || !relay) return;
  const ac = (flightsAbort = new AbortController());
  const b = c.data.bbox;
  try {
    const fs = await fetchFlights(relay, (b.south + b.north) / 2, (b.west + b.east) / 2, FLIGHTS_NM, ac.signal);
    if (ac.signal.aborted) return;
    flightList = fs;
    c.setFlights(fs);
    flightsLine = `✈ ${fmt(c.planeCount)} máy bay · ${FLIGHTS_SOURCE} · cập nhật ${new Date().toLocaleTimeString('vi-VN', { hour12: false })}`;
  } catch {
    if (ac.signal.aborted) return;
    // The planes already shown stay until they go stale (60 s).
    flightsLine = '✈ Không lấy được dữ liệu chuyến bay';
  }
  showFlightsLine();
  flightsTimer = window.setTimeout(() => void pollFlights(), FLIGHTS_POLL_MS);
}

$('btn-flights').addEventListener('click', () => {
  if (!flightsSource) return;
  flightsOn = !flightsOn;
  try {
    localStorage.setItem(FLIGHTS_KEY, flightsOn ? '1' : '0');
  } catch {
    /* storage blocked */
  }
  if (flightsOn) {
    flightsLine = '';
    city?.setFlights(flightList);
  }
  syncFlights();
});
/** The 3D view was shown or hidden, or the tab changed: pause or resume polling, not while a build runs. */
let flightsViewKey = '';
const viewKey = () => `${$('city-view').hidden}|${document.visibilityState}`;
function onViewChange() {
  if (!city?.data || busy || viewKey() === flightsViewKey) return;
  syncFlights();
}
document.addEventListener('visibilitychange', onViewChange);
showFlightsLine();

function showPlaneInfo(f: Flight | null) {
  const panel = $('plane-info');
  if (!f) {
    panel.hidden = true;
    return;
  }
  $('building-info').hidden = true;
  $('pi-title').textContent = f.callsign || f.hex.toUpperCase();
  $('pi-kind').textContent = f.type ? `Loại ${f.type}` : 'Không rõ loại máy bay';
  const dl = $('pi-facts');
  dl.innerHTML = '';
  for (const [k, v] of [
    ['Độ cao', `${fmt(f.altM)} m`],
    ['Tốc độ', `${fmt(f.gsMs * 3.6)} km/h`],
    ['Hướng', `${fmt(f.trackDeg)}°`],
  ]) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  panel.hidden = false;
}
function closePlaneInfo() {
  $('plane-info').hidden = true;
}
$('pi-close').addEventListener('click', closePlaneInfo);

// ---------- Time of day ----------

const slider = $<HTMLInputElement>('t-slider');
const dateInput = $<HTMLInputElement>('t-date');
const now = new Date();
dateInput.valueAsDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
// Start at the current clock time of the example area (Hà Nội, UTC+7).
slider.value = String((now.getUTCHours() * 60 + now.getUTCMinutes() + 7 * 60) % 1440);
let playing = false;

/** The built city's area while the 3D view is showing, otherwise the area selected on the map. */
function moodBBox(): BBox | null {
  return city && !$('city-view').hidden ? (city.data?.bbox ?? null) : mapView.bbox;
}

/** The slider shows local clock time at the area (UTC offset estimated from longitude). */
function areaUtcOffsetHours(): number {
  const b = moodBBox();
  return b ? Math.round((b.west + b.east) / 2 / 15) : -new Date().getTimezoneOffset() / 60;
}

function currentDate(): Date {
  const [y, m, d] = (dateInput.value || new Date().toISOString().slice(0, 10)).split('-').map(Number);
  const mins = Number(slider.value);
  return new Date(Date.UTC(y, m - 1, d, 0, mins) - areaUtcOffsetHours() * 3_600_000);
}

const clockLabel = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(Math.floor(mins % 60)).padStart(2, '0')}`;

/** Where the mood is judged: the built city, else the selected area, else the map centre. */
function moodPlace(): { lat: number; lon: number } {
  const b = moodBBox();
  if (b) return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
  const c = mapView.map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

function currentMood(): Mood {
  if (city && !$('city-view').hidden) return city.currentMood;
  const { lat, lon } = moodPlace();
  const date = currentDate();
  return dominantMood(sunState(date, lat, lon), isRising(date, lat, lon));
}

function highlightMood() {
  const mood = currentMood();
  document.querySelectorAll<HTMLButtonElement>('#mood-picker button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mood === mood);
    b.setAttribute('aria-pressed', String(b.dataset.mood === mood));
  });
  $('btn-mood').textContent = MOOD_LABEL[mood];
}

function pickMood(m: Mood) {
  const { lat, lon } = moodPlace();
  const [y, mo, d] = (dateInput.value || new Date().toISOString().slice(0, 10)).split('-').map(Number);
  slider.value = String(minuteForMood(m, new Date(Date.UTC(y, mo - 1, d)), lat, lon, areaUtcOffsetHours()));
  applyTime();
}

document.querySelectorAll<HTMLButtonElement>('#mood-picker button').forEach((b) => {
  const m = b.dataset.mood as Mood;
  b.querySelector('i')!.setAttribute('style', `--sky:${MOOD_KEYS[m].sky};--wall:${TOY_WALLS[0]};--roof:${TOY_ROOFS[0]}`);
  b.addEventListener('click', () => pickMood(m));
});
$('btn-mood').addEventListener('click', () => pickMood(MOODS[(MOODS.indexOf(currentMood()) + 1) % MOODS.length]));

function applyTime() {
  if (!city) {
    $('t-clock').textContent = clockLabel(Number(slider.value));
    highlightMood();
    return;
  }
  const mins = Number(slider.value);
  city.setTime(currentDate(), mins / 60);
  const s = city.sunInfo!;
  $('t-clock').textContent = clockLabel(mins);
  $('t-sun').textContent = s.altitudeDeg > 0 ? `Mặt trời ${fmt(s.altitudeDeg)}°, hướng ${s.compass}` : s.night > 0.9 ? 'Ban đêm · đèn đã bật' : 'Hoàng hôn / bình minh';
  const ts = city.trafficStats;
  const bk = ts.byKind as Record<string, number>;
  $('i-traffic').textContent = `🛵 ${fmt(bk.moto ?? 0)} xe máy · 🚗 ${fmt((bk.car ?? 0) + (bk.bus ?? 0) + (bk.truck ?? 0))} ô tô/buýt/tải · 🚲 ${fmt(bk.bicycle ?? 0)} · 🚶 ${fmt(ts.people)} người · ~${fmt(ts.flow * 100)}% tốc độ thông thường (mô phỏng)`;
  document.querySelector('#city-view .info')?.classList.toggle('night', s.night > 0.5);
  highlightMood();
}
applyTime();
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

/**
 * Preview build (VITE_PREVIEW=1, used for the hosted Artifact): the page may not reach any
 * external service, so it opens straight into bundled data snapshots (tools/snapshot.ts).
 */
async function bootPreview() {
  document.body.classList.add('preview');
  showCity();
  const select = $<HTMLSelectElement>('preview-area');
  let list: SnapshotEntry[] = [];
  try {
    list = (await (await fetch(new URL('snapshots/index.json', APP_ROOT))).json()) as SnapshotEntry[];
  } catch {
    /* no snapshots bundled: demo only */
  }
  // Default location first (issue #2), then the others, then the procedural demo.
  list.sort((a, b) => (a.id === 'ennam' ? -1 : b.id === 'ennam' ? 1 : 0));
  for (const e of list) select.add(new Option(e.name, e.id));
  select.add(new Option('Thành phố mẫu (sinh ngẫu nhiên)', '__demo'));
  select.hidden = false;
  const open = (id: string) => {
    closeBuildingInfo();
    const e = list.find((x) => x.id === id);
    if (e) build('snapshot', e);
    else build('demo', undefined);
  };
  select.addEventListener('change', () => open(select.value));
  open(select.value);
}

async function boot() {
  if (PREVIEW) return bootPreview();
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
