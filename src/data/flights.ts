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
    if (!r || typeof r.lat !== 'number' || typeof r.lon !== 'number') continue;
    out.push({
      hex: String(r.hex ?? ''),
      callsign: String(r.flight ?? '').trim(),
      type: String(r.t ?? ''),
      lat: r.lat,
      lon: r.lon,
      altM: typeof r.alt_baro === 'number' ? r.alt_baro * FT_M : 0,
      gsMs: (Number(r.gs) || 0) * KT_MS,
      trackDeg: Number(r.track) || 0,
      seenAt: now - (Number(r.seen_pos) || 0) * 1000,
    });
  }
  return out;
}

/** `?flights=<url>` > `tinymap:flightsRelay` > DEFAULT_FLIGHTS_RELAY > the Vite dev proxy > none. */
export function flightsRelay(search: string, storage: Storage | null, dev: boolean): string | null {
  const q = new URLSearchParams(search).get('flights');
  if (q) return q;
  let saved: string | null = null;
  try {
    saved = storage?.getItem('tinymap:flightsRelay') ?? null;
  } catch {
    /* storage blocked */
  }
  if (saved) return saved;
  if (DEFAULT_FLIGHTS_RELAY) return DEFAULT_FLIGHTS_RELAY;
  return dev ? '/flights-api' : null;
}

export function flightsUrl(relay: string, lat: number, lon: number, nm: number): string {
  return `${relay.replace(/\/+$/, '')}/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${nm}`;
}

export async function fetchFlights(relay: string, lat: number, lon: number, nm: number, signal?: AbortSignal): Promise<Flight[]> {
  const res = await fetch(flightsUrl(relay, lat, lon, nm), { signal });
  if (!res.ok) throw new Error(`flights relay ${res.status}`);
  return parseFlights(await res.json(), Date.now());
}
