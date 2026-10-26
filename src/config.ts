import type { BBox } from './data/types';

/**
 * Default location when the browser position is unavailable: Công ty Én Nam, 101 Châu Thị Hoá,
 * P. Chánh Hưng, TP. Hồ Chí Minh. OSM has no house number 101 yet, so this is the street's
 * midpoint — replace with the exact coordinate when known (issue #2).
 */
export const DEFAULT_LOCATION = { lat: 10.73776, lon: 106.67637, label: 'Én Nam – 101 Châu Thị Hoá' };

/** Ngã Tư Sở / Khương Thượng, Hà Nội — the "Ví dụ" button. */
export const EXAMPLE_BBOX: BBox = { south: 20.9992, west: 105.8152, north: 21.0068, east: 105.8238 };

/** Half size of the area pre-selected around a location, in metres. */
export const DEFAULT_AREA_HALF_M = 400;
