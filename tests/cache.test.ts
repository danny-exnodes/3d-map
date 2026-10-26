import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetCacheForTests, cacheClear, cacheGet, cacheSet, cacheUsage, CACHE_MAX_BYTES } from '../src/data/cache';
import { parseOverpassStatus, slimOverpass } from '../src/data/osm';
import { bboxKey } from '../src/data/loader';

beforeEach(async () => {
  _resetCacheForTests();
  await cacheClear();
});

describe('IndexedDB cache', () => {
  it('stores and returns values per namespace', async () => {
    await cacheSet('osm', 'a', '{"x":1}', 60_000);
    expect(await cacheGet('osm', 'a')).toBe('{"x":1}');
    expect(await cacheGet('weather', 'a')).toBeUndefined();
  });

  it('expires entries after their TTL', async () => {
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    await cacheSet('weather', 'k', { t: 30 }, 1000);
    spy.mockReturnValue(now + 2000);
    expect(await cacheGet('weather', 'k')).toBeUndefined();
    spy.mockRestore();
  });

  it('evicts least-recently-used entries over the size cap', async () => {
    const big = CACHE_MAX_BYTES / 5;
    let t = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) await cacheSet('osm', k, 'x', 60_000, big);
    spy.mockRestore();
    const u = await cacheUsage();
    expect(u.bytes).toBeLessThanOrEqual(CACHE_MAX_BYTES);
    expect(await cacheGet('osm', 'f')).toBe('x');
    expect(await cacheGet('osm', 'a')).toBeUndefined();
  });
});

describe('Overpass helpers', () => {
  it('reads the rate-limit status', () => {
    expect(parseOverpassStatus('Rate limit: 2\n2 slots available now.\nCurrently running queries')).toBe(0);
    expect(parseOverpassStatus('Rate limit: 2\nSlot available after: 2026-10-26T12:00:05Z, in 7 seconds.\nSlot available after: x, in 31 seconds.')).toBe(7);
    expect(parseOverpassStatus('garbage')).toBeNull();
  });

  it('drops unused tags', () => {
    const s = slimOverpass({ elements: [{ type: 'way', id: 1, tags: { building: 'yes', 'source:date': '2019', note: 'x', height: '9' } }] });
    expect(s.elements[0].tags).toEqual({ building: 'yes', height: '9' });
  });

  it('rounds bbox keys so tiny pans hit the cache', () => {
    expect(bboxKey({ south: 21.000012, west: 105.8, north: 21.01, east: 105.81 })).toBe(bboxKey({ south: 21.000049, west: 105.80001, north: 21.01, east: 105.81 }));
  });
});
