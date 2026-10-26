import * as THREE from 'three';
import type { CityData } from '../data/types';
import { LocalProjection } from '../geo/projection';
import { buildBuildings } from './buildings';
import { buildLandscape } from './landscape';
import { buildRoads, type RailPath, type RoadPath } from './roads';

export interface BuiltCity {
  group: THREE.Group;
  paths: RoadPath[];
  railPaths: RailPath[];
  buildings: number;
  trees: number;
}

/** Pure geometry generation: CityData → meshes. Runs in the build worker (or inline as a fallback). */
export function buildCity(data: CityData, onProgress: (f: number, detail: string) => void = () => {}): BuiltCity {
  const proj = new LocalProjection(data.bbox);
  const group = new THREE.Group();
  onProgress(0.05, 'Đường & cầu');
  const roads = buildRoads(data.roads, data.rails, proj);
  group.add(roads.group);
  onProgress(0.3, 'Nhà cửa');
  const b = buildBuildings(data.buildings, proj, (f) => onProgress(0.3 + f * 0.35, 'Nhà cửa'));
  group.add(b.mesh);
  onProgress(0.7, 'Cây, sông, đèn đường');
  const land = buildLandscape(data, proj, roads.paths, b.footprints, roads.lampSpots);
  group.add(land.group);
  return { group, paths: roads.paths, railPaths: roads.railPaths, buildings: b.count, trees: land.treeCount };
}
