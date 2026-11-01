import { describe, expect, it } from 'vitest';
import { buildListingUrl, CHOTOT_REGIONS, decodeChotot, legalFromLabel } from '../src/land/chotot';

// Three real ads from gateway.chotot.com (cg=1040), seller fields, body text and images removed;
// the third one's characteristics trimmed to "Hẻm xe hơi" (#38).
const compare = (legal: string, land: string, pty?: string) => ({
  compare: {
    items: [
      { id: 'property_legal_document', label: 'Giấy tờ pháp lý', value: legal },
      { id: 'land_type', label: 'Loại hình', value: land },
      ...(pty ? [{ id: 'pty_characteristics', label: 'Đặc điểm', value: pty }] : []),
    ],
  },
});
const ADS = [
  {
    ad_id: 179765403, list_id: 135531248, category: 1040, type: 's', price: 1500000000, size: 1533, width: 30, length: 50.11,
    land_type: 4, property_legal_document: 6, pty_characteristics: [1, 3, 2, 4], latitude: 20.768013, longitude: 106.234566,
    ward_name: 'Xã Tứ Cường', ward_name_v3: 'Xã Thanh Miện', street_name: '39b', list_time: 1793424060970, is_price_not_valid: false,
    feature_params: compare('Giấy tờ viết tay', 'Đất nông nghiệp', 'Mặt tiền, Nở hậu, Hẻm xe hơi, Chưa có thổ cư'),
  },
  {
    ad_id: 179035357, list_id: 134909322, category: 1040, type: 's', price: 1750000000, size: 415, width: 10, length: 42,
    land_type: 1, property_legal_document: 1, pty_characteristics: [5, 1, 3], latitude: 10.550592, longitude: 107.278465,
    ward_name: 'Xã Long Tân', ward_name_v3: 'Xã Đất Đỏ', street_name: 'Long Tân', list_time: 1793423944660, is_price_not_valid: false,
    feature_params: compare('Đã có sổ', 'Đất thổ cư', 'Thổ cư 1 phần, Mặt tiền, Nở hậu'),
  },
  {
    ad_id: 178616098, list_id: 134555129, category: 1040, type: 's', price: 800000000, size: 250, width: 5, length: 50,
    land_type: 4, property_legal_document: 1, pty_characteristics: [2], latitude: 9.260136, longitude: 105.37531,
    ward_name: 'Phường 1', ward_name_v3: 'Phường Giá Rai', street_name: 'Cầu Trần Văn Sớm', list_time: 1793423789000, is_price_not_valid: false,
    feature_params: compare('Đã có sổ', 'Đất nông nghiệp', 'Hẻm xe hơi'),
  },
];

describe('Chợ Tốt decoder (#38)', () => {
  it('maps a raw ad to a Listing', () => {
    const l = decodeChotot(ADS[0])!;
    expect(l).toMatchObject({
      id: 'chotot/135531248', source: 'chotot', lat: 20.768, lon: 106.2346, price: 1.5e9, size: 1533,
      width: 30, length: 50.11, landType: 'Đất nông nghiệp', legal: 'giay-tay', access: 'mat-tien', corner: false,
      shape: 'no-hau', ward: 'Xã Thanh Miện', street: '39b', time: 1793424060970, url: 'https://www.chotot.com/135531248.htm',
    });
    expect(l.pricePerM2).toBe(Math.round(1.5e9 / 1533));
    const l2 = decodeChotot(ADS[1])!;
    expect(l2.legal).toBe('so-rieng');
    expect(l2.landType).toBe('Đất thổ cư');
    expect(decodeChotot(ADS[2])!.access).toBe('hem-lon');
  });

  it('never copies seller fields or text', () => {
    const l = decodeChotot({ ...ADS[1], account_name: 'x', full_name: 'x', seller_info: { full_name: 'x' }, body: 'gọi 0901234567', images: ['a.jpg'] })!;
    expect(JSON.stringify(l)).not.toMatch(/full_name|account|seller|0901234567|jpg/);
  });

  it('falls back to labels for unknown codes', () => {
    const ad = { ...ADS[2], property_legal_document: 99, land_type: 99, pty_characteristics: [], feature_params: compare('Sổ hồng riêng', 'Đất thổ cư', 'Lô góc, Tóp hậu') };
    const l = decodeChotot(ad)!;
    expect(l.legal).toBe('so-rieng');
    expect(l.corner).toBe(true);
    expect(l.shape).toBe('top-hau');
    expect(l.access).toBe('unknown');
    expect(decodeChotot({ ...ADS[2], property_legal_document: undefined, feature_params: undefined })!.legal).toBe('unknown');
    expect(legalFromLabel('Sổ chung / công chứng vi bằng')).toBe('so-chung');
    expect(legalFromLabel('Đang chờ sổ')).toBe('cho-so');
    expect(legalFromLabel('Không có sổ')).toBe('giay-tay');
  });

  it('rejects ads without coordinates, price or size', () => {
    expect(decodeChotot({ ...ADS[0], latitude: undefined })).toBeNull();
    expect(decodeChotot({ ...ADS[0], price: 0 })).toBeNull();
    expect(decodeChotot({ ...ADS[0], size: undefined })).toBeNull();
    expect(decodeChotot({ ...ADS[0], is_price_not_valid: true })).toBeNull();
    expect(decodeChotot(null)).toBeNull();
  });

  it('builds gateway and proxy URLs', () => {
    const u = new URL(buildListingUrl({ region: 'hcm', limit: 50, offset: 100, area: 13096, wards: [9222, 9223] }));
    expect(u.origin + u.pathname).toBe('https://gateway.chotot.com/v1/public/ad-listing');
    expect(Object.fromEntries(u.searchParams)).toEqual({ cg: '1040', st: 's', region_v2: String(CHOTOT_REGIONS.hcm), area_v2: '13096', wards: '9222,9223', limit: '50', o: '100' });
    expect(buildListingUrl({ region: 'hn' }, 'https://p.example.dev/')).toBe('https://p.example.dev/?cg=1040&st=s&region_v2=12000&limit=50&o=0');
  });
});
