# Tiny Map

**Vẽ một khu trên bản đồ → dựng thành mô hình thành phố 3D low‑poly** ngay trong trình duyệt, từ dữ liệu mở OpenStreetMap. Có chu kỳ ngày/đêm theo vị trí mặt trời thật, cửa sổ sáng đèn về đêm, xe cộ và tàu điện chạy, lớp giao thông, thời tiết thực tế, chế độ pixel và xuất file `.glb`.

*Draw a rectangle on a map and get a stylised 3D diorama of that neighbourhood, built client-side from OpenStreetMap data.*

| Chọn vùng | Ban ngày | Ban đêm |
| --- | --- | --- |
| ![map](docs/map.png) | ![day](docs/day.png) | ![night](docs/night.png) |

## Tính năng

- **Chọn vùng**: tìm địa điểm (Nominatim), kéo chuột vẽ hình chữ nhật, hoặc chọn nhanh 800 m quanh tâm bản đồ. Vùng được lưu vào URL (`#bbox=…`) để chia sẻ.
- **Dữ liệu**: nhà (chiều cao từ `height` / `building:levels`, nếu thiếu thì ước lượng theo loại nhà), đường theo cấp & số làn, cầu vượt, đường sắt trên cao, sông hồ (kể cả multipolygon), công viên, cây, địa điểm nổi bật.
- **Dựng 3D** (Three.js): nhà màu pastel kiểu nhà ống, mái dốc/mái chóp cho nhà thấp, cửa sổ sinh bằng shader (không cần texture), vỉa hè, vạch kẻ đường, trụ cầu, hàng cây ven đường, đèn đường.
- **Thời gian**: thanh trượt 24h + chọn ngày; vị trí mặt trời tính theo thiên văn cho đúng toạ độ; tự đổi sang ánh trăng, cửa sổ sáng đèn, đèn xe và bloom khi trời tối. Nút ▶ tua nhanh 1 giờ/giây.
- **Giao thông (mô phỏng)**: xe máy, ô tô, xe buýt chạy theo đúng làn bên phải, mật độ đổi theo giờ cao điểm; lớp 🚦 tô màu tốc độ từng đoạn đường chính; tàu chạy trên các tuyến ray.
- **Thời tiết thực** từ Open‑Meteo (không cần API key): nhiệt độ, mây, tự bật mưa.
- **Xuất**: ảnh PNG, mô hình `.glb` (mở được bằng Blender, three.js editor…).
- **Demo offline**: thành phố sinh ngẫu nhiên (sông, cầu vượt, metro) khi không có mạng — thêm `?demo` vào URL.

## Chạy thử

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit test (parser OSM, mặt trời, phép chiếu…)
npm run build      # bản tĩnh trong dist/, deploy lên bất kỳ static host nào
```

Yêu cầu Node 20+ và trình duyệt hỗ trợ WebGL2.

## Kiến trúc

```
src/
  main.ts              # UI: luồng chọn vùng → tải → dựng → điều khiển
  ui/MapView.ts        # bản đồ 2D MapLibre + công cụ vẽ hình chữ nhật
  data/osm.ts          # truy vấn Overpass + chuyển OSM → CityData
  data/demo.ts         # thành phố mẫu offline
  data/rings.ts        # ghép way của multipolygon thành vòng kín
  geo/projection.ts    # phép chiếu cục bộ lon/lat → mét (x đông, z nam)
  scene/CityScene.ts   # renderer, camera, ánh sáng, bloom, xuất GLB
  scene/buildings.ts   # tường + mái gộp thành 1 mesh, shader cửa sổ
  scene/roads.ts       # đường, vỉa hè, vạch kẻ, cầu vượt, đường sắt
  scene/landscape.ts   # nền, nước, cây xanh, đèn đường
  scene/traffic.ts     # mô phỏng xe/tàu, lớp màu giao thông
  scene/sun.ts         # vị trí mặt trời + bảng màu bầu trời
  services/            # Nominatim (tìm kiếm), Open‑Meteo (thời tiết)
```

Mọi thứ chạy phía client, không cần server. Mỗi lớp (nhà, đường, cây…) được gộp thành một vài draw call (merged geometry / InstancedMesh) nên vùng ~1 km² với vài nghìn nhà vẫn mượt.

## Lộ trình (rất hoan nghênh đóng góp)

- [ ] Ghép thêm **Overture Maps / Open Buildings** để bù nhà thiếu trên OSM (đọc GeoParquet/PMTiles qua HTTP range).
- [ ] Dữ liệu giao thông thực (nguồn mở hoặc API có key do người dùng cung cấp) thay cho mô phỏng.
- [ ] Địa hình (DEM) cho vùng đồi núi.
- [ ] Chạy dựng hình trong Web Worker để không giật UI với vùng lớn.
- [ ] Cache dữ liệu Overpass trong IndexedDB.
- [ ] Mái nhà phức tạp hơn (straight skeleton) cho đa giác bất kỳ, `building:part`.
- [ ] Đa ngôn ngữ (hiện UI tiếng Việt).

## Dữ liệu & giấy phép

- Mã nguồn: [MIT](LICENSE).
- Dữ liệu bản đồ © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Nền bản đồ © [CARTO](https://carto.com/attributions). Thời tiết: [Open‑Meteo](https://open-meteo.com/) (CC BY 4.0).
- Hãy tôn trọng chính sách sử dụng của các dịch vụ công cộng: [Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances), [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) (≤ 1 request/giây). Khi triển khai lượng truy cập lớn, nên tự host Overpass/Nominatim.
