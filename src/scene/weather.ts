import type { Weather } from '../services/weather';

export type WeatherKind = 'auto' | 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog';

export const WEATHER_KINDS: readonly WeatherKind[] = ['auto', 'clear', 'cloudy', 'rain', 'storm', 'fog'];

export const WEATHER_LABEL: Record<WeatherKind, string> = {
  auto: 'Tự động',
  clear: 'Nắng',
  cloudy: 'Nhiều mây',
  rain: 'Mưa',
  storm: 'Dông',
  fog: 'Sương mù',
};

export const WEATHER_ICON: Record<WeatherKind, string> = {
  auto: '🔄',
  clear: '☀️',
  cloudy: '☁️',
  rain: '🌧️',
  storm: '⛈️',
  fog: '🌫️',
};

export interface WeatherPreset {
  /** Cloud cover 0..1. */
  cloud: number;
  /** 0 none, 1 rain, 2 heavy rain. */
  rain: 0 | 1 | 2;
  /** Horizontal drift of the rain per unit of fall (wind). */
  slant: number;
  /** Multiplier on the fog distances of the build. */
  fogScale: number;
  lightning: boolean;
  /** How much sun and hemisphere light are taken away, 0..1 (intensity x (1 - dim)). */
  dim: number;
}

const PRESETS: Record<Exclude<WeatherKind, 'auto'>, WeatherPreset> = {
  clear: { cloud: 0, rain: 0, slant: 0, fogScale: 1, lightning: false, dim: 0 },
  cloudy: { cloud: 0.85, rain: 0, slant: 0, fogScale: 0.9, lightning: false, dim: 0.15 },
  rain: { cloud: 0.9, rain: 1, slant: 0.15, fogScale: 0.6, lightning: false, dim: 0.3 },
  storm: { cloud: 1, rain: 2, slant: 0.5, fogScale: 0.5, lightning: true, dim: 0.5 },
  fog: { cloud: 0.5, rain: 0, slant: 0, fogScale: 0.3, lightning: false, dim: 0.2 },
};

export function weatherPreset(kind: Exclude<WeatherKind, 'auto'>): WeatherPreset {
  return { ...PRESETS[kind] };
}

/** Which hand-picked look best matches a live reading. */
export function kindFromLive(w: Weather): Exclude<WeatherKind, 'auto'> {
  if (w.code >= 95) return 'storm';
  if (w.rain) return 'rain';
  if (w.code === 45 || w.code === 48) return 'fog';
  return w.code === 3 || w.cloudCover > 0.6 ? 'cloudy' : 'clear';
}

export function parseWeatherKind(s: string | null): WeatherKind | null {
  return WEATHER_KINDS.find((k) => k === s) ?? null;
}
