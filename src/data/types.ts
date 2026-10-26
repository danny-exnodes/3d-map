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

export type RoofShape = 'flat' | 'gabled' | 'hipped' | 'pyramidal' | 'dome' | 'pagoda';
export type FacadeMaterial = 'glass' | 'brick' | 'metal' | 'concrete';
/** Vietnamese building typologies used for heuristics and procedural detail (#5). */
export type Archetype = 'tube' | 'shophouse' | 'villa' | 'apartment' | 'office' | 'civic' | 'industrial' | 'temple' | 'church' | 'generic';
/** Where the height came from, best first (#3). */
export type HeightSource = 'osm' | 'gob' | 'overture' | 'heuristic';
export type FootprintSource = 'osm' | 'overture' | 'demo';

export interface Building {
  id: string;
  polygon: Polygon;
  /** Height in meters (walls only, without roof). */
  height: number;
  minHeight: number;
  kind: string;
  roof: RoofShape;
  roofHeight?: number;
  color?: string;
  roofColor?: string;
  material?: FacadeMaterial;
  archetype?: Archetype;
  heightSource: HeightSource;
  footprintSource: FootprintSource;
  levels?: number;
  name?: string;
  address?: string;
  /** A building:part; its outline building is not drawn (Simple 3D Buildings). */
  isPart?: boolean;
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

export interface CityStats {
  footprints: Record<FootprintSource, number>;
  heights: Record<HeightSource, number>;
  /** Attribution lines for the data actually used. */
  attributions: string[];
}

export interface CityData {
  stats?: CityStats;
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

export type ProgressStep = 'osm' | 'overture' | 'heights' | 'merge' | 'build';
export type ProgressFn = (step: ProgressStep, fraction: number, detail?: string) => void;
