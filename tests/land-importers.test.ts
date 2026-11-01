import { describe, expect, it } from 'vitest';
import { parseGeoJson, parseKml, parseVn2000Table } from '../src/land/importers';
import { parcelMetrics } from '../src/land/parcels';
import { vn2000ToWgs84 } from '../src/land/vn2000';

const CM = 105.75;
// A 5 × 20 m lot: X north, Y east.
const corners = [
  [1192000, 602000],
  [1192000, 602005],
  [1192020, 602005],
  [1192020, 602000],
];

describe('VN-2000 table import (#37)', () => {
  it('reads space-separated rows with a header and a closing row', () => {
    const text = `Bảng tọa độ góc ranh
Điểm   X(m)   Y(m)   Cạnh(m)
1 1192000.00 602000.00 5.00
2 1192000.00 602005.00 20.00
3 1192020.00 602005.00 5.00
4 1192020.00 602000.00 20.00
1 1192000.00 602000.00`;
    const t = parseVn2000Table(text, CM);
    expect(t.corners).toHaveLength(4);
    expect(t.corners[0]).toEqual({ label: '1', x: 1192000, y: 602000 });
    const m = parcelMetrics(t.ring, []);
    expect(Math.abs(m.area - 100)).toBeLessThan(0.5);
  });

  it('accepts tabs, semicolons, commas and Vietnamese decimal commas', () => {
    const rows = corners.map(([x, y], i) => [i + 1, x, y]);
    const tab = rows.map((r) => `${r[0]}\t${String(r[1])},50\t${String(r[2])},25`).join('\n');
    const semi = rows.map((r) => `M${r[0]};${r[1]}.5;${r[2]}.25`).join('\n');
    const csv = rows.map((r) => `${r[0]},${r[1]}.5,${r[2]}.25`).join('\n');
    const csvSpaced = rows.map((r) => `${r[0]}, ${r[1]}.5, ${r[2]}.25`).join('\n');
    const thousands = rows.map((r) => `${r[0]} 1.192.${String(r[1]).slice(4)},5 602.${String(r[2]).slice(3)},25`).join('\n');
    for (const text of [tab, semi, csv, csvSpaced, thousands]) {
      const t = parseVn2000Table(text, CM);
      expect(t.corners.map((c) => [c.x, c.y])).toEqual(corners.map(([x, y]) => [x + 0.5, y + 0.25]));
    }
    expect(parseVn2000Table(semi, CM).corners[2].label).toBe('M3');
  });

  it('fixes a swapped Y X order and rejects too few points', () => {
    const swapped = corners.map(([x, y]) => `${y} ${x}`).join('\n');
    expect(parseVn2000Table(swapped, CM).corners[1]).toEqual({ label: undefined, x: 1192000, y: 602005 });
    expect(() => parseVn2000Table('X Y\n1 1192000 602000', CM)).toThrow(/ít nhất 3/);
  });
});

describe('GeoJSON import (#37)', () => {
  const ring = [[106.7, 10.78], [106.70005, 10.78], [106.70005, 10.7802], [106.7, 10.7802], [106.7, 10.78]];

  it('reads a FeatureCollection with cadastral properties', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { so_to: 12, SoThua: '345', KyHieuMucDich: 'ODT+CLN' }, geometry: { type: 'Polygon', coordinates: [ring] } },
        { type: 'Feature', properties: { LoaiDat: 'BHK' }, geometry: { type: 'MultiPolygon', coordinates: [[ring], [ring]] } },
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } },
      ],
    };
    const shapes = parseGeoJson(JSON.stringify(fc));
    expect(shapes).toHaveLength(3);
    expect(shapes[0]).toMatchObject({ soTo: '12', soThua: '345', landCode: 'ODT' });
    expect(shapes[0].ring).toHaveLength(4);
    expect(shapes[1].landCode).toBe('HNK');
  });

  it('reads a bare Polygon and converts VN-2000 metres when a meridian is given', () => {
    expect(parseGeoJson(JSON.stringify({ type: 'Polygon', coordinates: [ring] }))).toHaveLength(1);
    const projected = { type: 'Polygon', coordinates: [corners.map(([x, y]) => [y, x])] };
    expect(() => parseGeoJson(JSON.stringify(projected))).toThrow(/VN-2000/);
    const [s] = parseGeoJson(JSON.stringify(projected), CM);
    const [lon, lat] = vn2000ToWgs84(1192000, 602000, CM);
    expect(s.ring[0][0]).toBeCloseTo(lon, 9);
    expect(s.ring[0][1]).toBeCloseTo(lat, 9);
    expect(() => parseGeoJson('{oops')).toThrow(/không hợp lệ/);
  });
});

describe('KML import (#37)', () => {
  it('reads Placemark polygons with name and extended data', () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Trích lục</name>
<Placemark><name>Thửa 345</name>
  <ExtendedData><Data name="so_to"><value>12</value></Data><SchemaData><SimpleData name="loai_dat">ONT</SimpleData></SchemaData></ExtendedData>
  <Polygon><outerBoundaryIs><LinearRing><coordinates>
    106.7,10.78,0 106.70005,10.78,0 106.70005,10.7802,0 106.7,10.7802,0 106.7,10.78,0
  </coordinates></LinearRing></outerBoundaryIs>
  <innerBoundaryIs><LinearRing><coordinates>106.70001,10.78001 106.70002,10.78001 106.70002,10.78002</coordinates></LinearRing></innerBoundaryIs>
  </Polygon></Placemark>
<Placemark><name>Khác</name><MultiGeometry>
  <Polygon><outerBoundaryIs><LinearRing><coordinates>106.71,10.79 106.711,10.79 106.711,10.791</coordinates></LinearRing></outerBoundaryIs></Polygon>
</MultiGeometry></Placemark>
</Document></kml>`;
    const shapes = parseKml(kml);
    expect(shapes).toHaveLength(2);
    expect(shapes[0]).toMatchObject({ name: 'Thửa 345', soTo: '12', landCode: 'ONT' });
    expect(shapes[0].ring).toHaveLength(4);
    expect(shapes[1].name).toBe('Khác');
    expect(shapes[1].ring).toHaveLength(3);
  });
});
