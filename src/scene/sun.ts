import * as THREE from 'three';

export interface SunState {
  /** Unit vector pointing towards the sun in scene space (x east, y up, z south). */
  direction: THREE.Vector3;
  altitudeDeg: number;
  azimuthDeg: number;
  /** 0 = full day, 1 = deep night. */
  night: number;
  /** Compass label of the sun bearing, e.g. "Đông Nam". */
  compass: string;
}

const COMPASS_VI = ['Bắc', 'Đông Bắc', 'Đông', 'Đông Nam', 'Nam', 'Tây Nam', 'Tây', 'Tây Bắc'];
const COMPASS_SHORT = ['B', 'ĐB', 'Đ', 'ĐN', 'N', 'TN', 'T', 'TB'];

export function compassLabel(bearingDeg: number, short = false): string {
  const i = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return (short ? COMPASS_SHORT : COMPASS_VI)[i];
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const RAD = Math.PI / 180;

/**
 * Sun position (same algorithm as the SunCalc library, after
 * https://aa.quae.nl/en/reken/zonpositie.html). Azimuth is in radians from
 * south, positive towards west; altitude in radians above the horizon.
 */
export function sunPosition(date: Date, lat: number, lon: number): { azimuth: number; altitude: number } {
  const d = date.getTime() / 86_400_000 - 0.5 + 2_440_588 - 2_451_545;
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  const e = RAD * 23.4397;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
  const lw = -lon * RAD;
  const phi = lat * RAD;
  const H = RAD * (280.16 + 360.9856235 * d) - lw - ra;
  return {
    azimuth: Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)),
    altitude: Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)),
  };
}

export function sunState(date: Date, lat: number, lon: number): SunState {
  const { azimuth: az, altitude: alt } = sunPosition(date, lat, lon);
  const ch = Math.cos(alt);
  const direction = new THREE.Vector3(-Math.sin(az) * ch, Math.sin(alt), Math.cos(az) * ch).normalize();
  const bearing = ((az * 180) / Math.PI + 180 + 360) % 360; // from north, clockwise
  return {
    direction,
    altitudeDeg: (alt * 180) / Math.PI,
    azimuthDeg: bearing,
    night: 1 - smooth(-0.1, 0.12, Math.sin(alt)),
    compass: compassLabel(bearing),
  };
}

const DAY_SKY = new THREE.Color('#9fd3f2');
const DUSK_SKY = new THREE.Color('#f2a96b');
const NIGHT_SKY = new THREE.Color('#101a3d');
const DAY_SUN = new THREE.Color('#fff4e0');
const LOW_SUN = new THREE.Color('#ffb070');

/** Sky / fog colour, sun light colour and intensities for a sun state and cloud cover (0..1). */
export function lighting(s: SunState, cloud = 0) {
  const elev = Math.sin((s.altitudeDeg * Math.PI) / 180);
  const dusk = Math.exp(-((elev - 0.02) ** 2) / 0.006);
  const sky = NIGHT_SKY.clone().lerp(DAY_SKY, 1 - s.night).lerp(DUSK_SKY, dusk * 0.55);
  sky.lerp(new THREE.Color('#9aa3ad'), cloud * 0.45 * (1 - s.night));
  const sunColor = LOW_SUN.clone().lerp(DAY_SUN, smooth(0.05, 0.45, elev));
  return {
    sky,
    sunColor,
    sunIntensity: Math.max(0, smooth(-0.02, 0.2, elev)) * 2.6 * (1 - cloud * 0.6),
    hemiIntensity: 1.1 + (1 - s.night) * 0.4,
    hemiSky: new THREE.Color('#bcd8ff').lerp(new THREE.Color('#4b5bb0'), s.night),
    hemiGround: new THREE.Color('#d8c9a8').lerp(new THREE.Color('#2b2540'), s.night),
  };
}
