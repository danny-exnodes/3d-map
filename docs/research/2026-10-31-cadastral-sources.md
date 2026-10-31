# Vietnamese cadastral and land-use data sources for Tiny Map: research report

Date: 2026-10-31. Researcher: Claude (data-research subagent).
Scope: public, machine-readable sources of land parcels (thửa đất), land-use type (loại đất) and dimensions that a **client-side-only** app on GitHub Pages can use.
Method: web search, WebFetch, and `curl -m 20` from the cloud sandbox through the agent proxy, with no more than 3 requests per host. The test origin header was `Origin: https://danny-exnodes.github.io`.

> **Bottom line:** No official or commercial source we found exposes Vietnamese cadastral parcels (số tờ / số thửa / loại đất / diện tích) as a public, documented, CORS-enabled API. The national land database (CSDL quốc gia về đất đai) and provincial VBDLIS/iLIS systems sit behind logins. They are shared only by API between state agencies, or per-parcel against a fee (45,000 đ/thửa, TT 56/2024/TT-BTC). Portals for the public, such as TP.HCM ttqh, Hà Nội quyhoach / qhkhsdd and Đà Nẵng GIS, are web viewers. They have undocumented internal APIs and reference-only disclaimers, and most cannot be reached from outside Vietnam. Commercial aggregators (Guland, Meey Map, batdongsan) explicitly forbid scraping or automated extraction, or offer only contract-based enterprise APIs.
> **What a client-side app can legally do today:** (a) take parcel geometry that the user supplies (VN2000 corner coordinates from the sổ đỏ, or a GeoJSON/DXF/SHP file from a trích lục) and compute area, edge lengths and frontage locally; (b) let the user pick the loại đất from the official code table below; (c) add context from open land-cover and land-use data (OSM/OpenFreeMap `landuse`, Overture `land_use`, ESA WorldCover / Esri-IO LULC via Planetary Computer). None of these open sources is cadastral.

---

## 1. Ranked sources

Legend: ✅ verified from the sandbox · ⚠️ partly verified · ❌ not reachable or not verified · CORS = `Access-Control-Allow-Origin` present for our origin.

### Tier A: usable directly from the browser (open licence, CORS OK). These are not cadastral.

