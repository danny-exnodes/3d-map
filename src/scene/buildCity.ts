import * as THREE from 'three';
import { clipCityToBBox } from '../data/clip';
import type { CityData } from '../data/types';
import { LocalProjection } from '../geo/projection';
import { buildBuildings } from './buildings';
import { buildLandscape } from './landscape';
import { sampleAlong } from './geometry';
import { buildRoads, type RailPath, type RoadPath } from './roads';
import { type Style, toyParamsFor } from './style';

export interface BuiltCity {
  group: THREE.Group;
  paths: RoadPath[];
  railPaths: RailPath[];
  buildings: number;
  trees: number;
  buildingIds: string[];
}

/** Pure geometry generation: CityData → meshes in a style. Runs in the build worker (or inline as a fallback). */
export function buildCity(input: CityData, onProgress: (f: number, detail: string) => void = () => {}, style: Style = 'toy'): BuiltCity {
  const data = clipCityToBBox(input);
  const proj = new LocalProjection(data.bbox);
  const group = new THREE.Group();
  onProgress(0.05, 'Đường & cầu');
  const pastel = toyParamsFor(style).pastel;
  const roads = buildRoads(data.roads, data.rails, proj, pastel);
  group.add(roads.group);
  onProgress(0.3, 'Nhà cửa');
  const b = buildBuildings(data.buildings, proj, {
    onProgress: (f) => onProgress(0.3 + f * 0.35, 'Nhà cửa'),
    roadDistance: roadDistanceField(roads.paths),
    style,
  });
  group.add(b.mesh, ...b.instanced, b.details);
  onProgress(0.7, 'Cây, sông, đèn đường');
  const land = buildLandscape(data, proj, roads.paths, b.footprints, roads.lampSpots, pastel);
  group.add(land.group);
  return { group, paths: roads.paths, railPaths: roads.railPaths, buildings: b.count, trees: land.treeCount, buildingIds: b.ids };
}

/** Approximate distance to the nearest drivable road centreline (samples every 4 m, 20 m hash). */
export function roadDistanceField(paths: RoadPath[]): (x: number, z: number) => number {
  const cell = 20;
  const grid = new Map<string, number[]>();
  for (const p of paths) {
    if (p.road.cls === 'path') continue;
    sampleAlong(p.pts, 4, (x, z) => {
      const k = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(x, z);
    }, 0);
  }
  return (x, z) => {
    const ci = Math.floor(x / cell), cj = Math.floor(z / cell);
    let best = Infinity;
    for (let i = ci - 2; i <= ci + 2; i++)
      for (let j = cj - 2; j <= cj + 2; j++) {
        const l = grid.get(`${i},${j}`);
        if (!l) continue;
        for (let k = 0; k < l.length; k += 2) best = Math.min(best, Math.hypot(l[k] - x, l[k + 1] - z));
      }
    return best;
  };
}
