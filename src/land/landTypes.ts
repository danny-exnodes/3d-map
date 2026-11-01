import type { LandGroup } from './types';

/**
 * Land-use codes of Thông tư 08/2024/TT-BTNMT, Phụ lục II mục A (Luật Đất đai 2024 Điều 9) (#37).
 * Transcribed from luatvietnam.vn and cross-checked against secondary sources; not yet checked
 * against the gazette PDF. `parent` is the code one level up in the official numbering, so the
 * UI can show "Đất trồng lúa › Đất chuyên trồng lúa".
 */
export interface LandType {
  code: string;
  name: string;
  group: LandGroup;
  parent?: string;
}

const T = (code: string, name: string, group: LandGroup, parent?: string): LandType => ({ code, name, group, parent });

export const LAND_TYPES: readonly LandType[] = [
  // I. Nhóm đất nông nghiệp
  T('CHN', 'Đất trồng cây hằng năm', 'NNP'),
  T('LUA', 'Đất trồng lúa', 'NNP', 'CHN'),
  T('LUC', 'Đất chuyên trồng lúa', 'NNP', 'LUA'),
  T('LUK', 'Đất trồng lúa còn lại', 'NNP', 'LUA'),
  T('HNK', 'Đất trồng cây hằng năm khác', 'NNP', 'CHN'),
  T('CLN', 'Đất trồng cây lâu năm', 'NNP'),
  T('LNP', 'Đất lâm nghiệp', 'NNP'),
  T('RDD', 'Đất rừng đặc dụng', 'NNP', 'LNP'),
  T('RPH', 'Đất rừng phòng hộ', 'NNP', 'LNP'),
  T('RSX', 'Đất rừng sản xuất', 'NNP', 'LNP'),
  T('RSN', 'Đất rừng sản xuất là rừng tự nhiên', 'NNP', 'RSX'),
  T('NTS', 'Đất nuôi trồng thủy sản', 'NNP'),
  T('CNT', 'Đất chăn nuôi tập trung', 'NNP'),
  T('LMU', 'Đất làm muối', 'NNP'),
  T('NKH', 'Đất nông nghiệp khác', 'NNP'),
  // II. Nhóm đất phi nông nghiệp
  T('OTC', 'Đất ở', 'PNN'),
  T('ONT', 'Đất ở tại nông thôn', 'PNN', 'OTC'),
  T('ODT', 'Đất ở tại đô thị', 'PNN', 'OTC'),
  T('TSC', 'Đất xây dựng trụ sở cơ quan', 'PNN'),
  T('CQA', 'Đất quốc phòng, an ninh', 'PNN'),
  T('CQP', 'Đất quốc phòng', 'PNN', 'CQA'),
  T('CAN', 'Đất an ninh', 'PNN', 'CQA'),
  T('DSN', 'Đất xây dựng công trình sự nghiệp', 'PNN'),
  T('DVH', 'Đất xây dựng cơ sở văn hóa', 'PNN', 'DSN'),
  T('DXH', 'Đất xây dựng cơ sở xã hội', 'PNN', 'DSN'),
  T('DYT', 'Đất xây dựng cơ sở y tế', 'PNN', 'DSN'),
  T('DGD', 'Đất xây dựng cơ sở giáo dục và đào tạo', 'PNN', 'DSN'),
  T('DTT', 'Đất xây dựng cơ sở thể dục, thể thao', 'PNN', 'DSN'),
  T('DKH', 'Đất xây dựng cơ sở khoa học và công nghệ', 'PNN', 'DSN'),
  T('DMT', 'Đất xây dựng cơ sở môi trường', 'PNN', 'DSN'),
  T('DKT', 'Đất xây dựng cơ sở khí tượng thủy văn', 'PNN', 'DSN'),
  T('DNG', 'Đất xây dựng cơ sở ngoại giao', 'PNN', 'DSN'),
  T('DSK', 'Đất xây dựng công trình sự nghiệp khác', 'PNN', 'DSN'),
  T('CSK', 'Đất sản xuất, kinh doanh phi nông nghiệp', 'PNN'),
  T('SCC', 'Đất khu công nghiệp, cụm công nghiệp', 'PNN', 'CSK'),
  T('SKK', 'Đất khu công nghiệp', 'PNN', 'SCC'),
  T('SKN', 'Đất cụm công nghiệp', 'PNN', 'SCC'),
  T('SCT', 'Đất khu công nghệ thông tin tập trung', 'PNN', 'SCC'),
  T('TMD', 'Đất thương mại, dịch vụ', 'PNN', 'CSK'),
  T('SKC', 'Đất cơ sở sản xuất phi nông nghiệp', 'PNN', 'CSK'),
  T('SKS', 'Đất sử dụng cho hoạt động khoáng sản', 'PNN', 'CSK'),
  T('CCC', 'Đất sử dụng vào mục đích công cộng', 'PNN'),
  T('DGT', 'Đất công trình giao thông', 'PNN', 'CCC'),
  T('DTL', 'Đất công trình thủy lợi', 'PNN', 'CCC'),
  T('DCT', 'Đất công trình cấp nước, thoát nước', 'PNN', 'CCC'),
  T('DPC', 'Đất công trình phòng, chống thiên tai', 'PNN', 'CCC'),
  T('DDD', 'Đất có di tích lịch sử - văn hóa, danh lam thắng cảnh, di sản thiên nhiên', 'PNN', 'CCC'),
  T('DRA', 'Đất công trình xử lý chất thải', 'PNN', 'CCC'),
  T('DNL', 'Đất công trình năng lượng, chiếu sáng công cộng', 'PNN', 'CCC'),
  T('DBV', 'Đất công trình hạ tầng bưu chính, viễn thông, công nghệ thông tin', 'PNN', 'CCC'),
  T('DCH', 'Đất chợ dân sinh, chợ đầu mối', 'PNN', 'CCC'),
  T('DKV', 'Đất khu vui chơi, giải trí công cộng, sinh hoạt cộng đồng', 'PNN', 'CCC'),
  T('TON', 'Đất tôn giáo', 'PNN'),
  T('TIN', 'Đất tín ngưỡng', 'PNN'),
  T('NTD', 'Đất nghĩa trang, nhà tang lễ, cơ sở hỏa táng; đất cơ sở lưu trữ tro cốt', 'PNN'),
  T('TVC', 'Đất có mặt nước chuyên dùng', 'PNN'),
  T('MNC', 'Đất có mặt nước chuyên dùng dạng ao, hồ, đầm, phá', 'PNN', 'TVC'),
  T('SON', 'Đất có mặt nước dạng sông, ngòi, kênh, rạch, suối', 'PNN', 'TVC'),
  T('PNK', 'Đất phi nông nghiệp khác', 'PNN'),
  // III. Nhóm đất chưa sử dụng
  T('CGT', 'Đất do Nhà nước thu hồi theo quy định của pháp luật đất đai chưa giao, chưa cho thuê', 'CSD'),
  T('BCS', 'Đất bằng chưa sử dụng', 'CSD'),
  T('DCS', 'Đất đồi núi chưa sử dụng', 'CSD'),
  T('NCS', 'Núi đá không có rừng cây', 'CSD'),
  T('MCS', 'Đất có mặt nước chưa sử dụng', 'CSD'),
];

