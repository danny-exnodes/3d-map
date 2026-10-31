import { APP_ROOT } from '../config';
import { cacheGet, cacheSet } from '../data/cache';
import type { LngLat } from '../data/types';
import { buildListingUrl, type ChototRegion, decodeChotot } from './chotot';
import type { Access, LegalStatus, Listing, MarketStats } from './types';

/**
 * Market asking prices (#38). Two sources, both client-side:
 *  - a daily snapshot of Chợ Tốt land ads built in CI (tools/listings.ts → <APP_ROOT>/market/),
 *    because gateway.chotot.com sends no CORS header for our origin;
 *  - optionally, a live query through the user's own CORS proxy (docs/market-proxy.md).
 * Everything here is pure data code (no DOM) so it can be unit-tested in Node.
 */

export type MarketRegion = ChototRegion;

export interface MarketIndex {
  generated: string;
  regions: Partial<Record<MarketRegion, { count: number; file: string }>>;
}

export interface MarketFile {
  generated: string;
  source: string;
  region: MarketRegion;
  count: number;
  listings: Listing[];
}

export interface MarketSnapshot {
  /** ISO time of the newest region file used. */
  generated: string;
  listings: Listing[];
  /** True when served from an expired cache entry because the network failed. */
  stale: boolean;
}

const NS = 'market';
const TTL_MS = 6 * 3600 * 1000;

/** URL under the app root; APP_ROOT is './' in Node (tests, tools), which `new URL` rejects. */
const rootUrl = (path: string) => (/^[a-z][a-z0-9+.-]*:/i.test(APP_ROOT) ? new URL(path, APP_ROOT).href : APP_ROOT + path);

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return (await res.json()) as T;
}

/** One region's snapshot, via the IndexedDB cache (6 h), stale copy when offline. */
async function loadRegion(region: MarketRegion, index: () => Promise<MarketIndex>, signal?: AbortSignal): Promise<{ file: MarketFile; stale: boolean } | null> {
  const key = rootUrl(`market/${region}`);
  const hit = await cacheGet<MarketFile>(NS, key);
  if (hit) return { file: hit, stale: false };
  try {
    const idx = await index();
    const entry = idx.regions[region];
    if (!entry) return null;
    const file = await getJson<MarketFile>(rootUrl(`market/${entry.file}`), signal);
    void cacheSet(NS, key, file, TTL_MS);
    return { file, stale: false };
  } catch (e) {
    // Offline or the snapshot is missing: an expired copy is better than nothing.
    const stale = await cacheGet<MarketFile>(NS, key, true);
    if (stale && !signal?.aborted) return { file: stale, stale: true };
    throw e;
  }
}

/** Listings from the bundled snapshot for one city or both. */
export async function loadMarket(region: MarketRegion | 'all', signal?: AbortSignal): Promise<MarketSnapshot> {
  const regions: MarketRegion[] = region === 'all' ? ['hcm', 'hn'] : [region];
  // The index is fetched at most once per call, and only on a cache miss.
  let idx: Promise<MarketIndex> | null = null;
  const index = () => (idx ??= getJson<MarketIndex>(rootUrl('market/index.json'), signal));
  const parts = await Promise.all(regions.map((r) => loadRegion(r, index, signal)));
  const out: MarketSnapshot = { generated: '', listings: [], stale: false };
  for (const p of parts) {
    if (!p) continue;
    out.listings.push(...p.file.listings);
    if (p.file.generated > out.generated) out.generated = p.file.generated;
    out.stale ||= p.stale;
  }
  return out;
}

// ---- Live query through the user's proxy ----

const PROXY_KEY = 'tinymap:marketProxy';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // blocked storage (Safari private mode, sandboxed iframes)
  }
}

/** URL of the user's Chợ Tốt CORS proxy, or null when not configured. */
export function marketProxy(): string | null {
  return storage()?.getItem(PROXY_KEY) || null;
}

export function setMarketProxy(url: string | null): void {
  const s = storage();
  if (!s) return;
  if (url && url.trim()) s.setItem(PROXY_KEY, url.trim());
  else s.removeItem(PROXY_KEY);
}

