# Tiny Map: research on market data and valuation (2026-10-31)

Researcher: market-data subagent. Sandbox egress is US-based through the agent proxy. Tags used below:
- **[TESTED]**: verified with curl from the sandbox today.
- **[SOURCE]**: taken from a cited web page (secondary source, usually thuvienphapluat / luatvietnam / muaban blog).
- **[UNVERIFIED]**: inference, rule of thumb, or not checked against the original text.

Raw samples were kept only in the research session (not in the repo); `tests/land-chotot.test.ts` has PII-free fixtures.

---

## 0. TL;DR for a client-only app

| # | Source | Unauthenticated JSON | Coordinates | Price/m² | CORS for `danny-exnodes.github.io` | Recommendation |
|---|---|---|---|---|---|---|
| 1 | **Chợ Tốt Nhà** `gateway.chotot.com` | **Yes [TESTED]** | **Yes** (`latitude`/`longitude`) | **Yes** (`price_million_per_m2`) | **No [TESTED]**: allowlist echoes only its own origins (e.g. `https://www.nhatot.com`) | **Needs a proxy or a static snapshot.** Best data source. ToS risk is medium. |
| 2 | muaban.net | No JSON API. SSR `__NEXT_DATA__` in HTML [TESTED] | No (text `location` only) | No (price + area string) | No (HTML page) | Avoid / low value |
| 3 | homedy.com | No JSON API. HTML includes `"latitude"` [TESTED] | Yes (in HTML) | Derivable | No | Avoid (HTML scraping) |
| 4 | meeymap.com `apiv3.meeymap.com` | API exists, `ACAO: *`, but needs `client-id`/`meey-token` headers [TESTED, 403 "Bad request"] | Likely | Likely | `*` (tested) | Avoid (needs a private token, undocumented) |
| 5 | batdongsan.com.vn | No public API. **403 Cloudflare** [TESTED] | Map tiles internally | Listing pages show tr/m² | No | Avoid. Largest site, but ToS and anti-bot block it |
| 6 | alonhadat.com.vn | No API. **429** on first request [TESTED] | No | No | No | Avoid |
| 7 | guland.vn | No API. **403** [TESTED]. Planning map, not listings | n/a | n/a | No | Avoid |
| 8 | rever.vn / onehousing.vn | SPA, no public API found [TESTED, shallow] | ? | ? | ? | Avoid / [UNVERIFIED] |
| A | Anthropic Messages API | n/a | n/a | n/a | **Yes [TESTED]**: preflight returns `access-control-allow-origin: *` and allows header `anthropic-dangerous-direct-browser-access` | **Direct** (BYO key) |
| B | OpenAI Chat Completions | n/a | n/a | n/a | **Yes [TESTED]**: echoes our origin | Direct (BYO key) |
| C | Google Gemini `generativelanguage.googleapis.com` | n/a | n/a | n/a | **Yes [TESTED]**: echoes our origin for headers `content-type,x-goog-api-key` | Direct (BYO key) |
| G1 | Bảng giá đất HCMC (NQ 87/2025/NQ-HĐND) | **No machine-readable source found**. PDF of 1,262 pages | No (street segments as text) | Yes (VT1 per segment) | n/a | Parse offline once, ship as static JSON in `public/` |
| G2 | Bảng giá đất Hà Nội (NQ 52/2025/NQ-HĐND) | **No.** Scanned/signed PDFs (17 annexes) on `datafiles.hanoi.gov.vn` | No | Yes | n/a | Same as G1. The host is unreachable from the sandbox (connection reset, likely geo-block) |

