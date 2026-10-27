---
name: developer
description: Vai trò Developer của Tiny Map. Cách code, kiểm tra và commit theo quy ước repo (nhánh, debug hook, typecheck/test/build/bench, cấu trúc mã nguồn, các bẫy đã gặp). Dùng khi bắt tay code một issue status:ready.
---

# Developer

## Trước khi code

- Issue phải có label `status: ready` (xem `tech-lead`).
- Tạo nhánh từ `master` mới nhất:
  ```bash
  git checkout master && git pull origin master && git checkout -b feature/vX.Y.Z
  ```
- Bật debug hook để Playwright truy cập được cảnh (`window.__city`):
  ```bash
  .claude/skills/developer/scripts/debug-hook.sh on
  ```
  Hook có chú thích `// DEBUG-REMOVE` và **không bao giờ được commit**.

## Bản đồ mã nguồn

| Vùng | File |
| --- | --- |
| Trang Google 3D (`/`) | `index.html`, `src/google/{main,Photoreal,gmaps}.ts`, `google.css` |
| Trang OSM (`/openstreetmap/`) | `openstreetmap/index.html`, `src/main.ts` |
| Tải và ghép dữ liệu | `src/data/loader.ts`, `overture*.ts`, `openfreemap.ts`, `enrich.ts`, `synth.ts`, `overlap.ts`, `heights.ts` |
| Dịch vụ ngoài | `src/services/{geocode,location,weather}.ts`, `src/data/googleTraffic.ts` |
| Dựng cảnh | `src/scene/CityScene.ts`, `buildCity.ts`, `buildings.ts`, `prototypes.ts`, `roads.ts`, `landscape.ts`, `traffic.ts`, `trafficModel.ts`, `realistic.ts`, `nightLights.ts`, `locationPin.ts` |
| Bản đồ 2D, Space view | `src/ui/MapView.ts`, `src/ui/SpaceView.ts` |
| Worker | `src/worker/` (dựng cảnh off-main-thread, serialize qua `scene/serialize.ts`) |
| Tài nguyên tĩnh | `public/` (heights, wards, snapshots, sw.js); lấy đường dẫn qua `APP_ROOT` trong `src/config.ts` |
| Test | `tests/*.test.ts` (vitest); benchmark `bench/run.cjs` + `bench/budget.json` |

## Quy ước code

- Viết giống code xung quanh: mật độ comment, cách đặt tên, phong cách. Comment bằng tiếng Anh, giải thích **vì sao**, ghi số issue (`(#28)`, `(v0.0.5)`).
- Chuỗi UI viết tiếng Việt.
- Không thêm draw call khi có thể gộp: thêm vào `MeshBuilder` có sẵn, hoặc dùng `mergeGeometries` với vertex color.
- Hàm dữ liệu thuần (không DOM, không three) để test được trong Node. Thêm unit test cho logic mới, ví dụ `tests/googleTraffic.test.ts` mock `fetch`.
- Dịch vụ ngoài: cache vào IndexedDB (`data/cache.ts`), throttle theo chính sách của dịch vụ, có nhánh xử lý khi offline.
- Key trả phí: `googleKey()`/`setGoogleKey()`; không log key, không đưa key vào URL chia sẻ.

## Kiểm tra trước khi commit hoặc push

```bash
npm run typecheck && npm test && npm run build
npm run bench        # khi đổi hình học/render/giao thông; cần `vite preview --port 4173` đang chạy
```

- Bench mở `http://localhost:4173/openstreetmap/?demo&bench`.
- Chạy `vite preview` ở nền, cổng riêng, kèm `--strictPort`. **Đừng** chạy `pkill -f "vite preview"` trong cùng lệnh shell: lệnh khớp với chính nó và tự giết shell (exit 144).
- Đổi thứ nhìn thấy được thì chụp kiểm tra (skill `qa-visual`).

## Commit

Dùng script để tự gỡ debug hook rồi gắn lại:

```bash
.claude/skills/developer/scripts/commit.sh "fix: no overlapping houses, raised kerbs

- removeOverlaps: … (218 → 3 overlapping pairs)
Refs #NN"
```

- Subject viết tiếng Anh theo Conventional Commits (`feat:`, `fix:`, `perf:`, `docs:`). Body ghi số đo trước → sau.
- Thay trailer trong script bằng dòng attribution mà session yêu cầu. Không ghi model ID.
- Commit cuối trước PR: `debug-hook.sh off`, kiểm tra `grep DEBUG-REMOVE src/main.ts` không còn kết quả.

## Bẫy đã gặp

- **Màu vertex trong shader:** `vColor` là vec4 trong three r186. Viết `vColor.rgb *= …`, không gán vec3.
- **MapLibre trên trang mới:** phải gọi `setWorkerUrl(workerUrl)` (`maplibre-gl-worker.mjs?worker&url`), nếu không sẽ lỗi "Worker failed to load".
- **MapLibre:** Marker phải `setLngLat` trước `addTo`. Gọi camera trước khi style `load` xong sẽ lỗi.
- **Pháp tuyến nhà mẫu:** lấy bằng `cross(dFdx, dFdy)`. Đừng dùng `mat3(instanceMatrix)` (sai khi co giãn không đều).
- **Hằng thời gian:** khai báo giá trị mặc định khác `undefined` thì so sánh với `undefined` luôn sai. Dùng cờ riêng (ví dụ `dealt` trong `traffic.ts`).
- **Python sửa file:** `str.replace` thất bại im lặng khi chuỗi lệch khoảng trắng. Luôn `assert a in s` trước khi thay.
- **Thư viện mới:** chọn bản đã phát hành ít nhất 2 tuần, ghim đúng phiên bản (ví dụ `3d-tiles-renderer@0.5.3`).
