import './style.css';
import { generateDemoCity } from './data/demo';
import { cacheClearUnpinned, cacheUsage } from './data/cache';
import { type CityId, deletePackage, downloadPackage, listPackages, loadWards, packageSize, registerServiceWorker, searchWards, type Ward, wardAreaKm2 } from './data/offline';
import { loadCity } from './data/loader';
import type { BBox, Building, CityData, FootprintSource, HeightSource, ProgressStep } from './data/types';
import { bboxAreaKm2, pointInRing } from './geo/projection';
import { CityScene } from './scene/CityScene';
import type { ColorMode } from './scene/colorMode';
import { compassLabel } from './scene/sun';
import { reverseGeocode, searchPlaces, type Place } from './services/geocode';
import { fetchWeather } from './services/weather';
import { cityWorker } from './worker/client';
import { DEFAULT_AREA_HALF_M, DEFAULT_LOCATION, EXAMPLE_BBOX } from './config';
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
      const res = await fetch(`${import.meta.env.BASE_URL}snapshots/${snapshot.id}.json`);
      if (!res.ok) throw new Error(`snapshot ${snapshot.id}: HTTP ${res.status}`);
      data = (await res.json()) as CityData;
    } else {
      loadAbort = new AbortController();
      data = await loadData(b, loadAbort.signal);
    }
    showCity();
    city ??= new CityScene($('canvas'), $('labels'));
    setLayout(layout);
    city.onFrame = updateHud;
    city.onPick = showBuildingInfo;
    city.setColorMode(colorMode);
    const bench = /[?&]bench\b/.test(location.search) ? startBench(city) : null;
    const stats = await city.build(data, progress);
    bench?.(stats.seconds, data);
    applyTime();
    const km2 = bboxAreaKm2(b);
    $('i-title').textContent = snapshot ? snapshot.name : source === 'demo' ? 'Thành phố mẫu' : 'Vùng mới';
    $('i-stats').textContent = `${fmt(km2, 2)} km² · dựng xong trong ${fmt(stats.seconds, 1)} s · ${fmt(stats.buildings)} nhà · ${fmt(stats.trees)} cây · ${data.source}`;
    renderSourceStats(data);
    $('progress').hidden = true;
    if (PREVIEW) {
      document.querySelector('.w-icon')!.textContent = '🌡️';
      $('w-label').textContent = 'Không có thời tiết trong bản xem thử';
      $('w-time').textContent = snapshot ? `Dữ liệu chụp ngày ${snapshot.created}` : '';
    } else loadWeather(b);
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

