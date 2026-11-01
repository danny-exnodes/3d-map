/**
 * Market-comparison valuation of one parcel (#39).
 *
 * Pure module: no DOM, no network, so it runs in Node tests and inside the AI advisor's
 * `revalue` tool. The method follows the comparison approach of the Vietnamese appraisal
 * standards (TT 42/2024/TT-BTC): adjust each comparable for differences in comparison
 * factors, drop comparables that need too much adjustment or land far from the rest, and
 * weight the survivors by closeness and by how little they had to be adjusted.
 *
 * Every coefficient in FACTORS is a default to calibrate against real transactions. None
 * of them is a legal value; provinces publish their own adjustment tables.
 */
import type { LngLat } from '../data/types';
import { landGroup } from './landTypes';
import type { Access, LegalStatus, Listing, MarketStats, Parcel, ParcelShape } from './types';

export interface Assumptions {
  access: Access;
  /** Alley width in metres; when given it decides the alley class (hẻm lớn / vừa / nhỏ). */
  accessWidth?: number;
  /** Alley level: 1 = hẻm chính, 2 = hẻm cấp 2 (hẻm trong hẻm), ... */
  alleyLevel?: number;
  corner: boolean;
  legal: LegalStatus;
  /** TT 08/2024 land code, e.g. 'ODT'. */
  landCode: string;
  /** Share of the area inside a planned road widening (lộ giới), 0..1. */
  roadWideningShare: number;
  /** Asking → transaction discount applied to every listing price, 0..1. */
  askDiscount: number;
}

export type Comparable = Listing & { distance: number };

export type ValuationMethod = 'so-sanh' | 'trung-vi-khu-vuc' | 'khong-du-lieu';
export type Confidence = 'high' | 'medium' | 'low';

export interface Adjustment {
  factor: string;
  subject: string;
  comp: string;
  /** a_f(subject) − a_f(comp). */
  delta: number;
}

export interface UsedComparable {
  id: string;
  distance: number;
  /** Asking price per m², VND. */
  raw: number;
  /** After the ask discount and every factor adjustment, VND/m². */
  adjusted: number;
  /** Product of (1 + delta), clamped. */
  factor: number;
  /** Normalised weight, sums to 1 over `used`. */
  weight: number;
  adjustments: Adjustment[];
}

export interface Valuation {
  method: ValuationMethod;
  /** VND/m²; 0 when method is 'khong-du-lieu'. */
  pricePerM2: number;
  /** pricePerM2 × parcel area, VND. */
  total: number;
  /** Range of the total, VND. */
  low: number;
  high: number;
  confidence: Confidence;
  used: UsedComparable[];
  rejected: { id: string; reason: string }[];
  assumptions: Assumptions;
  /** Vietnamese, shown to the user as-is. */
  notes: string[];
}

export interface ValuationOptions {
  /** Ward/area snapshot used when there are too few comparables (asking prices). */
  prior?: MarketStats;
  /** Wider-area median asking price per m² that the fallback shrinks toward. */
  areaMedian?: number;
  /** Minimum usable comparables for the comparison method (default 3). */
  minComps?: number;
}

export const DEFAULT_ASK_DISCOUNT = 0.08;

/** Shown with every result; the app must never present this as a formal appraisal. */
export const DISCLAIMER =
  'Ước tính tham khảo từ giá rao bán, không phải chứng thư thẩm định giá. Theo Luật Giá 2023, chỉ thẩm định viên về giá được cấp phép mới phát hành chứng thư.';

/**
 * Adjustment offsets a_f relative to a baseline lot (đất ở, mặt tiền, vuông vức, 30–150 m²,
 * sổ riêng). Sources: old HCMC/HN price-table ratios and common appraisal practice
 * (research §4.2). Defaults to calibrate, not legal values.
 */
