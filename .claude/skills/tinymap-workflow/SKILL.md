---
name: tinymap-workflow
description: Quy trình làm việc đầy đủ của dự án Tiny Map, từ yêu cầu của chủ dự án tới bản deploy và báo cáo. Dùng khi nhận một đợt yêu cầu mới (danh sách việc, phản hồi sau khi thử bản chạy), khi không rõ bước tiếp theo, hoặc khi bắt đầu session mới trên repo này.
---

# Tiny Map: quy trình một đợt việc

Đây là skill điều phối. Mỗi bước có skill riêng cho từng vai trò:

| Vai trò / giai đoạn | Skill | Đầu ra |
| --- | --- | --- |
| Product Owner (PO) | `product-owner` | Issue có mục **[PO] Đề xuất** |
| TechLead (TL) | `tech-lead` | Mục **[TechLead] Phân tích**, label `status: ready` |
| Developer | `developer` | Commit trên `feature/*` hoặc `fix/*`, đã qua kiểm tra cục bộ |
| QA | `qa-visual` | Ảnh chụp Playwright, số liệu trước/sau |
| Steward (GitHub) | `steward` | PR, CI xanh, merge, theo dõi PR |
| Release | `release-checkpoint` | `docs/releases/vX.Y.Z.md`, README, CLAUDE.md |

## 0. Mở đầu session

1. Đọc `CLAUDE.md` và checkpoint mới nhất `docs/releases/v*.md` (bản số lớn nhất).
2. Xem issue #1 (Roadmap) và các issue đang mở có label `status: ready`.
3. `git status` và `git log --oneline -5` trên `master`. Nếu có nhánh dở thì tiếp tục nhánh đó.

## 1. Nhận yêu cầu

Chủ dự án viết tiếng Việt, thường là danh sách đánh số hoặc một đoạn phản hồi sau khi thử bản chạy, kèm link `#bbox=…`.
- Tách thành từng mục, đánh số theo đúng thứ tự của chủ dự án. Báo cáo cuối đợt cũng dùng thứ tự này.
- Có link bbox thì **tái hiện trước**: dựng đúng bbox đó (skill `qa-visual`), đo hoặc chụp hiện trạng.
- Chủ dự án đã giao toàn quyền: không hỏi lại những gì tự quyết được. Chỉ hỏi khi việc có chi phí tiền thật, thay đổi điều khoản, hoặc không thể đảo ngược.
- Tạo task list (TaskCreate), mỗi task là một nhóm việc.

## 2. Issue: PO đề xuất, TL phân tích

- Gom mục liên quan vào một issue (ví dụ #28 gộp "địa chỉ + vật liệu + xe"). Mỗi issue cần làm được trong một PR.
- PO viết **[PO] Đề xuất** (skill `product-owner`). TL viết **[TechLead] Phân tích** (skill `tech-lead`).
- Kết thúc bằng `✅ PO đồng ý · ✅ TechLead đồng ý`, gắn label `feature` (hoặc `bug`) và `status: ready`.
- **Chỉ code khi issue đã có `status: ready`.** Việc nhỏ trong một đợt phản hồi vẫn cần issue (v0.0.5 đã bỏ bước này; đừng lặp lại).

## 3. Code

Một nhánh cho cả đợt: `feature/vX.Y.Z` (hoặc `fix/...`). Mỗi commit là một nhóm việc, ghi `Refs #N`. Chi tiết ở skill `developer`.

## 4. Kiểm tra

- Trước mỗi push: `npm run typecheck && npm test && npm run build`.
- Thay đổi về hình học, render, giao thông: chạy thêm `npm run bench` (ngân sách trong `bench/budget.json`: 300k tam giác, 40 draw call).
- Mỗi thay đổi nhìn thấy được thì chụp ảnh kiểm tra (skill `qa-visual`). Không báo "xong" khi chưa nhìn thấy kết quả.

## 5. Phát hành

1. Viết checkpoint `docs/releases/vX.Y.Z.md`, cập nhật README và con trỏ trong CLAUDE.md (skill `release-checkpoint`).
2. Push nhánh, mở PR với `Closes #…`, theo dõi CI, merge khi xanh (skill `steward`). Merge vào `master` sẽ tự deploy GitHub Pages.
3. Tag `vX.Y.Z`: proxy của sandbox chặn push tag. Hướng dẫn chủ dự án tạo trên Releases → Choose a tag → Target = commit merge.

## 6. Báo cáo

Viết bằng tiếng Việt, đi theo thứ tự yêu cầu của chủ dự án.
- **Mỗi mục:** đã làm gì, nguyên nhân gốc nếu là lỗi, và số đo (trước → sau).
- **Giới hạn:** nói thẳng những gì chưa kiểm tra được, ví dụ cần key thật hoặc dịch vụ bị chặn trong sandbox.
- **Việc của chủ dự án:** tạo tag, nhập key, thử bản chạy.
- Không lặp lại chi tiết kỹ thuật đã có trong checkpoint.

## Quy ước chung

- UI và tài liệu viết tiếng Việt. Commit message, PR title, comment trong code viết tiếng Anh; PR body viết tiếng Việt.
- Đại từ chỉ người dùng hay chủ dự án: "bạn" (tiếng Việt), they/them (tiếng Anh).
- Không ghi model ID vào repo.
- Key của dịch vụ trả phí (Google) chỉ do người dùng nhập và chỉ lưu `localStorage` (`tinymap:googleKey`). Không commit key.
