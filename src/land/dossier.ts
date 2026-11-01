/**
 * Valuation dossier (#39): one self-describing JSON document with everything behind an
 * estimate (parcel, nearby listings, adjustments, assumptions, sources). It is what the AI
 * advisor reads through its get_dossier tool, and what a user can export to hand to another
 * agent or a human appraiser. Comparables carry no seller PII: ids, links and numbers only.
 */
import type { LngLat } from '../data/types';
import { GROUP_LABEL, landGroup, landType } from './landTypes';
import type { Access, LandGroup, LegalStatus, MarketStats, Parcel, ParcelMetrics } from './types';
import { type Assumptions, type Comparable, DISCLAIMER, type Valuation } from './valuation';

export const DOSSIER_SCHEMA = 'tinymap.valuation/v1' as const;

export interface DossierComparable {
  id: string;
  url?: string;
  distance: number; // m
  price: number; // VND, asking
  size: number; // m²
  pricePerM2: number; // VND/m², asking
  legal: LegalStatus;
  access: Access;
  corner: boolean;
  /** ISO time of posting. */
  time: string;
}

export interface ValuationDossier {
  schema: typeof DOSSIER_SCHEMA;
  /** ISO time the dossier was built. */
  generated: string;
  parcel: {
    id: string;
    source: Parcel['source'];
    landCode: string;
    landName?: string;
    group?: LandGroup;
    ring: LngLat[];
    metrics: Omit<ParcelMetrics, 'edges'>;
    soTo?: string;
    soThua?: string;
  };
  market: {
    source: string;
    snapshotTime?: string;
    radiusM: number;
    stats: MarketStats;
    comparables: DossierComparable[];
  };
  valuation: Valuation;
  assumptions: Assumptions;
  disclaimers: string[];
  sources: { name: string; url?: string; license?: string }[];
}

export interface DossierInput {
  parcel: Parcel;
  comparables: Comparable[];
  stats: MarketStats;
  valuation: Valuation;
  radiusM: number;
  /** e.g. 'Chợ Tốt (ảnh chụp hằng ngày)' or 'Chợ Tốt (trực tiếp qua proxy)'. */
  marketSource?: string;
  snapshotTime?: string;
  /** Injected for deterministic tests. */
  now?: Date;
}

export const DOSSIER_SOURCES: ValuationDossier['sources'] = [
  { name: 'OpenStreetMap / OpenFreeMap (ranh sử dụng đất tham khảo)', url: 'https://www.openstreetmap.org/copyright', license: 'ODbL 1.0' },
  { name: 'Chợ Tốt Nhà (giá rao bán)', url: 'https://www.nhatot.com' },
  { name: 'Thông tư 08/2024/TT-BTNMT (mã loại đất)' },
  { name: 'Thông tư 42/2024/TT-BTC (chuẩn mực thẩm định giá bất động sản, phương pháp so sánh)' },
];

export const DOSSIER_DISCLAIMERS = [
  DISCLAIMER,
  'Ranh thửa lấy từ OpenStreetMap chỉ là vùng sử dụng đất tham khảo, không phải bản đồ địa chính.',
  'Giá rao bán thường cao hơn giá giao dịch thực; quy hoạch và pháp lý cần kiểm tra tại cơ quan nhà nước.',
];

/** Drops the edge list (large, derivable from the ring) so the dossier stays compact for the LLM. */
function compactMetrics(m: ParcelMetrics): Omit<ParcelMetrics, 'edges'> {
  const { edges: _edges, ...rest } = m;
  return rest;
}

export function buildDossier(input: DossierInput): ValuationDossier {
  const { parcel, valuation } = input;
  const code = parcel.landCode;
  return {
    schema: DOSSIER_SCHEMA,
    generated: (input.now ?? new Date()).toISOString(),
    parcel: {
      id: parcel.id,
      source: parcel.source,
      landCode: code,
      landName: landType(code)?.name,
      group: landGroup(code),
      ring: parcel.ring,
      metrics: compactMetrics(parcel.metrics),
      soTo: parcel.soTo,
      soThua: parcel.soThua,
    },
    market: {
      source: input.marketSource ?? 'Chợ Tốt',
      snapshotTime: input.snapshotTime,
      radiusM: input.radiusM,
      stats: input.stats,
      // Whitelist the fields: never forward free text (titles, seller names, phones).
      comparables: input.comparables.map((c) => ({
        id: c.id,
        url: c.url,
        distance: Math.round(c.distance),
        price: c.price,
        size: c.size,
        pricePerM2: c.pricePerM2,
        legal: c.legal,
        access: c.access,
        corner: c.corner,
        time: new Date(c.time).toISOString(),
      })),
    },
    valuation,
    assumptions: valuation.assumptions,
    disclaimers: [...DOSSIER_DISCLAIMERS],
    sources: DOSSIER_SOURCES.map((s) => ({ ...s })),
  };
}