export const FACTORS = {
  access: { 'mat-tien': 0, 'hem-lon': -0.3, 'hem-vua': -0.45, 'hem-nho': -0.55, unknown: -0.3 } as Record<Access, number>,
  /** Per alley level beyond the first (hẻm cấp 2, 3...). */
  alleyLevel: -0.05,
  corner: 0.1,
  /** Frontage width, upper bounds in metres (exclusive). */
  frontage: [
    { below: 3, a: -0.1 },
    { below: 4, a: -0.05 },
    { below: 8, a: 0 },
    { below: Infinity, a: 0.03 },
  ],
  shape: { vuong: 0, 'no-hau': 0.03, 'top-hau': -0.07, meo: -0.1 } as Record<ParcelShape, number>,
  /** Lot area in m² (exclusive upper bounds); small urban lots trade higher per m². */
  area: [
    { below: 30, a: 0.05 },
    { below: 150, a: 0 },
    { below: 500, a: -0.05 },
    { below: Infinity, a: -0.15 },
  ],
  legal: { 'so-rieng': 0, 'so-chung': -0.15, 'cho-so': -0.15, 'giay-tay': -0.3, unknown: 0 } as Record<LegalStatus, number>,
  /** Residential = ODT/ONT; other non-agricultural, agricultural, unused land. */
  landGroup: { residential: 0, PNN: -0.1, NNP: -0.7, CSD: -0.8 },
  /** Applied when part of the lot lies inside a planned road widening: base + perShare·share. */
  roadWidening: { base: -0.15, perShare: -0.25 },
  /** Alley width thresholds (m) for hẻm lớn / hẻm vừa; narrower is hẻm nhỏ (HCMC convention). */
  alleyWidth: { large: 5, medium: 3 },
} as const;

/** Rejection thresholds and weighting constants (research §4.2). */
const MAX_GROSS = 0.5;
const MAD_K = 3;
/**
 * Floor for the outlier band in log space (±30%): with a tight cluster MAD is tiny and 3·MAD
 * would throw out ordinary comps a few percent off the median.
 */
const MIN_BAND = Math.log(1.3);
const DIST_SCALE = 500; // m
const GROSS_EPS = 0.05;
const SHRINK_K = 10;
const ADJ_MIN = 0.3;
const ADJ_MAX = 2;

const ACCESS_LABEL: Record<Access, string> = {
  'mat-tien': 'mặt tiền',
  'hem-lon': 'hẻm lớn',
  'hem-vua': 'hẻm vừa',
  'hem-nho': 'hẻm nhỏ',
  unknown: 'chưa rõ',
};
const LEGAL_LABEL: Record<LegalStatus, string> = {
  'so-rieng': 'sổ riêng',
  'so-chung': 'sổ chung',
  'cho-so': 'chờ sổ',
  'giay-tay': 'giấy tay',
  unknown: 'chưa rõ',
};
const SHAPE_LABEL: Record<ParcelShape, string> = {
  vuong: 'vuông vức',
  'no-hau': 'nở hậu',
  'top-hau': 'tóp hậu',
  meo: 'méo',
};

type FactorGroup = keyof typeof FACTORS.landGroup;

// Land-code → group comes from the TT 08/2024 table so the code list lives in one place.
function codeGroup(code: string): FactorGroup {
  const c = code.trim().toUpperCase();
  if (c === 'ODT' || c === 'ONT') return 'residential';
  return landGroup(c) ?? 'PNN';
}

/** Chợ Tốt land-type labels → factor group; undefined when the label says nothing. */
function labelGroup(label: string | undefined): FactorGroup | undefined {
  if (!label) return undefined;
  const s = label.toLowerCase();
  if (s.includes('nông nghiệp') || s.includes('lúa') || s.includes('vườn')) return 'NNP';
  if (s.includes('thổ cư') || s.includes('đất ở')) return 'residential';
  if (s.includes('dự án') || s.includes('thương mại') || s.includes('sản xuất')) return 'PNN';
  return undefined;
}

function band(table: readonly { below: number; a: number }[], x: number): number {
  for (const b of table) if (x < b.below) return b.a;
  return 0;
}

export function accessFromWidth(w: number): Access {
  if (w >= FACTORS.alleyWidth.large) return 'hem-lon';
  if (w >= FACTORS.alleyWidth.medium) return 'hem-vua';
  return 'hem-nho';
}

/** Access class actually used for the subject: an explicit alley width wins over the label. */
export function effectiveAccess(a: Assumptions): Access {
  if (a.access !== 'mat-tien' && a.accessWidth != null && a.accessWidth > 0) return accessFromWidth(a.accessWidth);
  return a.access;
}