**Recommended architecture (no backend):**
1. **Listings:** a scheduled **GitHub Action** (server-side, so CORS does not apply) calls the Chợ Tốt `ad-listing` endpoint for land (`cg=1040`) for each region at a low rate (for example daily, a few hundred requests). It keeps only aggregate or anonymised fields: id, lat/lon rounded to about 50 m, price, size, price/m², width, length, land_type, legal doc, list_time, ward. It commits `public/market/<region>.json` (or per-ward tiles), and Pages serves it. The browser then filters by distance to the selected parcel.
   - Option B: an optional, user-configured proxy URL (Cloudflare Worker template in docs) for live queries. The app stays client-only, and the user owns the proxy.
   - Drop seller name, phone, avatar and account ids (personal data, Nghị định 13/2023 on personal data protection).
   - Link out to the original ad (`https://www.nhatot.com/<list_id>.htm` [UNVERIFIED URL pattern]) rather than copying text and photos.
2. **Government prices:** parse the NQ 87/2025 (HCMC) and NQ 52/2025 (HN) PDFs offline into JSON (`{province, ward_new, street, from, to, vt1_dat_o, vt1_tmdv, vt1_sxkd}`). Geocode street segments against OSM ways, which the app already loads. Ship the result as a static asset.
3. **Valuation:** a deterministic estimator in TS (section 4). The LLM is an optional "explain / advise" layer only, called directly from the browser with the user's key.

---

## 1. Listing marketplaces

### 1.1 Chợ Tốt Nhà (nhatot.com), `gateway.chotot.com` **[TESTED]**

Endpoint (GET, no auth, JSON):
```
https://gateway.chotot.com/v1/public/ad-listing?cg=1040&region_v2=13000&area_v2=13096&wards=9222&st=s,k&limit=20&o=0
```
- `cg` category ids [TESTED]: **1000** = Bất động sản (all), **1040** = **Đất** (land), 1050 = apartment/room for rent (seen in results). Other sub-ids from public knowledge [UNVERIFIED]: 1010 căn hộ/chung cư, 1020 nhà ở, 1030 văn phòng/mặt bằng.
- `region_v2` [TESTED]: **13000 = TP Hồ Chí Minh** (total 3,286 land ads), **12000 = Hà Nội** (432 land ads). `area_v2` is district (13096 = Quận 1, 13116 = Củ Chi, 12082 = Đông Anh). `wards=<id>` filters by ward (worked); `ward=` did not.
- `price=1000000000-5000000000` and `size=50-100` range filters work [TESTED: 767 hits].
- `st=s,k`: s = bán (sell), k = cần mua/cho thuê; `type` field `s` [UNVERIFIED semantics of k].
- The `latitude=..&longitude=..&distance=..` geo filter returned 7 unrelated ads, so **no working radius filter was found** [TESTED]. Filter by ward or district, then compute distance on the client.
- `total` is capped at **10000** for broad queries, and `limit` is paged with `o` (offset).
- Region list: `https://gateway.chotot.com/v1/public/chapy-pro/regions` (legacy ids, e.g. `12`→Hà Nội with districts `73` Hoàn Kiếm …) [TESTED].

Sample fields (ad 179765403, trimmed) [TESTED]:
```json
{"ad_id":179765403,"list_id":135531248,"category":1040,"type":"s",
 "price":1500000000,"price_string":"1,5 tỷ","size":1533,"price_million_per_m2":0.978,
 "width":30,"length":50.11,"land_type":4,"property_legal_document":6,
 "region_v2":1004,"region_name":"Hải Dương","area_v2":100412,"area_name":"Huyện Thanh Miện",
 "ward":3856,"ward_name":"Xã Tứ Cường","street_name":"39b",
 "latitude":20.768013,"longitude":106.234566,"location":"20.7680136,106.2345633",
 "pty_characteristics":[1,5], "pty_map":"https://cdn.chotot.com/admincentre/location/10x965984_106x513448_c.jpg",
 "list_time":1793424060970,
 "feature_params":{"compare":{"items":[{"id":"property_legal_document","value":"Giấy tờ viết tay"},
   {"id":"land_type","value":"Đất nông nghiệp"},
   {"id":"pty_characteristics","value":"Mặt tiền, Nở hậu, Hẻm xe hơi, Chưa có thổ cư"}]}}}
```
Other keys present: `region_name_v3`, `ward_name_v3` (**post-merger names**, e.g. `ward_name`="Xã Tân Thông Hội" → `ward_name_v3`="Xã Củ Chi"; "Phường Phạm Ngũ Lão" → "Phường Bến Thành"), `street_name`, `streetnumber_display`, `pty_project_name`, `original_price`, `price_diff`, `is_price_not_valid`, `body` (free text), `subject`, `images`, and seller PII (`account_name`, `full_name`, `avatar`, `seller_info`). Do not store the PII fields.

