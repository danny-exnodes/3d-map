import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetCacheForTests, cacheClear, cacheGet, cachePin, cacheSet } from '../src/data/cache';
import { fold, searchWards, wardAreaKm2, type WardList } from '../src/data/offline';

const hcm = JSON.parse(readFileSync('public/wards/hcm.json', 'utf8')) as WardList;
const hn = JSON.parse(readFileSync('public/wards/hn.json', 'utf8')) as WardList;

describe('ward lists (#18)', () => {
  it('cover the phường of TP.HCM and Hà Nội after the 2025 reform', () => {
    expect(hcm.wards.filter((w) => w.kind === 'phuong').length).toBeGreaterThanOrEqual(110);
    expect(hn.wards.filter((w) => w.kind === 'phuong').length).toBeGreaterThanOrEqual(50);
  });

  it('contain the default location (Én Nam, 101 Châu Thị Hoá) in Phường Chánh Hưng', () => {
    const [w] = searchWards(hcm.wards, 'chanh hung');
    expect(w.name).toBe('Phường Chánh Hưng');
    const lon = 106.6764, lat = 10.7378;
    expect(lon > w.bbox.west && lon < w.bbox.east && lat > w.bbox.south && lat < w.bbox.north).toBe(true);
    expect(wardAreaKm2(w)).toBeGreaterThan(1);
    expect(wardAreaKm2(w)).toBeLessThan(20);
  });

  it('searches without accents and ranks name prefixes first', () => {
    expect(fold('Phường Đống Đa')).toBe('phuong dong da');
    expect(searchWards(hn.wards, 'Đống Đa')[0].name).toBe('Phường Đống Đa');
    expect(searchWards(hn.wards, 'phuong hoan kiem')[0].name).toBe('Phường Hoàn Kiếm');
    expect(searchWards(hcm.wards, 'ben thanh')[0].name).toBe('Phường Bến Thành');
  });
});

describe('offline pins', () => {
  beforeEach(async () => {
    _resetCacheForTests();
    await cacheClear();
  });

  it('keeps a tile shared by two packages until both are deleted', async () => {
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    await cacheSet('overture', 't1', new ArrayBuffer(10), 1000);
    const keys = [{ ns: 'overture', key: 't1' }];
    expect(await cachePin(keys, 'ward-a', true)).toBe(10);
    await cachePin(keys, 'ward-b', true);
    spy.mockReturnValue(now + 10_000); // long expired
    await cachePin(keys, 'ward-a', false);
    expect(await cacheGet('overture', 't1')).toBeInstanceOf(ArrayBuffer);
    await cachePin(keys, 'ward-b', false);
    expect(await cacheGet('overture', 't1')).toBeUndefined();
    spy.mockRestore();
  });
});
