import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader as Pbf } from 'pbf';
const url = 'https://tiles.overturemaps.org/2026-10-21.0/buildings.pmtiles';
const p = new PMTiles(url);
const h = await p.getHeader();
console.log('zoom', h.minZoom, h.maxZoom, 'tileType', h.tileType, 'compression', h.tileCompression);
const md = await p.getMetadata();
console.log('layers', JSON.stringify(md.vector_layers?.map(l => [l.id, l.minzoom, l.maxzoom, Object.keys(l.fields||{})])));
const tile = (lon, lat, z) => { const n = 2 ** z; const x = Math.floor((lon + 180) / 360 * n); const r = lat * Math.PI / 180; const y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); return [x, y]; };
for (const [name, lon, lat] of [['NgaTuSo', 105.8196, 21.0032], ['EnNam', 106.6764, 10.7378], ['Q1 HCMC', 106.7009, 10.7769]]) {
  const z = h.maxZoom; const [x, y] = tile(lon, lat, z);
  const t0 = Date.now();
  const r = await p.getZxy(z, x, y);
  if (!r) { console.log(name, 'no tile'); continue; }
  const vt = new VectorTile(new Pbf(new Uint8Array(r.data)));
  for (const ln of Object.keys(vt.layers)) {
    const L = vt.layers[ln]; let hh = 0, fl = 0; const src = {}; const props = new Set();
    for (let i = 0; i < L.length; i++) { const f = L.feature(i).properties; Object.keys(f).forEach(k => props.add(k)); if (f.height != null) hh++; if (f.num_floors != null) fl++; const s = String(f['@sources'] ?? f.sources ?? '').match(/"dataset":"([^"]+)"/g); (s||['?']).forEach(d => src[d] = (src[d]||0)+1); }
    console.log(name, `z${z}`, ln, 'features', L.length, 'height', hh, 'num_floors', fl, (r.data.byteLength/1024).toFixed(0)+'KB', Date.now()-t0+'ms');
    console.log('  props', [...props].join(','));
    console.log('  sources', JSON.stringify(src));
  }
}
