import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TOY_ROOFS, TOY_WALLS, toyColor } from '../src/scene/toyPalette';

describe('toy palette', () => {
  it('maps any colour onto a palette entry of the right kind', () => {
    const walls = TOY_WALLS.map((c) => new THREE.Color(c).getHexString());
    const roofs = TOY_ROOFS.map((c) => new THREE.Color(c).getHexString());
    for (const c of ['#ffffff', '#40444d', '#c4462f', '#5fa8d8', '#f0e6d2']) {
      expect(walls).toContain(toyColor(c, 'wall').getHexString());
      expect(roofs).toContain(toyColor(c, 'roof').getHexString());
    }
  });
  it('keeps different source colours apart', () => {
    expect(toyColor('#c4462f', 'roof').getHexString()).not.toBe(toyColor('#6a8cc2', 'roof').getHexString());
    expect(toyColor('#e8d5b5', 'wall').getHexString()).not.toBe(toyColor('#b8d8c0', 'wall').getHexString());
  });
  it('matches neutrals on lightness, not on a fake hue', () => {
    expect(['f6e3c6', 'fbeec1']).toContain(toyColor('#ffffff', 'wall').getHexString());
    expect(['f6e3c6', 'fbeec1']).toContain(toyColor('#f0e6d2', 'wall').getHexString());
    expect(['f4c7b8', 'f7d9e3']).not.toContain(toyColor('#9a9a9a', 'wall').getHexString());
  });
  it('wraps hue around red', () => {
    expect(toyColor('#ff0010', 'roof').getHexString()).toBe(toyColor('#ff1000', 'roof').getHexString());
    expect(toyColor('#ff0010', 'roof').getHexString()).not.toBe('9fb5d4');
  });
});
