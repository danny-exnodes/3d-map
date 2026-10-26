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
