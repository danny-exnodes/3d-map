import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JS module deployed to Cloudflare
import worker, { relayPath } from '../proxy/flights-worker.js';

const u = (p: string) => new URL(p, 'https://relay.test');

describe('relayPath', () => {
  it('accepts only the readsb point query', () => {
    expect(relayPath(u('/v2/lat/21.0300/lon/105.8500/dist/40'))).toBe('/v2/lat/21.0300/lon/105.8500/dist/40');
    expect(relayPath(u('/v2/lat/-1/lon/-2.5/dist/250'))).not.toBeNull();
    for (const p of ['/v2/all', '/../x', '/v2/lat/21/lon/105/dist/0', '/v2/lat/21/lon/105/dist/999', '/v2/lat/abc/lon/105/dist/40']) {
      expect(relayPath(u(p))).toBeNull();
    }
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

  it('echoes an allowed origin and forwards to adsb.fi', async () => {
    const r = await run('https://danny-exnodes.github.io');
    expect(r.status).toBe(200);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('https://danny-exnodes.github.io');
    expect((up.mock.calls[0] as unknown[])[0]).toBe('https://opendata.adsb.fi/api/v2/lat/21/lon/105/dist/40');
  });

  it('404s other paths', async () => {
    expect((await run('http://localhost:5173', '/v2/all')).status).toBe(404);
  });
});
