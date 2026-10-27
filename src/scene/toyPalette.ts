import * as THREE from 'three';

/** Cozy "toy" palette: pastel walls and roofs, soft ground, grass and roads. */
export const TOY_WALLS: readonly string[] = ['#f6e3c6', '#f4c7b8', '#cfe5d0', '#f7d9e3', '#fbeec1', '#d6e2f2'];
export const TOY_ROOFS: readonly string[] = ['#e08a70', '#d47560', '#eba37c', '#9fb5d4'];
export const TOY_GROUND = '#f2e7d0';
export const TOY_GRASS = '#b5d99b';
export const TOY_ROAD = '#e0d0b0';
export const TOY_WATER = '#8ccbe0';
export const TOY_TREES: readonly string[] = ['#8cc977', '#a6d683', '#79b86b'];
/** Plinth colour = wall colour × this. */
export const PLINTH_SHADE = 0.78;

interface Entry {
  h: number;
  l: number;
  color: THREE.Color;
}

const entries = (list: readonly string[]): Entry[] =>
  list.map((hex) => {
    const color = new THREE.Color(hex);
    const hsl = { h: 0, s: 0, l: 0 };
    color.getHSL(hsl);
    return { h: hsl.h, l: hsl.l, color };
  });

const WALL_ENTRIES = entries(TOY_WALLS);
const ROOF_ENTRIES = entries(TOY_ROOFS);
const src = new THREE.Color();
const hsl = { h: 0, s: 0, l: 0 };

/** Nearest palette entry by hue (weighted ×2, circular) and lightness; the source data is left untouched. */
export function toyColor(hex: string, kind: 'wall' | 'roof', out = new THREE.Color()): THREE.Color {
  src.set(hex).getHSL(hsl);
  let best = (kind === 'wall' ? WALL_ENTRIES : ROOF_ENTRIES)[0];
  let bestD = Infinity;
  for (const e of kind === 'wall' ? WALL_ENTRIES : ROOF_ENTRIES) {
    const dh = Math.abs(e.h - hsl.h);
    const d = 2 * Math.min(dh, 1 - dh) + Math.abs(e.l - hsl.l);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return out.copy(best.color);
}
