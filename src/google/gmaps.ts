/**
 * Google Maps Platform access for the Google version (v0.0.5), always with the user's own key:
 * - Map Tiles API: 2D roadmap/traffic tile sessions (used by MapLibre) and their copyright line;
 * - Maps JavaScript API: Geocoder for search and reverse geocoding (the Geocoding web service
 *   has no CORS, the JS API does).
 */

const TILES = 'https://tile.googleapis.com/v1';

export interface TileSession {
  session: string;
  tileWidth: number;
  expiry: number;
}

export async function createTileSession(key: string, opts: { overlay?: boolean; layerTypes?: string[] } = {}): Promise<TileSession> {
  const res = await fetch(`${TILES}/createSession?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapType: 'roadmap', language: 'vi-VN', region: 'VN', scale: 'scaleFactor2x', highDpi: true, ...opts }),
  });
  if (!res.ok) throw new Error(`Map Tiles API HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = (await res.json()) as { session: string; tileWidth: number; expiry: string };
  return { session: j.session, tileWidth: j.tileWidth, expiry: Number(j.expiry) * 1000 };
}

export const tileUrl = (key: string, s: TileSession) => `${TILES}/2dtiles/{z}/{x}/{y}?session=${s.session}&key=${encodeURIComponent(key)}`;

/** Copyright text Google requires for the visible 2D area. */
export async function viewportCopyright(key: string, s: TileSession, zoom: number, b: { north: number; south: number; east: number; west: number }): Promise<string> {
  const q = new URLSearchParams({ session: s.session, key, zoom: String(Math.round(zoom)), north: String(b.north), south: String(b.south), east: String(b.east), west: String(b.west) });
  const res = await fetch(`https://tile.googleapis.com/tile/v1/viewport?${q}`);
  if (!res.ok) return '';
  return ((await res.json()) as { copyright?: string }).copyright ?? '';
}

// ---- Maps JavaScript API (minimal typing of what is used) ----

interface LatLngLiteral {
  lat: number;
  lng: number;
}
interface GeocoderResult {
  formatted_address: string;
  geometry: { location: { lat(): number; lng(): number }; viewport?: { getNorthEast(): { lat(): number; lng(): number }; getSouthWest(): { lat(): number; lng(): number } } };
  place_id: string;
  types: string[];
}
interface Geocoder {
  geocode(req: { address?: string; location?: LatLngLiteral; language?: string; region?: string }): Promise<{ results: GeocoderResult[] }>;
}
declare global {
  interface Window {
    google?: { maps: { importLibrary(name: string): Promise<{ Geocoder: new () => Geocoder }> } };
    __tinymapGmaps?: () => void;
  }
}

let geocoderP: Promise<Geocoder> | null = null;

function geocoder(key: string): Promise<Geocoder> {
  geocoderP ??= new Promise<void>((resolve, reject) => {
    if (window.google?.maps) return resolve();
    window.__tinymapGmaps = () => resolve();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=vi&region=VN&loading=async&callback=__tinymapGmaps`;
    s.async = true;
    s.onerror = () => reject(new Error('Không tải được Maps JavaScript API'));
    document.head.appendChild(s);
  }).then(async () => new (await window.google!.maps.importLibrary('geocoding')).Geocoder());
  geocoderP.catch(() => (geocoderP = null));
  return geocoderP;
}

export interface Place {
  address: string;
  lat: number;
  lon: number;
  placeId: string;
  /** south, west, north, east when Google gives a viewport. */
  bounds?: [number, number, number, number];
}

const toPlace = (r: GeocoderResult): Place => {
  const v = r.geometry.viewport;
  return {
    address: r.formatted_address,
    lat: r.geometry.location.lat(),
    lon: r.geometry.location.lng(),
    placeId: r.place_id,
    bounds: v ? [v.getSouthWest().lat(), v.getSouthWest().lng(), v.getNorthEast().lat(), v.getNorthEast().lng()] : undefined,
  };
};

export async function searchPlace(key: string, q: string): Promise<Place | null> {
  const { results } = await (await geocoder(key)).geocode({ address: q, language: 'vi', region: 'VN' });
  return results[0] ? toPlace(results[0]) : null;
}

/** Address at a point: the most precise result (street address / premise first). */
export async function reverseGeocodeGoogle(key: string, lat: number, lon: number): Promise<Place | null> {
  const { results } = await (await geocoder(key)).geocode({ location: { lat, lng: lon }, language: 'vi' });
  const best = results.find((r) => r.types.some((t) => t === 'street_address' || t === 'premise' || t === 'subpremise')) ?? results[0];
  return best ? toPlace(best) : null;
}

export const googleMapsLink = (p: { lat: number; lon: number; placeId?: string }) =>
  `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(6)},${p.lon.toFixed(6)}${p.placeId ? `&query_place_id=${p.placeId}` : ''}`;
