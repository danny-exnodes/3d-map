import { describe, expect, it } from 'vitest';
import { tiltShiftStrength } from '../src/scene/tiltShift';

describe('tilt-shift strength', () => {
  it('is off top-down and near the horizon, full in the oblique view', () => {
    expect(tiltShiftStrength(0)).toBe(0);
    expect(tiltShiftStrength(15)).toBe(0);
    expect(tiltShiftStrength(50)).toBe(1);
    expect(tiltShiftStrength(85)).toBe(0);
    expect(tiltShiftStrength(25)).toBeGreaterThan(0);
    expect(tiltShiftStrength(25)).toBeLessThan(1);
  });
});
