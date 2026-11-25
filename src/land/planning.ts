/**
 * Planning lookup (#59): what the official HCMC planning portal says about a point, i.e. the
 * zoning cells (quy hoạch phân khu 1/2000) under the cadastral lot at that point, the road
 * setbacks (lộ giới) and the lot's administrative data.
 *
 * Source: thongtinquyhoach.hochiminhcity.gov.vn (Sở Quy hoạch - Kiến trúc TP.HCM). It has no
 * public documentation; the endpoint below is the one the portal's own page calls. It needs no
 * key and answers CORS, so the browser can call it directly. One request per parcel the user
 * selects, never bulk. Planning here is reference only, not a legal document.
 */
import type { LngLat } from '../data/types';
import { cacheGet, cacheSet } from '../data/cache';
import { pointInRing } from '../geo/projection';
import { ringCenter } from './valuation';

export const PLANNING_API = 'https://sqhkt-qlqh.tphcm.gov.vn/computing/930/api/v3.1/a-z/all';
export const PLANNING_PORTAL = 'https://thongtinquyhoach.hochiminhcity.gov.vn/';
export const PLANNING_SOURCE = { name: 'Cổng thông tin quy hoạch TP.HCM (Sở Quy hoạch - Kiến trúc)', url: PLANNING_PORTAL };
export const PLANNING_DISCLAIMER =
  'Thông tin quy hoạch lấy từ cổng của Sở Quy hoạch - Kiến trúc TP.HCM theo điểm giữa thửa, chỉ để tham khảo, không thay thế giấy tờ pháp lý (giấy phép quy hoạch, thông tin quy hoạch do cơ quan có thẩm quyền cấp).';

/** Rough box around HCMC, only to skip pointless requests; the portal returns nothing elsewhere. */
const HCM_BOX = { minLon: 106.35, maxLon: 107.05, minLat: 10.3, maxLat: 11.2 };
export const inHcm = (lon: number, lat: number) => lon >= HCM_BOX.minLon && lon <= HCM_BOX.maxLon && lat >= HCM_BOX.minLat && lat <= HCM_BOX.maxLat;

/** Link that opens the portal centred on a point (the portal uses leaflet-hash: #zoom/lat/lon). */
export const portalLink = (lon: number, lat: number) => `${PLANNING_PORTAL}#18/${lat.toFixed(6)}/${lon.toFixed(6)}`;

/** MultiPolygon coordinates, as the portal returns them (lon, lat). */
export type MultiPolygon = number[][][][];

export interface PlanningCell {
  id: string;
  /** Portal legend code, e.g. 'DGT', 'HH', 'NNO'. */
  code: string;
  /** Vietnamese function name, e.g. 'Đất giao thông'. */
  name: string;
  /** Area of this cell inside the lot, m². */
  areaM2: number;
  /** Share of the lot covered by this cell, percent. */
  sharePct: number;
  /** '#rrggbb' from the portal legend. */
  color: string;
  /** Block code ('mã ô phố'), e.g. 'M5'. */
  block?: string;
  geometry: MultiPolygon;
}

export interface PlanningFrontage {
  street: string;
  /** Side of the lot facing this street, e.g. 'Tây Nam'. */
  side?: string;
  /** Road width including setback (lộ giới), metres. */
  roadWidthM?: number;
  /** Length along / into the lot, metres. */
  frontageM?: number;
  depthM?: number;
}

export interface PlanningInfo {
  /** The point that was asked about. */
  lon: number;
  lat: number;
  cadastralId?: string;
  soTo?: string;
  soThua?: string;
  ward?: string;
  district?: string;
  /** Lot area according to the portal, m². */
  areaM2?: number;
  /** Planning projects (đồ án) that apply. */
  plans: string[];
  cells: PlanningCell[];
  frontages: PlanningFrontage[];
  /** Outline of the portal's lot. */
  outline?: MultiPolygon;
  /** Count of extra layers the portal returned but that are not parsed here (chi tiết, ngành, điều chỉnh cục bộ, công trình). */
  extraLayers: number;
  /** ms since epoch when fetched. */
  fetchedAt: number;
}

// ---- parsing ----

/** The portal wraps most layers as JSON strings inside the JSON; accept either form. */
function unwrap(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const numOf = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const strOf = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);

