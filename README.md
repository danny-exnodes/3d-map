# Tiny Map

**Vẽ một khu trên bản đồ → dựng thành mô hình thành phố 3D low‑poly** ngay trong trình duyệt, từ dữ liệu mở OpenStreetMap. Có chu kỳ ngày/đêm theo vị trí mặt trời thật, cửa sổ sáng đèn về đêm, xe cộ và tàu điện chạy, lớp giao thông, thời tiết thực tế, chế độ pixel và xuất file `.glb`.

*Draw a rectangle on a map and get a stylised 3D diorama of that neighbourhood, built client-side from OpenStreetMap data.*

| Chọn vùng | Ban ngày | Ban đêm |
| --- | --- | --- |
| ![map](docs/map.png) | ![day](docs/day.png) | ![night](docs/night.png) |

## Tính năng

**Chọn vùng**
- Mở app sẽ tự lấy vị trí hiện tại. Không lấy được thì về mặc định Én Nam – 101 Châu Thị Hoá (TP.HCM). Nút 📍 để lấy lại vị trí.
- Tìm địa điểm (Nominatim), kéo chuột vẽ hình chữ nhật, hoặc chọn nhanh 800 m quanh tâm bản đồ. Vùng được lưu vào URL (`#bbox=…`) để chia sẻ.