const BASE_URL = new URL(import.meta.env.BASE_URL, location.href).href;
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
  const b = city.data.bbox;
  const bearing = city.view.bearing;
  try {
    if (!space.open) {
      $('btn-space').classList.add('on');
      savedView = city.saveView();
      const up = city.skyPose;
      await Promise.all([city.animateCamera(up.pos, up.target, 1100), new Promise((r) => setTimeout(r, 600)).then(() => space!.show((b.west + b.east) / 2, (b.south + b.north) / 2, bearing))]);
    } else {
      await space.hide(bearing);
      if (savedView) await city.animateCamera(savedView.pos, savedView.target, 1300);
      $('btn-space').classList.remove('on');
    }
  } finally {
    spaceBusy = false;
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

function showBuildingInfo(b: Building | null) {
  const panel = $('building-info');
  if (!b) {
    panel.hidden = true;
    return;
  }
  $('bi-title').textContent = b.name || ARCHETYPE_VI[b.archetype ?? 'generic'];
  $('bi-kind').textContent = [b.name ? ARCHETYPE_VI[b.archetype ?? 'generic'] : '', b.kind !== 'yes' ? `building=${b.kind}` : ''].filter(Boolean).join(' · ');
  const facts: [string, string][] = [
    ['Chiều cao', `${fmt(b.height, 1)} m${b.minHeight ? ` (từ ${fmt(b.minHeight, 1)} m)` : ''}`],
    ['Số tầng', b.levels ? fmt(b.levels) : `~${fmt(Math.max(1, Math.round(b.height / 3.3)))}`],
    ['Nguồn chiều cao', HEIGHT_SOURCE_VI[b.heightSource]],
    ['Footprint', FOOTPRINT_VI[b.footprintSource]],
  ];
  facts.push(['Địa chỉ', b.address ?? 'đang tìm…']);
  if (b.roof !== 'flat') facts.push(['Mái', b.roof]);
  const dl = $('bi-facts');
  dl.innerHTML = '';
  for (const [k, v] of facts) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  const link = $<HTMLAnchorElement>('bi-edit');
  const osm = /^(way|relation)\/(\d+)$/.exec(b.id);
  if (osm) {
    link.href = `https://www.openstreetmap.org/edit?${osm[1]}=${osm[2]}`;
    link.textContent = b.heightSource === 'osm' ? 'Sửa trên OpenStreetMap ↗' : 'Bổ sung chiều cao / số tầng trên OpenStreetMap ↗';
    link.hidden = false;
  } else if (b.footprintSource === 'overture') {
    const ring = b.polygon[0];
    const lon = ring.reduce((a, p) => a + p[0], 0) / ring.length;
    const lat = ring.reduce((a, p) => a + p[1], 0) / ring.length;
    link.href = `https://www.openstreetmap.org/edit#map=20/${lat.toFixed(6)}/${lon.toFixed(6)}`;
    link.textContent = 'Nhà này chưa có trên OpenStreetMap — vẽ thêm ↗';
    link.hidden = false;
  } else link.hidden = true;
  panel.hidden = false;
  if (!b.address) lookupAddress(b);
}

/** Fills the address row from Nominatim when the building has no addr:* tags (#28). */
async function lookupAddress(b: Building) {
  const ring = b.polygon[0];
  const lon = ring.reduce((a, p) => a + p[0], 0) / ring.length;
  const lat = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  const cell = () => [...$('bi-facts').querySelectorAll('dt')].find((d) => d.textContent === 'Địa chỉ')?.nextElementSibling as HTMLElement | undefined;
  try {
    const r = await reverseGeocode(lat, lon);
    const c = cell();
    if (!c || $('building-info').hidden) return;
    if (!r) c.textContent = `Chưa có địa chỉ · ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    else {
      const exact = r.osmId === b.id || pointInRing(r.lon, r.lat, ring);
      c.textContent = r.address + (exact ? '' : ' (gần đúng)');
      c.title = 'Nguồn: OpenStreetMap Nominatim';
    }
  } catch {
    const c = cell();
    if (c) c.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} (không tra được địa chỉ khi offline)`;
  }
}
function closeBuildingInfo() {
  $('building-info').hidden = true;
  city?.select(-1);
}
$('bi-close').addEventListener('click', closeBuildingInfo);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeBuildingInfo());

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
  const bk = ts.byKind as Record<string, number>;
  $('i-traffic').textContent = `🛵 ${fmt(bk.moto ?? 0)} xe máy · 🚗 ${fmt((bk.car ?? 0) + (bk.bus ?? 0) + (bk.truck ?? 0))} ô tô/buýt/tải · 🚲 ${fmt(bk.bicycle ?? 0)} · 🚶 ${fmt(ts.people)} người · ~${fmt(ts.flow * 100)}% tốc độ thông thường (mô phỏng)`;
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
// Colour / monochrome (#7) / realistic (#19): remembered per browser, overridable with ?style=mono|color|real.
const COLOR_KEY = 'tinymap:colorMode';
const MODES: ColorMode[] = ['color', 'mono', 'real'];
const MODE_LABEL: Record<ColorMode, string> = { color: '◑ Có màu', mono: '◐ Đơn sắc', real: '✦ Siêu thực' };
function initialColorMode(): ColorMode {
  const q = /[?&]style=(mono|color|real)\b/.exec(location.search)?.[1];
  if (q) return q as ColorMode;
  try {
    const v = localStorage.getItem(COLOR_KEY) as ColorMode | null;
    return v && MODES.includes(v) ? v : 'color';
  } catch {
    return 'color';
  }
}
let colorMode = initialColorMode();
function applyColorMode() {
  city?.setColorMode(colorMode);
  const btn = $('btn-mono');
  btn.classList.toggle('on', colorMode !== 'color');
  btn.textContent = MODE_LABEL[colorMode];
}
$('btn-mono').addEventListener('click', () => {
  colorMode = MODES[(MODES.indexOf(colorMode) + 1) % MODES.length];
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
    list = (await (await fetch(`${import.meta.env.BASE_URL}snapshots/index.json`)).json()) as SnapshotEntry[];
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
