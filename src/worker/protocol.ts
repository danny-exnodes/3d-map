import type { BBox, CityData } from '../data/types';
import type { RailPath, RoadPath } from '../scene/roads';
import type { ObjectDesc } from '../scene/serialize';

export type WorkerRequest =
  | { id: number; op: 'build'; data: CityData }
  | { id: number; op: 'parseOverpass'; bbox: BBox; text: string }
  | { id: number; op: 'demo'; bbox: BBox }
  | { id: number; op: 'loadOsm'; bbox: BBox }
  | { id: number; op: 'abort'; target: number };

export interface BuildResult {
  objects: ObjectDesc[];
  paths: RoadPath[];
  railPaths: RailPath[];
  buildings: number;
  trees: number;
}

export type WorkerResponse =
  | { id: number; type: 'progress'; f: number; detail: string; step?: string }
  | { id: number; type: 'result'; result: unknown }
  | { id: number; type: 'error'; message: string };
