/**
 * Flood points through the CORS relay: observed stations from Thoát nước Hà Nội (HSDC) and forecast
 * risk zones from Bản đồ triều cường (Tuổi Trẻ) for TP.HCM. Neither feed is documented, so parsing
 * skips anything it does not understand instead of failing.
 */

/** 0 = dry (not drawn) … 3 = deepest. */
export type FloodLevel = 0 | 1 | 2 | 3;
export type FloodRegion = 'hanoi' | 'hcm';

export interface FloodPoint {
  id: string;
  name: string;
  lat: number;
  lon: number;
  level: FloodLevel;
  /** Disc radius on the ground (m); 0 when dry. */
  radiusM: number;
  source: FloodRegion;
}

export const FLOOD_SOURCE: Record<FloodRegion, string> = { hanoi: 'Thoát nước Hà Nội', hcm: 'Bản đồ triều cường (Tuổi Trẻ)' };

const STATION_RADIUS = [0, 40, 70, 100];
const SUMMARY_KM = 5;

const clampLevel = (n: number): FloodLevel => Math.min(3, Math.max(0, n)) as FloodLevel;

/** `<timestamp>_Flood_level<N>.png` → N − 1. Only level1 has been seen (a dry day): confirm N ≥ 2 on a rainy one. */
export function hsdcLevel(icon: unknown): FloodLevel {
  const m = typeof icon === 'string' ? /Flood_level(\d+)/.exec(icon) : null;
  return m ? clampLevel(Number(m[1]) - 1) : 0;
}

/** Only `low` and `watch` have been seen; an unknown level is shown as 1 rather than hidden. */
export function tuoiTreLevel(level: unknown): FloodLevel {
  switch (level) {
    case 'low':
      return 0;
    case 'watch':
      return 1;
    case 'high':
      return 2;
    case 'severe':
    case 'critical':
    case 'very_high':
      return 3;
    default:
      return 1;
  }
}

/** A finite number from a number or a plain decimal string ("21.03", not "21,03" or ""). */
function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string' || !/^\s*-?\d+(\.\d+)?\s*$/.test(v)) return NaN;
  return Number(v);
}

const placed = (p: FloodPoint) => Number.isFinite(p.lat) && Number.isFinite(p.lon);

/** The placed points; throws when there were rows but none could be read (the feed changed shape), so the caller reports a failure instead of "no flooding". */
function keepPlaced(points: FloodPoint[]): FloodPoint[] {
  const ok = points.filter(placed);
  if (points.length && !ok.length) throw new Error('flood feed: no readable rows');
  return ok;
}

export function parseHsdc(json: unknown): FloodPoint[] {
  const body = json as { Code?: unknown; Content?: unknown } | null;
  if (body?.Code !== 1 || !Array.isArray(body.Content)) throw new Error('flood feed: unexpected HSDC response');
  return keepPlaced(
    body.Content.map((r: Record<string, unknown>): FloodPoint => {
      const level = hsdcLevel(r?.Icon);
      return { id: `hn-${r?.TramId}`, name: String(r?.TenTram ?? ''), lat: num(r?.Lat), lon: num(r?.Lng), level, radiusM: STATION_RADIUS[level], source: 'hanoi' };
    }),
  );
}

export function parseTuoiTre(json: unknown): FloodPoint[] {
  if (!Array.isArray(json)) throw new Error('flood feed: unexpected Tuổi Trẻ response');
  return keepPlaced(
    json.map((r: Record<string, unknown>): FloodPoint => {
      const radius = num(r?.radius_m);
      return { id: `hcm-${r?.zone_id}`, name: String(r?.name ?? ''), lat: num(r?.lat), lon: num(r?.lng), level: tuoiTreLevel(r?.level), radiusM: Number.isFinite(radius) ? radius : 0, source: 'hcm' };
    }),
  );
}

/** The city whose feed covers this point, from rough boxes around Hà Nội and TP.HCM. */
export function floodRegion(lat: number, lon: number): FloodRegion | null {
  if (lat >= 20.53 && lat <= 21.39 && lon >= 105.28 && lon <= 106.03) return 'hanoi';
  if (lat >= 10.3 && lat <= 11.2 && lon >= 106.3 && lon <= 107.2) return 'hcm';
  return null;
}

export function floodUrl(relay: string, region: FloodRegion): string {
  return `${relay.replace(/\/+$/, '')}/flood/${region}`;
}

export async function fetchFlood(relay: string, region: FloodRegion, signal?: AbortSignal): Promise<FloodPoint[]> {
  const res = await fetch(floodUrl(relay, region), { signal });
  if (!res.ok) throw new Error(`flood ${res.status}`);
  const json: unknown = await res.json();
  return region === 'hanoi' ? parseHsdc(json) : parseTuoiTre(json);
}

/** Equirectangular distance; plenty at a few km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const k = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot(lat2 - lat1, (lon2 - lon1) * k) * 111.32;
}

/** The card line: flooded (Hà Nội, observed) or at-risk (TP.HCM, forecast) points within 5 km. */
export function floodSummary(points: FloodPoint[], region: FloodRegion, lat: number, lon: number, time: string): string {
  const n = points.filter((p) => p.level >= 1 && distanceKm(lat, lon, p.lat, p.lon) <= SUMMARY_KM).length;
  const what = region === 'hanoi' ? ['đang ngập', 'ngập'] : ['có nguy cơ ngập', 'nguy cơ ngập'];
  const head = n ? `${n} điểm ${what[0]}` : `Không có điểm ${what[1]} nào`;
  return `💧 ${head} trong ${SUMMARY_KM} km · ${FLOOD_SOURCE[region]} · cập nhật ${time}`;
}
