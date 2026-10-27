import * as THREE from 'three';
import { sunPosition, sunState, type SunState } from './sun';

export type Mood = 'morning' | 'noon' | 'golden' | 'night';

export const MOODS: readonly Mood[] = ['morning', 'noon', 'golden', 'night'];

export const MOOD_LABEL: Record<Mood, string> = {
  morning: 'Buổi sáng',
  noon: 'Nắng trưa',
  golden: 'Hoàng hôn',
  night: 'Đêm ấm',
};

export interface MoodKey {
  sky: string;
  sun: string;
  sunIntensity: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  exposure: number;
}

export const MOOD_KEYS: Record<Mood, MoodKey> = {
  morning: { sky: '#a9d8f2', sun: '#ffffff', sunIntensity: 2.0, hemiSky: '#cfe3ff', hemiGround: '#e0d4b8', hemiIntensity: 1.6, exposure: 1.0 },
  noon: { sky: '#cdeaf3', sun: '#fff0d8', sunIntensity: 1.9, hemiSky: '#e3f0ff', hemiGround: '#f0dcc0', hemiIntensity: 1.7, exposure: 1.05 },
  golden: { sky: '#f8cfab', sun: '#ffb36b', sunIntensity: 2.6, hemiSky: '#ffe0c2', hemiGround: '#c4b0d4', hemiIntensity: 1.2, exposure: 1.0 },
  night: { sky: '#7a76a8', sun: '#a9b0ff', sunIntensity: 0.6, hemiSky: '#9692cc', hemiGround: '#4a4160', hemiIntensity: 0.9, exposure: 1.1 },
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** True while the sun is climbing: the altitude 10 minutes later is higher. */
export function isRising(date: Date, lat: number, lon: number): boolean {
  return sunPosition(new Date(date.getTime() + 600_000), lat, lon).altitude > sunPosition(date, lat, lon).altitude;
}

export function moodWeights(s: SunState, rising: boolean): Record<Mood, number> {
  const elev = Math.sin((s.altitudeDeg * Math.PI) / 180);
  const d = 1 - s.night;
  // ponytail: assumes noon sun ≥ 37°; key on hour angle if the app goes beyond ~30° latitude
  const morning = rising ? d * (1 - smooth(0.3, 0.6, elev)) : 0;
  const golden = rising ? 0 : d * (1 - smooth(0.12, 0.35, elev));
  return { morning, noon: d - morning - golden, golden, night: s.night };
}

export function dominantMood(s: SunState, rising: boolean): Mood {
  const w = moodWeights(s, rising);
  return MOODS.reduce((best, m) => (w[m] > w[best] ? m : best), MOODS[0]);
}

const KEY_COLORS = Object.fromEntries(
  MOODS.map((m) => [
    m,
    {
      sky: new THREE.Color(MOOD_KEYS[m].sky),
      sun: new THREE.Color(MOOD_KEYS[m].sun),
      hemiSky: new THREE.Color(MOOD_KEYS[m].hemiSky),
      hemiGround: new THREE.Color(MOOD_KEYS[m].hemiGround),
    },
  ]),
) as Record<Mood, Record<'sky' | 'sun' | 'hemiSky' | 'hemiGround', THREE.Color>>;

const addScaled = (to: THREE.Color, c: THREE.Color, k: number) => {
  to.r += c.r * k;
  to.g += c.g * k;
  to.b += c.b * k;
};

const CLOUD_GREY = new THREE.Color('#9aa3ad');

/** Sky / fog colour, sun and hemisphere light and exposure: a weighted blend of the four mood keys, greyed by cloud cover (0..1). */
export function moodLighting(s: SunState, rising: boolean, cloud = 0) {
  const w = moodWeights(s, rising);
  const sky = new THREE.Color(0, 0, 0);
  const sunColor = new THREE.Color(0, 0, 0);
  const hemiSky = new THREE.Color(0, 0, 0);
  const hemiGround = new THREE.Color(0, 0, 0);
  let sunIntensity = 0;
  let hemiIntensity = 0;
  let exposure = 0;
  for (const m of MOODS) {
    const k = MOOD_KEYS[m];
    const c = KEY_COLORS[m];
    addScaled(sky, c.sky, w[m]);
    addScaled(sunColor, c.sun, w[m]);
    addScaled(hemiSky, c.hemiSky, w[m]);
    addScaled(hemiGround, c.hemiGround, w[m]);
    sunIntensity += k.sunIntensity * w[m];
    hemiIntensity += k.hemiIntensity * w[m];
    exposure += k.exposure * w[m];
  }
  sky.lerp(CLOUD_GREY, cloud * 0.45 * (1 - s.night));
  return { sky, sunColor, sunIntensity: sunIntensity * (1 - cloud * 0.6), hemiSky, hemiGround, hemiIntensity, exposure };
}

/** Local clock minute (0..1439) where `mood` is strongest (middle of a plateau) on the day starting at `dateUtcMidnight` (UTC) at the given place. */
export function minuteForMood(mood: Mood, dateUtcMidnight: Date, lat: number, lon: number, utcOffsetHours: number): number {
  const STEP = 5;
  const fallback = mood === 'night' ? 0 : 720;
  const weights: number[] = [];
  const altitudes: number[] = [];
  for (let m = 0; m < 1440; m += STEP) {
    const date = new Date(dateUtcMidnight.getTime() + m * 60_000 - utcOffsetHours * 3_600_000);
    weights.push(moodWeights(sunState(date, lat, lon), isRising(date, lat, lon))[mood]);
    altitudes.push(sunPosition(date, lat, lon).altitude);
  }
  if (Math.max(...weights) <= 0.05) return fallback;
  if (mood === 'night') {
    // First 5-minute step that is dark enough and at least 60 minutes after the sun last dipped below the horizon.
    const set = altitudes.findIndex((a, i) => i > 0 && altitudes[i - 1] >= 0 && a < 0);
    if (set >= 0) {
      for (let i = set + 60 / STEP; i < weights.length; i++) if (weights[i] > 0.05) return i * STEP;
    }
  }
  // Middle of the longest run of steps within 1e-3 of the peak, so a plateau (noon) lands in its centre.
  const peak = Math.max(...weights);
  let bestStart = 0;
  let bestLen = 0;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] < peak - 1e-3) continue;
    let j = i;
    while (j + 1 < weights.length && weights[j + 1] >= peak - 1e-3) j++;
    if (j - i + 1 > bestLen) [bestStart, bestLen] = [i, j - i + 1];
    i = j;
  }
  return (bestStart + Math.floor((bestLen - 1) / 2)) * STEP;
}
