import { afterEach, describe, expect, it, vi } from 'vitest';
import hsdcFixture from './fixtures/hsdc-hanoi.json';
import ttFixture from './fixtures/tuoitre-forecasts.json';
import { fetchFlood, type FloodLevel, type FloodPoint, floodRegion, floodSummary, hsdcLevel, parseHsdc, parseTuoiTre, tuoiTreLevel } from '../src/data/flood';

describe('hsdcLevel', () => {
  it('maps Flood_level<N> to N-1, clamped, and anything else to 0', () => {
    expect(hsdcLevel('202608311105287262087_Flood_level1.png')).toBe(0);
    expect(hsdcLevel('x_Flood_level2.png')).toBe(1);
    expect(hsdcLevel('x_Flood_level4.png')).toBe(3);
    expect(hsdcLevel('x_Flood_level9.png')).toBe(3);
    for (const v of ['', 'flood.png', null, 42, undefined]) expect(hsdcLevel(v)).toBe(0);
  });
});

describe('tuoiTreLevel', () => {
  it('maps the named levels and treats unknown ones as 1', () => {
    expect([tuoiTreLevel('low'), tuoiTreLevel('watch'), tuoiTreLevel('high')]).toEqual([0, 1, 2]);
    for (const v of ['severe', 'critical', 'very_high']) expect(tuoiTreLevel(v)).toBe(3);
    expect(tuoiTreLevel('new-level')).toBe(1);
    expect(tuoiTreLevel(undefined)).toBe(1);
  });
});

describe('parseHsdc', () => {
  it('reads the recorded 45 stations', () => {
    const ps = parseHsdc(hsdcFixture);
    expect(ps).toHaveLength(45);
    expect(ps[0]).toEqual({ id: 'hn-3', name: 'Cao Bá Quát (cổng Cty Môi trường đô thị)', lat: 21.03018, lon: 105.8395, level: 0, radiusM: 0, source: 'hanoi' });
  });

  it('sizes stations by level: 40, 70, 100 m', () => {
    const one = (icon: string) => parseHsdc({ Code: 1, Content: [{ TramId: '1', TenTram: 'A', Lat: '21.03', Lng: '105.85', Icon: icon }] })[0].radiusM;
    expect([one('x_Flood_level2.png'), one('x_Flood_level3.png'), one('x_Flood_level4.png')]).toEqual([40, 70, 100]);
  });

  it('skips points without a usable position', () => {
    const c = [
      { TramId: '1', TenTram: 'A', Lat: '', Lng: '105.8' },
      { TramId: '2', TenTram: 'B', Lat: '21,03', Lng: '105.8' },
      { TramId: '3', TenTram: 'C' },
      { TramId: '4', TenTram: 'D', Lat: '21.03', Lng: '105.85' },
    ];
    expect(parseHsdc({ Code: 1, Content: c }).map((p) => p.id)).toEqual(['hn-4']);
    for (const junk of [null, {}, { Content: 'x' }, []]) expect(parseHsdc(junk)).toEqual([]);
  });
});

describe('parseTuoiTre', () => {
  it('reads the recorded 11 zones with their radius', () => {
    const ps = parseTuoiTre(ttFixture);
    expect(ps).toHaveLength(11);
    expect(ps[0]).toMatchObject({ id: 'hcm-1', name: 'Thảo Điền - An Khánh', lat: 10.803, lon: 106.735, level: 0, radiusM: 900, source: 'hcm' });
    expect(ps.filter((p) => p.level === 1)).toHaveLength(5);
  });
});

describe('floodRegion', () => {
  it('knows Hà Nội and TP.HCM and nothing else', () => {
    expect(floodRegion(21.03, 105.85)).toBe('hanoi');
    expect(floodRegion(10.78, 106.7)).toBe('hcm');
    expect(floodRegion(16.05, 108.2)).toBeNull(); // Đà Nẵng
    expect(floodRegion(NaN, 105.85)).toBeNull();
  });
});

describe('fetchFlood', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('calls <relay>/flood/<region> and parses by region', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(hsdcFixture)));
    vi.stubGlobal('fetch', f);
    expect(await fetchFlood('https://r.test/', 'hanoi')).toHaveLength(45);
    expect((f.mock.calls[0] as unknown[])[0]).toBe('https://r.test/flood/hanoi');
  });

  it('fetchFlood rejects on non-JSON and on 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>down</html>')));
    await expect(fetchFlood('/flights-api', 'hcm')).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })));
    await expect(fetchFlood('/flights-api', 'hcm')).rejects.toThrow();
  });
});

describe('floodSummary', () => {
  const at = (level: FloodLevel, dLat: number): FloodPoint => ({ id: 'x' + dLat, name: 'X', lat: 21.03 + dLat, lon: 105.85, level, radiusM: 40, source: 'hanoi' });

  it('counts level >= 1 within 5 km, with observed or forecast wording', () => {
    expect(floodSummary([at(2, 0.01), at(1, 0.02), at(0, 0.01), at(3, 0.1)], 'hanoi', 21.03, 105.85, '14:05')).toBe('💧 2 điểm đang ngập trong 5 km · Thoát nước Hà Nội · cập nhật 14:05');
    expect(floodSummary([], 'hanoi', 21.03, 105.85, '14:05')).toBe('💧 Không có điểm ngập nào trong 5 km · Thoát nước Hà Nội · cập nhật 14:05');
    expect(floodSummary([{ ...at(1, 0), source: 'hcm' }], 'hcm', 21.03, 105.85, '14:05')).toBe('💧 1 điểm có nguy cơ ngập trong 5 km · Bản đồ triều cường (Tuổi Trẻ) · cập nhật 14:05');
    expect(floodSummary([], 'hcm', 21.03, 105.85, '14:05')).toBe('💧 Không có điểm nguy cơ ngập nào trong 5 km · Bản đồ triều cường (Tuổi Trẻ) · cập nhật 14:05');
  });
});