const trM2 = (v: number) => `${(v / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tr/m²`;
const ty = (v: number) => `${(v / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ`;
const CONF: Record<Valuation['confidence'], string> = { high: 'cao', medium: 'trung bình', low: 'thấp' };
const METHOD: Record<Valuation['method'], string> = {
  'so-sanh': 'So sánh trực tiếp',
  'trung-vi-khu-vuc': 'Trung vị khu vực',
  'khong-du-lieu': 'Không đủ dữ liệu',
};

/** Vietnamese Markdown summary of a dossier, for export and copy-paste. */
export function dossierToMarkdown(d: ValuationDossier): string {
  const p = d.parcel;
  const v = d.valuation;
  const m = p.metrics;
  const out: string[] = [];
  out.push(`# Hồ sơ định giá thửa đất ${p.soTo && p.soThua ? `(tờ ${p.soTo}, thửa ${p.soThua})` : p.id}`);
  out.push('', `_Lập lúc ${d.generated}. Lược đồ \`${d.schema}\`._`, '');
  out.push('## Thửa đất');
  out.push(`- Loại đất: ${p.landCode}${p.landName ? ` (${p.landName})` : ''}${p.group ? `, ${GROUP_LABEL[p.group]}` : ''}`);
  out.push(`- Diện tích: ${Math.round(m.area).toLocaleString('vi-VN')} m², chu vi ${Math.round(m.perimeter)} m`);
  out.push(`- Mặt tiền: ${m.frontage != null ? `${m.frontage.toFixed(1)} m` : 'không xác định'}, chiều sâu ${m.depth.toFixed(1)} m, hình dáng ${m.shape}`);
  if (m.streetName) out.push(`- Đường gần nhất: ${m.streetName}`);
  out.push('', '## Kết quả');
  out.push(`- Phương pháp: ${METHOD[v.method]}; độ tin cậy ${CONF[v.confidence]}`);
  if (v.method !== 'khong-du-lieu') {
    out.push(`- Đơn giá ước tính: **${trM2(v.pricePerM2)}**`);
    out.push(`- Tổng giá trị: **${ty(v.total)}** (khoảng ${ty(v.low)} – ${ty(v.high)})`);
  }
  for (const n of v.notes) out.push(`- ${n}`);
  out.push('', '## Thị trường');
  const s = d.market.stats;
  out.push(`- Nguồn: ${d.market.source}${d.market.snapshotTime ? ` (dữ liệu lúc ${d.market.snapshotTime})` : ''}, bán kính ${d.market.radiusM} m`);
  out.push(`- ${s.count} tin, trung vị ${trM2(s.median)} (P25 ${trM2(s.p25)}, P75 ${trM2(s.p75)}), loại ${s.outliers} tin bất thường`);
  if (v.used.length) {
    out.push('', '| Tin | Cách (m) | Giá rao (tr/m²) | Sau điều chỉnh (tr/m²) | Trọng số |', '| --- | ---: | ---: | ---: | ---: |');
    for (const u of v.used) {
      const c = d.market.comparables.find((x) => x.id === u.id);
      const name = c?.url ? `[${u.id}](${c.url})` : u.id;
      out.push(`| ${name} | ${Math.round(u.distance)} | ${(u.raw / 1e6).toFixed(1)} | ${(u.adjusted / 1e6).toFixed(1)} | ${(u.weight * 100).toFixed(0)}% |`);
    }
  }
  if (v.rejected.length) {
    out.push('', 'Tin bị loại:');
    for (const r of v.rejected) out.push(`- ${r.id}: ${r.reason}`);
  }
  out.push('', '## Lưu ý');
  for (const x of d.disclaimers) out.push(`- ${x}`);
  out.push('', '## Nguồn');
  for (const x of d.sources) out.push(`- ${x.name}${x.license ? ` (${x.license})` : ''}${x.url ? `: ${x.url}` : ''}`);
  return out.join('\n') + '\n';
}