/**
 * TT 25/2014/TT-BTNMT codes that are gone in 2024 but still printed on most existing sổ đỏ and
 * cadastral maps (#37). Codes kept unchanged in 2024 need no alias. LUN has no 2024 equivalent;
 * LUK is the closest. DTS / DCK map to their 2024 group codes.
 */
export const LEGACY_ALIASES: Readonly<Record<string, string>> = {
  LUN: 'LUK',
  BHK: 'HNK',
  NHK: 'HNK',
  DTS: 'DSK',
  SKT: 'SKK',
  SKX: 'SKC',
  DSH: 'DKV',
  DDT: 'DDD',
  DDL: 'DDD',
  DCK: 'CCC',
};

const BY_CODE = new Map(LAND_TYPES.map((t) => [t.code, t]));

/** Looks up a 2024 code or a legacy alias (case-insensitive); undefined for unknown codes. */
export function landType(code: string | undefined): LandType | undefined {
  if (!code) return undefined;
  const c = code.trim().toUpperCase();
  return BY_CODE.get(c) ?? BY_CODE.get(LEGACY_ALIASES[c] ?? '');
}

export function landGroup(code: string | undefined): LandGroup | undefined {
  return landType(code)?.group;
}

export const GROUP_LABEL: Readonly<Record<LandGroup, string>> = {
  NNP: 'Nhóm đất nông nghiệp',
  PNN: 'Nhóm đất phi nông nghiệp',
  CSD: 'Nhóm đất chưa sử dụng',
};

