import { describe, expect, it } from 'vitest';
import { GROUP_COLOR, LAND_TYPES, landColor, landGroup, landType, osmClassToLand } from '../src/land/landTypes';

describe('land types (#37)', () => {
  it('has the full TT 08/2024 table with unique codes and valid parents', () => {
    const codes = LAND_TYPES.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBe(64); // 15 NNP + 44 PNN + 5 CSD
    for (const t of LAND_TYPES) if (t.parent) expect(landType(t.parent)?.group).toBe(t.group);
    expect(LAND_TYPES.filter((t) => t.group === 'CSD').map((t) => t.code)).toEqual(['CGT', 'BCS', 'DCS', 'NCS', 'MCS']);
  });

  it('resolves codes case-insensitively and legacy TT 25/2014 aliases', () => {
    expect(landType('odt')?.name).toBe('Đất ở tại đô thị');
    expect(landType('BHK')?.code).toBe('HNK');
    expect(landType('LUN')?.code).toBe('LUK');
    expect(landType('SKT')?.code).toBe('SKK');
    expect(landType('XYZ')).toBeUndefined();
    expect(landType(undefined)).toBeUndefined();
    expect(landGroup('CLN')).toBe('NNP');
    expect(landGroup('TMD')).toBe('PNN');
    expect(landGroup('BCS')).toBe('CSD');
  });

  it('gives distinct colours to common codes and falls back to the group colour', () => {
    const common = ['ODT', 'TMD', 'SKC', 'LUA', 'HNK', 'CLN', 'RSX', 'DKV', 'NTD', 'MNC', 'DGT', 'DGD', 'DYT'];
    expect(new Set(common.map(landColor)).size).toBe(common.length);
    expect(landColor('LMU')).toBe(GROUP_COLOR.NNP);
    expect(landColor('CGT')).toBe(GROUP_COLOR.CSD);
    expect(new Set(Object.values(GROUP_COLOR)).size).toBe(3);
    // Readable on a dark basemap: every colour is light (relative luminance > 0.3).
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const t of LAND_TYPES) expect(lum(landColor(t.code))).toBeGreaterThan(0.3);
  });

  it('maps OpenMapTiles classes to land codes', () => {
    expect(osmClassToLand('residential', undefined, true)).toBe('ODT');
    expect(osmClassToLand('residential', undefined, false)).toBe('ONT');
    expect(osmClassToLand('retail', undefined, true)).toBe('TMD');
    expect(osmClassToLand('industrial', undefined, true)).toBe('SKC');
    expect(osmClassToLand('farmland', 'rice', false)).toBe('LUA');
    expect(osmClassToLand('farmland', 'farmland', false)).toBe('HNK');
    expect(osmClassToLand('farmland', 'orchard', false)).toBe('CLN');
    expect(osmClassToLand('wood', 'forest', false)).toBe('RSX');
    expect(osmClassToLand('cemetery', undefined, true)).toBe('NTD');
    expect(osmClassToLand('university', undefined, true)).toBe('DGD');
    expect(osmClassToLand('hospital', undefined, true)).toBe('DYT');
    expect(osmClassToLand('grass', 'park', true)).toBe('DKV');
    expect(osmClassToLand('pitch', undefined, true)).toBe('DTT');
    expect(osmClassToLand('stadium', undefined, true)).toBe('DTT');
    expect(osmClassToLand('water', 'reservoir', true)).toBe('MNC');
    expect(osmClassToLand('river', undefined, true)).toBe('SON');
    expect(osmClassToLand('railway', undefined, true)).toBe('DGT');
    expect(osmClassToLand('military', undefined, true)).toBe('CQP');
    expect(osmClassToLand('religious', undefined, true)).toBe('TON');
    expect(osmClassToLand('construction', undefined, true)).toBe('PNK');
    expect(osmClassToLand('quarry', undefined, true)).toBe('SKS');
    expect(osmClassToLand('wetland', undefined, true)).toBe('BCS');
    expect(osmClassToLand('sand', undefined, true)).toBe('BCS');
    expect(osmClassToLand('something_new', undefined, true)).toBe('PNK');
    expect(osmClassToLand(undefined, undefined, true)).toBe('PNK');
  });
});
