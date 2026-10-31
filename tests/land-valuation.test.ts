import { describe, expect, it } from 'vitest';
import { buildDossier, DOSSIER_JSON_SCHEMA, DOSSIER_SCHEMA, dossierToMarkdown } from '../src/land/dossier';
import { marketStats } from '../src/land/market';
import type { Listing, Parcel } from '../src/land/types';
import { type Comparable, defaultAssumptions, FACTORS, valueParcel } from '../src/land/valuation';

const TR = 1e6;

function subjectParcel(over: Partial<Parcel['metrics']> = {}): Parcel {
  const lon = 106.7;
  const lat = 10.78;
  const dx = 5 / 109000; // ~5 m
  const dy = 16 / 110600; // ~16 m
  return {
    id: 'p1',
    source: 'osm',
    ring: [
      [lon, lat],
      [lon + dx, lat],
      [lon + dx, lat + dy],
      [lon, lat + dy],
    ],
    landCode: 'ODT',
    landCodeGuessed: true,
    metrics: { area: 80, perimeter: 42, edges: [], frontage: 5, depth: 16, shape: 'vuong', streetDistance: 5, ...over },
  };
}

function listing(id: string, pricePerM2: number, over: Partial<Listing> = {}): Listing {
  return {
    id,
    source: 'chotot',
    lon: 106.7,
    lat: 10.78,
    price: pricePerM2 * 80,
    size: 80,
    pricePerM2,
    width: 5,
    legal: 'so-rieng',
    access: 'mat-tien',
    corner: false,
    landType: 'Đất thổ cư',
    time: Date.UTC(2026, 8, 1),
    ...over,
  };
}

const comp = (id: string, ppm2: number, distance = 200, over: Partial<Listing> = {}): Comparable => ({ ...listing(id, ppm2 * TR, over), distance });

const PO_COMPS = [comp('a', 100, 190), comp('b', 110, 200), comp('c', 120, 210), comp('d', 130, 200), comp('e', 400, 205)];

