import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOverpassText, OVERPASS_ENDPOINTS, OVERPASS_LIMITS } from '../src/data/osm';

const bbox = { south: 21, west: 105.8, north: 21.001, east: 105.801 };
const saved = { ...OVERPASS_LIMITS };

/** fetch that never answers until aborted — what an overloaded Overpass mirror does. */
const hangingFetch = (_url: string, init?: RequestInit) =>
  new Promise<Response>((_res, rej) => {
    const abort = () => rej(new DOMException('Aborted', 'AbortError'));
    if (init?.signal?.aborted) abort(); // like real fetch
    init?.signal?.addEventListener('abort', abort);
  });

afterEach(() => {
  Object.assign(OVERPASS_LIMITS, saved);
  vi.unstubAllGlobals();
});

describe('fetchOverpassText with stalled mirrors', () => {
  it('gives up on each silent mirror and reports an error instead of hanging', async () => {
    Object.assign(OVERPASS_LIMITS, { statusMs: 20, firstByteMs: 30, stallMs: 30 });
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push(String(url));
      return hangingFetch(url, init);
    });
    const t0 = Date.now();
    await expect(fetchOverpassText(bbox)).rejects.toThrow(/không phản hồi/);
    expect(Date.now() - t0).toBeLessThan(2000);
    // status + query per mirror
    expect(calls.filter((u) => u.endsWith('/interpreter'))).toHaveLength(OVERPASS_ENDPOINTS.length);
  });

  it('moves on to the next mirror when the first one stalls', async () => {
    Object.assign(OVERPASS_LIMITS, { statusMs: 20, firstByteMs: 30, stallMs: 30 });
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/status')) return Promise.resolve(new Response('2 slots available now.'));
      if (String(url) === OVERPASS_ENDPOINTS[0]) return hangingFetch(url, init);
      return Promise.resolve(new Response('{"elements":[]}'));
    });
    expect(await fetchOverpassText(bbox)).toBe('{"elements":[]}');
  });

  it('still honours the caller abort', async () => {
    vi.stubGlobal('fetch', hangingFetch);
    const c = new AbortController();
    const p = fetchOverpassText(bbox, c.signal);
    c.abort();
    await expect(p).rejects.toThrow();
  });
});