const num = { type: 'number' } as const;
const str = { type: 'string' } as const;

/** JSON Schema (draft 2020-12) of ValuationDossier, for external agents that consume exports. */
export const DOSSIER_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://danny-exnodes.github.io/3d-map/schemas/tinymap.valuation.v1.json',
  title: 'Tiny Map valuation dossier',
  type: 'object',
  required: ['schema', 'generated', 'parcel', 'market', 'valuation', 'assumptions', 'disclaimers', 'sources'],
  properties: {
    schema: { const: DOSSIER_SCHEMA },
    generated: { type: 'string', format: 'date-time' },
    parcel: {
      type: 'object',
      required: ['id', 'source', 'landCode', 'ring', 'metrics'],
      properties: {
        id: str,
        source: { enum: ['osm', 'vn2000', 'import'] },
        landCode: str,
        landName: str,
        group: { enum: ['NNP', 'PNN', 'CSD'] },
        ring: { type: 'array', items: { type: 'array', items: num, minItems: 2, maxItems: 2 } },
        metrics: {
          type: 'object',
          required: ['area', 'perimeter', 'frontage', 'depth', 'shape', 'streetDistance'],
          properties: {
            area: num,
            perimeter: num,
            frontage: { type: ['number', 'null'] },
            depth: num,
            shape: { enum: ['vuong', 'no-hau', 'top-hau', 'meo'] },
            streetDistance: { type: ['number', 'null'] },
            streetName: str,
          },
        },
        soTo: str,
        soThua: str,
      },
    },
    market: {
      type: 'object',
      required: ['source', 'radiusM', 'stats', 'comparables'],
      properties: {
        source: str,
        snapshotTime: str,
        radiusM: num,
        stats: {
          type: 'object',
          required: ['count', 'outliers', 'median', 'p25', 'p75', 'min', 'max'],
          properties: { count: num, outliers: num, median: num, p25: num, p75: num, min: num, max: num },
        },
        comparables: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'distance', 'price', 'size', 'pricePerM2', 'legal', 'access', 'corner', 'time'],
            additionalProperties: false,
            properties: {
              id: str,
              url: str,
              distance: num,
              price: num,
              size: num,
              pricePerM2: num,
              legal: { enum: ['so-rieng', 'so-chung', 'cho-so', 'giay-tay', 'unknown'] },
              access: { enum: ['mat-tien', 'hem-lon', 'hem-vua', 'hem-nho', 'unknown'] },
              corner: { type: 'boolean' },
              time: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
    valuation: {
      type: 'object',
      required: ['method', 'pricePerM2', 'total', 'low', 'high', 'confidence', 'used', 'rejected', 'notes'],
      properties: {
        method: { enum: ['so-sanh', 'trung-vi-khu-vuc', 'khong-du-lieu'] },
        pricePerM2: num,
        total: num,
        low: num,
        high: num,
        confidence: { enum: ['high', 'medium', 'low'] },
        used: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'distance', 'raw', 'adjusted', 'factor', 'weight', 'adjustments'],
            properties: {
              id: str,
              distance: num,
              raw: num,
              adjusted: num,
              factor: num,
              weight: num,
              adjustments: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['factor', 'subject', 'comp', 'delta'],
                  properties: { factor: str, subject: str, comp: str, delta: num },
                },
              },
            },
          },
        },
        rejected: { type: 'array', items: { type: 'object', required: ['id', 'reason'], properties: { id: str, reason: str } } },
        notes: { type: 'array', items: str },
      },
    },
    assumptions: {
      type: 'object',
      required: ['access', 'corner', 'legal', 'landCode', 'roadWideningShare', 'askDiscount'],
      properties: {
        access: { enum: ['mat-tien', 'hem-lon', 'hem-vua', 'hem-nho', 'unknown'] },
        accessWidth: num,
        alleyLevel: num,
        corner: { type: 'boolean' },
        legal: { enum: ['so-rieng', 'so-chung', 'cho-so', 'giay-tay', 'unknown'] },
        landCode: str,
        roadWideningShare: { type: 'number', minimum: 0, maximum: 1 },
        askDiscount: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    disclaimers: { type: 'array', items: str, minItems: 1 },
    sources: {
      type: 'array',
      items: { type: 'object', required: ['name'], properties: { name: str, url: str, license: str } },
    },
  },
} as const;
