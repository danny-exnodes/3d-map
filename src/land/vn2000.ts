import type { LngLat } from '../data/types';

/**
 * VN-2000 ↔ WGS84 for the corner-coordinate tables printed on a sổ đỏ (#37).
 *
 * Cadastral maps use VN-2000 TM-3° (k0 = 0.9999, false easting 500 000 m) with a central
 * meridian fixed per province. Vietnamese surveying writes X = northing and Y = easting, the
 * reverse of the GIS habit, so every function here takes (x = north, y = east).
 *
 * VN-2000 uses the WGS84 ellipsoid; only the datum differs, by the published 7-parameter Helmert
 * shift as proj4 writes it (+towgs84, Position Vector convention). Accuracy is that of those
 * parameters (~1 m), far below a parcel edge but not survey grade.
 */

const a = 6378137;
const f = 1 / 298.257223563;
const e2 = f * (2 - f);
const e = Math.sqrt(e2);
const K0 = 0.9999;
const FALSE_EASTING = 500000;
const RAD = Math.PI / 180;

// Krüger series to n⁶ (Karney 2011): sub-millimetre inside a 3° zone, so round trips are exact.
const n = f / (2 - f);
const A = (a / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64 + n ** 6 / 256);
const ALPHA = [
  n / 2 - (2 / 3) * n ** 2 + (5 / 16) * n ** 3 + (41 / 180) * n ** 4 - (127 / 288) * n ** 5 + (7891 / 37800) * n ** 6,
  (13 / 48) * n ** 2 - (3 / 5) * n ** 3 + (557 / 1440) * n ** 4 + (281 / 630) * n ** 5 - (1983433 / 1935360) * n ** 6,
  (61 / 240) * n ** 3 - (103 / 140) * n ** 4 + (15061 / 26880) * n ** 5 + (167603 / 181440) * n ** 6,
  (49561 / 161280) * n ** 4 - (179 / 168) * n ** 5 + (6601661 / 7257600) * n ** 6,
  (34729 / 80640) * n ** 5 - (3418889 / 1995840) * n ** 6,
  (212378941 / 319334400) * n ** 6,
];
const BETA = [
  n / 2 - (2 / 3) * n ** 2 + (37 / 96) * n ** 3 - (1 / 360) * n ** 4 - (81 / 512) * n ** 5 + (96199 / 604800) * n ** 6,
  (1 / 48) * n ** 2 + (1 / 15) * n ** 3 - (437 / 1440) * n ** 4 + (46 / 105) * n ** 5 - (1118711 / 3870720) * n ** 6,
  (17 / 480) * n ** 3 - (37 / 840) * n ** 4 - (209 / 4480) * n ** 5 + (5569 / 90720) * n ** 6,
  (4397 / 161280) * n ** 4 - (11 / 504) * n ** 5 - (830251 / 7257600) * n ** 6,
  (4583 / 161280) * n ** 5 - (108847 / 3991680) * n ** 6,
  (20648693 / 638668800) * n ** 6,
];

/** +towgs84 for VN-2000: metres, arc-seconds, ppm. */
const TOWGS84 = [-191.90441429, -39.30318279, -111.45032835, -0.00928836, 0.01975479, -0.00427372, 0.252906278] as const;

/**
 * Central meridians per province, TT 973/2001/TT-TCĐC Phụ lục (transcription on caselaw.vn,
 * not the gazette PDF; values are from secondary sources) (#37). Provinces split later inherit
 * their parent's meridian (Điện Biên ← Lai Châu, Đắk Nông ← Đắk Lắk, Hậu Giang ← Cần Thơ).
 * The 2025 merged provinces keep the meridian of each former province, so a sổ đỏ from former
 * Bình Dương (now TP.HCM) is still 105°45', and one from former Bà Rịa–Vũng Tàu is 107°45'.
 */
