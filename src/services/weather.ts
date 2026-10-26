export interface Weather {
  temperature: number;
  code: number;
  cloudCover: number;
  precipitation: number;
  label: string;
  icon: string;
  rain: boolean;
}

/** WMO weather interpretation codes → Vietnamese label + emoji. */
export function describeWeather(code: number): { label: string; icon: string; rain: boolean } {
  if (code === 0) return { label: 'Trời quang', icon: '☀️', rain: false };
  if (code <= 2) return { label: 'Ít mây', icon: '🌤️', rain: false };
  if (code === 3) return { label: 'Nhiều mây', icon: '☁️', rain: false };
  if (code === 45 || code === 48) return { label: 'Sương mù', icon: '🌫️', rain: false };
  if (code >= 51 && code <= 57) return { label: 'Mưa phùn', icon: '🌦️', rain: true };
  if (code >= 61 && code <= 67) return { label: 'Mưa', icon: '🌧️', rain: true };
  if (code >= 71 && code <= 77) return { label: 'Tuyết', icon: '🌨️', rain: false };
  if (code >= 80 && code <= 82) return { label: 'Mưa rào', icon: '🌧️', rain: true };
  if (code >= 95) return { label: 'Dông', icon: '⛈️', rain: true };
  return { label: 'Không rõ', icon: '🌡️', rain: false };
}

import { cacheGet, cacheSet } from '../data/cache';

/** Current weather from Open-Meteo (free, no API key), cached for 15 minutes. */
export async function fetchWeather(lat: number, lon: number, signal?: AbortSignal): Promise<Weather> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = await cacheGet<Weather>('weather', key);
  if (hit) return hit;
  const w = await fetchWeatherUncached(lat, lon, signal);
  void cacheSet('weather', key, w, 15 * 60_000);
  return w;
}

async function fetchWeatherUncached(lat: number, lon: number, signal?: AbortSignal): Promise<Weather> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat.toFixed(4));
  url.searchParams.set('longitude', lon.toFixed(4));
  url.searchParams.set('current', 'temperature_2m,weather_code,cloud_cover,precipitation');
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const j = (await res.json()) as {
    current: { temperature_2m: number; weather_code: number; cloud_cover: number; precipitation: number };
  };
  const c = j.current;
  return {
    temperature: c.temperature_2m,
    code: c.weather_code,
    cloudCover: c.cloud_cover / 100,
    precipitation: c.precipitation,
    ...describeWeather(c.weather_code),
  };
}
