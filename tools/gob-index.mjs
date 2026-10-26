// Builds tools/data/gob-vnm-2023-index.json: tile URL → UTM zone + bbox, by reading only TIFF headers.
import { fromUrl } from 'geotiff';
import { readFileSync, writeFileSync } from 'node:fs';
const urls = readFileSync(new URL('./data/gob-vnm-2023-urls.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);
const out = [];
let i = 0, done = 0;
async function worker() {
  while (i < urls.length) {
    const url = urls[i++];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const img = await (await fromUrl(url)).getImage();
        const epsg = img.getGeoKeys().ProjectedCSTypeGeoKey;
        out.push({ url, epsg, bbox: img.getBoundingBox() });
        break;
      } catch (e) { if (attempt === 2) console.error('fail', url, e.message); }
    }
    if (++done % 200 === 0) console.error(done, '/', urls.length);
  }
}
await Promise.all(Array.from({ length: 24 }, worker));
out.sort((a, b) => a.url.localeCompare(b.url));
writeFileSync(new URL('./data/gob-vnm-2023-index.json', import.meta.url), JSON.stringify(out));
console.log('indexed', out.length);
