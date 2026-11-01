import { TOY, type ToyParams } from './toyGeometry';

/**
 * How the model is drawn. Đồ chơi: rounded pastel toy houses (default). Khối: plain blocks in the
 * buildings' own colours, sharp corners, no plinth or chimneys. Siêu thực: realistic materials on the
 * Khối geometry. The style is chosen at build time: colours, geometry and the GLB bake depend on it.
 */
export type Style = 'toy' | 'block' | 'real';

export const STYLES: readonly Style[] = ['toy', 'block', 'real'];

export const STYLE_LABEL: Record<Style, string> = { toy: 'Đồ chơi', block: 'Khối', real: 'Siêu thực' };

/** A style from `?style=` or storage; master's colour modes (`color`, `mono`) read as Khối. */
export function parseStyle(s: string | null): Style | null {
  if (s === 'toy' || s === 'block' || s === 'real') return s;
  if (s === 'color' || s === 'mono') return 'block';
  return null;
}

/** Toy unit proportions for a style (toyGeometry.ts) and whether colours go through the pastel palette. */
export function toyParamsFor(style: Style): ToyParams & { pastel: boolean } {
  if (style === 'toy') return { inset: TOY.inset, radius: TOY.radius, plinthH: TOY.plinthH, roofBevel: TOY.roofBevel, chimneys: true, pastel: true };
  return { inset: 0, radius: 0, plinthH: 0, roofBevel: 0, chimneys: false, pastel: false };
}