describe('valuation (#39)', () => {
  it('defaults: mặt tiền when a street is within 15 m, sổ riêng, 8% ask discount', () => {
    const a = defaultAssumptions(subjectParcel());
    expect(a).toMatchObject({ access: 'mat-tien', legal: 'so-rieng', landCode: 'ODT', askDiscount: 0.08, corner: false });
    expect(defaultAssumptions(subjectParcel({ streetDistance: 40 })).access).toBe('hem-vua');
    expect(defaultAssumptions(subjectParcel({ frontage: null, streetDistance: null })).access).toBe('hem-vua');
  });

  it('PO: comps 100–130 tr/m² + a 400 outlier → estimate in 105–125 tr/m² (no ask discount)', () => {
    const p = subjectParcel();
    const v = valueParcel(p, PO_COMPS, { ...defaultAssumptions(p), askDiscount: 0 });
    expect(v.method).toBe('so-sanh');
    expect(v.pricePerM2 / TR).toBeGreaterThanOrEqual(105);
    expect(v.pricePerM2 / TR).toBeLessThanOrEqual(125);
    expect(v.rejected.map((r) => r.id)).toEqual(['e']);
    expect(v.used).toHaveLength(4);
    expect(v.total).toBeCloseTo(v.pricePerM2 * 80, 0);
    expect(v.low).toBeLessThan(v.total);
    expect(v.high).toBeGreaterThan(v.total);
    expect(v.confidence).toBe('medium'); // 4 comps
    const wsum = v.used.reduce((s, u) => s + u.weight, 0);
    expect(wsum).toBeCloseTo(1, 6);
  });

  it('default 8% ask discount scales the estimate and is explained in the notes', () => {
    const p = subjectParcel();
    const a0 = valueParcel(p, PO_COMPS, { ...defaultAssumptions(p), askDiscount: 0 });
    const a8 = valueParcel(p, PO_COMPS, defaultAssumptions(p));
    expect(a8.pricePerM2 / a0.pricePerM2).toBeCloseTo(0.92, 6);
    expect(a8.notes).toContain('Giá rao bán đã trừ 8% để quy về giá giao dịch.');
    expect(a8.notes.some((n) => n.includes('không phải chứng thư thẩm định giá'))).toBe(true);
  });

  it('PO: giấy tay lowers the value by about 30%', () => {
    const p = subjectParcel();
    const base = valueParcel(p, PO_COMPS, defaultAssumptions(p));
    const gt = valueParcel(p, PO_COMPS, { ...defaultAssumptions(p), legal: 'giay-tay' });
    const drop = 1 - gt.pricePerM2 / base.pricePerM2;
    expect(drop).toBeGreaterThan(0.27);
    expect(drop).toBeLessThan(0.33);
    expect(gt.used[0].adjustments).toContainEqual({ factor: 'Pháp lý', subject: 'giấy tay', comp: 'sổ riêng', delta: -0.3 });
  });

  it('adjusts comps toward the subject: a hẻm-vừa comp is lifted for a mặt-tiền subject', () => {
    const p = subjectParcel();
    const comps = [comp('a', 60, 200, { access: 'hem-vua' }), comp('b', 100, 200), comp('c', 100, 200), comp('d', 100, 200)];
    const v = valueParcel(p, comps, { ...defaultAssumptions(p), askDiscount: 0 });
    const a = v.used.find((u) => u.id === 'a')!;
    expect(a.factor).toBeCloseTo(1 + FACTORS.access['mat-tien'] - FACTORS.access['hem-vua'], 6);
    expect(a.adjusted).toBeCloseTo(60 * TR * 1.45, -2);
    // A larger adjustment means less weight than an identical comp.
    expect(a.weight).toBeLessThan(v.used.find((u) => u.id === 'b')!.weight);
  });

  it('rejects comps needing more than 50% gross adjustment', () => {
    const p = subjectParcel();
    const comps = [comp('far', 50, 200, { access: 'hem-nho', legal: 'giay-tay' }), comp('b', 100), comp('c', 105), comp('d', 110)];
    const v = valueParcel(p, comps, defaultAssumptions(p));
    expect(v.rejected[0].id).toBe('far');
    expect(v.rejected[0].reason).toMatch(/50%/);
  });

  it('unknown comp attributes take the market-typical value and do not count in gross', () => {
    const p = subjectParcel();
    const comps = ['a', 'b', 'c'].map((id) => comp(id, 100, 200, { access: 'unknown', legal: 'unknown', width: undefined, landType: undefined }));
    const v = valueParcel(p, comps, { ...defaultAssumptions(p), askDiscount: 0 });
    expect(v.used).toHaveLength(3);
    // Subject mặt tiền vs typical (−0.30) → +30%.
    expect(v.pricePerM2 / TR).toBeCloseTo(130, 4);
    expect(v.used[0].adjustments[0].comp).toMatch(/^chưa rõ/);
  });

  it('nearer comps weigh more; confidence high with ≥5 tight comps', () => {
    const p = subjectParcel();
    const comps = [comp('n', 100, 50), comp('f', 120, 1500), comp('x', 110, 300), comp('y', 108, 300), comp('z', 112, 300)];
    const v = valueParcel(p, comps, { ...defaultAssumptions(p), askDiscount: 0 });
    expect(v.confidence).toBe('high');
    const w = Object.fromEntries(v.used.map((u) => [u.id, u.weight]));
    expect(w.n).toBeGreaterThan(w.f * 10);
  });

  it('falls back to the shrunk area median with fewer than 3 comps', () => {
    const p = subjectParcel();
    const v = valueParcel(p, [comp('a', 100), comp('b', 120)], { ...defaultAssumptions(p), askDiscount: 0, access: 'hem-vua' }, { areaMedian: 80 * TR });
    expect(v.method).toBe('trung-vi-khu-vuc');
    expect(v.confidence).toBe('low');
    // (2·110 + 10·80) / 12 = 85, then hẻm vừa vs typical (−0.45 vs −0.30) → ×0.85.
    expect(v.pricePerM2 / TR).toBeCloseTo(85 * 0.85, 4);
    expect(v.low).toBeLessThan(v.total);
    expect(v.high).toBeGreaterThan(v.total);
  });

  it('uses a prior snapshot when no comps are given, and reports no data otherwise', () => {
    const p = subjectParcel();
    const prior = { count: 40, outliers: 2, median: 90 * TR, p25: 70 * TR, p75: 110 * TR, min: 30 * TR, max: 200 * TR };
    const v = valueParcel(p, [], { ...defaultAssumptions(p), askDiscount: 0, access: 'hem-lon' }, { prior });
    expect(v.method).toBe('trung-vi-khu-vuc');
    expect(v.pricePerM2 / TR).toBeCloseTo(90, 4); // hẻm lớn == typical
    const none = valueParcel(p, [], defaultAssumptions(p));
    expect(none.method).toBe('khong-du-lieu');
    expect(none.pricePerM2).toBe(0);
  });

  it('road widening and agricultural land code discount the subject', () => {
    const p = subjectParcel();
    const base = valueParcel(p, PO_COMPS, defaultAssumptions(p)).pricePerM2;
    const rw = valueParcel(p, PO_COMPS, { ...defaultAssumptions(p), roadWideningShare: 0.2 }).pricePerM2;
    expect(rw / base).toBeCloseTo(1 - 0.15 - 0.25 * 0.2, 6);
    const cln = valueParcel(p, PO_COMPS, { ...defaultAssumptions(p), landCode: 'CLN' });
    // −0.70 vs đất thổ cư comps exceeds the 50% gross limit → every comp rejected → fallback.
    expect(cln.method).toBe('trung-vi-khu-vuc');
    expect(cln.pricePerM2).toBeLessThan(base * 0.5);
  });
});

