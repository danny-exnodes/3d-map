import type { LngLat } from '../data/types';

/** Land-use group under Luật Đất đai 2024 Điều 9 (#37). */
export type LandGroup = 'NNP' | 'PNN' | 'CSD';

/** Where a parcel outline came from (#37). */
export type ParcelSource =
  | 'osm' // reference land-use polygon from OpenFreeMap (not a cadastral parcel)
  | 'vn2000' // corner coordinates pasted from a sổ đỏ
  | 'import'; // GeoJSON / KML from a trích lục

export interface ParcelEdge {
  /** Start and end corner (lon, lat). */
  a: LngLat;
  b: LngLat;
  /** Length in metres. */
  length: number;
  /** True if this edge is the frontage (closest to a street). */
  front: boolean;
}

export type ParcelShape = 'vuong' | 'no-hau' | 'top-hau' | 'meo';

export interface ParcelMetrics {
  area: number; // m²
  perimeter: number; // m
  edges: ParcelEdge[];
  /** Frontage width in metres (length of the front edge); null if no street is near. */
  frontage: number | null;
  /** Depth in metres, measured perpendicular to the front edge (or the longest edge). */
  depth: number;
  shape: ParcelShape;
  /** Distance from the front edge to the nearest street centreline, metres (null if none). */
  streetDistance: number | null;
  streetName?: string;
}

export interface Parcel {
  id: string;
  source: ParcelSource;
  /** Outer ring, closed or open, (lon, lat). */
  ring: LngLat[];
  /** TT 08/2024 land code, e.g. 'ODT'. */
  landCode: string;
  /** True when the code is guessed from OSM tags rather than given by the user. */
  landCodeGuessed: boolean;
  /** Raw OSM class for reference parcels, e.g. 'residential'. */
  osmClass?: string;
  soTo?: string; // số tờ bản đồ
  soThua?: string; // số thửa
  name?: string;
  metrics: ParcelMetrics;
}

/** A street centreline for frontage detection. */
export interface Street {
  name?: string;
  line: LngLat[];
}

// ---- Market listings (#38) ----

export type LegalStatus = 'so-rieng' | 'so-chung' | 'cho-so' | 'giay-tay' | 'unknown';
export type Access = 'mat-tien' | 'hem-lon' | 'hem-vua' | 'hem-nho' | 'unknown';

export interface Listing {
  id: string;
  source: 'chotot' | 'user';
  lon: number;
  lat: number;
  /** Total asking price, VND. */
  price: number;
  /** Land area, m². */
  size: number;
  /** Asking price per m², VND. */
  pricePerM2: number;
  width?: number;
  length?: number;
  /** Decoded land type label (Vietnamese), e.g. 'Đất thổ cư'. */
  landType?: string;
  legal: LegalStatus;
  access: Access;
  corner: boolean;
  /** 'no-hau' / 'top-hau' if stated by the seller. */
  shape?: ParcelShape;
  ward?: string;
  street?: string;
  /** Posting time, ms since epoch. */
  time: number;
  url?: string;
}

export interface MarketStats {
  count: number;
  /** Listings dropped as outliers. */
  outliers: number;
  median: number; // VND/m²
  p25: number;
  p75: number;
  min: number;
  max: number;
}