**Dữ liệu** (xem [Nguồn dữ liệu](#nguồn-dữ-liệu))
- Footprint nhà gộp từ **OpenStreetMap** và **Overture Maps** (Google/Microsoft ML buildings). Ở nhiều khu của VN, Overture có nhiều nhà hơn OSM hàng chục lần.
- **Chiều cao** ưu tiên theo thứ tự: tag OSM > **Google Open Buildings 2.5D** (trung vị trong footprint) > số tầng Overture > ước lượng theo hình dạng footprint.
- Mỗi nhà ghi lại nguồn của footprint và chiều cao. Nút 📏 tô màu nhà theo nguồn chiều cao.
- Ngoài nhà còn có đường theo cấp & số làn, cầu vượt, đường sắt trên cao, sông hồ, công viên, cây, địa điểm nổi bật.

**Dựng 3D** (Three.js, chạy trong Web Worker)
- Mái dốc, mái chóp, mái chùa hai tầng và mái vòm được đặt theo hình chữ nhật bao nhỏ nhất của footprint. Nhà xưởng có mái tôn thấp. Đọc được `building:part`, `roof:*`, `building:colour/material` (Simple 3D Buildings).
- Kiến trúc mẫu Việt Nam:
  - nhà ống/shophouse có ban công ở mặt tiền giáp đường, tum thang và bồn nước inox trên sân thượng;
  - chung cư/cao ốc có khối đế và tháp lùi vào;
  - mặt kính, gạch, kim loại thể hiện bằng shader.
- Cửa sổ sinh bằng shader (không cần texture). Có vỉa hè, vạch kẻ đường, trụ cầu, hàng cây ven đường, đèn đường.
- **Bấm vào một nhà** để xem tên, loại, số tầng, chiều cao, nguồn dữ liệu, kèm link sửa hoặc vẽ thêm trên OpenStreetMap.

**Hiển thị**
- Ba chế độ xem **Có màu / Đơn sắc / Siêu thực**. Lựa chọn được ghi nhớ, đặt được qua URL `?style=mono|real`.
  - Đơn sắc theo phong cách mô hình kiến trúc, đèn đêm vẫn giữ màu ấm.
  - **Siêu thực** (#19) dùng vật liệu PBR sinh hoàn toàn bằng shader, không tải texture nên chạy được offline:
    - mặt tiền: vữa loang, vệt mưa, gờ sàn, cửa sổ có khung và bậu, kính phản chiếu trời, cục lạnh, cửa cuốn và bảng hiệu tầng trệt, tường kính, gạch, ốp kim loại;
    - mái: mái bằng bê tông có vết ố, mái tôn sóng có gỉ, mái ngói;
    - mặt đất: đường nhựa có vá và ướt khi mưa, vỉa hè lát gạch, cỏ;
    - sông hồ có sóng động và phản chiếu bầu trời;
    - tán cây nhiều khối;
    - bầu trời khí quyển có mây, chiếu sáng môi trường, ambient occlusion (tự tắt khi máy yếu), bóng mềm.
- Chế độ pixel.
- Thanh thời gian 24h + chọn ngày. Mặt trời đặt đúng vị trí thiên văn theo toạ độ. Ban đêm có ánh trăng, cửa sổ và đèn xe sáng, bloom.
- **Giao thông (mô phỏng)**: xe máy, ô tô, xe buýt chạy theo làn bên phải, mật độ đổi theo giờ cao điểm. Lớp 🚦 tô màu tốc độ. Có tàu chạy trên ray.
- **Thời tiết thực** từ Open‑Meteo: nhiệt độ, mây, mưa.

**Hiệu năng**
- Dữ liệu tải và mô hình dựng trong Web Worker, main thread không bị đơ.
- Bộ nhớ đệm IndexedDB (OSM 7 ngày, Overture 30 ngày, thời tiết 15 phút).
- Tiến độ hiện theo số byte tải thật. Có nút huỷ.
- Bóng đổ chỉ render lại khi cần. Pixel ratio tự hạ khi FPS thấp. Chi tiết nhỏ chỉ hiện khi zoom gần (LOD).
- Benchmark tự động trong CI.

**Xuất**: ảnh PNG, mô hình `.glb` (theo chế độ màu đang chọn).

**Demo offline**: thêm `?demo` vào URL để dựng thành phố sinh ngẫu nhiên.

| Ngã Tư Sở (OSM + Overture + Google 2.5D) | Nguồn chiều cao 📏 | Đơn sắc |
| --- | --- | --- |
| ![ngatuso](docs/ngatuso.png) | ![sources](docs/height-sources.png) | ![mono](docs/mono.png) |

| Có màu | Siêu thực | Siêu thực – cận cảnh |
| --- | --- | --- |
| ![before](docs/real-before.jpg) | ![after](docs/real-after.jpg) | ![street](docs/real-street.jpg) |

| Siêu thực – sông, cầu cạn | Siêu thực – ban đêm | |
| --- | --- | --- |
| ![river](docs/real-river.jpg) | ![night](docs/real-night.jpg) | |

| Én Nam – Q.8, TP.HCM | Thông tin toà nhà | Ban đêm |
| --- | --- | --- |
| ![ennam](docs/ennam.png) | ![info](docs/building-info.png) | ![night](docs/night.png) |

## Chạy thử

```bash
npm install
npm run dev        # http://localhost:5173 — có thêm /api/heights tính chiều cao cho mọi vùng ở VN
npm test           # unit test
npm run build      # bản tĩnh trong dist/
npm run bench      # benchmark (cần `npm run preview` đang chạy ở cổng 4173)
```

Yêu cầu Node 22.18+ (CLI chiều cao chạy thẳng file `.ts`) và trình duyệt hỗ trợ WebGL2.

## Nguồn dữ liệu

| Nguồn | Dùng cho | Cách truy cập | Giấy phép |
| --- | --- | --- | --- |
| [OpenStreetMap](https://www.openstreetmap.org/) qua Overpass | nhà, đường, sông, cây… | trình duyệt, cache 7 ngày | ODbL |
| [Overture Maps](https://docs.overturemaps.org/guides/buildings) `buildings.pmtiles` | bù footprint | PMTiles (range request, CORS) | ODbL |
| [Google Open Buildings 2.5D Temporal](https://sites.research.google/gr/open-buildings/temporal/) | chiều cao nhà | GeoTIFF công khai, **không có CORS** → tiền xử lý | CC BY 4.0 |
| [Open‑Meteo](https://open-meteo.com/) | thời tiết | trình duyệt | CC BY 4.0 |

### Lưới chiều cao Google 2.5D

GeoTIFF của Google không cho trình duyệt đọc trực tiếp vì không có CORS. Vì vậy chiều cao được trích sẵn thành lưới 2 m (`uint16`, đơn vị dm):

```bash
# Sinh lưới cho một vùng (chỉ phủ Việt Nam — chỉ mục tile ở tools/data/)
npm run heights -- --id hoankiem --name "Hồ Hoàn Kiếm" --bbox 21.024,105.848,21.034,105.858
```

File được ghi vào `public/heights/` và tự thêm vào `index.json`. Repo kèm sẵn lưới cho **Ngã Tư Sở** và **Én Nam**.

Cách app tìm lưới chiều cao cho một vùng:
- `npm run dev`: endpoint `/api/heights` tính lưới cho vùng bất kỳ.
- Bản tĩnh: đặt `VITE_HEIGHTS_API=https://…/api/heights` trỏ tới một proxy cùng API (#4).
- Không có lưới: dùng heuristic theo hình dạng footprint.

## Kiến trúc

```
src/
  main.ts                 # UI: chọn vùng → tải → dựng → điều khiển
  config.ts               # vị trí mặc định, vùng ví dụ
  services/location.ts    # vị trí hiện tại + fallback
  ui/MapView.ts           # bản đồ 2D MapLibre + vẽ hình chữ nhật
  data/loader.ts          # pipeline: OSM ∥ Overture ∥ chiều cao → ghép
  data/osm.ts             # Overpass (stream, rate limit) + parser
  data/overture.ts        # Overture PMTiles → footprint
  data/heights.ts         # lưới chiều cao Google 2.5D
  data/enrich.ts          # ghép footprint, gán chiều cao, thống kê nguồn
  data/buildings.ts       # tag → Building: kiến trúc mẫu, heuristic, kiểu mái
  data/cache.ts           # IndexedDB (TTL + LRU)
  worker/                 # Web Worker: tải dữ liệu + dựng hình, truyền buffer
  scene/CityScene.ts      # renderer, camera, ánh sáng, bloom, chọn nhà, xuất GLB
  scene/buildings.ts      # tường + mái gộp 1 mesh, shader cửa sổ/vật liệu/chọn
  scene/roofs.ts          # OBB, mái dốc/chóp/vòm/chùa
  scene/details.ts        # ban công, tum thang, bồn nước (instanced, LOD)
  scene/colorMode.ts      # Có màu / Đơn sắc
  scene/realistic.ts      # Siêu thực: vật liệu PBR thủ tục, bầu trời, nước, cây
  scene/roads.ts …        # đường, cầu, ray; landscape.ts; traffic.ts; sun.ts
tools/
  gob-heights.mjs         # CLI trích lưới chiều cao
  gob-index.mjs           # dựng lại chỉ mục tile Google 2.5D cho VN
  overture-spike.mjs      # đo độ phủ Overture tại một điểm
bench/                    # benchmark + ngân sách hiệu năng cho CI
```

## Phiên bản

- [v0.0.1](docs/releases/v0.0.1.md) (2026-10-26): release note kiêm checkpoint (kiến trúc, quy trình, giới hạn, việc tiếp theo).

## Lộ trình

Kế hoạch và thảo luận nằm trong [issue #1](https://github.com/danny-exnodes/3d-map/issues/1). Backlog hiện tại:

- [ ] Proxy CORS để bản tĩnh lấy được chiều cao cho mọi vùng (#4)
- [ ] Lớp so sánh ảnh thực Google Photorealistic 3D Tiles (#6)
- [ ] Dữ liệu giao thông thực (#11)
- [ ] Chia tile + LOD cho vùng lớn, địa hình (DEM), straight skeleton cho mái phức tạp

## Dữ liệu & giấy phép

- Mã nguồn: [MIT](LICENSE).
- Dữ liệu bản đồ © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Footprint bổ sung: [Overture Maps Foundation](https://overturemaps.org/) (ODbL). Chiều cao: [Google Open Buildings 2.5D Temporal](https://sites.research.google/gr/open-buildings/temporal/) (CC BY 4.0) — các file trong `public/heights/` là dữ liệu phái sinh, cùng giấy phép CC BY 4.0. Nền bản đồ © [CARTO](https://carto.com/attributions). Thời tiết: [Open‑Meteo](https://open-meteo.com/) (CC BY 4.0).
- App hiển thị ghi công đúng các nguồn đã dùng cho từng vùng.
- Hãy tôn trọng chính sách sử dụng của các dịch vụ công cộng: [Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances), [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) (≤ 1 request/giây). Khi triển khai lượng truy cập lớn, nên tự host Overpass/Nominatim.