Enum decoding from `feature_params` labels [TESTED for a few values only; the full mapping is UNVERIFIED]:
- `property_legal_document`: 1 = Đã có sổ (seen with sổ), 6 = Giấy tờ viết tay. Others are probably "Đang chờ sổ", "Không có sổ", "Sổ chung / công chứng vi bằng".
- `land_type`: 1 = Đất thổ cư (probable), 4 = Đất nông nghiệp. Others are probably dự án, công nghiệp.
- `pty_characteristics`: multi-select, e.g. Mặt tiền, Nở hậu, Hẻm xe hơi, Chưa có thổ cư, … These map directly to the valuation adjustments in section 4.

Data quality notes:
- `price_million_per_m2` is the asking price divided by `size`. Some ads are clearly wrong. For example, the Q1 ad "790,000,000 VND for 1,200 m²" gives 0.66 tr/m², and the price field sometimes holds a per-m² number. Use an IQR/MAD outlier filter and honour `is_price_not_valid`.
- Coordinates are user/geocoder supplied and are often snapped to the ward or street. Treat them as ±100–500 m [UNVERIFIED].
- Asking prices, not transaction prices.

CORS [TESTED]:
- `Origin: https://www.nhatot.com` → `access-control-allow-origin: https://www.nhatot.com`.
- `Origin: https://danny-exnodes.github.io` → **no ACAO header** (only `access-control-expose-headers`, `vary: Origin`). The preflight also returns no ACAO. **A browser fetch from GitHub Pages will be blocked.**

ToS / legal: robots.txt on www.nhatot.com sits behind a Cloudflare challenge (403) [TESTED]. I could not retrieve Chợ Tốt's "Quy định sử dụng" [UNVERIFIED]. Marketplace terms usually forbid automated collection and republication. Commercial scrapers (e.g. Bright Data) advertise Chợ Tốt datasets. **Risk: medium.** Keep requests low and cached, store aggregates plus links, credit the source, drop PII, and be ready to remove the source if asked. Update frequency: real time; ads appear minutes after posting (`date: "2 phút trước"`).

### 1.2 batdongsan.com.vn
- HTML listing pages: **403 Cloudflare** to curl [TESTED]. No public API. Pages show per-street "Lịch sử giá" (asking price/m² history, 1/2/5 years) and district ranges, e.g. Quận 2 land 62–608 tr/m² [SOURCE: search snippet of batdongsan.com.vn/ban-dat-quan-2]. ToS prohibits copying content [UNVERIFIED]. **Avoid** for automated use. A user can open a deep link from the app instead.

### 1.3 muaban.net
- `https://muaban.net/bat-dong-san/ban-dat` returns 200 with Next.js `__NEXT_DATA__` [TESTED]. Item fields: `id, city_id, district_id, category_id (33 đất), subcategory_id, price, price_display, location ("Phường 2, Quận Tân Bình, TP.HCM"), attributes[{value:"156 m²"}], publish_at, url, phone_enc`. **No coordinates.** robots.txt `Allow: /`. Low value: no geo, and many mis-categorised ads (an apartment listed under "Đất dự án").

### 1.4 homedy.com
- 200 HTML, robots `Allow: /` (blocks GPTBot/Ahrefs) [TESTED]. HTML contains `"latitude": 20.99…`. No JSON API found. Scraping HTML is fragile. Avoid.

### 1.5 meeymap.com (Meey Land)
- The frontend uses `https://apiv3.meeymap.com`, which returns `ACAO: *` but answers 403 `{"error":"Bad request"}` without the `client-id`/`meey-token` headers [TESTED]. Proprietary, so avoid.