/** '130,130,130' → '#828282'; anything else falls back to grey so a bad value can't break the style. */
export function rgbToHex(rgb: unknown): string {
  const m = /^\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*$/.exec(String(rgb ?? ''));
  if (!m) return '#9aa0a6';
  return '#' + [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('');
}

/** A GeoJSON geometry, or (for the lot's `ranh`) the bare MultiPolygon coordinates the portal sends. */
function toMultiPolygon(g: unknown): MultiPolygon | undefined {
  const geo = unwrap(g);
  if (Array.isArray(geo)) return Array.isArray(geo[0]) && Array.isArray(geo[0][0]) && Array.isArray(geo[0][0][0]) ? (geo as MultiPolygon) : undefined;
  if (!isObj(geo)) return undefined;
  const c = geo.coordinates;
  if (!Array.isArray(c)) return undefined;
  if (geo.type === 'MultiPolygon') return c as MultiPolygon;
  if (geo.type === 'Polygon') return [c as number[][][]];
  return undefined;
}

function features(layer: unknown): Record<string, unknown>[] {
  const v = unwrap(layer);
  return Array.isArray(v) ? v.filter(isObj) : [];
}

/**
 * Turns the portal's answer into PlanningInfo. Returns null when the portal has no lot at the
 * point (it answers with an empty array). Throws if the answer has an unexpected shape, so the
 * caller can show "could not look up" instead of "no planning".
 */
export function parsePlanning(raw: unknown, lon: number, lat: number, now = Date.now()): PlanningInfo | null {
  if (Array.isArray(raw) && raw.length === 0) return null;
  if (!isObj(raw)) throw new Error('Phản hồi quy hoạch không đúng định dạng');
  const tt = unwrap(raw.ThongTinChung);
  if (tt === undefined && !('QHPK' in raw)) throw new Error('Phản hồi quy hoạch thiếu dữ liệu');
  if (!isObj(tt)) return null;

  const cells: PlanningCell[] = [];
  for (const f of features(raw.QHPK)) {
    const p = isObj(f.properties) ? f.properties : {};
    const geometry = toMultiPolygon(f.geometry);
    if (!geometry) continue;
    cells.push({
      id: strOf(p.maso) ?? strOf(p.gid) ?? `cell${cells.length}`,
      code: strOf(p.maquyuoc) ?? '?',
      name: strOf(p.chucnang) ?? 'Chưa rõ chức năng',
      areaM2: numOf(p.dientich) ?? 0,
      sharePct: numOf(p.tldientich) ?? 0,
      color: rgbToHex(p.rgbcolor),
      block: strOf(p.maopho),
      geometry,
    });
  }
  cells.sort((a, b) => b.areaM2 - a.areaM2);

  // Field names are not consistent between rows: 'logioi' vs 'LoGioi', and widths can be missing.
  const frontages: PlanningFrontage[] = features(raw.LoGioi).map((f) => {
    const p = isObj(f.properties) ? f.properties : {};
    return {
      street: strOf(p.tenduong) ?? 'đường không tên',
      side: strOf(p.huongtiepgiap),
      roadWidthM: numOf(p.logioi) ?? numOf(p.LoGioi),
      frontageM: numOf(p.chieungang),
      depthM: numOf(p.chieusau),
    };
  });

  const plans = Array.isArray(tt.dsdoan) ? tt.dsdoan.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  return {
    lon,
    lat,
    cadastralId: strOf(tt.mathuadat),
    soTo: strOf(tt.soto),
    soThua: strOf(tt.sothua),
    ward: strOf(tt.tenphuongxa),
    district: strOf(tt.tenquanhuyen),
    areaM2: numOf(tt.dientich),
    plans,
    cells,
    frontages,
    outline: toMultiPolygon(tt.ranh),
    extraLayers: ['QHChiTiet', 'QHNganh', 'DCCB', 'CTXD'].filter((k) => features(raw[k]).length > 0).length,
    fetchedAt: now,
  };
}

// ---- query point ----

/**
 * A point that is really inside the ring: the centroid when it is, else the middle of the
 * longest stretch of a horizontal line through the centroid (L-shaped lots have centroids
 * outside themselves).
 */
export function interiorPoint(ring: LngLat[]): LngLat {
  const c = ringCenter(ring);
  const pts = ring as [number, number][];
  if (pointInRing(c[0], c[1], pts)) return c;
  const xs: number[] = [];
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > c[1] !== yj > c[1]) xs.push(((xj - xi) * (c[1] - yi)) / (yj - yi) + xi);
  }
  xs.sort((a, b) => a - b);
  let best: LngLat = pts[0];
  let bestLen = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > bestLen) {
      bestLen = xs[i + 1] - xs[i];
      best = [(xs[i] + xs[i + 1]) / 2, c[1]];
    }
  }
  return best;
}