export const PROVINCE_MERIDIANS: Readonly<Record<string, number>> = {
  'Lai Châu': 103,
  'Điện Biên': 103,
  'Sơn La': 104,
  'Kiên Giang': 104.5,
  'Cà Mau': 104.5,
  'Lào Cai': 104.75,
  'Yên Bái': 104.75,
  'Nghệ An': 104.75,
  'Phú Thọ': 104.75,
  'An Giang': 104.75,
  'Thanh Hóa': 105,
  'Vĩnh Phúc': 105,
  'Đồng Tháp': 105,
  'Cần Thơ': 105,
  'Hậu Giang': 105,
  'Bạc Liêu': 105,
  'Hà Nội': 105,
  'Ninh Bình': 105,
  'Hà Nam': 105,
  'Hà Giang': 105.5,
  'Hải Dương': 105.5,
  'Hà Tĩnh': 105.5,
  'Bắc Ninh': 105.5,
  'Hưng Yên': 105.5,
  'Thái Bình': 105.5,
  'Nam Định': 105.5,
  'Tây Ninh': 105.5,
  'Vĩnh Long': 105.5,
  'Sóc Trăng': 105.5,
  'Trà Vinh': 105.5,
  'Cao Bằng': 105.75,
  'Long An': 105.75,
  'Tiền Giang': 105.75,
  'Bến Tre': 105.75,
  'Hải Phòng': 105.75,
  'TP. Hồ Chí Minh': 105.75,
  'Bình Dương': 105.75,
  'Tuyên Quang': 106,
  'Hòa Bình': 106,
  'Quảng Bình': 106,
  'Quảng Trị': 106.25,
  'Bình Phước': 106.25,
  'Bắc Kạn': 106.5,
  'Thái Nguyên': 106.5,
  'Bắc Giang': 107,
  'Thừa Thiên Huế': 107,
  'Lạng Sơn': 107.25,
  'Kon Tum': 107.5,
  'Quảng Ninh': 107.75,
  'Đồng Nai': 107.75,
  'Bà Rịa – Vũng Tàu': 107.75,
  'Quảng Nam': 107.75,
  'Lâm Đồng': 107.75,
  'Đà Nẵng': 107.75,
  'Quảng Ngãi': 108,
  'Ninh Thuận': 108.25,
  'Khánh Hòa': 108.25,
  'Bình Định': 108.25,
  'Đắk Lắk': 108.5,
  'Đắk Nông': 108.5,
  'Phú Yên': 108.5,
  'Gia Lai': 108.5,
  'Bình Thuận': 108.5,
};

/** Converts a sổ đỏ corner (X = northing, Y = easting, metres) to WGS84 [lon, lat]. */
export function vn2000ToWgs84(x: number, y: number, centralMeridian: number): LngLat {
  const [lon, lat] = tmInverse(x, y, centralMeridian);
  const [X, Y, Z] = toEcef(lon, lat, 0);
  const [X2, Y2, Z2] = helmert(X, Y, Z);
  const [lon2, lat2] = fromEcef(X2, Y2, Z2);
  return [lon2, lat2];
}

/** WGS84 [lon, lat] → VN-2000 TM-3° { x: northing, y: easting }. Exact inverse of vn2000ToWgs84. */
export function wgs84ToVn2000(lon: number, lat: number, centralMeridian: number): { x: number; y: number } {
  // The forward Helmert dropped the VN-2000 ellipsoidal height; recover the WGS84 height that
  // maps to h = 0 on VN-2000 by iterating (converges in 2–3 steps), so round trips are exact.
  let h = 0;
  let vn: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const [X, Y, Z] = toEcef(lon, lat, h);
    vn = helmertInverse(X, Y, Z);
    const g = fromEcef(...vn);
    h -= g[2];
  }
  const [vlon, vlat] = fromEcef(...vn);
  const [east, north] = tmForward(vlon, vlat, centralMeridian);
  return { x: north, y: east };
}

