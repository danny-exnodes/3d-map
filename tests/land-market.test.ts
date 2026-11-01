import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetCacheForTests, cacheClear } from '../src/data/cache';
import { filterOutliers, haversine, loadLive, loadMarket, marketProxy, marketStats, nearby, parseListingsCsv, quantile, regionFor, setMarketProxy } from '../src/land/market';
import type { Listing } from '../src/land/types';

const L = (id: string, ppm2Tr: number, lon = 106.7, lat = 10.77): Listing => ({
  id, source: 'chotot', lon, lat, price: ppm2Tr * 1e6 * 100, size: 100, pricePerM2: ppm2Tr * 1e6,
  legal: 'so-rieng', access: 'unknown', corner: false, time: 0,
});

beforeEach(async () => {
  _resetCacheForTests();
  await cacheClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('market statistics (#38)', () => {
  it('drops the 400 tr/m² outlier and sub-1 tr/m² prices', () => {
    const ls = [100, 110, 120, 130, 400].map((v, i) => L(`a${i}`, v));
    const { kept, outliers } = filterOutliers([...ls, L('cheap', 0.5)]);
    expect(kept.map((l) => l.pricePerM2 / 1e6)).toEqual([100, 110, 120, 130]);
    expect(outliers.map((l) => l.id).sort()).toEqual(['a4', 'cheap']);
  });

  it('keeps everything when MAD is zero', () => {
    expect(filterOutliers([L('a', 50), L('b', 50), L('c', 50), L('d', 90)]).kept).toHaveLength(4);
  });

  it('computes interpolated quantiles', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10, 20, 30, 40, 50], 0.25)).toBe(20);
    const s = marketStats([100, 110, 120, 130, 400].map((v, i) => L(`a${i}`, v)));
    expect(s).toEqual({ count: 4, outliers: 1, median: 115e6, p25: 107.5e6, p75: 122.5e6, min: 100e6, max: 130e6 });
    expect(marketStats([]).count).toBe(0);
  });

  it('finds nearby listings sorted by distance', () => {
    // 0.001° latitude ≈ 111 m.
    const ls = [L('far', 50, 106.7, 10.79), L('mid', 50, 106.7, 10.772), L('near', 50, 106.7, 10.771)];
    const n = nearby(ls, 106.7, 10.77, 500);
    expect(n.map((l) => l.id)).toEqual(['near', 'mid']);
    expect(n[0].distance).toBeCloseTo(111.2, 0);
    expect(haversine(106.7, 10.77, 106.7, 10.79)).toBeCloseTo(2224, -1);
  });

  it('guesses the city from latitude', () => {
    expect(regionFor(105.85, 21.03)).toBe('hn');
    expect(regionFor(106.7, 10.77)).toBe('hcm');
  });
});

describe('user CSV (#38)', () => {
  it('reads Vietnamese headers and number formats', () => {
    const csv = '﻿Vĩ độ;Kinh độ;Giá;Diện tích;Pháp lý;Vị trí;URL\n10,77;106,7;3,5 tỷ;70 m2;Sổ hồng;Hẻm xe hơi;https://x.vn/1\n10.78;106.71;1.500.000.000;50;Giấy tay;Mặt tiền;\nbad;row;;;;;\n';
    const ls = parseListingsCsv(csv);
    expect(ls).toHaveLength(2);
    expect(ls[0]).toMatchObject({ source: 'user', lat: 10.77, lon: 106.7, price: 3.5e9, size: 70, pricePerM2: 50e6, legal: 'so-rieng', access: 'hem-lon', url: 'https://x.vn/1' });
    expect(ls[1]).toMatchObject({ price: 1.5e9, size: 50, pricePerM2: 30e6, legal: 'giay-tay', access: 'mat-tien' });
  });

  it('accepts English headers and price per m² only', () => {
    const ls = parseListingsCsv('lat,lng,size,gia_m2,legal\n21.0,105.8,"1,200",85 tr,so chung\n');
    expect(ls[0]).toMatchObject({ lat: 21, lon: 105.8, size: 1200, pricePerM2: 85e6, price: 85e6 * 1200, legal: 'so-chung' });
    expect(parseListingsCsv('a,b\n1,2')).toEqual([]);
  });
});

describe('market snapshot loading (#38)', () => {
  const index = { generated: '2026-10-31T00:00:00Z', regions: { hcm: { count: 1, file: 'hcm.json' }, hn: { count: 1, file: 'hn.json' } } };
  const file = (region: string, id: string) => ({ generated: '2026-10-31T00:00:00Z', source: 'Chợ Tốt Nhà (nhatot.com)', region, count: 1, listings: [L(id, 60)] });
  const serve = () =>
    vi.fn(async (url: string) => {
      if (url.endsWith('market/index.json')) return Response.json(index);
      if (url.endsWith('market/hcm.json')) return Response.json(file('hcm', 'h1'));
      if (url.endsWith('market/hn.json')) return Response.json(file('hn', 'n1'));
      return new Response('', { status: 404 });
    });

  it('loads region files through the index and caches them', async () => {
    const f = serve();
    vi.stubGlobal('fetch', f);
    const all = await loadMarket('all');
    expect(all.listings.map((l) => l.id)).toEqual(['h1', 'n1']);
    expect(all.stale).toBe(false);
    expect(f).toHaveBeenCalledTimes(3); // one index + two files
    await new Promise((r) => setTimeout(r, 20)); // cacheSet is fire-and-forget
    const again = await loadMarket('hcm');
    expect(again.listings.map((l) => l.id)).toEqual(['h1']);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('falls back to an expired copy when offline', async () => {
    vi.stubGlobal('fetch', serve());
    await loadMarket('hn');
    await new Promise((r) => setTimeout(r, 20));
    // 7 h later the 6 h entry has expired and the network is gone.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 7 * 3600 * 1000);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const snap = await loadMarket('hn');
    expect(snap.stale).toBe(true);
    expect(snap.listings.map((l) => l.id)).toEqual(['n1']);
    await expect(loadMarket('hcm')).rejects.toThrow('Failed to fetch');
  });

  it('queries the proxy like the gateway and keeps nearby ads', async () => {
    const mem = new Map<string, string>([['tinymap:marketProxy', 'https://p.example.dev/']]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: () => {}, removeItem: () => {} });
    const ad = (id: number, lat: number) => ({ list_id: id, latitude: lat, longitude: 105.85, price: 5e9, size: 50, list_time: 1 });
    const f = vi.fn(async () => Response.json({ total: 2, ads: [ad(1, 21.03), ad(2, 21.2)] }));
    vi.stubGlobal('fetch', f);
    const ls = await loadLive([105.85, 21.031], 1000);
    expect(ls.map((l) => l.id)).toEqual(['chotot/1']);
    const u = new URL((f.mock.calls[0] as unknown as [string])[0]);
    expect(u.origin).toBe('https://p.example.dev');
    expect(u.searchParams.get('region_v2')).toBe('12000');
    expect(u.searchParams.get('cg')).toBe('1040');
    expect(f).toHaveBeenCalledTimes(1); // short page: stop paging
  });

  it('stores the proxy URL only where localStorage exists', () => {
    expect(marketProxy()).toBeNull();
    setMarketProxy('https://p.example.dev/'); // no localStorage in Node: no-op, no throw
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) });
    setMarketProxy(' https://p.example.dev/ ');
    expect(marketProxy()).toBe('https://p.example.dev/');
    expect(mem.get('tinymap:marketProxy')).toBe('https://p.example.dev/');
    setMarketProxy(null);
    expect(marketProxy()).toBeNull();
  });
});