export function defaultAssumptions(parcel: Parcel): Assumptions {
  const m = parcel.metrics;
  const onStreet = m.frontage != null && m.streetDistance != null && m.streetDistance < 15;
  return {
    access: onStreet ? 'mat-tien' : 'hem-vua',
    alleyLevel: 1,
    corner: false,
    legal: 'so-rieng',
    landCode: parcel.landCode,
    roadWideningShare: 0,
    askDiscount: DEFAULT_ASK_DISCOUNT,
  };
}

/** Attributes the factor table compares; undefined = not known for this lot. */
interface Lot {
  access?: Access;
  alleyLevel?: number;
  corner?: boolean;
  width?: number;
  shape?: ParcelShape;
  area?: number;
  legal?: LegalStatus;
  group?: FactorGroup;
  roadWideningShare?: number;
}

function subjectLot(parcel: Parcel, a: Assumptions): Lot {
  const access = effectiveAccess(a);
  return {
    access,
    alleyLevel: access === 'mat-tien' ? 1 : Math.max(1, a.alleyLevel ?? 1),
    corner: a.corner,
    width: parcel.metrics.frontage ?? undefined,
    shape: parcel.metrics.shape,
    area: parcel.metrics.area,
    legal: a.legal,
    group: codeGroup(a.landCode),
    roadWideningShare: a.roadWideningShare,
  };
}

function compLot(c: Listing): Lot {
  return {
    access: c.access === 'unknown' ? undefined : c.access,
    corner: c.corner,
    width: c.width,
    shape: c.shape,
    area: c.size > 0 ? c.size : undefined,
    legal: c.legal === 'unknown' ? undefined : c.legal,
    group: labelGroup(c.landType),
  };
}

/** The market-typical lot: what an unknown attribute is assumed to be. */
const TYPICAL: Required<Lot> = {
  access: 'unknown', // a_f = −0.30, the typical listing sits in a large alley
  alleyLevel: 1,
  corner: false,
  width: 5,
  shape: 'vuong',
  area: 80,
  legal: 'so-rieng',
  group: 'residential',
  roadWideningShare: 0,
};

interface FactorDef {
  name: string;
  value: (l: Required<Lot>) => number;
  label: (l: Required<Lot>) => string;
  known: (l: Lot) => boolean;
}

const fmt = (x: number) => (Math.round(x * 10) / 10).toString();

const FACTOR_DEFS: FactorDef[] = [
  { name: 'Vị trí', value: (l) => FACTORS.access[l.access], label: (l) => ACCESS_LABEL[l.access], known: (l) => l.access != null },
  {
    name: 'Cấp hẻm',
    value: (l) => (l.access === 'mat-tien' ? 0 : FACTORS.alleyLevel * Math.max(0, l.alleyLevel - 1)),
    label: (l) => (l.access === 'mat-tien' ? '—' : `cấp ${l.alleyLevel}`),
    known: (l) => l.alleyLevel != null,
  },
  { name: 'Lô góc', value: (l) => (l.corner ? FACTORS.corner : 0), label: (l) => (l.corner ? 'có' : 'không'), known: (l) => l.corner != null },
  { name: 'Mặt tiền', value: (l) => band(FACTORS.frontage, l.width), label: (l) => `${fmt(l.width)} m`, known: (l) => l.width != null && l.width > 0 },
  { name: 'Hình dáng', value: (l) => FACTORS.shape[l.shape], label: (l) => SHAPE_LABEL[l.shape], known: (l) => l.shape != null },
  { name: 'Diện tích', value: (l) => band(FACTORS.area, l.area), label: (l) => `${Math.round(l.area)} m²`, known: (l) => l.area != null },
  { name: 'Pháp lý', value: (l) => FACTORS.legal[l.legal], label: (l) => LEGAL_LABEL[l.legal], known: (l) => l.legal != null },
  { name: 'Loại đất', value: (l) => FACTORS.landGroup[l.group], label: (l) => (l.group === 'residential' ? 'đất ở' : l.group), known: (l) => l.group != null },
  {
    name: 'Lộ giới',
    value: (l) => (l.roadWideningShare > 0 ? FACTORS.roadWidening.base + FACTORS.roadWidening.perShare * Math.min(1, l.roadWideningShare) : 0),
    label: (l) => (l.roadWideningShare > 0 ? `${Math.round(l.roadWideningShare * 100)}% dính` : 'không'),
    known: (l) => l.roadWideningShare != null,
  },
];