describe('dossier (#39)', () => {
  const p = { ...subjectParcel(), soTo: '12', soThua: '345' };
  const v = valueParcel(p, PO_COMPS, defaultAssumptions(p));
  const d = buildDossier({
    parcel: p,
    comparables: PO_COMPS,
    stats: marketStats(PO_COMPS),
    valuation: v,
    radiusM: 1000,
    snapshotTime: '2026-10-30T00:00:00Z',
    now: new Date('2026-10-31T00:00:00Z'),
  });

  it('has every required key of the JSON schema', () => {
    for (const k of DOSSIER_JSON_SCHEMA.required) expect(d).toHaveProperty(k);
    for (const k of DOSSIER_JSON_SCHEMA.properties.parcel.required) expect(d.parcel).toHaveProperty(k);
    for (const k of DOSSIER_JSON_SCHEMA.properties.market.required) expect(d.market).toHaveProperty(k);
    for (const k of DOSSIER_JSON_SCHEMA.properties.valuation.required) expect(d.valuation).toHaveProperty(k);
    for (const k of DOSSIER_JSON_SCHEMA.properties.assumptions.required) expect(d.assumptions).toHaveProperty(k);
    expect(d.schema).toBe(DOSSIER_SCHEMA);
    expect(d.generated).toBe('2026-10-31T00:00:00.000Z');
    expect(d.parcel.group).toBe('PNN');
    expect(d.parcel.metrics).not.toHaveProperty('edges');
    expect(d.sources.map((s) => s.name).join(' ')).toMatch(/OpenStreetMap.*Chợ Tốt.*08\/2024.*42\/2024/);
  });

  it('comparables carry only whitelisted, PII-free fields', () => {
    const allowed = Object.keys(DOSSIER_JSON_SCHEMA.properties.market.properties.comparables.items.properties);
    for (const c of d.market.comparables) for (const k of Object.keys(c)) expect(allowed).toContain(k);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it('renders a Vietnamese Markdown summary', () => {
    const md = dossierToMarkdown(d);
    expect(md).toMatch(/^# Hồ sơ định giá thửa đất \(tờ 12, thửa 345\)/);
    expect(md).toContain('So sánh trực tiếp');
    expect(md).toContain('không phải chứng thư thẩm định giá');
    expect(md).toContain('| a |');
  });
});
