import type { Access, LegalStatus, Listing, ParcelShape } from './types';

/**
 * Decoder for Chợ Tốt Nhà land ads (gateway.chotot.com, category 1040 "Đất") into `Listing` (#38).
 * Pure: no DOM, no fetch, so the snapshot tool (tools/listings.ts), the live proxy path in
 * market.ts and the tests share one decoder. Only market facts are kept; seller fields,
 * free-text body and images are never copied (PII + copyright).
 */

export const CHOTOT_GATEWAY = 'https://gateway.chotot.com/v1/public/ad-listing';

/** region_v2 ids of the two cities the app covers (tested against the gateway, #38). */
export const CHOTOT_REGIONS = { hcm: 13000, hn: 12000 } as const;
export type ChototRegion = keyof typeof CHOTOT_REGIONS;

/** Category id of land ads ("Đất"). */
export const CHOTOT_LAND_CATEGORY = 1040;

export interface ListingQuery {
  region: ChototRegion;
  /** Page size; the gateway accepts up to 50. */
  limit?: number;
  /** Offset (`o`). */
  offset?: number;
  /** Old district id (`area_v2`). */
  area?: number;
  /** Ward id(s) (`wards`). */
  wards?: number | number[];
}

/**
 * Query string for the ad-listing endpoint. `base` lets the browser path point at the user's
 * CORS proxy, which forwards the same query (docs/market-proxy.md).
 */
export function buildListingUrl(q: ListingQuery, base: string = CHOTOT_GATEWAY): string {
  const p = new URLSearchParams();
  p.set('cg', String(CHOTOT_LAND_CATEGORY));
  p.set('st', 's'); // sell ads only; 'k' mixes in "cần mua" posts
  p.set('region_v2', String(CHOTOT_REGIONS[q.region]));
  if (q.area != null) p.set('area_v2', String(q.area));
  if (q.wards != null) p.set('wards', Array.isArray(q.wards) ? q.wards.join(',') : String(q.wards));
  p.set('limit', String(q.limit ?? 50));
  p.set('o', String(q.offset ?? 0));
  return `${base}${base.includes('?') ? '&' : '?'}${p.toString()}`;
}

// Numeric enums observed on live ads (labels from feature_params.compare). Unknown codes fall
// back to the labels, which Chợ Tốt ships alongside the codes.
const LEGAL_CODES: Record<number, LegalStatus> = { 1: 'so-rieng', 5: 'so-chung', 6: 'giay-tay' };
const LAND_TYPES: Record<number, string> = { 1: 'Đất thổ cư', 2: 'Đất nền dự án', 4: 'Đất nông nghiệp' };
const PTY_CODES: Record<number, string> = {
  1: 'Mặt tiền',
  2: 'Hẻm xe hơi',
  3: 'Nở hậu',
  4: 'Chưa có thổ cư',
  5: 'Thổ cư 1 phần',
  6: 'Thổ cư toàn bộ',
};

/** Legal status from a Vietnamese label ("Đã có sổ", "Sổ chung / công chứng vi bằng", …). */
export function legalFromLabel(label: string | undefined): LegalStatus {
  const s = (label ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('sổ chung') || s.includes('vi bằng')) return 'so-chung';
  if (s.includes('chờ sổ')) return 'cho-so';
  if (s.includes('viết tay') || s.includes('không có sổ') || s.includes('chưa có sổ')) return 'giay-tay';
  if (s.includes('đã có sổ') || s.includes('sổ hồng') || s.includes('sổ đỏ') || s.includes('sổ riêng')) return 'so-rieng';
  return 'unknown';
}

type RawAd = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

function compareLabels(ad: RawAd): Record<string, string> {
  const items = (ad.feature_params as { compare?: { items?: { id?: string; value?: string }[] } } | undefined)?.compare?.items;
  const out: Record<string, string> = {};
  if (Array.isArray(items)) for (const i of items) if (i?.id && typeof i.value === 'string') out[i.id] = i.value;
  return out;
}

/** Raw Chợ Tốt ad → Listing, or null when it cannot be used as a comparable. */
export function decodeChotot(ad: unknown): Listing | null {
  if (!ad || typeof ad !== 'object') return null;
  const a = ad as RawAd;
  if (a.is_price_not_valid === true) return null;
  const listId = num(a.list_id);
  const lat = num(a.latitude);
  const lon = num(a.longitude);
  const price = num(a.price);
  const size = num(a.size);
  if (listId == null || lat == null || lon == null || !price || !size || price <= 0 || size <= 0) return null;
  if (lat === 0 && lon === 0) return null;
  const labels = compareLabels(a);

  const legalCode = num(a.property_legal_document);
  const legal = (legalCode != null && LEGAL_CODES[legalCode]) || legalFromLabel(labels.property_legal_document);

  // Characteristics: prefer the label string (covers codes we have not seen, e.g. lô góc).
  const ptyLabels = new Set<string>();
  if (labels.pty_characteristics) for (const s of labels.pty_characteristics.split(',')) if (s.trim()) ptyLabels.add(s.trim().toLowerCase());
  if (Array.isArray(a.pty_characteristics)) for (const c of a.pty_characteristics) { const l = PTY_CODES[c as number]; if (l) ptyLabels.add(l.toLowerCase()); }
  const has = (s: string) => ptyLabels.has(s.toLowerCase());
  const access: Access = has('Mặt tiền') ? 'mat-tien' : has('Hẻm xe hơi') ? 'hem-lon' : 'unknown';
  const shape: ParcelShape | undefined = has('Nở hậu') ? 'no-hau' : has('Tóp hậu') ? 'top-hau' : undefined;
  const corner = has('Lô góc') || has('Căn góc');

  const landCode = num(a.land_type);
  const landType = str(labels.land_type) ?? (landCode != null ? LAND_TYPES[landCode] : undefined);
  const width = num(a.width);
  const length = num(a.length);
  const time = num(a.list_time) ?? 0;

  const l: Listing = {
    id: `chotot/${listId}`,
    source: 'chotot',
    lon: round(lon, 4),
    lat: round(lat, 4),
    price,
    size,
    pricePerM2: Math.round(price / size),
    legal,
    access,
    corner,
    time,
    // chotot.com/<list_id>.htm 301-redirects to the slugged nhatot.com page (verified #38);
    // the slug needs district names we do not keep.
    url: `https://www.chotot.com/${listId}.htm`,
  };
  if (width && width > 0) l.width = width;
  if (length && length > 0) l.length = length;
  if (landType) l.landType = landType;
  if (shape) l.shape = shape;
  const ward = str(a.ward_name_v3) ?? str(a.ward_name);
  if (ward) l.ward = ward;
  const street = str(a.street_name);
  if (street) l.street = street;
  return l;
}