### 1.6 alonhadat.com.vn: 429 rate limit on the first request [TESTED]. robots disallows only `/can-mua*`, `/can-thue*`, `/publish/*`. HTML only. Avoid.
### 1.7 guland.vn: 403 [TESTED]. A planning-map (quy hoạch) product, not a listing feed. Avoid.
### 1.8 rever.vn, onehousing.vn: 200 SPA shells. No public API host found in the HTML [TESTED, shallow]. [UNVERIFIED] Both are brokerages with curated inventory and no open API.

---

## 2. Government land price tables (bảng giá đất), 2026

Legal frame [SOURCE]:
- **Luật Đất đai 2024** (31/2024/QH15) originally required provinces to issue the first new table from **01/01/2026** and adjust it annually.
- **Nghị quyết 254/2025/QH15** (effective 01/01/2026), Điều 7 khoản 3: the **HĐND cấp tỉnh** (provincial council), not the UBND, decides the table and may amend it when needed. So the 2026 tables are **Nghị quyết HĐND**, not "Quyết định UBND".
- Giá đất methodology: **Nghị định 71/2024/NĐ-CP** (effective 01/8/2024), amended by **Nghị định 226/2025/NĐ-CP** (15/8/2025). These cover the comparison, income, residual and hệ số điều chỉnh methods.

### 2.1 TP.HCM (merged HCMC + Bình Dương + Bà Rịa–Vũng Tàu)
- **Nghị quyết 87/2025/NQ-HĐND**, dated 26/12/2025, effective **01/01/2026** [SOURCE: luatvietnam, muaban blog]. It replaces QĐ 79/2024/QĐ-UBND (31/10/2024–31/12/2025).
- PDF of **1,262 pages**. VT1 đất ở by street segment is in Phụ lục II (pp. 18–560, ex-HCMC), III (561–1002, ex-Bình Dương?) and IV (1003–1260, ex-BR-VT?). Annex-to-area mapping [UNVERIFIED].
- Highest price: **687.2 tr/m²** (Đồng Khởi, Lê Lợi, Nguyễn Huệ, phường Sài Gòn/Bến Thành). Ex-BR-VT max is Thùy Vân at 149.48 tr/m²; ex-Bình Dương max is Bác Sĩ Yersin at 89.6 tr/m² [SOURCE: muaban blog].
- VT2–VT4 (hẻm): expressed as a **% of VT1 by alley width**. The exact 2026 ratios are **[UNVERIFIED]**. The prior regime (QĐ 02/2020 & 79/2024) used VT2 hẻm ≥ 5 m = 0.5×VT1, VT3 hẻm 3–<5 m = 0.4, VT4 hẻm < 3 m = 0.3, hẻm cấp sau −10%, and depth ≥ 100 m from the frontage −10% [UNVERIFIED for 2026; the draft NQ text quoted "độ sâu ≥ 100 m … giảm 10% của từng vị trí" (SOURCE: thuvienphapluat, draft)]. **Read the "Quy định" part of NQ 87/2025 before coding these.**
- Follow-up docs: QĐ 2940/QĐ-UBND (28/11/2025, appraisal council), Công văn 454/UBND-ĐT (21/01/2026, implementation). The **hệ số điều chỉnh giá đất 2026** for HCMC is being proposed [SOURCE: thuvienphapluat "Đề xuất hệ số điều chỉnh giá đất năm 2026 tại TPHCM"].

