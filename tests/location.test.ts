import { describe, expect, it } from 'vitest';
import { resolveStartLocation } from '../src/services/location';

const fallback = { lat: 10.7, lon: 106.6 };
const memStorage = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const geoOk = (lat: number, lon: number) => ({
  getCurrentPosition: (ok: PositionCallback) => ok({ coords: { latitude: lat, longitude: lon } } as GeolocationPosition),
});
const geoFail = { getCurrentPosition: (_ok: PositionCallback, err?: PositionErrorCallback | null) => err?.({ code: 1 } as GeolocationPositionError) };
const perm = (state: PermissionState) => ({ query: async () => ({ state }) as PermissionStatus });

describe('resolveStartLocation', () => {
  it('uses the GPS position and caches it', async () => {
    const storage = memStorage();
    const r = await resolveStartLocation(fallback, { geolocation: geoOk(21, 105.8), permissions: perm('granted'), storage });
    expect(r).toEqual({ lat: 21, lon: 105.8, source: 'gps' });
    expect(storage.m.get('tinymap:lastLocation')).toContain('105.8');
  });

  it('prefers the cached position', async () => {
    const storage = memStorage({ 'tinymap:lastLocation': JSON.stringify({ lat: 16, lon: 108 }) });
    const r = await resolveStartLocation(fallback, { geolocation: geoOk(21, 105.8), storage });
    expect(r.source).toBe('cache');
    expect(r.lat).toBe(16);
  });

  it('falls back to the default when GPS fails or is denied', async () => {
    expect((await resolveStartLocation(fallback, { geolocation: geoFail, storage: memStorage() })).source).toBe('default');
    let asked = false;
    const geo = { getCurrentPosition: () => { asked = true; } };
    const r = await resolveStartLocation(fallback, { geolocation: geo, permissions: perm('denied'), storage: memStorage() });
    expect(r).toEqual({ ...fallback, source: 'default' });
    expect(asked).toBe(false);
  });

  it('falls back when geolocation is unavailable or storage throws', async () => {
    const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect((await resolveStartLocation(fallback, { geolocation: null, storage: bad })).source).toBe('default');
  });

  it('times out a hanging GPS request', async () => {
    const hang = { getCurrentPosition: () => {} };
    const r = await resolveStartLocation(fallback, { geolocation: hang, storage: memStorage(), timeoutMs: 10 });
    expect(r.source).toBe('default');
  });
});
