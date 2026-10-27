---
name: release-checkpoint
description: Kết thúc một đợt việc của Tiny Map. Viết checkpoint docs/releases/vX.Y.Z.md đúng cấu trúc 10 mục của bản trước, cập nhật README (Mới trong vX.Y.Z, bảng nguồn dữ liệu, danh sách phiên bản) và con trỏ trong CLAUDE.md. Dùng trước khi mở PR cuối đợt.
---

# Release: checkpoint, README, CLAUDE.md

Checkpoint là **điểm khôi phục ngữ cảnh**: một agent mới chỉ cần đọc nó để làm tiếp. Viết cho người không có lịch sử chat.

## Đánh số phiên bản

- Tăng bản vá cho mỗi đợt việc: v0.0.4 → v0.0.5.
- Tag do chủ dự án tạo trên GitHub (xem `steward`).

## Cấu trúc bắt buộc (giống hệt bản trước)

Mở checkpoint mới nhất trong `docs/releases/` và giữ nguyên các tiêu đề:

```markdown
# Tiny Map vX.Y.Z: release note và checkpoint

> **Ngày:** YYYY-MM-DD · **Commit:** merge của PR đợt "…" trên `master` (tag `vX.Y.Z` tạo trên giao diện GitHub) · **Bản chạy:** <url>
>
> Tài liệu này là **điểm khôi phục ngữ cảnh** … Nó thay cho [vPrev](vPrev.md); phần nào không nhắc lại ở đây thì vẫn đúng như vPrev …

---

## 1. Sản phẩm là gì            ← yêu cầu của chủ dự án, đánh số đúng như họ viết
## 2. Tính năng mới trong vX.Y.Z  ← bảng Nhóm | Tính năng | Issue, + số liệu trước/sau
## 3. Kiến trúc: phần thay đổi   ← sơ đồ file/luồng dạng code block + ghi chú kỹ thuật
## 4. Nguồn dữ liệu và giới hạn đã biết  ← bảng nguồn mới (truy cập, giấy phép) + "Đã biết, chưa sửa"
## 5. Môi trường của agent       ← mẹo sandbox mới (lệnh, bẫy, cách test)
## 6. Quy trình làm việc đã thống nhất
## 7. Lệnh hay dùng              ← URL, tham số, phím tắt mới
## 8. Trạng thái issue tại vX.Y.Z ← bảng ✅ / 🟡 / ⏸️ / 🔒
## 9. Gợi ý việc tiếp theo (chưa thống nhất; phải qua quy trình PO/TL)
## 10. Lịch sử thay đổi vX.Y.Z  ← `git log --oneline master..HEAD`
```

Quy tắc viết:
- Ghi số đo có thật (bench, đếm chồng lấn, thời gian dựng), không viết "cải thiện đáng kể".
- Mục 4 "Đã biết, chưa sửa" phải thành thật: cái gì chưa kiểm với dịch vụ thật, cái gì đánh đổi.
- Mục 10 lấy commit thật. Commit docs cuối có thể bỏ.

## README.md

1. **Thêm khối "Mới trong vX.Y.Z"** ngay trên khối của bản trước, ở mục Tính năng. Mỗi dòng là một thay đổi người dùng thấy.
2. **Bảng nguồn dữ liệu:** thêm dòng cho nguồn mới, gồm tên kèm link, dùng cho gì, cách truy cập và giấy phép.
3. **Danh sách phiên bản:** thêm `- [vX.Y.Z](docs/releases/vX.Y.Z.md) (ngày): tóm tắt` lên đầu.
4. **Đổi URL hoặc trang:** cập nhật khối giới thiệu ở đầu README. Ví dụ v0.0.5 có hai trang `/` và `/openstreetmap/`.

## CLAUDE.md

- Đổi con trỏ checkpoint mới nhất (cả chữ hiển thị lẫn link) sang `docs/releases/vX.Y.Z.md`.
- Chỉ thêm dòng tóm tắt khi kiến trúc hoặc quy ước thay đổi. Ví dụ v0.0.5 thêm dòng "Có 2 trang…".

## Kiểm tra cuối

```bash
.claude/skills/developer/scripts/debug-hook.sh off   # no DEBUG-REMOVE line left
npm run typecheck && npm test && npm run build
grep -n "vX.Y.Z" CLAUDE.md README.md
```

Sau đó commit `docs: vX.Y.Z release note and checkpoint, README`, rồi chuyển sang `steward`.
