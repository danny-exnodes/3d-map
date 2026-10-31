import { describe, expect, it } from 'vitest';
import { PROVINCE_MERIDIANS, vn2000ToWgs84, wgs84ToVn2000 } from '../src/land/vn2000';

describe('VN-2000 ↔ WGS84 (#37)', () => {
  it('round-trips to well under a millimetre', () => {
    for (const [x, y, cm] of [
      [1192000, 602000, 105.75],
      [2327000, 587000, 105],
      [1780000, 550000, 107.75],
      [1350000, 420000, 108.25],
    ]) {
      const [lon, lat] = vn2000ToWgs84(x, y, cm);
      const back = wgs84ToVn2000(lon, lat, cm);
      expect(Math.abs(back.x - x)).toBeLessThan(1e-3);
      expect(Math.abs(back.y - y)).toBeLessThan(1e-3);
    }
  });

  it('puts a TP.HCM sổ đỏ point in central Sài Gòn', () => {
    const [lon, lat] = vn2000ToWgs84(1192000, 602000, PROVINCE_MERIDIANS['TP. Hồ Chí Minh']);
    expect(Math.abs(lat - 10.78)).toBeLessThan(0.05);
    expect(Math.abs(lon - 106.69)).toBeLessThan(0.05);
  });

  // Reference values computed with PROJ 9 (pyproj 3.8) from the same proj4 string
  // (+proj=tmerc +k=0.9999 +x_0=500000 +ellps=WGS84 +towgs84=…). No published sổ đỏ ↔ WGS84
  // control pair was found, so this checks the implementation, not the datum parameters.
  it('matches PROJ to within 0.5 m', () => {
    const cases: [number, number, number, number, number][] = [
      [1192000, 602000, 105.75, 106.684464531, 10.777469768],
      [2327000, 587000, 105, 105.838911815, 21.034487385],
      [1780000, 550000, 107.75, 108.219218456, 16.093664085],
    ];
    for (const [x, y, cm, lon, lat] of cases) {
      const [glon, glat] = vn2000ToWgs84(x, y, cm);
      const dE = (glon - lon) * 111320 * Math.cos((lat * Math.PI) / 180);
      const dN = (glat - lat) * 110574;
      expect(Math.hypot(dE, dN)).toBeLessThan(0.5);
    }
  });

  it('lists the required province meridians', () => {
    const expected: Record<string, number> = {
      'TP. Hồ Chí Minh': 105.75, 'Hà Nội': 105, 'Đà Nẵng': 107.75, 'Hải Phòng': 105.75, 'Cần Thơ': 105, 'Bình Dương': 105.75,
      'Đồng Nai': 107.75, 'Bà Rịa – Vũng Tàu': 107.75, 'Khánh Hòa': 108.25, 'Lâm Đồng': 107.75, 'Quảng Ninh': 107.75,
      'Bắc Ninh': 105.5, 'Thừa Thiên Huế': 107, 'Nghệ An': 104.75, 'Thanh Hóa': 105,
    };
    for (const [k, v] of Object.entries(expected)) expect(PROVINCE_MERIDIANS[k]).toBe(v);
    for (const v of Object.values(PROVINCE_MERIDIANS)) expect((v * 4) % 1).toBe(0); // multiples of 15'
  });
});
