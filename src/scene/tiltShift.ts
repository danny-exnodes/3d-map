import { smooth } from './sun';

/** Blur strength (0..1) for the miniature tilt-shift look; `tiltDeg` is the camera tilt from vertical (0 = top-down). */
export function tiltShiftStrength(tiltDeg: number): number {
  return smooth(15, 35, tiltDeg) * (1 - smooth(65, 80, tiltDeg));
}
