/**
 * Live traffic from Google (#11): the Routes API returns speed readings (NORMAL / SLOW /
 * TRAFFIC_JAM) along a route when asked for TRAFFIC_ON_POLYLINE. Google has no API giving
 * speeds for every street of an area, so the app asks for one route along each main road of the
 * model and paints what comes back onto those roads.
 *
 * Needs the user's own Google Maps Platform key (billing on; roughly US$10 per 1 000 routes).
 * The key stays in this browser's localStorage. Complying with the Google Maps Platform terms
 * for showing this content is up to the key owner; "Traffic © Google" is always shown with it.
 */
import type { LngLat } from './types';

const KEY = 'tinymap:googleKey';
const ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';

export type Speed = 'NORMAL' | 'SLOW' | 'TRAFFIC_JAM';
/** Speed / free-flow speed for each reading. */
export const SPEED_RATIO: Record<Speed, number> = { NORMAL: 0.9, SLOW: 0.5, TRAFFIC_JAM: 0.18 };

export function googleKey(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setGoogleKey(k: string | null) {
  try {
    if (k) localStorage.setItem(KEY, k);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Google encoded polyline → [lon, lat] points. */
export function decodePolyline(s: string): LngLat[] {
  const out: LngLat[] = [];
  let i = 0, lat = 0, lon = 0;
  while (i < s.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b: number;
      do {
        b = s.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d;
      else lon += d;
    }
    out.push([lon / 1e5, lat / 1e5]);
  }
  return out;
}

export interface TrafficPiece {
  line: LngLat[];
  speed: Speed;
}

/** One route's speed readings, split into polyline pieces. */
export async function routeTraffic(from: LngLat, to: LngLat, key: string, signal?: AbortSignal): Promise<TrafficPiece[]> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.polyline.encodedPolyline,routes.travelAdvisory.speedReadingIntervals',
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: from[1], longitude: from[0] } } },
      destination: { location: { latLng: { latitude: to[1], longitude: to[0] } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      extraComputations: ['TRAFFIC_ON_POLYLINE'],
    }),
  });
  if (!res.ok) throw new Error(`Google Routes HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as {
    routes?: { polyline?: { encodedPolyline?: string }; travelAdvisory?: { speedReadingIntervals?: { startPolylinePointIndex?: number; endPolylinePointIndex?: number; speed?: Speed }[] } }[];
  };
  const r = json.routes?.[0];
  if (!r?.polyline?.encodedPolyline) return [];
  const pts = decodePolyline(r.polyline.encodedPolyline);
  return (r.travelAdvisory?.speedReadingIntervals ?? []).map((iv) => ({
    line: pts.slice(iv.startPolylinePointIndex ?? 0, (iv.endPolylinePointIndex ?? pts.length - 1) + 1),
    speed: iv.speed ?? 'NORMAL',
  }));
}

type XZ = [number, number];

const segDist = (p: XZ, a: XZ, b: XZ) => {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const L = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
};

/**
 * Speed ratio for a road (local x/z polyline) from Google pieces (local x/z): the reading covering
 * most of the road within `tol` metres, or null when Google said nothing about it.
 */
export function matchRoad(road: XZ[], pieces: { line: XZ[]; speed: Speed }[], tol = 12): number | null {
  const votes: Record<Speed, number> = { NORMAL: 0, SLOW: 0, TRAFFIC_JAM: 0 };
  let samples = 0;
  for (let i = 0; i < road.length - 1; i++) {
    for (const t of [0.25, 0.75]) {
      const p: XZ = [road[i][0] + (road[i + 1][0] - road[i][0]) * t, road[i][1] + (road[i + 1][1] - road[i][1]) * t];
      samples++;
      let best: Speed | null = null, bd = tol;
      for (const piece of pieces) {
        for (let k = 0; k < piece.line.length - 1; k++) {
          const d = segDist(p, piece.line[k], piece.line[k + 1]);
          if (d < bd) (bd = d), (best = piece.speed);
        }
      }
      if (best) votes[best]++;
    }
  }
  const total = votes.NORMAL + votes.SLOW + votes.TRAFFIC_JAM;
  if (!samples || total < samples * 0.5) return null;
  const s = (Object.keys(votes) as Speed[]).sort((a, b) => votes[b] - votes[a])[0];
  return SPEED_RATIO[s];
}
