export interface Place {
  name: string;
  lat: number;
  lon: number;
  bbox?: [south: number, north: number, west: number, east: number];
}

/** Free-text search via OpenStreetMap Nominatim (please respect its usage policy: ≤1 req/s). */
export async function searchPlaces(q: string, signal?: AbortSignal): Promise<Place[]> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '6');
  url.searchParams.set('accept-language', navigator.language || 'vi');
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const rows = (await res.json()) as { display_name: string; lat: string; lon: string; boundingbox?: string[] }[];
  return rows.map((r) => ({
    name: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    bbox: r.boundingbox?.map(parseFloat) as Place['bbox'],
  }));
}

export interface ReverseResult {
  address: string;
  /** Location of the matched object, and its OSM id (e.g. "way/123"). */
  lat: number;
  lon: number;
  osmId?: string;
}

let lastReverse = 0;

/**
 * Address at a point (#28), via Nominatim reverse geocoding: at most one request per second
 * (Nominatim usage policy), cached in IndexedDB for 30 days.
 */
export async function reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<ReverseResult | null> {
  const { cacheGet, cacheSet } = await import('../data/cache');
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const hit = await cacheGet<ReverseResult | null>('reverse', key);
  if (hit !== undefined) return hit;
  const wait = lastReverse + 1100 - Date.now();
  lastReverse = Math.max(Date.now(), lastReverse + 1100);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('zoom', '18');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'vi');
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const r = (await res.json()) as {
    error?: string;
    lat?: string;
    lon?: string;
    osm_type?: string;
    osm_id?: number;
    address?: Record<string, string>;
  };
  const out = r.error || !r.address ? null : { address: formatAddress(r.address), lat: Number(r.lat), lon: Number(r.lon), osmId: r.osm_type && r.osm_id ? `${r.osm_type}/${r.osm_id}` : undefined };
  void cacheSet('reverse', key, out, 30 * 24 * 3600 * 1000);
  return out;
}

/** "101 Châu Thị Hoá, Phường Chánh Hưng, Thành phố Hồ Chí Minh" from Nominatim address parts. */
export function formatAddress(a: Record<string, string>): string {
  const street = [a.house_number, a.road ?? a.pedestrian ?? a.footway].filter(Boolean).join(' ');
  const ward = a.quarter ?? a.suburb ?? a.neighbourhood ?? a.village;
  const city = a.city ?? a.town ?? a.state;
  return [a.amenity ?? a.building ?? a.shop, street, ward, city].filter((x, i, l) => x && l.indexOf(x) === i).join(', ');
}
