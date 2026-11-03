import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JS module deployed to Cloudflare
import worker, { relayPath, upstreamFor } from '../proxy/flights-worker.js';

const u = (p: string) => new URL(p, 'https://relay.test');

describe('relayPath', () => {
  it('accepts only the readsb point query', () => {
    expect(relayPath(u('/v2/lat/21.0300/lon/105.8512/dist/40'))).toBe('/v2/lat/21.03/lon/105.85/dist/40');
    expect(relayPath(u('/v2/lat/21.03/lon/105.85/dist/40?x=1'))).toBe('/v2/lat/21.03/lon/105.85/dist/40');
    expect(relayPath(u('/v2/lat/-1/lon/-2.5/dist/250'))).not.toBeNull();
    for (const p of ['/v2/all', '/../x', '/v2/lat/21/lon/105/dist/0', '/v2/lat/21/lon/105/dist/999', '/v2/lat/abc/lon/105/dist/40', '/v2/lat/91/lon/105/dist/40', '/v2/lat/21/lon/181/dist/40', '/v2/lat/21.12345/lon/105/dist/40', '/v2/lat/21/lon/105/dist/40/', '//v2/lat/21/lon/105/dist/40', '/v2%2Flat/21/lon/105/dist/40', '/v2/lat/21/lon/105%2F../dist/40']) {
      expect(relayPath(u(p))).toBeNull();
    }
  });
});

describe('upstreamFor', () => {
  it('maps the readsb query and the two flood paths, nothing else', () => {
    expect(upstreamFor(u('/v2/lat/21.0300/lon/105.8512/dist/40'))).toBe('https://api.adsb.lol/v2/lat/21.03/lon/105.85/dist/40');
    expect(upstreamFor(u('/flood/hanoi'))).toBe('https://thoatnuochanoi.vn/ungngap/api/flood/getflood');
    expect(upstreamFor(u('/flood/hcm'))).toBe('https://bandotrieucuong.tuoitrethanhphobac.vn/api/forecasts');
    for (const p of ['/flood', '/flood/', '/flood/danang', '/flood/hanoi/', '/flood/hanoi/x', '/flood/HANOI', '//flood/hanoi']) expect(upstreamFor(u(p))).toBeNull();
  });
});

describe('fetch', () => {
  const cache = { match: vi.fn(async () => undefined as Response | undefined), put: vi.fn(async () => {}) };
  const up = vi.fn(async () => new Response('{"aircraft":[]}', { status: 200 }));
  const run = (origin: string | null, path = '/v2/lat/21/lon/105/dist/40') => {
    vi.stubGlobal('fetch', up);
    vi.stubGlobal('caches', { default: cache });
    const headers: Record<string, string> = origin ? { Origin: origin } : {};
    return worker.fetch(new Request('https://relay.test' + path, { headers }), {}, { waitUntil() {} });
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('403s a foreign origin without touching upstream', async () => {
    const r = await run('https://evil.test');
    expect(r.status).toBe(403);
    expect(up).not.toHaveBeenCalled();
  });

  it('echoes an allowed origin and forwards to adsb.lol', async () => {
    const r = await run('https://danny-exnodes.github.io');
    expect(r.status).toBe(200);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('https://danny-exnodes.github.io');
    expect((up.mock.calls[0] as unknown[])[0]).toBe('https://api.adsb.lol/v2/lat/21.00/lon/105.00/dist/40');
  });

  it('404s other paths, with CORS for an allowed origin', async () => {
    const r = await run('http://localhost:5173', '/v2/all');
    expect(r.status).toBe(404);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });

  it('forwards /flood/hanoi for an allowed origin and 403s a foreign one', async () => {
    const r = await run('https://danny-exnodes.github.io', '/flood/hanoi');
    expect(r.status).toBe(200);
    expect((up.mock.calls[0] as unknown[])[0]).toBe('https://thoatnuochanoi.vn/ungngap/api/flood/getflood');
    expect((await run('https://evil.test', '/flood/hanoi')).status).toBe(403);
  });

  it('403s a missing Origin', async () => {
    expect((await run(null)).status).toBe(403);
  });

  it('answers the preflight', async () => {
    vi.stubGlobal('fetch', up);
    const r = await worker.fetch(new Request('https://relay.test/v2/lat/21/lon/105/dist/40', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } }), {}, {});
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });

  it('405s a POST with CORS', async () => {
    vi.stubGlobal('fetch', up);
    vi.stubGlobal('caches', { default: cache });
    const r = await worker.fetch(new Request('https://relay.test/v2/lat/21/lon/105/dist/40', { method: 'POST', headers: { Origin: 'http://localhost:5173' } }), {}, {});
    expect(r.status).toBe(405);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });

  it('404s an out-of-range latitude', async () => {
    expect((await run('http://localhost:5173', '/v2/lat/95/lon/105/dist/40')).status).toBe(404);
  });

  it('serves from the cache and shares the key across digits', async () => {
    cache.match.mockResolvedValueOnce(new Response('{"aircraft":[1]}'));
    const r = await run('http://localhost:5173', '/v2/lat/21.0312/lon/105.8499/dist/40');
    expect(await r.text()).toBe('{"aircraft":[1]}');
    expect(up).not.toHaveBeenCalled();
    expect((cache.match.mock.calls[0] as unknown as [Request])[0].url).toBe('https://relay.test/v2/lat/21.03/lon/105.85/dist/40');
  });

  it('answers 502 with CORS when upstream throws or fails', async () => {
    up.mockRejectedValueOnce(new Error('net'));
    const r = await run('http://localhost:5173');
    expect(r.status).toBe(502);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    up.mockResolvedValueOnce(new Response('x', { status: 500 }));
    expect((await run('http://localhost:5173')).status).toBe(502);
  });
});