### 2.2 Hà Nội
- **Nghị quyết 52/2025/NQ-HĐND**, passed 26/11/2025, effective **01/01/2026** [SOURCE]. It supersedes QĐ 71/2024/QĐ-UBND (which applied to 31/12/2025).
- Structure: 17 **khu vực** (Phụ lục 01–17), 4 **vị trí** for đất ở / TMDV / SXKD. VT1 is a parcel with at least one side on a street or ngõ named in the table. VT2–4 are defined by the **mặt cắt ngõ** (alley cross-section) leading to the parcel (Điều 3 khoản 2) [SOURCE]. The exact thresholds are **[UNVERIFIED]**. The old QĐ 30/2019 & 71/2024 used VT2 = ngõ ≥ 3.5 m, VT3 = 2–3.5 m, VT4 = < 2 m, with each VT carrying its own price column (not a fixed ratio).
- Highest price: **702.194 tr/m²** (Hàng Ngang, Bà Triệu đoạn Hàng Khay–Trần Hưng Đạo, Hai Bà Trưng đoạn Lê Thánh Tông–Quán Sứ, Lý Thường Kiệt) [SOURCE: muaban blog].
- Official gazette PDFs: `https://datafiles.hanoi.gov.vn/gov-hni/6249/VanBanCongBao/2026/2/5/NQPQ-52-2025-{2,3}_signed.pdf`. From the sandbox the connection is **reset** (proxy log `ws_closed_mid_exchange`, likely a VN geo-restriction) [TESTED]. Reportedly scanned images, so OCR is needed [SOURCE].

### 2.3 Machine-readable sources
- **None found** for either city (GitHub / HuggingFace search) [SOURCE: search]. Aggregators (thuvienphapluat.vn, thuviennhadat.vn, luatvietnam) host PDF/Excel copies and per-ward pages, but 403 to our fetcher and copyright the compilation. The tables themselves are legal documents (văn bản QPPL are not subject to copyright under Luật SHTT Điều 15), so parsing the **official** PDF is the clean route.
- Plan: download from the gov portals (from a VN IP or manually), run `pdftotext -layout` (HCMC is text-based? [UNVERIFIED]) or OCR (Hà Nội scans), build a CSV, and review it by hand on a sample. That is a one-time job of roughly 2–4 dev-days per city. Update yearly, or when HĐND amends the table.

### 2.4 Administrative merger (affects keys and matching)
- From **01/07/2025**: **34 provinces** (28 tỉnh + 6 TP) and **3,321 xã/phường/đặc khu**. **District level abolished.** Codes are in **QĐ 19/2025/QĐ-TTg** (30/6/2025), e.g. Hà Nội = 01 [SOURCE: lsvn, thuvienphapluat]. Legal basis: NQ 202/2025/QH15.
- The 2026 price tables are keyed by **new ward + street segment**. Chợ Tốt still exposes **old** region/district/ward (`region_name` "Hải Dương", now part of Hải Phòng) alongside `*_v3` new names [TESTED]. The app needs an old→new ward crosswalk. Prefer a point-in-polygon test of lat/lon against new ward boundaries, if a boundary dataset is available (separate research item).

---

## 3. Market price indices and reports (fallback priors)

| Source | Content | Machine-readable? | Use |
|---|---|---|---|
| batdongsan.com.vn "Lịch sử giá" / market reports | Asking price/m² by district/street, 1–5 y history | No (Cloudflare, HTML/charts) [TESTED 403] | Manual reference only |
| Savills VN, CBRE VN, DKRA, JLL, Cushman | Quarterly reports, mostly **primary market** apartments, landed projects, land-plot (đất nền) supply/absorption in HCMC/HN and the south | PDFs or press releases only [UNVERIFIED: no API] | Hand-curated citywide trend factors |
| Hội Môi giới BĐS VN (VARS) | Quarterly market reports | PDF [UNVERIFIED] | Same |
| **Chợ Tốt snapshot (self-built)** | Median asking tr/m² per new ward, land type and month, from section 1.1 | **Yes** (our own JSON) | **Recommended prior**: ward median, shrunk toward the district/province median when n is small |

Recommended prior: `prior(ward) = (n·median_ward + k·median_parent)/(n + k)` with k ≈ 10 (empirical-Bayes shrinkage) [proposal].

---

## 4. Valuation methodology → deterministic estimator

