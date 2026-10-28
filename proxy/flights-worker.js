// Cloudflare Worker: CORS relay for adsb.fi. Forwards one path pattern, answers only the app's origins, caches 10 s.
const UPSTREAM = 'https://opendata.adsb.fi/api';
const ORIGINS = ['https://danny-exnodes.github.io', 'http://localhost:5173'];
const PATH = /^\/v2\/lat\/-?\d+(\.\d+)?\/lon\/-?\d+(\.\d+)?\/dist\/(\d{1,3})$/;

/** The upstream path for a valid request, else null. */
export function relayPath(url) {
  const m = PATH.exec(url.pathname);
  if (!m) return null;
  const dist = Number(m[3]);
  return dist >= 1 && dist <= 250 ? url.pathname : null;
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
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
    const path = relayPath(new URL(request.url));
    if (!path) return new Response('not found', { status: 404 });

    const cache = caches.default;
    const key = new Request(new URL(path, request.url).toString());
    const hit = await cache.match(key);
    if (hit) return withCors(hit, origin);

    const up = await fetch(UPSTREAM + path);
    if (!up.ok) return withCors(new Response('upstream ' + up.status, { status: 502 }), origin);
    const res = new Response(up.body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10' } });
    ctx.waitUntil(cache.put(key, res.clone()));
    return withCors(res, origin);
  },
};