/** City for a point: everything north of 16° (Huế) is treated as Hà Nội's market. */
export function regionFor(_lon: number, lat: number): MarketRegion {
  return lat > 16 ? 'hn' : 'hcm';
}

/**
 * Fresh listings around `center` from the proxy. The gateway has no working radius filter, so
 * this pages through the city's newest ads (a few pages, to stay polite) and filters by distance.
 */
export async function loadLive(center: LngLat, radiusM: number, signal?: AbortSignal, pages = 3): Promise<Listing[]> {
  const proxy = marketProxy();
  if (!proxy) throw new Error('Chưa cấu hình proxy Chợ Tốt');
  const region = regionFor(center[0], center[1]);
  const key = `${proxy}|${region}|${pages}`;
  let all = await cacheGet<Listing[]>(NS, key);
  if (!all) {
    all = [];
    for (let p = 0; p < pages; p++) {
      const body = await getJson<{ ads?: unknown[] }>(buildListingUrl({ region, limit: 50, offset: p * 50 }, proxy), signal);
      const ads = body.ads ?? [];
      for (const ad of ads) {
        const l = decodeChotot(ad);
        if (l) all.push(l);
      }
      if (ads.length < 50) break;
    }
    void cacheSet(NS, key, all, 30 * 60_000);
  }
  return nearby(all, center[0], center[1], radiusM);
}

// ---- Analysis ----

/** Great-circle distance in metres. */
export function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371008.8;
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type NearbyListing = Listing & { distance: number };

