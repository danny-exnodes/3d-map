import { pointInRing } from '../geo/projection';
import { type CityId, fold, type Ward, type WardList } from './offline';

/**
 * Deep links to a ward: `?focus=ben-cat` opens the map on Phường Bến Cát (idea from e-City's
 * `citywide-31.html?focus=ben-cat`). Pure functions, so they are unit-tested against the bundled
 * ward lists in `public/wards/`.
 *
 * Accepted forms (case and accents do not matter, spaces work too):
 * - `ben-cat`, `Bến Cát`               → by name, without "Phường"/"Xã"/"Đặc khu";
 * - `phuong-ben-cat`, `xa-thanh-an`     → by name with its kind, to pick between a phường and a xã;
 * - `hn:an-khanh`, `hcm:phuong-an-khanh` → limited to one city;
 * - `thanh-an~2`                        → the 2nd ward with that name (names that fold to the same slug);
 * - the ward id from the list.
 *
 * When several wards match, TP.HCM comes before Hà Nội, phường before xã, then file order.
 */

export interface WardMatch {
  ward: Ward;
  city: CityId;
}

const KIND_PREFIX = /^(phuong|xa|dac-khu)-/;
const KIND_RANK: Record<Ward['kind'], number> = { phuong: 0, xa: 1, khac: 2 };
const CITY_IDS: CityId[] = ['hcm', 'hn'];

/** "Phường Văn Miếu - Quốc Tử Giám" → "phuong-van-mieu-quoc-tu-giam". */
export function slugify(s: string): string {
  return fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Name slug with its kind: "phuong-ben-cat". */
export function wardFullSlug(w: Ward): string {
  return slugify(w.name);
}

/** Name slug without "Phường"/"Xã"/"Đặc khu": "ben-cat". Kind 'khac' names keep every word ("Phương Bản"). */
export function wardSlug(w: Ward): string {
  const full = wardFullSlug(w);
  return w.kind === 'khac' ? full : full.replace(KIND_PREFIX, '');
}

/** All wards matching a `focus` value, best first. Empty when nothing matches. */
export function findWards(lists: WardList[], raw: string): WardMatch[] {
  let q = raw.trim();
  // "thanh-an~2": the 2nd ward of that name (Xã Thanh An and Xã Thạnh An fold to the same slug).
  const nth = /^(.*?)\s*~\s*(\d+)$/.exec(q);
  if (nth) {
    const all = findWards(lists, nth[1]);
    const i = Number(nth[2]) - 1;
    return i >= 0 && i < all.length ? [all[i], ...all.filter((_, j) => j !== i)] : [];
  }
  let city: CityId | undefined;
  const m = /^(hcm|hn)\s*[:/]\s*(.+)$/i.exec(q);
  if (m) {
    city = m[1].toLowerCase() as CityId;
    q = m[2];
  }
  const id = q.toLowerCase();
  const slug = slugify(q);
  if (!slug) return [];

  const out: (WardMatch & { order: number })[] = [];
  let order = 0;
  for (const list of [...lists].sort((a, b) => CITY_IDS.indexOf(a.city) - CITY_IDS.indexOf(b.city))) {
    if (city && list.city !== city) continue;
    for (const ward of list.wards) {
      order++;
      if (ward.id.toLowerCase() === id) return [{ ward, city: list.city }];
      if (wardSlug(ward) === slug || wardFullSlug(ward) === slug) out.push({ ward, city: list.city, order });
    }
  }
  // Cities are already in order; within a city, phường before xã.
  return out
    .sort((a, b) => CITY_IDS.indexOf(a.city) - CITY_IDS.indexOf(b.city) || KIND_RANK[a.ward.kind] - KIND_RANK[b.ward.kind] || a.order - b.order)
    .map(({ ward, city }) => ({ ward, city }));
}

/** The shortest `focus` value that opens exactly this ward first (used for "copy link"). */
export function focusSlug(ward: Ward, city: CityId, lists: WardList[]): string {
  const core = wardSlug(ward);
  const full = wardFullSlug(ward);
  for (const c of [core, full, `${city}:${core}`, `${city}:${full}`]) {
    if (findWards(lists, c)[0]?.ward.id === ward.id) return c;
  }
  const n = findWards(lists, `${city}:${full}`).findIndex((m) => m.ward.id === ward.id);
  return n >= 0 ? `${city}:${full}~${n + 1}` : ward.id;
}

/**
 * A point inside the ward, to centre the default build area on. The bbox centre when it falls
 * inside the ward; otherwise the middle of the widest span across the largest polygon at its
 * mid-latitude (bbox centres of crescent or L-shaped wards can land outside, even in another ward).
 */
export function wardAnchor(w: Ward): [lon: number, lat: number] {
  const c: [number, number] = [(w.bbox.west + w.bbox.east) / 2, (w.bbox.south + w.bbox.north) / 2];
  const outers = w.polygon.map((p) => p[0] as [number, number][]).filter((r) => r && r.length >= 3);
  if (!outers.length || outers.some((r) => pointInRing(c[0], c[1], r))) return c;

  const span = (r: [number, number][]) => {
    let s = Infinity, n = -Infinity;
    for (const [, y] of r) (s = Math.min(s, y)), (n = Math.max(n, y));
    return { s, n };
  };
  const largest = outers.reduce((a, r) => (ringArea(r) > ringArea(a) ? r : a));
  const { s, n } = span(largest);
  const y = (s + n) / 2;
  const xs: number[] = [];
  for (let i = 0, j = largest.length - 1; i < largest.length; j = i++) {
    const [x1, y1] = largest[j], [x2, y2] = largest[i];
    if ((y1 > y) !== (y2 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
  }
  xs.sort((a, b) => a - b);
  let best: [number, number] | null = null, width = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > width) (width = xs[i + 1] - xs[i]), (best = [(xs[i] + xs[i + 1]) / 2, y]);
  }
  return best ?? c;
}

function ringArea(r: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(a / 2);
}
