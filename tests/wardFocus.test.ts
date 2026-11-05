import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Ward, WardList } from '../src/data/offline';
import { findWards, focusSlug, slugify, wardAnchor, wardFullSlug, wardSlug } from '../src/data/wardFocus';
import { pointInRing } from '../src/geo/projection';

const hcm = JSON.parse(readFileSync('public/wards/hcm.json', 'utf8')) as WardList;
const hn = JSON.parse(readFileSync('public/wards/hn.json', 'utf8')) as WardList;
const lists = [hcm, hn];
const first = (q: string) => findWards(lists, q)[0];
const inside = (w: Ward, [x, y]: [number, number]) => w.polygon.some((p) => pointInRing(x, y, p[0] as [number, number][]));

describe('ward slugs (?focus=)', () => {
  it('folds accents, đ and punctuation', () => {
    expect(slugify('Phường Bến Cát')).toBe('phuong-ben-cat');
    expect(slugify('  Đống   Đa ')).toBe('dong-da');
    expect(slugify('Phường Văn Miếu - Quốc Tử Giám')).toBe('phuong-van-mieu-quoc-tu-giam');
  });

  it('drops the kind prefix only for phường/xã/đặc khu', () => {
    const w = (name: string, kind: Ward['kind']) => ({ id: 'x', name, kind, bbox: { south: 0, west: 0, north: 0, east: 0 }, polygon: [] }) as Ward;
    expect(wardSlug(w('Phường Bến Cát', 'phuong'))).toBe('ben-cat');
    expect(wardSlug(w('Đặc khu Côn Đảo', 'xa'))).toBe('con-dao');
    // "Phương Bản" (Hà Nội, kind 'khac') is a name, not "Phường" + "Bản".
    expect(wardSlug(w('Phương Bản', 'khac'))).toBe('phuong-ban');
    expect(wardFullSlug(w('Xã Thạnh An', 'xa'))).toBe('xa-thanh-an');
  });
});

describe('findWards', () => {
  it('opens Phường Bến Cát from ?focus=ben-cat (e-City link)', () => {
    const m = first('ben-cat');
    expect(m.city).toBe('hcm');
    expect(m.ward.name).toBe('Phường Bến Cát');
  });

  it('accepts accents, spaces, the kind and the ward id', () => {
    const id = first('ben-cat').ward.id;
    for (const q of ['Bến Cát', 'BEN CAT', 'phuong-ben-cat', 'Phường Bến Cát', 'hcm:ben-cat', id]) expect(first(q)?.ward.id).toBe(id);
  });

  it('ranks TP.HCM before Hà Nội and lets a city or kind prefix pick the other', () => {
    // Phường An Khánh (TP.HCM) and Xã An Khánh (Hà Nội).
    expect(findWards(lists, 'an-khanh').map((m) => m.city)).toEqual(['hcm', 'hn']);
    expect(first('hn:an-khanh').ward.name).toBe('Xã An Khánh');
    expect(first('xa-an-khanh').ward.name).toBe('Xã An Khánh');
    expect(first('hcm:an-khanh').ward.name).toBe('Phường An Khánh');
  });

  it('returns nothing for unknown or empty values', () => {
    expect(findWards(lists, 'khong-co-phuong-nay')).toEqual([]);
    expect(findWards(lists, '  ')).toEqual([]);
    expect(findWards(lists, 'hn:ben-cat')).toEqual([]);
  });
});

describe('focusSlug', () => {
  it('is the short slug when it is unambiguous', () => {
    const { ward, city } = first('ben-cat');
    expect(focusSlug(ward, city, lists)).toBe('ben-cat');
  });

  it('round-trips for every ward of both cities', () => {
    for (const list of lists) {
      for (const w of list.wards) expect(first(focusSlug(w, list.city, lists))?.ward.id).toBe(w.id);
    }
  });

  it('adds the kind or city when the short slug opens another ward', () => {
    const hnAnKhanh = hn.wards.find((w) => w.name === 'Xã An Khánh')!;
    expect(focusSlug(hnAnKhanh, 'hn', lists)).toBe('xa-an-khanh');
  });

  it('numbers wards whose names fold to the same slug (Xã Thanh An, Xã Thạnh An)', () => {
    const names = findWards(lists, 'thanh-an').map((m) => m.ward.name);
    expect(names.sort()).toEqual(['Xã Thanh An', 'Xã Thạnh An']);
    const second = findWards(lists, 'thanh-an')[1].ward;
    expect(focusSlug(second, 'hcm', lists)).toBe('hcm:xa-thanh-an~2');
    expect(first('thanh-an~2').ward.id).toBe(second.id);
    expect(findWards(lists, 'thanh-an~3')).toEqual([]);
  });
});

describe('wardAnchor', () => {
  it('lies inside every ward', () => {
    for (const list of lists) {
      for (const w of list.wards) expect(inside(w, wardAnchor(w)), w.name).toBe(true);
    }
  });
});
