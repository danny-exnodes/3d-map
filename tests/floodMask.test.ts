import { describe, expect, it } from 'vitest';
import type { BoatRoute } from '../src/scene/boats';
import { distanceToWater, FLOOD_COVERAGE_FLOOR, floodCoverage, floodMaskGrid, floodSpreadMetres } from '../src/scene/floodMask';

const river: BoatRoute = { kind: 'line', pts: [[-100, 0], [100, 0]], width: 20 };
const lake: BoatRoute = { kind: 'area', ring: [[-10, -10], [10, -10], [10, 10], [-10, 10]], areaM2: 400 };

describe('distanceToWater', () => {
  it('is 0 inside a river channel, positive just outside it', () => {
    expect(distanceToWater([0, 0], river)).toBe(0); // on the centreline
    expect(distanceToWater([0, 9], river)).toBe(0); // within half-width (10 m)
    expect(distanceToWater([0, 15], river)).toBeCloseTo(5);
  });

  it('is 0 inside a lake ring, else distance to its edge', () => {
    expect(distanceToWater([0, 0], lake)).toBe(0);
    expect(distanceToWater([20, 0], lake)).toBeCloseTo(10);
  });

  it('respects holes in an area (an island counts as dry)', () => {
    const withHole: BoatRoute = { ...lake, holes: [[[-2, -2], [2, -2], [2, 2], [-2, 2]]] };
    expect(distanceToWater([0, 0], withHole)).toBeGreaterThan(0);
  });
});

describe('floodSpreadMetres / floodCoverage', () => {
  it('spreads farther as the water gets deeper', () => {
    expect(floodSpreadMetres(0)).toBe(20);
    expect(floodSpreadMetres(1)).toBeGreaterThan(floodSpreadMetres(0.3));
  });

  it('is full strength at the water and never drops below the floor', () => {
    expect(floodCoverage(0, 0.5)).toBe(1);
    expect(floodCoverage(10_000, 0.5)).toBeCloseTo(FLOOD_COVERAGE_FLOOR);
    for (let d = 0; d < 2000; d += 37) expect(floodCoverage(d, 0.8)).toBeGreaterThanOrEqual(FLOOD_COVERAGE_FLOOR - 1e-9);
  });

  it('never increases moving away from the water', () => {
    let last = floodCoverage(0, 1);
    for (let d = 10; d <= 1000; d += 10) {
      const c = floodCoverage(d, 1);
      expect(c).toBeLessThanOrEqual(last + 1e-9);
      last = c;
    }
  });
});

describe('floodMaskGrid', () => {
  it('reads near-zero by the river and high far from it', () => {
    const hx = 200, hz = 200, res = 20;
    const grid = floodMaskGrid([river], hx, hz, res);
    expect(grid.length).toBe(res * res);
    const centerRow = Math.floor(res / 2); // z near 0, on the river
    const farRow = 0; // z near -hz, far from the river
    expect(grid[centerRow * res + Math.floor(res / 2)]).toBeLessThan(grid[farRow * res + Math.floor(res / 2)]);
  });

  it('is all max-distance with no water features', () => {
    const grid = floodMaskGrid([], 100, 100, 10);
    expect(Array.from(grid).every((v) => v === 255)).toBe(true);
  });
});
