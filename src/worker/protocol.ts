import type { CityLoadOptions } from '../data/loader';
import type { BBox, CityData } from '../data/types';
import type { RailPath, RoadPath } from '../scene/roads';
import type { ObjectDesc } from '../scene/serialize';
import type { Style } from '../scene/style';

export type WorkerRequest =
  | { id: number; op: 'build'; data: CityData; style: Style }
  | { id: number; op: 'parseOverpass'; bbox: BBox; text: string }
  | { id: number; op: 'demo'; bbox: BBox }
  | { id: number; op: 'loadCity'; bbox: BBox; opts: Omit<CityLoadOptions, 'signal'> }
  | { id: number; op: 'abort'; target: number };

export interface BuildResult {
  objects: ObjectDesc[];
  paths: RoadPath[];
  railPaths: RailPath[];
  buildings: number;
  trees: number;
  buildingIds: string[];
}

export type WorkerResponse =
  | { id: number; type: 'progress'; f: number; detail: string; step?: string }
  | { id: number; type: 'result'; result: unknown }
  | { id: number; type: 'error'; message: string };
