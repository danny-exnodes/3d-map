# Tiny Map: hướng dẫn cho agent

Trước khi làm gì, đọc **checkpoint mới nhất** trong `docs/releases/` (hiện là [`docs/releases/v0.0.5.md`](docs/releases/v0.0.5.md)). Sau đó xem [issue #1 (Roadmap)](https://github.com/danny-exnodes/3d-map/issues/1) trên GitHub để biết trạng thái hiện tại.

Tóm tắt:
- Web app Vite + TypeScript + Three.js + MapLibre, chạy hoàn toàn phía client. UI tiếng Việt.
- Có 2 trang: `index.html` là bản Google 3D (`src/google/`, cần key của người dùng), `openstreetmap/index.html` là bản dựng OSM (`src/main.ts`). Tài nguyên trong `public/` lấy theo `APP_ROOT`.
- Quy trình: mỗi việc là một issue, có PO đề xuất và TechLead phân tích. Chỉ code khi cả hai đã đồng ý (label `status: ready`).
- Nhánh mặc định là `master`. Làm trên `feature/*` hoặc `fix/*`, mở PR, chờ CI xanh rồi merge. Merge vào `master` sẽ tự deploy GitHub Pages.
- Trước khi push: `npm run typecheck && npm test && npm run build`. Với thay đổi về hiệu năng, chạy thêm `npm run bench`.
- Sandbox cloud không gọi được Overpass (đường mặc định giờ không cần Overpass); khi test nhánh Overpass, mock bằng Playwright.
- Khi kết thúc một đợt việc, viết checkpoint mới `docs/releases/vX.Y.Z.md` theo đúng cấu trúc của bản trước.