| # | Source | Endpoint (tested) | What it gives | Update freq. | Licence | CORS | Sandbox test |
|---|---|---|---|---|---|---|---|
| A1 | **OpenFreeMap vector tiles (OSM, OpenMapTiles schema)**, already used by the app | `https://tiles.openfreemap.org/planet` → `…/planet/20261025_080012_pt/{z}/{x}/{y}.pbf` | `landuse` layer (`class`: residential, commercial, industrial, retail, cemetery, school, hospital…), `landcover` (farmland, grass, wood…), `park`. Polygons, not parcels. | Weekly planet builds (current build is 2026-10-25) | ODbL (OSM) | ✅ `*` | ✅ 200. A z14 tile over Hoàn Kiếm (13009/7212, 93 KB) contains a `landuse` layer with `class`/`subclass` keys |
| A2 | **Overture Maps `base/land_use`, `land_cover`** (STAC and PMTiles), already used by the app | `https://stac.overturemaps.org/catalog.json` (latest release `2026-10-21.0`); `https://tiles.overturemaps.org/…` | OSM-derived land-use polygons (`subtype`/`class`: residential, agriculture, …) and ESA-derived land cover | Monthly releases | ODbL (land_use), CC-BY (land_cover) | ✅ `*` | ✅ catalog 200. Tiles bucket root returns 404 but sends CORS headers (normal for S3 root) |
| A3 | **OSM API v0.6 / Overpass** for `landuse=*` and `building=*` | `https://www.openstreetmap.org/api/0.6/map?bbox=…` | Raw OSM features, including `landuse=residential/farmland/paddy…`. Coverage in VN is uneven: cities are fairly good, rural areas are sparse. Paddy rice is often `landuse=farmland` + `crop=rice`. | Minutely | ODbL | ✅ echoes origin | ✅ 200 on API v0.6. **Overpass is blocked from the sandbox** (known; mock it with Playwright). The OSM API usage policy forbids bulk or heavy reads, so use tiles/Overture for display. |
| A4 | **Microsoft Planetary Computer STAC**: `esa-worldcover` (10 m, 2020/2021) and `io-lulc-annual-v02` (Esri/Impact Observatory 10 m annual LULC) | `https://planetarycomputer.microsoft.com/api/stac/v1/collections/esa-worldcover` (+ `/api/data/v1/…` tiler) | Raster land-cover classes (tree, crop, built-up, water…) | WorldCover is static (2021). IO-LULC is yearly. | CC-BY-4.0 | ✅ `*` | ✅ 200, licence `CC-BY-4.0`, temporal extent 2020–2021 |
| A5 | **Sentinel-2 L2A (Earth Search / AWS)**, for "near real time" imagery | `https://earth-search.aws.element84.com/v1/collections/sentinel-2-c1-l2a` | 10 m imagery every ~5 days. NDVI and similar can be computed client-side with `geotiff` (already in node_modules). | ~5-day revisit | Copernicus open | ✅ `*` | ✅ 200 |
| A6 | EOX Sentinel-2 cloudless WMTS (already used) | `https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml` | Imagery basemap | Yearly mosaic | CC-BY-NC-SA (s2cloudless) | ✅ | ✅ 200 |
| A7 | ESA WorldCover COGs on S3 (direct) | `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N21E105_Map.tif` | Same data as A4 | static | CC-BY-4.0 | ❌ **no CORS header** | ✅ 206 Range OK. Use A4 in the browser instead. |
| A8 | Dynamic World (Google, near-real-time 10 m land cover) | Earth Engine only | 9 land-cover class probabilities for each Sentinel-2 scene | ~daily | CC-BY-4.0 | ❌ needs a GEE account/OAuth | not tested (needs auth) |
| A9 | HDX (humdata.org) | `https://data.humdata.org/api/3/action/package_search?q=vietnam%20land%20use` | 3,056 hits, but **no parcel dataset**: FAOSTAT land inputs, HOT OSM exports (roads, buildings, waterways) | varies | mostly ODbL / CC-BY | ✅ `*` | ✅ 200 |

### Tier B: official government systems (authoritative, but closed to us)