/**
 * Note for when the portal's lot is clearly not the selected parcel (OSM parcels are land-use
 * areas, not cadastral lots). Null when they look alike.
 */
export function lotMismatchNote(parcelAreaM2: number, info: PlanningInfo): string | null {
  if (!info.areaM2 || !(parcelAreaM2 > 0)) return null;
  const r = info.areaM2 / parcelAreaM2;
  if (r >= 0.7 && r <= 1.4) return null;
  return `Thửa của cổng (${Math.round(info.areaM2).toLocaleString('vi-VN')} m²) khác thửa đang chọn (${Math.round(parcelAreaM2).toLocaleString('vi-VN')} m²): quy hoạch tra theo điểm giữa thửa nên chỉ đúng cho thửa của cổng.`;
}

// ---- loading ----

const NS = 'planning';
const TTL_MS = 24 * 3600 * 1000;
const TIMEOUT_MS = 20000;

type Cached = { none: true } | { info: PlanningInfo };

/**
 * Looks up planning at a point. Resolves null when the portal has no lot there, and rejects on
 * network/format problems (a stale cached answer is used first if the network fails).
 */
export async function loadPlanning(lon: number, lat: number, signal?: AbortSignal): Promise<PlanningInfo | null> {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const hit = await cacheGet<Cached>(NS, key);
  if (hit) return 'none' in hit ? null : hit.info;

  signal?.throwIfAborted();
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) ctl.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, TIMEOUT_MS);
  try {
    // Plain form POST: a CORS "simple request", so no preflight.
    const res = await fetch(PLANNING_API, { method: 'POST', body: new URLSearchParams({ Lat: String(lat), Lon: String(lon) }), signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // The portal sometimes answers 200 with an HTML page: say so in words, not a JSON parser message.
    const raw = await res.json().catch(() => {
      throw new Error('Cổng trả dữ liệu không hợp lệ');
    });
    const info = parsePlanning(raw, lon, lat);
    await cacheSet(NS, key, info ? { info } : { none: true }, TTL_MS);
    return info;
  } catch (e) {
    if (signal?.aborted) throw e;
    const stale = await cacheGet<Cached>(NS, key, true);
    if (stale) return 'none' in stale ? null : stale.info;
    throw timedOut ? new Error(`Cổng không phản hồi (quá ${TIMEOUT_MS / 1000} giây)`) : e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ---- map + dossier views ----

/** Lot outline + zoning cells as one FeatureCollection for the map (`kind` = 'lot' | 'cell'). */
export function planningToGeoJson(info: PlanningInfo | null): GeoJSON.FeatureCollection {
  const out: GeoJSON.Feature[] = [];
  if (info) {
    for (const c of info.cells) {
      out.push({ type: 'Feature', properties: { kind: 'cell', color: c.color, code: c.code, name: c.name }, geometry: { type: 'MultiPolygon', coordinates: c.geometry } });
    }
    if (info.outline) out.push({ type: 'Feature', properties: { kind: 'lot', color: '#ffffff' }, geometry: { type: 'MultiPolygon', coordinates: info.outline } });
  }
  return { type: 'FeatureCollection', features: out };
}

/** Compact form for the valuation dossier: no geometry, so it stays small for the LLM. */
export interface PlanningSummary {
  source: string;
  url: string;
  /** ISO time the portal was queried. */
  queriedAt: string;
  point: LngLat;
  lot: { id?: string; soTo?: string; soThua?: string; ward?: string; district?: string; areaM2?: number };
  plans: string[];
  cells: { code: string; name: string; block?: string; areaM2: number; sharePct: number }[];
  frontages: PlanningFrontage[];
  extraLayers: number;
}

export function summarizePlanning(info: PlanningInfo): PlanningSummary {
  return {
    source: PLANNING_SOURCE.name,
    url: portalLink(info.lon, info.lat),
    queriedAt: new Date(info.fetchedAt).toISOString(),
    point: [info.lon, info.lat],
    lot: { id: info.cadastralId, soTo: info.soTo, soThua: info.soThua, ward: info.ward, district: info.district, areaM2: info.areaM2 },
    plans: info.plans,
    cells: info.cells.map((c) => ({ code: c.code, name: c.name, block: c.block, areaM2: Math.round(c.areaM2 * 10) / 10, sharePct: Math.round(c.sharePct * 10) / 10 })),
    frontages: info.frontages,
    extraLayers: info.extraLayers,
  };
}
