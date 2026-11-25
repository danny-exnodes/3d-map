import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetCacheForTests, cacheClear } from '../src/data/cache';
import { buildDossier, dossierToMarkdown } from '../src/land/dossier';
import { inHcm, interiorPoint, loadPlanning, lotMismatchNote, PLANNING_API, parsePlanning, planningToGeoJson, portalLink, rgbToHex, summarizePlanning } from '../src/land/planning';
import { makeParcel } from '../src/land/parcels';
import { defaultAssumptions, valueParcel } from '../src/land/valuation';

// Trimmed real answers of the portal (Bến Nghé Q1 and Q5), see tests/fixtures/quyhoach-hcm.json.
const FX = JSON.parse(readFileSync(new URL('./fixtures/quyhoach-hcm.json', import.meta.url), 'utf8')) as Record<string, unknown>;

beforeEach(async () => {
  _resetCacheForTests();
  await cacheClear();
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('parsePlanning (#59)', () => {
  it('reads zoning cells, lot data, plans and setbacks from a real answer', () => {
    const i = parsePlanning(FX['ben-nghe'], 106.7040, 10.772)!;
    expect(i.district).toBe('Quận 1');
    expect(i.ward).toBe('Phường Bến Nghé');
    expect(i.cadastralId).toBe('267400430184');
    expect(i.areaM2).toBeCloseTo(8938.7, 1);
    expect(i.plans[0]).toMatch(/Khu Trung tâm hiện hữu/);
    // Cells sorted by area, with portal legend colour as #rrggbb.
    expect(i.cells.map((c) => c.code)).toContain('CXDVO');
    expect(i.cells[0].areaM2).toBeGreaterThanOrEqual(i.cells[i.cells.length - 1].areaM2);
    expect(i.cells.every((c) => /^#[0-9a-f]{6}$/.test(c.color))).toBe(true);
    expect(i.cells.find((c) => c.code === 'DGT')?.name).toBe('Đất giao thông');
    // Road widths come through as metres.
    const nguyenHue = i.frontages.find((f) => f.street === 'Nguyễn Huệ 2')!;
    expect(nguyenHue.roadWidthM).toBe(20);
    expect(nguyenHue.side).toBe('Tây Nam');
    expect(i.outline?.[0][0].length).toBeGreaterThan(3);
    expect(i.extraLayers).toBe(0);
  });

  it('tolerates rows with missing or differently named setback fields', () => {
    const i = parsePlanning(FX['quan5'], 106.66, 10.749)!;
    expect(i.frontages.find((f) => f.street.startsWith('Trần Văn Kiều'))?.roadWidthM).toBe(40);
    // Mạc Cửu: logioi null, 'LoGioi' 2.3 in a differently cased key.
    expect(i.frontages.find((f) => f.street === 'Mạc Cửu')?.roadWidthM).toBe(2.3);
  });

  it('returns null when the portal has no lot (empty array or empty lot info)', () => {
    expect(parsePlanning([], 106.7, 10.77)).toBeNull();
    expect(parsePlanning({ QHPK: '[]', ThongTinChung: '[]' }, 106.7, 10.77)).toBeNull();
  });

  it('throws on an answer that is not the expected shape, so the UI can say "could not look up"', () => {
    expect(() => parsePlanning('<html>maintenance</html>', 106.7, 10.77)).toThrow();
    expect(() => parsePlanning({ hello: 'world' }, 106.7, 10.77)).toThrow();
    expect(() => parsePlanning([{ x: 1 }], 106.7, 10.77)).toThrow();
  });

  it('counts extra layers it does not parse', () => {
    const raw = { ...(FX['quan5'] as object), QHNganh: JSON.stringify([{ type: 'Feature', properties: {}, geometry: null }]) };
    expect(parsePlanning(raw, 106.66, 10.749)!.extraLayers).toBe(1);
  });

  it('never lets a hostile colour reach a style attribute', () => {
    expect(rgbToHex('130,130,130')).toBe('#828282');
    expect(rgbToHex('255,0,0')).toBe('#ff0000');
    expect(rgbToHex('red;background:url(x)')).toBe('#9aa0a6');
    expect(rgbToHex(undefined)).toBe('#9aa0a6');
    expect(rgbToHex('999,0,0')).toBe('#ff0000');
  });
});

describe('query point and helpers', () => {
  it('interiorPoint is the centroid for a convex lot', () => {
    const ring: [number, number][] = [[106.7, 10.77], [106.7002, 10.77], [106.7002, 10.7702], [106.7, 10.7702], [106.7, 10.77]];
    const [x, y] = interiorPoint(ring);
    expect(x).toBeCloseTo(106.7001, 6);
    expect(y).toBeCloseTo(10.7701, 6);
  });

  it('interiorPoint stays inside a U-shaped lot whose centroid is outside', () => {
    // U opening upwards: centroid lies in the hollow.
    const u: [number, number][] = [[0, 0], [10, 0], [10, 10], [7, 10], [7, 3], [3, 3], [3, 10], [0, 10], [0, 0]];
    const p = interiorPoint(u.map(([x, y]) => [106 + x / 1e4, 10 + y / 1e4] as [number, number]));
    const inside = (x: number, y: number) => {
      let r = false;
      for (let i = 0, j = u.length - 1; i < u.length; j = i++) {
        const [xi, yi] = u[i];
        const [xj, yj] = u[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
      }
      return r;
    };
    expect(inside((p[0] - 106) * 1e4, (p[1] - 10) * 1e4)).toBe(true);
  });

  it('inHcm accepts HCMC and rejects Hà Nội and far-away points', () => {
    expect(inHcm(106.7009, 10.7769)).toBe(true);
    expect(inHcm(105.8542, 21.0285)).toBe(false);
    expect(inHcm(0, 0)).toBe(false);
  });

  it('flags a portal lot that is nothing like the selected parcel', () => {
    const i = parsePlanning(FX['quan5'], 106.66, 10.749)!; // 295 m²
    expect(lotMismatchNote(300, i)).toBeNull();
    expect(lotMismatchNote(5000, i)).toMatch(/khác thửa đang chọn/);
    expect(lotMismatchNote(0, i)).toBeNull();
  });

  it('builds a portal link and GeoJSON with the lot on top of the cells', () => {
    expect(portalLink(106.7, 10.77)).toBe('https://thongtinquyhoach.hochiminhcity.gov.vn/#18/10.770000/106.700000');
    const fc = planningToGeoJson(parsePlanning(FX['ben-nghe'], 106.704, 10.772));
    const kinds = fc.features.map((f) => f.properties?.kind);
    expect(kinds.filter((k) => k === 'cell').length).toBeGreaterThan(0);
    expect(kinds[kinds.length - 1]).toBe('lot');
    expect(planningToGeoJson(null).features).toEqual([]);
  });
});

describe('loadPlanning', () => {
  it('POSTs Lat/Lon as a form and parses the answer', async () => {
    const f = vi.fn(async (_u: RequestInfo | URL, _init?: RequestInit) => json(FX['ben-nghe']));
    vi.stubGlobal('fetch', f);
    const i = await loadPlanning(106.704, 10.772);
    expect(i?.ward).toBe('Phường Bến Nghé');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(PLANNING_API);
    expect(init?.method).toBe('POST');
    const body = init?.body as URLSearchParams;
    expect(body.get('Lat')).toBe('10.772');
    expect(body.get('Lon')).toBe('106.704');
  });

  it('caches an answer, including "no lot", so a repeat selection makes no request', async () => {
    const f = vi.fn(async () => json([]));
    vi.stubGlobal('fetch', f);
    expect(await loadPlanning(106.7, 10.77)).toBeNull();
    expect(await loadPlanning(106.7, 10.77)).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('rejects on HTTP errors and on non-JSON answers (not cached as "no planning")', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 502 })));
    await expect(loadPlanning(106.7, 10.77)).rejects.toThrow('HTTP 502');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })));
    await expect(loadPlanning(106.7, 10.77)).rejects.toThrow();
    const f = vi.fn(async () => json(FX['quan5']));
    vi.stubGlobal('fetch', f);
    expect((await loadPlanning(106.7, 10.77))?.district).toBe('Quận 5');
  });

  it('propagates an abort instead of falling back', async () => {
    const f = vi.fn((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
    vi.stubGlobal('fetch', f);
    const ac = new AbortController();
    const p = loadPlanning(106.7, 10.77, ac.signal);
    await vi.waitFor(() => expect(f).toHaveBeenCalled());
    ac.abort();
    await expect(p).rejects.toThrow('aborted');
    // Already aborted before it starts: no request at all.
    f.mockClear();
    await expect(loadPlanning(106.8, 10.8, ac.signal)).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});

describe('dossier integration', () => {
  const parcel = makeParcel({ id: 'p1', source: 'osm', ring: [[106.704, 10.772], [106.7042, 10.772], [106.7042, 10.7722], [106.704, 10.7722], [106.704, 10.772]], landCode: 'ODT' });
  const stats = { count: 0, outliers: 0, median: 0, p25: 0, p75: 0, min: 0, max: 0 };
  const val = valueParcel(parcel, [], defaultAssumptions(parcel));

  it('omits planning when there is none (schema stays as before)', () => {
    const d = buildDossier({ parcel, comparables: [], stats, valuation: val, radiusM: 1000 });
    expect(d.planning).toBeUndefined();
    expect(d.sources.map((s) => s.name).join(' ')).not.toMatch(/quy hoạch/i);
  });

  it('adds a compact planning summary, its source and disclaimer, and a Markdown section', () => {
    const info = parsePlanning(FX['ben-nghe'], 106.704, 10.772, Date.UTC(2026, 10, 25))!;
    const d = buildDossier({ parcel, comparables: [], stats, valuation: val, radiusM: 1000, planning: info });
    expect(d.planning?.queriedAt).toBe('2026-11-25T00:00:00.000Z');
    expect(d.planning?.cells.length).toBe(info.cells.length);
    expect(JSON.stringify(d.planning)).not.toMatch(/coordinates/); // no geometry in the dossier
    expect(d.sources.some((s) => /thongtinquyhoach/.test(s.url ?? ''))).toBe(true);
    expect(d.disclaimers.join(' ')).toMatch(/không thay thế giấy tờ pháp lý/);
    const md = dossierToMarkdown(d);
    expect(md).toMatch(/## Quy hoạch \(cổng TP\.HCM\)/);
    expect(md).toMatch(/Lộ giới Nguyễn Huệ 2/);
    expect(summarizePlanning(info).frontages.length).toBe(info.frontages.length);
  });
});