### 4.1 Legal and professional basis [SOURCE]
- **Thẩm định giá (private appraisal):** Luật Giá 2023 (16/2023/QH15) and the **Chuẩn mực thẩm định giá VN** issued 2024: TT 30/2024 (ethics, scope, basis), TT 31/2024 (information collection), TT 32/2024 (approaches: thị trường, chi phí, thu nhập), **TT 42/2024/TT-BTC** (real estate, effective 05/8/2024). TT 42 **does not apply to state land pricing**.
  - Approaches: **so sánh** (market), **thu nhập** (income: direct capitalisation / DCF), **chi phí** (cost), **thặng dư** (residual/development, mainly for land with development potential).
  - Rules for the comparison method, from the general standard; the 2024 details are paraphrased and [UNVERIFIED on exact wording]:
    - Use at least 3 comparables, preferably transacted or offered within the recent period.
    - Adjust each for differences in comparison factors (legal status, location, physical traits, transaction terms, time) using percentages or absolute amounts.
    - Weight the indicated values so that fewer and smaller **gross** adjustments get more weight.
    - Keep adjusted values within a reasonable spread.
- **Định giá đất (state):** NĐ 71/2024 (+ NĐ 226/2025). Five methods: so sánh, thu nhập, thặng dư, **hệ số điều chỉnh giá đất** (= bảng giá × K), and the latter's derivatives. Factors for non-agricultural land: vị trí/địa điểm, giao thông (road width, surface, number of frontages), cấp thoát nước/điện, **diện tích, kích thước, hình thể**, môi trường/an ninh, quy hoạch, thời hạn sử dụng, and so on. Annex II has worked examples. Provinces set their own adjustment percentages; e.g. Quảng Bình gives +20% for parcels on 2 or more roads [SOURCE].
- **Hệ số K** (hệ số điều chỉnh giá đất): issued by the province **yearly**, applied to bảng giá đất to compute land-use fees, land rent and similar charges. 2026 HCMC values are under proposal [SOURCE]. Treat K as a **state fee factor, not a market estimate**. The market/bảng-giá ratio is a separate empirical quantity.

### 4.2 Proposed estimator (all coefficients are **defaults to calibrate**, not legal values)

Inputs for the subject parcel: lat/lon, area A, frontage width W, depth L, access (mặt tiền đường / hẻm width w_h / hẻm cấp n), shape (vuông, nở hậu, tóp hậu, méo), legal status, land type, corner (2 mặt tiền), distance from the main road d.

**Method 1: Comparable sales (primary, needs ≥ 3 comps within R ≤ 1–2 km and ≤ 12 months)**
```
for each comp i:
  p_i   = price_i / size_i                         # asking VND/m²
  p_i  *= (1 - δ_ask)                              # asking→transaction discount, δ_ask = 0.08 (range 0.05–0.15) [heuristic, UNVERIFIED]
  p_i  *= (1 + g)^(Δmonths/12)                     # time adjustment, g from the ward snapshot trend (0 if unknown)
  adj_i = Π_f (1 + a_f(subject) - a_f(comp_i))     # multiplicative factor adjustments, table below
  v_i   = p_i * adj_i
  gross_i = Σ_f |a_f(subject) - a_f(comp_i)|
  w_i   = 1 / (gross_i + 0.05) * exp(-dist_i/500m)  # fewer/smaller adjustments + nearer = more weight
reject comps with gross_i > 0.5 or v_i outside median ± 3·MAD
V_cmp = Σ w_i v_i / Σ w_i  (VND/m²);  range = weighted P25–P75
```

Factor table a_f. Each value is an offset relative to the baseline "đất ở, mặt tiền đường ≥ 8 m, vuông vức, 50–100 m², sổ hồng riêng". Sources are mixed: old HCMC/HN table ratios plus common appraisal practice. **All [UNVERIFIED defaults]**.

