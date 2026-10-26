/** Bounding box in WGS84 degrees. */
export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export type LngLat = [lon: number, lat: number];
/** A polygon: outer ring first, then holes. Rings are not closed (first != last). */
export type Polygon = LngLat[][];

export interface Building {
  id: string;
  polygon: Polygon;
  /** Height in meters (walls only, without roof). */
  height: number;
  minHeight: number;
  kind: string;
  roof: 'flat' | 'gabled' | 'hipped';
  color?: string;
  roofColor?: string;
  name?: string;
}

export type RoadClass = 'motorway' | 'primary' | 'secondary' | 'tertiary' | 'residential' | 'service' | 'path';

export interface Road {
  id: string;
  line: LngLat[];
  cls: RoadClass;
  width: number;
  lanes: number;
  oneway: boolean;
  /** Vertical layer; >0 means bridge / flyover. */
  layer: number;
  bridge: boolean;
  tunnel: boolean;
  name?: string;
}

export interface Rail {
  id: string;
  line: LngLat[];
  kind: string;
  layer: number;
  bridge: boolean;
  tunnel: boolean;
}

export interface AreaFeature {
  id: string;
  polygon: Polygon;
  kind: 'water' | 'park' | 'grass' | 'forest' | 'plaza' | 'parking';
}

export interface Waterway {
  id: string;
  line: LngLat[];
  width: number;
}

export interface PointOfInterest {
  id: string;
  pos: LngLat;
  name: string;
  kind: string;
}

export interface CityData {
  bbox: BBox;
  buildings: Building[];
  roads: Road[];
  rails: Rail[];
  areas: AreaFeature[];
  waterways: Waterway[];
  trees: LngLat[];
  pois: PointOfInterest[];
  source: string;
}

export type ProgressStep = 'osm' | 'merge' | 'build';
export type ProgressFn = (step: ProgressStep, fraction: number, detail?: string) => void;
