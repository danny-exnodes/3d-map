import { describe, expect, it } from 'vitest';
import { sunState } from '../src/scene/sun';
import { dominantMood, isRising, minuteForMood, moodLighting, moodWeights, MOODS } from '../src/scene/moods';

const HN = { lat: 21.0285, lon: 105.8542 };
const at = (y: number, m: number, d: number, minLocal: number) => new Date(Date.UTC(y, m - 1, d, 0, minLocal) - 7 * 3_600_000);
const state = (date: Date) => [sunState(date, HN.lat, HN.lon), isRising(date, HN.lat, HN.lon)] as const;

describe('moods', () => {
  it('weights sum to 1 and pick the expected mood through a day', () => {
    for (let m = 0; m < 1440; m += 15) {
      const w = moodWeights(...state(at(2026, 6, 21, m)));
      expect(MOODS.reduce((a, k) => a + w[k], 0)).toBeCloseTo(1, 5);
    }
    expect(dominantMood(...state(at(2026, 6, 21, 12 * 60)))).toBe('noon');
    expect(dominantMood(...state(at(2026, 6, 21, 7 * 60)))).toBe('morning');
    expect(dominantMood(...state(at(2026, 6, 21, 18 * 60 + 15)))).toBe('golden');
    expect(dominantMood(...state(at(2026, 6, 21, 22 * 60)))).toBe('night');
  });
  it('blends without jumps through a June and a December day', () => {
    for (const [y, mo, d] of [[2026, 6, 21], [2026, 12, 21]]) {
      let prev = moodLighting(...state(at(y, mo, d, 0)));
      for (let m = 1; m < 1440; m++) {
        const cur = moodLighting(...state(at(y, mo, d, m)));
        // Dusk in the tropics lasts ~25 min, so a per-minute step up to ~0.05 is a fade; a jump is ≥ 0.3.
        expect(Math.abs(cur.sky.r - prev.sky.r) + Math.abs(cur.sky.g - prev.sky.g) + Math.abs(cur.sky.b - prev.sky.b)).toBeLessThan(0.08);
        expect(Math.abs(cur.sunIntensity - prev.sunIntensity)).toBeLessThan(0.06);
        prev = cur;
      }
    }
  });
  it('puts golden hour shortly before sunset in December and in June', () => {
    for (const [mo, sunsetMin] of [[12, 17 * 60 + 20], [6, 18 * 60 + 45]]) {
      const g = minuteForMood('golden', new Date(Date.UTC(2026, mo - 1, 21)), HN.lat, HN.lon, 7);
      expect(g).toBeGreaterThan(sunsetMin - 90);
      expect(g).toBeLessThan(sunsetMin);
    }
  });
  it('places each mood sensibly in a Hà Nội day', () => {
    for (const mo of [6, 12]) {
      const day = new Date(Date.UTC(2026, mo - 1, 21));
      const f = (k: 'morning' | 'noon' | 'golden' | 'night') => minuteForMood(k, day, HN.lat, HN.lon, 7);
      expect(f('noon')).toBeGreaterThanOrEqual(11 * 60 + 30);
      expect(f('noon')).toBeLessThanOrEqual(13 * 60);
      expect(f('morning')).toBeLessThan(9 * 60);
      expect(sunState(at(2026, mo, 21, f('morning')), HN.lat, HN.lon).altitudeDeg).toBeGreaterThan(0);
      expect(f('night')).toBeGreaterThan(f('golden'));
    }
  });
  it('returns 0 for night when the sun never sets', () => {
    expect(minuteForMood('night', new Date(Date.UTC(2026, 5, 21)), 78.2, 15.6, 1)).toBe(0); // Svalbard, midnight sun
  });
  it('returns a valid minute when the mood never occurs', () => {
    const m = minuteForMood('golden', new Date(Date.UTC(2026, 5, 21)), 78.2, 15.6, 1); // Svalbard, midnight sun
    expect(m).toBeGreaterThanOrEqual(0);
    expect(m).toBeLessThan(1440);
  });
});