function tmForward(lon: number, lat: number, cm: number): [east: number, north: number] {
  const phi = lat * RAD;
  const lam = (lon - cm) * RAD;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam));
  const eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let E = eta;
  let N = xi;
  for (let j = 1; j <= 6; j++) {
    E += ALPHA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    N += ALPHA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return [FALSE_EASTING + K0 * A * E, K0 * A * N];
}

function tmInverse(north: number, east: number, cm: number): LngLat {
  const xi = north / (K0 * A);
  const eta = (east - FALSE_EASTING) / (K0 * A);
  let xi1 = xi;
  let eta1 = eta;
  for (let j = 1; j <= 6; j++) {
    xi1 -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const taup = Math.sin(xi1) / Math.sqrt(Math.sinh(eta1) ** 2 + Math.cos(xi1) ** 2);
  const lam = Math.atan2(Math.sinh(eta1), Math.cos(xi1));
  // Newton on τ (tan φ) from τ' (tan of the conformal latitude), Karney 2011 eq. 19–21.
  let tau = taup;
  for (let i = 0; i < 6; i++) {
    const sigma = Math.sinh(e * Math.atanh((e * tau) / Math.sqrt(1 + tau * tau)));
    const taupi = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
    const dtau =
      ((taup - taupi) / Math.sqrt(1 + taupi * taupi)) * ((1 + (1 - e2) * tau * tau) / ((1 - e2) * Math.sqrt(1 + tau * tau)));
    tau += dtau;
    if (Math.abs(dtau) < 1e-14) break;
  }
  return [cm + lam / RAD, Math.atan(tau) / RAD];
}

function toEcef(lon: number, lat: number, h: number): [number, number, number] {
  const phi = lat * RAD, lam = lon * RAD;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  return [(N + h) * Math.cos(phi) * Math.cos(lam), (N + h) * Math.cos(phi) * Math.sin(lam), (N * (1 - e2) + h) * Math.sin(phi)];
}

function fromEcef(X: number, Y: number, Z: number): [lon: number, lat: number, h: number] {
  const p = Math.hypot(X, Y);
  let phi = Math.atan2(Z, p * (1 - e2));
  let h = 0;
  for (let i = 0; i < 6; i++) {
    const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    h = p / Math.cos(phi) - N;
    phi = Math.atan2(Z, p * (1 - (e2 * N) / (N + h)));
  }
  return [Math.atan2(Y, X) / RAD, phi / RAD, h];
}

/** Rotation/scale matrix of the Position Vector Helmert (small-angle form, as proj4 applies it). */
function helmertMatrix(): number[][] {
  const S = RAD / 3600;
  const rx = TOWGS84[3] * S, ry = TOWGS84[4] * S, rz = TOWGS84[5] * S;
  const k = 1 + TOWGS84[6] * 1e-6;
  return [
    [k, -k * rz, k * ry],
    [k * rz, k, -k * rx],
    [-k * ry, k * rx, k],
  ];
}
const M = helmertMatrix();

function helmert(X: number, Y: number, Z: number): [number, number, number] {
  return [
    TOWGS84[0] + M[0][0] * X + M[0][1] * Y + M[0][2] * Z,
    TOWGS84[1] + M[1][0] * X + M[1][1] * Y + M[1][2] * Z,
    TOWGS84[2] + M[2][0] * X + M[2][1] * Y + M[2][2] * Z,
  ];
}

/** Exact inverse (Cramer's rule) rather than flipping the signs, so round trips stay sub-mm. */
function helmertInverse(X: number, Y: number, Z: number): [number, number, number] {
  const b = [X - TOWGS84[0], Y - TOWGS84[1], Z - TOWGS84[2]];
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  const col = (c: number) => det(M.map((row, r) => row.map((v, j) => (j === c ? b[r] : v))));
  return [col(0) / D, col(1) / D, col(2) / D];
}