/** Group colours: light, mid-saturation tones so fills stay readable on the dark 2D basemap (#37). */
export const GROUP_COLOR: Readonly<Record<LandGroup, string>> = {
  NNP: '#9fd8a0', // soft green
  PNN: '#f2b48c', // peach
  CSD: '#c9c3b8', // warm grey
};

/**
 * Finer colours for the codes that actually show up in a city, loosely following the hues of the
 * official land-use map legend (residential pink/orange, commerce red, rice yellow-green, forest
 * green, water blue) but lightened for a dark background.
 */
const CODE_COLOR: Readonly<Record<string, string>> = {
  ODT: '#ff9e9e',
  ONT: '#ffc0a8',
  OTC: '#ffb0a0',
  TMD: '#ff7aa8',
  SKC: '#c8a2f0',
  SKK: '#b28cf0',
  SKN: '#b28cf0',
  SCC: '#b28cf0',
  SKS: '#b8a48a',
  LUA: '#e6ec8a',
  LUC: '#e6ec8a',
  LUK: '#d8e27a',
  HNK: '#f3e39a',
  CHN: '#f3e39a',
  CLN: '#b8e07a',
  RSX: '#7cc98a',
  RPH: '#6cbf8f',
  RDD: '#5fb48a',
  LNP: '#7cc98a',
  NTS: '#8ad3e0',
  DKV: '#9ee6b8',
  DTT: '#a6e3c8',
  NTD: '#b9b2c9',
  MNC: '#8cc4f2',
  SON: '#7ab6f0',
  TVC: '#8cc4f2',
  DGT: '#d0d0d0',
  DGD: '#ffd27a',
  DYT: '#ff8f8f',
  TON: '#e6b8ff',
  TIN: '#e6b8ff',
  CQP: '#a8b87a',
  CAN: '#a8b87a',
  PNK: '#e0c8b0',
};

/** Fill colour for a land code: per-code when common, else the group colour, else neutral grey. */
export function landColor(code: string | undefined): string {
  const t = landType(code);
  if (!t) return '#bbbbbb';
  return CODE_COLOR[t.code] ?? GROUP_COLOR[t.group];
}

/**
 * Guesses a land code from an OpenMapTiles `landuse` / `landcover` / `park` class (#37). This is
 * only a hint for reference polygons: OSM land use is not the legal loại đất. `urban` picks ODT
 * over ONT for residential land, since the app has no administrative urban/rural boundary.
 */
export function osmClassToLand(cls: string | undefined, subclass: string | undefined, urban: boolean): string {
  const keys = [subclass, cls].filter((k): k is string => !!k).map((k) => k.toLowerCase());
  for (const k of keys) {
    const code = OSM_MAP[k];
    if (code === 'RES') return urban ? 'ODT' : 'ONT';
    if (code) return code;
  }
  return 'PNK';
}

/** Subclass is tried first, so e.g. landcover class=farmland subclass=rice gives LUA. */
const OSM_MAP: Readonly<Record<string, string>> = {
  residential: 'RES',
  suburb: 'RES',
  neighbourhood: 'RES',
  quarter: 'RES',
  commercial: 'TMD',
  retail: 'TMD',
  industrial: 'SKC',
  farmland: 'HNK',
  farm: 'HNK',
  farmyard: 'HNK',
  allotments: 'HNK',
  rice: 'LUA',
  paddy: 'LUA',
  orchard: 'CLN',
  plantation: 'CLN',
  vineyard: 'CLN',
  wood: 'RSX',
  forest: 'RSX',
  cemetery: 'NTD',
  grave_yard: 'NTD',
  school: 'DGD',
  college: 'DGD',
  university: 'DGD',
  kindergarten: 'DGD',
  hospital: 'DYT',
  pitch: 'DTT',
  stadium: 'DTT',
  track: 'DTT',
  park: 'DKV',
  grass: 'DKV',
  playground: 'DKV',
  garden: 'DKV',
  recreation_ground: 'DKV',
  village_green: 'DKV',
  water: 'MNC',
  basin: 'MNC',
  reservoir: 'MNC',
  pond: 'MNC',
  river: 'SON',
  canal: 'SON',
  railway: 'DGT',
  transportation: 'DGT',
  military: 'CQP',
  religious: 'TON',
  place_of_worship: 'TON',
  construction: 'PNK',
  brownfield: 'PNK',
  quarry: 'SKS',
  wetland: 'BCS',
  sand: 'BCS',
  bare_rock: 'BCS',
  rock: 'BCS',
  scrub: 'BCS',
};
