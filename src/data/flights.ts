/** Live aircraft from adsb.fi (readsb JSON) through a CORS relay; the free feeds send no CORS headers. */

export interface Flight {
  hex: string;
  callsign: string;
  type: string;
  lat: number;
  lon: number;
  altM: number;
  gsMs: number;
  trackDeg: number;
  /** Epoch ms of the last position report (`now` minus `seen_pos`). */
  seenAt: number;
}

/** A plane with no report for this long is gone. */
export const STALE_MS = 60_000;

/** URL of the deployed Cloudflare Worker (proxy/flights-worker.js); empty until the owner deploys it. */
export const DEFAULT_FLIGHTS_RELAY = '';

const FT_M = 0.3048;
const KT_MS = 1852 / 3600;

/** `now` is epoch ms. Rows without a numeric lat/lon are skipped. */
export function parseFlights(json: unknown, now: number): Flight[] {
  const j = json as { aircraft?: unknown; ac?: unknown } | null;
  const rows = j?.aircraft ?? j?.ac;
  if (!Array.isArray(rows)) return [];
  const out: Flight[] = [];
  for (const r of rows) {
    if (!r || !Number.isFinite(r.lat) || !Number.isFinite(r.lon) || Math.abs(r.lat) > 90 || Math.abs(r.lon) > 180) continue;
    let altFt: number;
    if (r.alt_baro === 'ground') altFt = 0;
    else if (Number.isFinite(r.alt_baro)) altFt = r.alt_baro;
    else if (Number.isFinite(r.alt_geom)) altFt = r.alt_geom;
    else continue;
    const gs = Number.isFinite(r.gs) ? r.gs : 0;
    const seen = Number.isFinite(r.seen_pos) ? r.seen_pos : 0;
    out.push({
      hex: String(r.hex ?? ''),
      callsign: String(r.flight ?? '').trim(),
      type: String(r.t ?? ''),
      lat: r.lat,
      lon: r.lon,
      altM: altFt * FT_M,
      gsMs: gs * KT_MS,
      trackDeg: Number.isFinite(r.track) ? r.track : 0,
      seenAt: now - seen * 1000,
    });
  }
  return out;
}

/**
 * https URLs, or a path on the page's own origin. The value is parsed the way fetch will parse it, so
 * `/\evil.test` or `/<TAB>/evil.test` (which browsers read as off-origin) are refused up front.
 */
export function validRelay(v: string, base: string = typeof location === 'undefined' ? 'https://localhost' : location.origin): boolean {
  if (/[\\\s\u0000-\u001f]/.test(v)) return false;
  try {
    if (/^https:\/\/[^/]/i.test(v)) return new URL(v).protocol === 'https:';
    if (!v.startsWith('/') || v.startsWith('//')) return false;
    return new URL(v, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** `?flights=<url>` > `tinymap:flightsRelay` > DEFAULT_FLIGHTS_RELAY > the Vite dev proxy > none. */
export function flightsRelay(search: string, storage: Storage | null, dev: boolean): string | null {
  const q = new URLSearchParams(search).get('flights');
  if (q && validRelay(q)) return q;
  let saved: string | null = null;
  try {
    saved = storage?.getItem('tinymap:flightsRelay') ?? null;
  } catch {
    /* storage blocked */
  }
  if (saved && validRelay(saved)) return saved;
  if (DEFAULT_FLIGHTS_RELAY) return DEFAULT_FLIGHTS_RELAY;
  return dev ? '/flights-api' : null;
}

export function flightsUrl(relay: string, lat: number, lon: number, nm: number): string {
  return `${relay.replace(/\/+$/, '')}/v2/lat/${lat.toFixed(2)}/lon/${lon.toFixed(2)}/dist/${nm}`;
}

export async function fetchFlights(relay: string, lat: number, lon: number, nm: number, signal?: AbortSignal): Promise<Flight[]> {
  const res = await fetch(flightsUrl(relay, lat, lon, nm), { signal });
  if (!res.ok) throw new Error(`flights relay ${res.status}`);
  const json = await res.json();
  const sec = (json as { now?: unknown } | null)?.now;
  return parseFlights(json, typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec * 1000 : Date.now());
}