| Factor | Level | a_f |
|---|---|---|
| Access (vị trí) | Mặt tiền đường chính | 0 |
| | Hẻm/ngõ ô tô ≥ 5 m (HN ≥ 3.5 m) | −0.30 |
| | Hẻm 3–5 m (HN 2–3.5 m) | −0.45 |
| | Hẻm < 3 m (HN < 2 m) | −0.55 |
| | Hẻm cấp 2+ (each extra level) | −0.05 |
| | Depth from main road > 100 m | −0.05 |
| Corner / 2 mặt tiền | yes | +0.10 (provincial practice up to +0.20) |
| Frontage width W | < 3 m | −0.10 |
| | 3–4 m | −0.05 |
| | 4–8 m | 0 |
| | > 8 m | +0.03 |
| Shape | Vuông vức (L/W 2–5) | 0 |
| | Nở hậu | +0.03 |
| | Tóp hậu | −0.07 |
| | Méo / đa giác / L/W > 6 | −0.10 |
| Area A (per-m² size effect) | < 30 m² | +0.05 (small lots trade higher per m² in cities) |
| | 30–150 m² | 0 |
| | 150–500 m² | −0.05 |
| | > 500 m² | −0.15 |
| Legal (pháp lý) | Sổ hồng/sổ đỏ riêng, thổ cư | 0 |
| | Sổ chung / đồng sở hữu | −0.15 |
| | Đang chờ sổ | −0.15 |
| | Giấy tay / vi bằng | −0.30 |
| Land type | Đất ở (ODT/ONT) | 0 |
| | Đất ở một phần + nông nghiệp | −0.20 to −0.40 (by % thổ cư) |
| | Đất nông nghiệp (CLN/LUA) | −0.60 to −0.80 |
| | Đất dự án / phân lô chưa sổ | −0.10 |
| Planning (quy hoạch) | Inside road-widening / lộ giới | −0.15 to −0.40 (proportional to the affected area) |

Use multiplicative composition, not additive, so that large discounts do not go negative. Clamp `adj_i` to [0.3, 2.0].

**Method 2: Government table × market ratio (fallback when comps are fewer than 3)**
```
P_table = VT1(street segment) × r_VT × (1 - 0.10·[depth ≥ 100 m])     # r_VT from NQ 87/2025 or NQ 52/2025, see §2
P_mkt   = P_table × M(ward)                                         # M = median(listing price/m² ÷ matched VT1) in ward/district from the snapshot
```
`M` is empirical; expect about 1.5–5× in HCMC/HN cores [UNVERIFIED]. Fall back to the district/province median when the ward has n < 10 matched listings. Report P_table separately as "giá nhà nước (để tính thuế/phí)". The fee calculation proper multiplies by **K** for land-use fees, which is a different purpose.

**Method 3: Ward prior (last resort)**: shrunk ward median (§3), adjusted by the same factor table relative to a "typical" lot.

**Reconciliation**
```
V = Σ_m c_m V_m / Σ c_m,  c_cmp = min(1, n_comps/5)·(1 - CV_comps), c_tbl = 0.3, c_prior = 0.2
confidence = high if n_comps ≥ 5 and CV < 0.25; medium if n ≥ 3; else low
```
Show the range, method weights and every adjustment in the UI. Investor advice should state clearly that the result is not a chứng thư thẩm định giá. Under Luật Giá, valuation certificates may only be issued by licensed appraisers.

Income and residual methods: optional. Income needs rental data (Chợ Tốt `cg=1000` with `st=u`/rent ads [UNVERIFIED param]) and cap rates of about 3–5% for urban land/houses [UNVERIFIED]. Residual needs FAR/coverage from quy hoạch, which is out of scope for v1.

---

## 5. LLM from the browser (BYO key)

