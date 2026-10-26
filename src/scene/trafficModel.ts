import type { RoadClass } from '../data/types';

/**
 * Traffic model for Vietnamese cities (#26). Still a simulation: there is no open real-time
 * traffic feed for Việt Nam (#11), but flows follow road class, lanes, hour and nearby
 * attractors instead of random numbers, and speed follows the volume/capacity ratio (BPR).
 *
 * Reference orders of magnitude (HCMC / Hà Nội traffic surveys): motorcycles are ~75–85% of
 * vehicles on urban streets, peaks at 7–8h and 17–18h30, an arterial lane carries a few
 * thousand vehicles per hour at peak.
 */

export type VehicleKind = 'moto' | 'car' | 'bus' | 'truck' | 'bicycle';
export const VEHICLE_KINDS: VehicleKind[] = ['moto', 'car', 'bus', 'truck', 'bicycle'];

/**
 * Peak-hour vehicles (not PCU) per lane per hour. Motorbikes take a quarter of a car's road
 * space, so a lane of a moto-heavy street carries far more vehicles than in car-based cities.
 */
const PEAK_FLOW: Record<RoadClass, number> = { motorway: 1800, primary: 3000, secondary: 2600, tertiary: 2000, residential: 900, service: 250, path: 0 };
/** Vehicles per lane per hour at which traffic is at capacity. */
const CAPACITY: Record<RoadClass, number> = { motorway: 2300, primary: 3600, secondary: 3200, tertiary: 2600, residential: 1300, service: 500, path: 1 };
/** Free-flow speed, m/s. */
export const FREE_SPEED: Record<RoadClass, number> = { motorway: 19, primary: 12, secondary: 10.5, tertiary: 9, residential: 6.5, service: 4.5, path: 0 };

/** Share of the daily peak at a local hour (0..1). */
export function hourProfile(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const g = (c: number, w: number) => Math.exp(-((h - c) ** 2) / w);
  return Math.min(1, 0.07 + 0.93 * g(7.6, 1.3) + 0.55 * g(12, 6) + 0.95 * g(17.8, 1.8) + 0.35 * g(20.5, 2.5));
}

/** Pedestrian activity at a local hour (0..1): school and work times, lunch, evening markets. */
export function walkProfile(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const g = (c: number, w: number) => Math.exp(-((h - c) ** 2) / w);
  return Math.min(1, 0.03 + 0.7 * g(7, 1.5) + 0.6 * g(12, 3) + 0.9 * g(18.5, 4));
}

/** Vehicle mix by road class. */
export function kindMix(cls: RoadClass): Record<VehicleKind, number> {
  if (cls === 'motorway') return { moto: 0.3, car: 0.46, bus: 0.08, truck: 0.16, bicycle: 0 };
  if (cls === 'residential' || cls === 'service') return { moto: 0.86, car: 0.05, bus: 0, truck: 0.01, bicycle: 0.08 };
  return { moto: 0.76, car: 0.16, bus: 0.035, truck: 0.025, bicycle: 0.02 };
}

export interface RoadLoad {
  /** Vehicles per hour per lane. */
  flow: number;
  /** Volume / capacity. */
  vc: number;
  /** Speed / free-flow speed, from the BPR curve. */
  speedRatio: number;
  /** Vehicles per km per lane. */
  density: number;
}

/**
 * Load on a road at an hour. `boost` (≥ 1) raises flow near markets, schools, hospitals and
 * junctions with major roads.
 */
export function roadLoad(cls: RoadClass, hour: number, boost = 1): RoadLoad {
  const flow = PEAK_FLOW[cls] * hourProfile(hour) * boost;
  const vc = flow / CAPACITY[cls];
  // BPR-style curve, steeper than the highway default: urban junctions saturate early.
  const speedRatio = 1 / (1 + 1.2 * vc ** 3.5);
  const speed = Math.max(0.5, FREE_SPEED[cls] * speedRatio);
  return { flow, vc, speedRatio, density: (flow / (speed * 3.6)) };
}

/** Overlay colour for a speed ratio (Google-traffic-like scale). */
export function loadColor(speedRatio: number): string {
  return speedRatio > 0.75 ? '#2ecc71' : speedRatio > 0.5 ? '#f1c40f' : speedRatio > 0.3 ? '#e67e22' : '#e74c3c';
}