| # | Source | Endpoint | Status | Notes |
|---|---|---|---|---|
| B1 | **CSDL quốc gia về đất đai / Hệ thống thông tin quốc gia về đất đai** (Bộ Nông nghiệp và Môi trường, Cục Quản lý đất đai). Governed by QĐ 11/2026/QĐ-TTg (effective 19/5/2026), NĐ 101/2024/NĐ-CP Art. 54–62, and QĐ 441/QĐ-BNNMT (2026, guidance on sharing GCN data via API) | No public URL confirmed. The "Cổng thông tin quốc gia về đất đai" is reported to publish since 15/8/2025. Requests go via Cổng DVC quốc gia (`dichvucong.gov.vn`). | ❌ `dichvucong.gov.vn`, `mae.gov.vn`, `dichvucong.mae.gov.vn`, `dangkydatdai.gov.vn` all fail from the sandbox (proxy CONNECT 502 / no response, probably upstream or geo-blocking) | API sharing is **for state agencies only** (NĐ 278/2025, NĐ 101 Art. 54). Citizens and businesses request data per parcel, with a fee: 45,000 đ/thửa for full information (TT 56/2024/TT-BTC). Personal data falls under Luật BVDLCN 91/2025/QH15. ~67.5 M parcels (≈67%) were digitised by 29/6/2026, with a completion target of 12/2026. **Not usable by a public client-side app.** |
| B2 | **VBDLIS** (Vietbando's provincial land information system; HCM instance) | `https://hcm.mplis.gov.vn/` → `/dc` → `302 /dc/Account/Login` (`www-authenticate: Bearer`) | ✅ reachable, **login required** | Internal system for land offices. No public API. |
| B3 | iLIS (`ilis.vn`) | `https://ilis.vn/` | ❌ CONNECT 502 from sandbox | Same category as VBDLIS (internal). Not verified. |
| B4 | **TP.HCM: Thông tin quy hoạch** (Sở Quy hoạch-Kiến trúc, built by Vlab) | `https://thongtinquyhoach.hochiminhcity.gov.vn/` | ⚠️ HTTP→302→HTTPS, then **connection reset** from the sandbox. WebFetch (outside network) got the page. | Shows 1/2000 zoning **land-use plan** (not the cadastral register), with search by VN2000 coordinates, số tờ / số thửa, or street. The page names no API, WMS or ArcGIS URL. Disclaimer: "chỉ mang tính tham khảo". No ToS page found. The internal API is undocumented and **not verified**. Mobile app `tech.vlab.ttqhhcm`. Since 7/2025 TP.HCM includes former Bình Dương and Bà Rịa–Vũng Tàu; coverage of those areas is not verified. |
| B5 | TP.HCM: `sqhkt-qlqh.tphcm.gov.vn` | `302 → /dang-nhap` | ✅ reachable, **login required** | Internal planning management. |
| B6 | TP.HCM: GIS xây dựng (`gisxaydung.tphcm.gov.vn`) | `https://gisxaydung.tphcm.gov.vn/` | ✅ reachable, **HTTP 403** | Planning GIS portal (2025). Blocked for us. Not verified further. |
| B7 | **Hà Nội: quyhoach.hanoi.vn** (Sở Quy hoạch-Kiến trúc) | `https://quyhoach.hanoi.vn/` | ✅ reachable, **HTTP 403** (LiteSpeed, also blocked for WebFetch) | Urban planning lookup. Pilot software reported 30/6/2026. No API docs found. |
| B8 | Hà Nội: qhkhsdd.hanoi.gov.vn (Sở NN&MT, land-use plan 2025) | `http://qhkhsdd.hanoi.gov.vn/` → 404, HTTPS → no response | ❌ | Land-use **plan** (kế hoạch sử dụng đất) viewer. Not verified. |
| B9 | Đà Nẵng: dananggis.danang.gov.vn / gis.danang.gov.vn / dcgis.vn / qhdt.danang.gov.vn | — | ❌ all CONNECT 502 / no response | Reports say it provides planning 1/500–1/10,000 "miễn phí" through a GIS viewer. API not verified. |
| B10 | Đồng Nai (gisdongnai.vn, bandoquyhoach.dongnai.gov.vn) | — | ❌ no response | Not verified. Note the 2025 merger with Bình Phước. |
| B11 | National: quyhoach.xaydung.gov.vn (Bộ Xây dựng), quyhoachquocgia.mpi.gov.vn | — | ❌ no response | Construction/urban planning and national master plan; not parcels. |
| B12 | **vnsdi.mae.gov.vn** (Cổng thông tin không gian địa lý Việt Nam, Cục Đo đạc, Bản đồ & TTĐL) | `https://vnsdi.mae.gov.vn/` (Angular + ArcGIS JS 3.40) → backend `https://dosm.vnsdi.gov.vn/portal`, `…/apiportal/api/Values` | ✅ page 200. Backend `…/portal/sharing/rest/search` → **HTTP 500** "Could not access any ArcGIS Enterprise portal machines" | Topographic/basemap NSDI, not cadastre. Uses ArcGIS tokens (reCAPTCHA on page). Currently broken. |
| B13 | data.gov.vn (Cổng dữ liệu quốc gia) | `https://data.gov.vn/` | ❌ CONNECT 502 | No parcel dataset was found in search results. Not verified. |

Note on reachability: many `*.gov.vn` hosts return CONNECT 502 or reset the connection from the sandbox. This looks like geo-blocking of non-VN egress or upstream failure, not a proxy policy decision. A user's browser inside Vietnam might reach them. Even so, **none sends CORS headers that we could observe**, and none documents a public API.

### Tier C: commercial aggregators (do NOT scrape)

| # | Source | Test | API? | ToS (scraping) |
|---|---|---|---|---|
| C1 | **Guland** (guland.vn) | ✅ 403, Cloudflare challenge (`cf-mitigated: challenge`, `cross-origin-resource-policy: same-origin`) | None public | Its "Điều khoản thỏa thuận" (per search snippet; the page itself returns 403 to us) **forbids bots, crawlers, scrapers and automated tools, and bulk collection, plus copying, storing or redistributing Guland data without authorisation.** Guland buys or compiles its plan files. **Must not be used.** |
| C2 | **Meey Map** (meeymap.com) | ✅ 200. `api.meeymap.com` → 522 | "Đấu nối API" is an enterprise offer behind "Liên hệ tư vấn" (no docs) | ToS (`help-center.meeymap.com/dieu-khoan-su-dung-meey-map`) defers to "Quy chế hoạt động" (not read). Data is reference-only, with a Google Maps basemap. **Possible paid B2B partner only.** |
| C3 | batdongsan.com.vn "bản đồ quy hoạch" | ✅ 403 | None | Not read. Treat as prohibited. |
| C4 | Other "kiểm tra quy hoạch" apps (QH TP.HCM, QH Đà Nẵng, DeeMap, Bản đồ Quy hoạch VN…) | not tested | None public | They redistribute provincial plan maps. Do not use. |
| C5 | Vietmap Maps API | ✅ 301 → maps.vietmap.vn | Tiles, geocode, routing (API key) | No land-use or parcel API. Not useful here. |

---

## 2. Data fields we would want, and where they could come from

| Field | Authoritative holder | Obtainable by our app? |
|---|---|---|
| Số tờ, số thửa, mã thửa (12 ký tự, TT 19/2026/TT-BNNMT) | CSDL đất đai / VBDLIS | Only if the user types it (from the sổ đỏ) |
| Loại đất (mục đích sử dụng) | CSDL đất đai; sổ đỏ | User picks it from the code table; OSM/Overture class can serve as a hint |
| Diện tích (m²) | Sổ đỏ / trích lục | **Compute** from geometry (geodesic area, or planar in VN2000 TM-3°) |
| Cạnh, mặt tiền, chiều sâu | Sổ đỏ (bảng tọa độ góc ranh VN2000), trích lục | **Compute**: edge lengths from vertices. Frontage = edge(s) adjacent or nearest to an OSM road (OpenFreeMap `transportation` layer). Depth = max distance from the frontage line. |
| Quy hoạch (planned use) | Provincial planning portals | No (closed). Link out to the official portal for the clicked point instead. |

VN2000 → WGS84: use proj4 with the province's central meridian (TM 3°, k = 0.9999, +towgs84 = -191.90441429,-39.30318279,-111.45032835,-0.00928836,0.01975479,-0.00427372,0.252906278). The per-province meridian table is in TT 973/2001/TT-TCĐC (not re-verified in this session). This lets a user paste the coordinate table from the sổ đỏ.

---

## 3. Recommendation for a client-side-only app

1. **Directly from the browser (allowed):**
   - OpenFreeMap tiles `landuse` / `landcover` / `transportation` layers (already integrated, CORS `*`, ODbL attribution).
   - Overture `land_use` / `land_cover` PMTiles or GeoParquet (CORS `*`).
   - Planetary Computer STAC and tiler for ESA WorldCover / IO-LULC (CORS `*`, CC-BY-4.0).
   - Sentinel-2 via Earth Search STAC plus COG range reads (CORS `*`) for a "recent imagery / NDVI" overlay. This is the only "near-real-time" open option, and it is land **cover**, not land **use**.
   - Present all of these as **"lớp phủ / sử dụng đất tham khảo (OSM/Overture)"**, never as "loại đất pháp lý".
2. **User-supplied data (recommended core of the feature):**
   - Input VN2000 corner coordinates (paste a table from the sổ đỏ), or import GeoJSON / KML / DXF / SHP (zip) from a trích lục bản đồ địa chính.
   - The user selects the province, so the app knows the central meridian.
   - The user enters số tờ / số thửa / loại đất (dropdown from §4).
   - The app computes area, perimeter, each edge length, frontage and depth, and draws the parcel on the map and in 3D.
3. **Needs a user-supplied proxy (optional, advanced, legal only if the portal allows it):** a provincial portal that the user is entitled to use could be wired through a proxy URL the user configures, in the same way the app takes the user's Google key today. We could **not** verify any such endpoint or its terms, so do not ship a default. At most, ship a "Mở cổng quy hoạch chính thức" deep link (ttqh HCM / quyhoach.hanoi.vn / dananggis) at the selected coordinates.
4. **Must NOT be used:** Guland, Meey Map (unless there is a signed contract), batdongsan, and any "kiểm tra quy hoạch" app tiles or APIs. Their ToS forbid scraping, and they sit behind Cloudflare or anti-bot protection. Also do not reverse-engineer internal APIs of gov portals (VBDLIS, ttqh, quyhoach.hanoi.vn). They are undocumented, carry reference-only disclaimers, and land-owner data is personal data under Luật 91/2025/QH15.

---

## 4. Land-use code table (Luật Đất đai 2024, Điều 9; Thông tư 08/2024/TT-BTNMT, Phụ lục II mục A; effective 01/08/2024)

Source: luatvietnam.vn transcription of TT 08/2024 Phụ lục II mục A. Partly cross-checked against hethongphapluat.com and the thuvienphapluat search snippets (LUC/LUK/CLN/ONT/ODT match). The original Công báo PDF was **not** fetched (thuvienphapluat and luatminhkhue return 403 to us). Check against the gazette before calling it "official".

### I. Nhóm đất nông nghiệp (NNP)
| STT | Mã | Tên loại đất |
|---|---|---|
| 1 | CHN | Đất trồng cây hằng năm |
| 1.1 | LUA | Đất trồng lúa |
| 1.1.1 | LUC | Đất chuyên trồng lúa |
| 1.1.2 | LUK | Đất trồng lúa còn lại |
| 1.2 | HNK | Đất trồng cây hằng năm khác |
| 2 | CLN | Đất trồng cây lâu năm |
| 3 | LNP | Đất lâm nghiệp |
| 3.1 | RDD | Đất rừng đặc dụng |
| 3.2 | RPH | Đất rừng phòng hộ |
| 3.3 | RSX | Đất rừng sản xuất |
| (trong đó) | RSN | Đất rừng sản xuất là rừng tự nhiên |
| 4 | NTS | Đất nuôi trồng thủy sản |
| 5 | CNT | Đất chăn nuôi tập trung |
| 6 | LMU | Đất làm muối |
| 7 | NKH | Đất nông nghiệp khác |

### II. Nhóm đất phi nông nghiệp (PNN)
| STT | Mã | Tên loại đất |
|---|---|---|
| 1 | OTC | Đất ở |
| 1.1 | ONT | Đất ở tại nông thôn |
| 1.2 | ODT | Đất ở tại đô thị |
| 2 | TSC | Đất xây dựng trụ sở cơ quan |
| 3 | CQA | Đất quốc phòng, an ninh |
| 3.1 | CQP | Đất quốc phòng |
| 3.2 | CAN | Đất an ninh |
| 4 | DSN | Đất xây dựng công trình sự nghiệp |
| 4.1 | DVH | Đất xây dựng cơ sở văn hóa |
| 4.2 | DXH | Đất xây dựng cơ sở xã hội |
| 4.3 | DYT | Đất xây dựng cơ sở y tế |
| 4.4 | DGD | Đất xây dựng cơ sở giáo dục và đào tạo |
| 4.5 | DTT | Đất xây dựng cơ sở thể dục, thể thao |
| 4.6 | DKH | Đất xây dựng cơ sở khoa học và công nghệ |
| 4.7 | DMT | Đất xây dựng cơ sở môi trường |
| 4.8 | DKT | Đất xây dựng cơ sở khí tượng thủy văn |
| 4.9 | DNG | Đất xây dựng cơ sở ngoại giao |
| 4.10 | DSK | Đất xây dựng công trình sự nghiệp khác |
| 5 | CSK | Đất sản xuất, kinh doanh phi nông nghiệp |
| 5.1 | SCC | Đất khu công nghiệp, cụm công nghiệp |
| 5.1.1 | SKK | Đất khu công nghiệp |
| 5.1.2 | SKN | Đất cụm công nghiệp |
| 5.1.3 | SCT | Đất khu công nghệ thông tin tập trung |
| 5.2 | TMD | Đất thương mại, dịch vụ |
| 5.3 | SKC | Đất cơ sở sản xuất phi nông nghiệp |
| 5.4 | SKS | Đất sử dụng cho hoạt động khoáng sản |
| 6 | CCC | Đất sử dụng vào mục đích công cộng |
| 6.1 | DGT | Đất công trình giao thông |
| 6.2 | DTL | Đất công trình thủy lợi |
| 6.3 | DCT | Đất công trình cấp nước, thoát nước |
| 6.4 | DPC | Đất công trình phòng, chống thiên tai |
| 6.5 | DDD | Đất có di tích lịch sử - văn hóa, danh lam thắng cảnh, di sản thiên nhiên |
| 6.6 | DRA | Đất công trình xử lý chất thải |
| 6.7 | DNL | Đất công trình năng lượng, chiếu sáng công cộng |
| 6.8 | DBV | Đất công trình hạ tầng bưu chính, viễn thông, công nghệ thông tin |
| 6.9 | DCH | Đất chợ dân sinh, chợ đầu mối |
| 6.10 | DKV | Đất khu vui chơi, giải trí công cộng, sinh hoạt cộng đồng |
| 7 | TON | Đất tôn giáo |
| 8 | TIN | Đất tín ngưỡng |
| 9 | NTD | Đất nghĩa trang, nhà tang lễ, cơ sở hỏa táng; đất cơ sở lưu trữ tro cốt |
| 10 | TVC | Đất có mặt nước chuyên dùng |
| 10.1 | MNC | Đất có mặt nước chuyên dùng dạng ao, hồ, đầm, phá |
| 10.2 | SON | Đất có mặt nước dạng sông, ngòi, kênh, rạch, suối |
| 11 | PNK | Đất phi nông nghiệp khác |

### III. Nhóm đất chưa sử dụng (CSD)
| STT | Mã | Tên loại đất |
|---|---|---|
| 1 | CGT | Đất do Nhà nước thu hồi theo quy định của pháp luật đất đai chưa giao, chưa cho thuê |
| 2 | BCS | Đất bằng chưa sử dụng |
| 3 | DCS | Đất đồi núi chưa sử dụng |
| 4 | NCS | Núi đá không có rừng cây |
| 5 | MCS | Đất có mặt nước chưa sử dụng |

### Legacy codes (TT 25/2014/TT-BTNMT, cadastral maps and sổ đỏ issued before 01/08/2024)
Many existing sổ đỏ and maps still carry these codes, so ship them as aliases (source: wiki.batdongsan.com.vn transcription; not checked against the gazette).

| Mã cũ | Tên | Map to (2024) |
|---|---|---|
| LUC | Đất chuyên trồng lúa nước | LUC |
| LUK | Đất trồng lúa nước còn lại | LUK |
| LUN | Đất lúa nương | LUK (closest; no 2024 equivalent) |
| BHK | Đất bằng trồng cây hàng năm khác | HNK |
| NHK | Đất nương rẫy trồng cây hàng năm khác | HNK |
| CLN, RSX, RPH, RDD, NTS, LMU, NKH | (same names) | same |
| ONT, ODT, TSC, CQP, CAN, TMD, SKC, SKS, SKK, SKN, DGT, DTL, DNL, DBV, DKV, DCH, DRA, TON, TIN, NTD, SON, MNC, PNK, DVH, DYT, DGD, DTT, DKH, DXH, DNG, DSK, BCS, DCS, NCS | (same or near-same names) | same |
| DTS | Đất xây dựng trụ sở của tổ chức sự nghiệp | DSK / DSN group |
| SKT | Đất khu chế xuất | SKK |
| SKX | Đất sản xuất vật liệu xây dựng, làm đồ gốm | SKC |
| DSH | Đất sinh hoạt cộng đồng | DKV |
| DDT | Đất có di tích lịch sử – văn hóa | DDD |
| DDL | Đất danh lam thắng cảnh | DDD |
| DCK | Đất công trình công cộng khác | CCC group |

Older planning codes (TT 29/2014 quy hoạch sử dụng đất), for example **DHT** (đất phát triển hạ tầng) and **TSN**: these appear on plan maps but not in the TT 08/2024 cadastral list. Show them as "mã cũ/quy hoạch" when found. (Not verified in detail.)

---

## 5. What could not be verified
- No official URL for the "Cổng thông tin quốc gia về đất đai" was found. QĐ 441/QĐ-BNNMT (2026) and NĐ 278/2025 are known only through secondary sources.
- Internal API endpoints of ttqh HCM, quyhoach.hanoi.vn and Đà Nẵng GIS: not inspected (blocked or unreachable from the sandbox), and their terms are unknown.
- Guland's ToS wording comes from a search-engine summary. The page returns 403 to both curl and WebFetch.
- Meey Map's "Quy chế hoạt động" was not read.
- The land-code table was not checked against the gazette PDF.
- OSM landuse coverage in VN was not measured quantitatively; only one Hanoi tile was sampled.

## 6. Sources
- Luật/code tables: [luatvietnam – ký hiệu các loại đất](https://luatvietnam.vn/dat-dai-nha-o/ky-hieu-cac-loai-dat-567-24866-article.html), [hethongphapluat – bảng tra cứu ký hiệu](https://hethongphapluat.com/phap-luat/huong-dan/bang-tra-cuu-ky-hieu-cac-loai-dat-moi-nhat-bi-kip-doc-hieu-so-do-va-ban-do-dia-chinh-theo-luat-dat-dai-2024.html), [thuvienphapluat – bảng mã 2026](https://thuvienphapluat.vn/phap-luat-nha-dat/cap-nhat-bang-tra-cuu-ma-ky-hieu-cac-loai-dat-moi-nhat-2026-16892.html), [wiki.batdongsan – ký hiệu (TT 25/2014)](https://wiki.batdongsan.com.vn/wiki/ky-hieu-cac-loai-dat-767579)
- National DB status: [vneconomy](https://vneconomy.vn/chinh-phu-yeu-cau-hoan-thien-du-lieu-dat-dai-theo-cac-moc-trong-2026.htm), [vietnamfinance](https://vietnamfinance.vn/hon-43-trieu-thua-dat-chua-co-co-so-du-lieu-ap-luc-hoan-thanh-trong-nam-2026-d144679.html), [thuvienphapluat – mã định danh thửa đất TT 19/2026](https://thuvienphapluat.vn/phap-luat-nha-dat/quy-dinh-ve-ma-dinh-danh-thua-dat-tu-ngay-3032026-theo-thong-tu-19-cu-the-ra-sao-16709.html), [QĐ 441/QĐ-BNNMT PDF](https://datafiles.chinhphu.vn/cpp/files/vbpq/2026/01/441-bnnmt.pdf), [thuvienphapluat – kết nối chia sẻ CSDL đất đai](https://thuvienphapluat.vn/phap-luat-nha-dat/ket-noi-lien-thong-chia-se-co-so-du-lieu-quoc-gia-ve-dat-dai-duoc-quy-dinh-ra-sao-8622.html)
- HCM: [thongtinquyhoach.hochiminhcity.gov.vn](https://thongtinquyhoach.hochiminhcity.gov.vn/), [sggp – GIS quy hoạch](https://www.sggp.org.vn/tphcm-van-hanh-thu-nghiem-cong-thong-tin-cong-khai-du-lieu-quy-hoach-tren-nen-tang-gis-post853441.html)
- Hà Nội: [wiki.batdongsan – quy hoạch Hà Nội 2026](https://wiki.batdongsan.com.vn/wiki/ban-do-quy-hoach-ha-noi-moi-nhat-2026-3-cach-tra-cuu-chuan-phap-ly-856419), [vietnamfinance](https://vietnamfinance.vn/huong-dan-nguoi-dan-ha-noi-kiem-tra-thong-tin-quy-hoach-chinh-thong-d146922.html)
- Đà Nẵng: [viettimes](https://viettimes.vn/da-nang-dua-co-so-du-lieu-khong-gian-do-thi-va-quy-hoach-tp-len-he-thong-gis-post159834.html)
- Commercial ToS: [guland điều khoản](https://guland.vn/dieu-khoan-thoa-thuan), [meeymap điều khoản](https://help-center.meeymap.com/dieu-khoan-su-dung-meey-map), [Vietmap API docs](https://maps.vietmap.vn/docs/map-api/overview/)