- **Anthropic** [TESTED preflight, docs via SOURCE]: an OPTIONS request to `https://api.anthropic.com/v1/messages` from Origin `https://danny-exnodes.github.io` returned `access-control-allow-origin: *`, `allow-headers: x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access, content-type, authorization`, `max-age 600`. The browser must send **`anthropic-dangerous-direct-browser-access: true`** (CORS opt-in added Aug 2024; Simon Willison). Without it, CORS requests get 401. In the JS SDK, the equivalent is `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })`. Intended for BYO-key apps. Keep the key in memory or `sessionStorage` (opt-in localStorage), never in the repo or URL, and add a CSP that restricts `connect-src`.
- **OpenAI** [TESTED preflight]: echoes the origin, allows `authorization`.
- **Gemini** [TESTED preflight]: echoes the origin for `content-type, x-goog-api-key`. Sending other non-allowed request headers makes the preflight return 403.
- Suggested pattern: the deterministic estimator produces a JSON "valuation dossier" (comps, adjustments, table price, confidence). The LLM gets only that dossier (no PII) and writes Vietnamese investor commentary with structured output (risks: pháp lý, quy hoạch, thanh khoản, giá chào vs. giao dịch). The prompt must forbid inventing numbers that are not in the dossier.

---

## 6. Open items / to verify before coding
1. The exact VT2–VT4 ratios and depth rules in **NQ 87/2025** (HCMC) and **NQ 52/2025 Điều 3** (HN). Needs the official text, which cannot be reached from the sandbox.
2. Chợ Tốt enum tables (`land_type`, `property_legal_document`, `pty_characteristics`), and whether a real geo-radius parameter exists.
3. Chợ Tốt ToS text on automated access. Consider emailing them for permission or a partnership.
4. A dataset of new (post-2025) ward boundaries for point-in-polygon.
5. Calibrate δ_ask and the factor table on a sample with known transaction prices (none freely available, so expert review is needed).

## Sources
- Chợ Tốt API, live tests (this session): `gateway.chotot.com/v1/public/ad-listing`, `/v1/public/chapy-pro/regions`
- HCMC NQ 87/2025: https://luatvietnam.vn/dat-dai/nghi-quyet-87-2025-nq-hdnd-tp-hcm-2025-bang-gia-dat-ap-dung-tu-01-01-2026-422935-d2.html ; https://muaban.net/blog/bang-gia-dat-tphcm-616919/ ; https://thuvienphapluat.vn/phap-luat-nha-dat/toan-bo-bang-gia-dat-o-tai-tphcm-2026-ra-sao-theo-de-xuat-moi-nhat-12310.html ; https://thuvienphapluat.vn/phap-luat-nha-dat/de-xuat-he-so-dieu-chinh-gia-dat-nam-2026-tai-tphcm-chi-tiet-the-nao-17140.html
- Hà Nội NQ 52/2025: https://muaban.net/blog/bang-gia-dat-ha-noi-2026-616910/ ; https://thuvienphapluat.vn/phap-luat-nha-dat/nghi-quyet-522025nqhdnd-bang-gia-dat-tai-ha-noi-co-hieu-luc-khi-nao-12302.html ; https://datafiles.hanoi.gov.vn/gov-hni/6249/VanBanCongBao/2026/2/5/NQPQ-52-2025-3_signed.pdf
- NĐ 71/2024 & NĐ 226/2025: https://thuvienphapluat.vn/van-ban/Bat-dong-san/Nghi-dinh-71-2024-ND-CP-quy-dinh-gia-dat-599145.aspx ; https://lsvn.vn/quy-dinh-moi-ve-trinh-tu-xac-dinh-gia-dat-theo-phuong-phap-so-sanh-a162065
- TT 42/2024/TT-BTC: https://luatvietnam.vn/tai-chinh/thong-tu-42-2024-tt-btc-chuan-muc-tham-dinh-gia-viet-nam-ve-tham-dinh-gia-bat-dong-san-355389-d1.html ; https://tapchicongthuong.vn/cac-cach-tiep-can-va-phuong-phap-tham-dinh-gia-bat-dong-san-tu-ngay-5-8-2024-122726.htm
- Merger / QĐ 19/2025/QĐ-TTg: https://lsvn.vn/danh-muc-va-ma-so-cua-34-tinh-thanh-moi-a160079 ; https://en.wikipedia.org/wiki/2025_Vietnamese_administrative_reforms
- Anthropic CORS: https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access
- Batdongsan district ranges (snippet): https://batdongsan.com.vn/ban-dat-quan-2/p25
