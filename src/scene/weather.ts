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
  /** How much sun light is taken away, 0..1 (intensity x (1 - dim)); shadows fade with it. */
  dim: number;
  /** Same for the hemisphere light. */
  hemiDim: number;
  /** Multiplier on the tone-mapping exposure. */
  exposure: number;
  /** How far the sky is pulled toward slate grey, 0..1. */
  grey: number;
}

const PRESETS: Record<Exclude<WeatherKind, 'auto'>, WeatherPreset> = {
  clear: { cloud: 0, rain: 0, slant: 0, fogScale: 1, lightning: false, dim: 0, hemiDim: 0, exposure: 1, grey: 0 },
  cloudy: { cloud: 0.85, rain: 0, slant: 0, fogScale: 0.9, lightning: false, dim: 0.3, hemiDim: 0.1, exposure: 1, grey: 0.25 },
  rain: { cloud: 0.9, rain: 1, slant: 0.15, fogScale: 0.6, lightning: false, dim: 0.55, hemiDim: 0.2, exposure: 0.95, grey: 0.6 },
  storm: { cloud: 1, rain: 2, slant: 0.5, fogScale: 0.5, lightning: true, dim: 0.75, hemiDim: 0.4, exposure: 0.9, grey: 0.9 },
  fog: { cloud: 0.5, rain: 0, slant: 0, fogScale: 0.3, lightning: false, dim: 0.2, hemiDim: 0.15, exposure: 1, grey: 0.4 },
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

/** Flash length, and the calm between flashes (photosensitivity: at most one flash per 4 s). */
export const FLASH_MS = 120;
export const GAP_MIN_MS = 4000;
export const GAP_MAX_MS = 12000;

export interface LightningState {
  /** When the next flash starts (ms); 0 when lightning is off. */
  flashAt: number;
  /** When the running flash ends; 0 when no flash is running. */
  flashEnd: number;
  /** When the last flash ended; 0 if none yet. */
  lastEnd: number;
}

export const idleLightning = (): LightningState => ({ flashAt: 0, flashEnd: 0, lastEnd: 0 });

/** Turn lightning on or off. Re-applying "on" keeps the running timer; a fresh start respects the last gap. */
export function armLightning(st: LightningState, on: boolean, now: number): LightningState {
  if (!on) return { flashAt: 0, flashEnd: 0, lastEnd: st.flashEnd ? now : st.lastEnd };
  if (st.flashAt) return st;
  return { ...st, flashAt: Math.max(now + 1500, st.lastEnd + GAP_MIN_MS), flashEnd: 0 };
}

/** Advance the flash timer. `rand` is in [0, 1). */
export function nextLightning(st: LightningState, now: number, rand: number): LightningState {
  if (st.flashEnd) {
    if (now < st.flashEnd) return st;
    return { flashEnd: 0, lastEnd: now, flashAt: now + GAP_MIN_MS + rand * (GAP_MAX_MS - GAP_MIN_MS) };
  }
  if (st.flashAt && now >= st.flashAt) return { ...st, flashEnd: now + FLASH_MS };
  return st;
}

export const isFlashing = (st: LightningState) => st.flashEnd > 0;