/** Listings within `radiusM` of a point, nearest first, with `distance` in metres. */
export function nearby(listings: Listing[], lon: number, lat: number, radiusM: number): NearbyListing[] {
  const out: NearbyListing[] = [];
  for (const l of listings) {
    const d = haversine(lon, lat, l.lon, l.lat);
    if (d <= radiusM) out.push({ ...l, distance: d });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

/** Linear-interpolated quantile of an ascending array. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Below this an ad's price is almost surely per-m² typed into the total, or a rental (#38). */
export const MIN_PRICE_PER_M2 = 1e6;

/**
 * Drops implausible asking prices: < 1 tr/m², then anything beyond median ± 3·MAD of
 * log(price/m²). Log scale because land prices are roughly log-normal and spread over 100×.
 */
export function filterOutliers<T extends Listing>(listings: T[]): { kept: T[]; outliers: T[] } {
  const outliers: T[] = [];
  const pass: T[] = [];
  for (const l of listings) (l.pricePerM2 >= MIN_PRICE_PER_M2 ? pass : outliers).push(l);
  if (pass.length < 3) return { kept: pass, outliers };
  const logs = pass.map((l) => Math.log(l.pricePerM2));
  const med = quantile([...logs].sort((a, b) => a - b), 0.5);
  const mad = quantile(logs.map((x) => Math.abs(x - med)).sort((a, b) => a - b), 0.5);
  if (mad === 0) return { kept: pass, outliers };
  const kept: T[] = [];
  pass.forEach((l, i) => (Math.abs(logs[i] - med) <= 3 * mad ? kept : outliers).push(l));
  return { kept, outliers };
}

/** Summary of price per m² after outlier filtering. */
export function marketStats(listings: Listing[]): MarketStats {
  const { kept, outliers } = filterOutliers(listings);
  const v = kept.map((l) => l.pricePerM2).sort((a, b) => a - b);
  return {
    count: v.length,
    outliers: outliers.length,
    median: quantile(v, 0.5),
    p25: quantile(v, 0.25),
    p75: quantile(v, 0.75),
    min: v.length ? v[0] : NaN,
    max: v.length ? v[v.length - 1] : NaN,
  };
}

// ---- User CSV ----

const fold = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

const COLUMNS: Record<string, string[]> = {
  lat: ['lat', 'latitude', 'vi_do'],
  lon: ['lon', 'lng', 'long', 'longitude', 'kinh_do'],
  price: ['gia', 'price', 'gia_ban', 'tong_gia'],
  size: ['dien_tich', 'size', 'area', 'dt'],
  ppm2: ['gia_m2', 'price_m2', 'price_per_m2', 'don_gia'],
  legal: ['phap_ly', 'legal'],
  access: ['vi_tri', 'access'],
  url: ['url', 'link'],
};

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) out.push(cur), (cur = '');
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Number from "1.500.000.000", "1,5", "120 m²", "3 tỷ", "85 tr" (Vietnamese conventions). */
function parseVnNumber(raw: string): number | null {
  let s = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let mult = 1;
  if (/t[ỷy]/.test(s)) mult = 1e9;
  else if (/tr/.test(s)) mult = 1e6; // "tr", "triệu"
  s = s.replace(/m[2²]/g, '').replace(/[^0-9.,]/g, '');
  if (!s) return null;
  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  if (dots && commas) {
    // Both used: the last one is the decimal mark.
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    s = s.split(dec === '.' ? ',' : '.').join('').replace(',', '.');
  } else if (dots + commas > 1) {
    s = s.replace(/[.,]/g, ''); // "1.500.000.000"
  } else if (dots + commas === 1) {
    // "1.500" without a unit is a thousands group (VN style); "1,5 tỷ" / "120,5" are decimals.
    s = mult === 1 && /^\d{1,3}[.,]\d{3}$/.test(s) ? s.replace(/[.,]/, '') : s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n * mult : null;
}

function accessFromLabel(label: string): Access {
  const s = fold(label);
  if (!s) return 'unknown';
  if (s.includes('mat_tien') || s === 'mt') return 'mat-tien';
  if (s.includes('hem_lon') || s.includes('xe_hoi') || s.includes('o_to')) return 'hem-lon';
  if (s.includes('hem_nho') || s.includes('xe_may')) return 'hem-nho';
  if (s.includes('hem')) return 'hem-vua';
  return (['mat-tien', 'hem-lon', 'hem-vua', 'hem-nho'] as const).find((a) => fold(a) === s) ?? 'unknown';
}

function legalFromCsv(label: string): LegalStatus {
  const s = fold(label);
  if (!s) return 'unknown';
  if (s.includes('chung') || s.includes('vi_bang')) return 'so-chung';
  if (s.includes('cho')) return 'cho-so';
  if (s.includes('tay') || s.includes('khong')) return 'giay-tay';
  if (s.includes('so')) return 'so-rieng';
  return 'unknown';
}

/**
 * Comparables typed in by the user (spreadsheet export). Needs lat, lon and either price + size
 * or price/m² + size. Rows that cannot be read are skipped.
 */
export function parseListingsCsv(text: string): Listing[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = [',', ';', '\t'].map((c) => [c, splitCsvLine(lines[0], c).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const header = splitCsvLine(lines[0], sep).map(fold);
  const col: Record<string, number> = {};
  for (const [k, aliases] of Object.entries(COLUMNS)) {
    const i = header.findIndex((h) => aliases.includes(h));
    if (i >= 0) col[k] = i;
  }
  if (col.lat == null || col.lon == null || col.size == null || (col.price == null && col.ppm2 == null)) return [];
  const now = Date.now();
  const out: Listing[] = [];
  for (let r = 1; r < lines.length; r++) {
    const f = splitCsvLine(lines[r], sep);
    const cell = (k: string) => (col[k] != null ? f[col[k]] ?? '' : '');
    const lat = Number(cell('lat').replace(',', '.'));
    const lon = Number(cell('lon').replace(',', '.'));
    const size = parseVnNumber(cell('size'));
    let price = parseVnNumber(cell('price'));
    let ppm2 = parseVnNumber(cell('ppm2'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !size || size <= 0) continue;
    if ((!price || price <= 0) && ppm2 && ppm2 > 0) price = ppm2 * size;
    if (!price || price <= 0) continue;
    if (!ppm2 || ppm2 <= 0) ppm2 = price / size;
    const l: Listing = {
      id: `user/${r}`,
      source: 'user',
      lon,
      lat,
      price,
      size,
      pricePerM2: Math.round(ppm2),
      legal: legalFromCsv(cell('legal')),
      access: accessFromLabel(cell('access')),
      corner: /goc/.test(fold(cell('access'))),
      time: now,
    };
    const url = cell('url');
    if (/^https?:\/\//.test(url)) l.url = url;
    out.push(l);
  }
  return out;
}
