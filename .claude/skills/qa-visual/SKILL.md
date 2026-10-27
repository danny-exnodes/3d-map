---
name: qa-visual
description: Vai trò QA của Tiny Map. Tái hiện lỗi và kiểm tra kết quả bằng mắt và bằng số qua Playwright (Chromium swiftshader), dựng đúng bbox chủ dự án gửi, chụp ảnh, dump dữ liệu, đo chồng lấn, mock Overpass/Google. Dùng khi nhận phản hồi kèm link #bbox, trước khi báo xong một thay đổi nhìn thấy được, hoặc khi cần số trước/sau.
---

# QA: tái hiện và kiểm tra

Sandbox có sẵn Chromium và Playwright (`require('playwright')`). **Đừng** chạy `playwright install`. WebGL chạy bằng swiftshader, nên mỗi khung hình chậm; chờ 2–3 s mỗi ảnh.

## Chuẩn bị

```bash
.claude/skills/developer/scripts/debug-hook.sh on      # window.__city
npm run build
npx vite preview --port 4173 --strictPort > /tmp/preview.log 2>&1 &   # background; don't pkill in the same command
```

Lưu script và ảnh vào scratchpad của session, không lưu vào repo.

## Kịch bản có sẵn (`.claude/skills/qa-visual/scripts/`)

| Script | Việc |
| --- | --- |
| `shoot.cjs <bbox> '<shots json>' [prefix]` | Mở `/openstreetmap/#bbox=…`, bấm Dựng 3D, in thống kê, chạy từng đoạn JS (đặt camera, đổi giờ…) rồi chụp và ghép ảnh lưới. Biến môi trường: `STYLE=real`, `DUMP=data.json`, `GEO=lat,lon`, `W`/`H` |
| `overlaps.py data.json [0.2]` | Đếm cặp footprint chồng nhau theo nguồn (cần `pip install shapely`) |
| `grid.py out.png a.png b.png …` | Ghép ảnh 2 cột để so sánh trước/sau |
| `google-mock.cjs [prefix]` | Mở trang Google với mọi API Google được mock: kiểm tra hộp nhập key, thông báo lỗi 403, tile 2D, link sang bản OSM |

Đoạn JS hay dùng (với `c = __city`):
- **Camera gần:** `c.controls.target.set(0,0,0); c.camera.position.set(60,70,90); c.controls.update()`
- **Đổi giờ:** `s=document.getElementById('t-slider'); s.value='1140'; s.dispatchEvent(new Event('input'))` (phút trong ngày)
- **Ẩn UI khi chụp:** `p.addStyleTag({content:'.info,.toolbar,.timebar,.poi-label,header{display:none!important}'})`
- **Dữ liệu:** `c.data.buildings`, `c.data.roads`, `c.trafficStats()`

## Kiểm tra theo loại thay đổi

- **Dữ liệu (chồng lấn, footprint):**
  - `DUMP=` rồi chạy `overlaps.py` trước và sau khi sửa;
  - ghi số cặp và tổng diện tích (đã đo: 218 → 3 cặp, diện tích −13%).
- **Tương tác bản đồ (chọn vùng, kéo thả):**
  - đọc toạ độ `.sel-handle` bằng `getBoundingClientRect`;
  - kéo bằng `p.mouse.down/move({steps})/up`;
  - so `location.hash` trước và sau.
- **Bấm vào toà nhà:**
  - click lần lượt vài điểm trên `#canvas` cho đến khi `#building-info` hiện;
  - in `textContent`.
- **Hiệu năng:**
  - `npm run bench` (36 draw call / 260k tam giác ở v0.0.5).
- **Điện thoại:**
  - `devices['iPhone 13']` của Playwright.
- **Space view:**
  - chụp nhiều khung trong lúc chuyển cảnh;
  - so pose camera trước và sau một vòng đi rồi về (`c.saveView()`).

## Mock dịch vụ không gọi được

- **Overpass:** bị chặn trong sandbox. Đường mặc định không cần Overpass. Muốn test nhánh `?osm=overpass` thì dùng `ctx.route(/overpass/, r => r.fulfill({ json: … }))`.
- **Google:** không có key thật. Dùng `google-mock.cjs`, hoặc `ctx.route` cho `tile.googleapis.com` và `routes.googleapis.com`.
- **Báo cáo:** luôn ghi rõ phần nào chỉ mới kiểm bằng mock.

## Đọc ảnh

Dùng Read tool để xem PNG. Mô tả điều thấy được kèm con số. Đừng kết luận "đẹp hơn" khi chưa so với ảnh trước.
