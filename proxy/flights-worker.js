// Cloudflare Worker: CORS relay for adsb.fi. Forwards one path pattern, answers only the app's origins, caches 10 s.
const UPSTREAM = 'https://opendata.adsb.fi/api';
const ORIGINS = ['https://danny-exnodes.github.io', 'http://localhost:5173'];
const PATH = /^\/v2\/lat\/(-?\d{1,3}(?:\.\d{1,4})?)\/lon\/(-?\d{1,3}(?:\.\d{1,4})?)\/dist\/(\d{1,3})$/;

/** The normalised upstream path (lat/lon to 2 decimals, so the cache key is shared) for a valid request, else null. */
export function relayPath(url) {
  const m = PATH.exec(url.pathname);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  const dist = Number(m[3]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || dist < 1 || dist > 250) return null;
  return `/v2/lat/${lat.toFixed(2)}/lon/${lon.toFixed(2)}/dist/${dist}`;
}

function withCors(res, origin) {
  const out = new Response(res.body, res);
  out.headers.set('Access-Control-Allow-Origin', origin);
  out.headers.set('Vary', 'Origin');
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS' && origin && ORIGINS.includes(origin)) {
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET', Vary: 'Origin' } });
    }
    if (!origin || !ORIGINS.includes(origin)) return new Response('forbidden', { status: 403 });
    if (request.method !== 'GET') return withCors(new Response('method not allowed', { status: 405 }), origin);
    const path = relayPath(new URL(request.url));
    if (!path) return withCors(new Response('not found', { status: 404 }), origin);

    const cache = caches.default;
    const key = new Request(new URL(path, request.url).toString());
    const hit = await cache.match(key);
    if (hit) return withCors(hit, origin);

    let up;
    try {
      up = await fetch(UPSTREAM + path);
    } catch {
      return withCors(new Response('upstream unreachable', { status: 502 }), origin);
    }
    if (!up.ok) return withCors(new Response('upstream ' + up.status, { status: 502 }), origin);
    const res = new Response(up.body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10' } });
    ctx.waitUntil(cache.put(key, res.clone()));
    return withCors(res, origin);
  },
};