const fill = (l: Lot): Required<Lot> => {
  const out = { ...TYPICAL };
  for (const k of Object.keys(l) as (keyof Lot)[]) if (l[k] != null) (out as Record<string, unknown>)[k] = l[k];
  return out;
};

/**
 * Compare two lots factor by factor. Unknown attributes on the reference side take the
 * market-typical value and are left out of the gross adjustment, so a sparse listing is
 * neither penalised nor trusted for that factor.
 */
function compare(subject: Lot, ref: Lot): { factor: number; gross: number; adjustments: Adjustment[] } {
  const s = fill(subject);
  const r = fill(ref);
  let factor = 1;
  let gross = 0;
  const adjustments: Adjustment[] = [];
  for (const f of FACTOR_DEFS) {
    const delta = f.value(s) - f.value(r);
    const known = f.known(ref);
    if (delta === 0 && known) continue;
    factor *= 1 + delta;
    if (known) gross += Math.abs(delta);
    if (delta !== 0) adjustments.push({ factor: f.name, subject: f.label(s), comp: known ? f.label(r) : `chưa rõ (coi như ${f.label(r)})`, delta });
  }
  return { factor: Math.min(ADJ_MAX, Math.max(ADJ_MIN, factor)), gross, adjustments };
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Weighted quantile with linear interpolation between sample midpoints. */
function weightedQuantile(vs: number[], ws: number[], q: number): number {
  const idx = vs.map((_, i) => i).sort((a, b) => vs[a] - vs[b]);
  const total = ws.reduce((s, w) => s + w, 0);
  let cum = 0;
  const pts = idx.map((i) => {
    const mid = (cum + ws[i] / 2) / total;
    cum += ws[i];
    return { p: mid, v: vs[i] };
  });
  if (q <= pts[0].p) return pts[0].v;
  for (let k = 1; k < pts.length; k++) {
    if (q <= pts[k].p) {
      const t = (q - pts[k - 1].p) / (pts[k].p - pts[k - 1].p);
      return pts[k - 1].v + t * (pts[k].v - pts[k - 1].v);
    }
  }
  return pts[pts.length - 1].v;
}

const tr = (vndPerM2: number) => `${(vndPerM2 / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tr/m²`;

export function valueParcel(parcel: Parcel, comps: Comparable[], assumptions: Assumptions, opts: ValuationOptions = {}): Valuation {
  const a: Assumptions = { ...assumptions, askDiscount: clamp01(assumptions.askDiscount ?? DEFAULT_ASK_DISCOUNT) };
  const area = parcel.metrics.area;
  const subject = subjectLot(parcel, a);
  const keep = 1 - a.askDiscount;
  const notes: string[] = [];
  const rejected: Valuation['rejected'] = [];
  if (a.askDiscount > 0) notes.push(`Giá rao bán đã trừ ${Math.round(a.askDiscount * 100)}% để quy về giá giao dịch.`);

  type Cand = { c: Comparable; v: number; factor: number; gross: number; adjustments: Adjustment[] };
  const valid: Comparable[] = [];
  const cands: Cand[] = [];
  for (const c of comps) {
    if (!(c.pricePerM2 > 0) || !Number.isFinite(c.pricePerM2)) {
      rejected.push({ id: c.id, reason: 'Giá không hợp lệ' });
      continue;
    }
    valid.push(c);
    const cmp = compare(subject, compLot(c));
    if (cmp.gross > MAX_GROSS) {
      rejected.push({ id: c.id, reason: `Điều chỉnh gộp ${Math.round(cmp.gross * 100)}% vượt 50%` });
      continue;
    }
    cands.push({ c, v: c.pricePerM2 * keep * cmp.factor, ...cmp });
  }

  // Outliers in log space: a 3·MAD band around the median of the adjusted values.
  let kept = cands;
  if (cands.length >= 3) {
    const logs = cands.map((k) => Math.log(k.v));
    const med = median(logs);
    const mad = median(logs.map((x) => Math.abs(x - med)));
    const bandW = Math.max(MAD_K * mad, MIN_BAND);
    {
      kept = [];
      cands.forEach((k, i) => {
        if (Math.abs(logs[i] - med) > bandW) rejected.push({ id: k.c.id, reason: `Giá sau điều chỉnh ${tr(k.v)} lệch xa trung vị` });
        else kept.push(k);
      });
    }
  }

  const minComps = opts.minComps ?? 3;
  if (kept.length >= minComps) {
    const raw = kept.map((k) => Math.exp(-Math.max(0, k.c.distance) / DIST_SCALE) / (k.gross + GROSS_EPS));
    const wsum = raw.reduce((s, w) => s + w, 0);
    const ws = raw.map((w) => w / wsum);
    const vs = kept.map((k) => k.v);
    const value = vs.reduce((s, v, i) => s + v * ws[i], 0);
    const variance = vs.reduce((s, v, i) => s + ws[i] * (v - value) ** 2, 0);
    const cv = value > 0 ? Math.sqrt(variance) / value : Infinity;
    const lo = weightedQuantile(vs, ws, 0.25);
    const hi = weightedQuantile(vs, ws, 0.75);
    const confidence: Confidence = kept.length >= 5 && cv < 0.25 ? 'high' : 'medium';
    notes.push(`Phương pháp so sánh: ${kept.length} tin rao tương đồng, hệ số biến thiên ${Math.round(cv * 100)}%.`);
    if (a.roadWideningShare > 0) notes.push('Có phần diện tích dính lộ giới: đã trừ giá, cần kiểm tra quy hoạch tại UBND phường/xã.');
    notes.push(DISCLAIMER);
    return {
      method: 'so-sanh',
      pricePerM2: value,
      total: value * area,
      low: lo * area,
      high: hi * area,
      confidence,
      used: kept.map((k, i) => ({
        id: k.c.id,
        distance: k.c.distance,
        raw: k.c.pricePerM2,
        adjusted: k.v,
        factor: k.factor,
        weight: ws[i],
        adjustments: k.adjustments,
      })),
      rejected,
      assumptions: a,
      notes,
    };
  }

  // Fallback: shrunk area median, adjusted from a typical lot to the subject (research §4.2, method 3).
  const { factor } = compare(subject, {});
  let n = 0;
  let m = NaN;
  let p25 = NaN;
  let p75 = NaN;
  if (valid.length) {
    const ps = valid.map((c) => c.pricePerM2);
    n = ps.length;
    m = median(ps);
    p25 = quantile(ps, 0.25);
    p75 = quantile(ps, 0.75);
  } else if (opts.prior && opts.prior.count > 0) {
    n = opts.prior.count;
    m = opts.prior.median;
    p25 = opts.prior.p25;
    p75 = opts.prior.p75;
  }
  const am = opts.areaMedian != null && opts.areaMedian > 0 ? opts.areaMedian : undefined;
  let center: number;
  if (Number.isFinite(m) && am != null) center = (n * m + SHRINK_K * am) / (n + SHRINK_K);
  else if (Number.isFinite(m)) center = m;
  else if (am != null) center = am;
  else {
    notes.push('Chưa có tin rao nào quanh thửa đất để ước tính giá.');
    notes.push(DISCLAIMER);
    return { method: 'khong-du-lieu', pricePerM2: 0, total: 0, low: 0, high: 0, confidence: 'low', used: [], rejected, assumptions: a, notes };
  }
  const value = center * keep * factor;
  // Keep the relative spread of the source quartiles when we have them, else ±25%.
  const spreadLo = Number.isFinite(p25) && m > 0 ? Math.min(1, p25 / m) : 0.75;
  const spreadHi = Number.isFinite(p75) && m > 0 ? Math.max(1, p75 / m) : 1.25;
  notes.push(
    `Không đủ 3 tin rao tương đồng: dùng trung vị khu vực${am != null ? ' (co về trung vị vùng rộng hơn)' : ''}, điều chỉnh theo đặc điểm thửa đất. Độ tin cậy thấp.`,
  );
  notes.push(DISCLAIMER);
  return {
    method: 'trung-vi-khu-vuc',
    pricePerM2: value,
    total: value * area,
    low: value * spreadLo * area,
    high: value * spreadHi * area,
    confidence: 'low',
    used: [],
    rejected,
    assumptions: a,
    notes,
  };
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : DEFAULT_ASK_DISCOUNT;
}

// ---- Geometry helper for the advisor's get_comparables tool ----

/** Vertex mean of the ring; good enough for parcel-scale distances. */
export function ringCenter(ring: LngLat[]): LngLat {
  const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring;
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / Math.max(1, pts.length), y / Math.max(1, pts.length)];
}
