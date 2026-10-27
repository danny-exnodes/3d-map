# Playbook: bộ skill "nhóm phát triển ảo" cho agent

> File này mô tả đầy đủ bộ skill và cách làm việc đã dùng trong dự án **Tiny Map** (`danny-exnodes/3d-map`, từ v0.0.1 tới v0.0.5).
>
> Dán file vào một session mới và yêu cầu: *"Dựa vào playbook này, xây dựng bộ skill trong `.claude/skills/` cho repo hiện tại"*. Agent nhận file làm theo mục 8.

---

## 1. Ý tưởng

Một agent đóng lần lượt các vai trò của một nhóm phần mềm nhỏ. Mỗi vai trò là một skill (`.claude/skills/<tên>/SKILL.md`), và một skill điều phối nối chúng thành quy trình:

```
Chủ dự án (người dùng) ─ yêu cầu ─▶ PO ─▶ TechLead ─▶ Developer ⇄ QA ─▶ Release ─▶ Steward ─▶ báo cáo
                                  issue  status:ready  commit    ảnh/số  checkpoint  PR/CI/merge
```

Nguyên tắc chung:
1. **Không code khi chưa có issue đã được PO và TL đồng ý** (label `status: ready`).
2. **Đo, đừng đoán.** Mỗi lỗi phải được tái hiện, và mỗi sửa đổi phải có số trước và sau.
3. **Không báo "xong" khi chưa nhìn thấy kết quả.** Có ảnh chụp hoặc số đo thì mới báo.
4. **Mỗi đợt việc kết thúc bằng một checkpoint.** Checkpoint là tài liệu đủ để một agent mới không có lịch sử chat làm tiếp.
5. **Chủ dự án giao toàn quyền.** Chỉ hỏi lại khi việc có chi phí tiền thật, đổi điều khoản hoặc giấy phép, hoặc không thể đảo ngược.

## 2. Danh sách skill

| Skill | Vai trò | Khi dùng | Đầu ra |
| --- | --- | --- | --- |
| `<project>-workflow` | Điều phối | Mở session, nhận đợt yêu cầu mới, không rõ bước tiếp | Task list, thứ tự các bước |
| `product-owner` | PO | Mở issue, gom yêu cầu, xác nhận đã đạt | Issue có mục **[PO] Đề xuất** |
| `tech-lead` | TechLead | Trước khi code; khi phải chọn giữa các cách làm | Mục **[TechLead] Phân tích** + label `status: ready` |
| `developer` | Developer | Khi bắt tay code | Commit trên `feature/*` hoặc `fix/*` đã qua kiểm tra |
| `qa-visual` | QA | Tái hiện lỗi; trước khi báo xong thay đổi nhìn thấy được | Ảnh chụp, số liệu, kết quả mock |
| `steward` | GitHub | Push, PR, CI, merge, sự kiện trên PR | PR được merge, issue được đóng |
| `release-checkpoint` | Release | Cuối đợt, trước PR cuối | `docs/releases/vX.Y.Z.md`, README, CLAUDE.md |

Mỗi `SKILL.md` có frontmatter:

```markdown
---
name: <tên-skill>
description: <vai trò + làm gì + KHI NÀO dùng — câu này quyết định agent có gọi skill hay không>
---
```

Script đi kèm đặt trong `.claude/skills/<tên>/scripts/`.

---

## 3. Skill điều phối: quy trình một đợt việc

**0. Mở đầu session**
- Đọc `CLAUDE.md` và checkpoint mới nhất (`docs/releases/v*.md`, bản số lớn nhất).
- Xem issue Roadmap (#1) và các issue có label `status: ready`.
- Chạy `git status` và `git log --oneline -5`. Nhánh nào còn dở thì làm tiếp nhánh đó.

**1. Nhận yêu cầu**
- Tách yêu cầu thành từng mục, giữ đúng thứ tự đánh số của chủ dự án. Báo cáo cuối đợt cũng theo thứ tự này.
- Yêu cầu có link tái hiện (bbox, URL, bước làm) thì tái hiện trước bằng skill QA và ghi lại hiện trạng.
- Tạo task list, mỗi nhóm việc một task.

**2. Issue**
- Gom các mục cùng vùng code hoặc cùng trải nghiệm vào một issue. Mỗi issue phải làm xong được trong một PR.
- PO viết **[PO] Đề xuất**. TL viết **[TechLead] Phân tích**.
- Cuối issue ghi `✅ PO đồng ý · ✅ TechLead đồng ý`, gắn label `feature`/`bug` và `status: ready`.
- Việc nhỏ trong một đợt phản hồi vẫn cần issue.

**3. Code**
- Một nhánh cho cả đợt: `feature/vX.Y.Z`.
- Mỗi commit là một nhóm việc, ghi `Refs #N`.

**4. Kiểm tra**
- Trước mỗi push chạy `typecheck && test && build`.
- Chạy benchmark khi thay đổi đụng tới hiệu năng.
- Chụp ảnh mọi thay đổi nhìn thấy được.

**5. Phát hành**
- Viết checkpoint, cập nhật README và CLAUDE.md.
- Push, mở PR có `Closes #…`, theo dõi CI, merge khi xanh. Merge sẽ tự deploy.
- Tạo tag: nếu proxy chặn push tag thì hướng dẫn chủ dự án tạo trên giao diện GitHub, chọn Target là commit merge.

**6. Báo cáo**
- Viết theo thứ tự yêu cầu. Mỗi mục gồm: đã làm gì, nguyên nhân gốc, số đo trước → sau.
- Nói rõ phần nào chưa kiểm được và vì sao (ví dụ thiếu key thật, dịch vụ bị chặn).
- Liệt kê việc chủ dự án cần làm (tạo tag, nhập key…).
- Không lặp lại chi tiết kỹ thuật đã có trong checkpoint.

**Quy ước ngôn ngữ**
- UI, tài liệu và body PR viết tiếng Việt.
- Commit message, tiêu đề PR và comment trong code viết tiếng Anh.
- Gọi chủ dự án là "bạn"; khi viết tiếng Anh dùng they/them.
- Không ghi model ID vào repo.
- Key dịch vụ trả phí do người dùng nhập, chỉ lưu `localStorage`, không bao giờ commit.

---

## 4. Product Owner

**Trách nhiệm**
1. **Diễn đạt yêu cầu thành hành vi thấy được.** Ví dụ: "khối nhìn hơi nhựa" thành "tường có vết bẩn, vệt mưa, chân tường tối, màu bớt rực".
2. **Ghi hiện tượng tái hiện** kèm link hoặc bbox cụ thể.
3. **Gom việc liên quan, tách việc có rủi ro riêng.** Ví dụ: tách dịch vụ trả phí thành issue riêng.
4. **Đặt tiêu chí chấp nhận kiểm được bằng mắt hoặc số.** Ví dụ: "≥ 90% cặp chồng lấn biến mất ở bbox X".
5. **Giữ ràng buộc sản phẩm.** Ví dụ ở Tiny Map: chạy hoàn toàn phía client; dịch vụ trả phí luôn opt-in với key của người dùng.
6. **Xác nhận.** Đọc lại phân tích của TL rồi đồng ý. Sau khi merge, kiểm tra trên bản chạy.

**Mẫu issue**

```markdown
**[PO] Đề xuất** (yêu cầu 1–3)
- <hành vi người dùng thấy được>
- <hành vi + tiêu chí đo>
- Ngoài phạm vi: <…>

**[TechLead] Phân tích**
(TL điền)

✅ PO đồng ý · ✅ TechLead đồng ý
```

**Thứ tự ưu tiên**
1. Sai dữ liệu hoặc hình ảnh.
2. Thao tác không chạy.
3. Cảm nhận chất lượng.
4. Tính năng hoặc nguồn dữ liệu mới.

**Ghi nhận các quyết định sản phẩm đã chốt** trong skill để agent không hỏi lại.

---

## 5. TechLead

**Quy trình**
1. **Tìm nguyên nhân gốc bằng số liệu.**
   - Ví dụ: dump dữ liệu cảnh bằng Playwright, đếm các cặp footprint giao nhau bằng `shapely` STRtree, phân loại theo nguồn.
   - Kết quả: ~200/218 cặp là nhà suy ra từ raster đè lên footprint thật.
2. **Chọn cách làm nhỏ nhất mà đúng nguyên nhân.** Lỗi ở tầng dữ liệu thì sửa ở tầng dữ liệu, không che bằng render.
3. **Giữ ngân sách hiệu năng trong CI.**
   - Ví dụ: ≤ 300k tam giác, ≤ 40 draw call, dựng ≤ 1,5 s.
   - Khi sát trần, gộp mesh hoặc geometry thay vì thêm mesh mới.
4. **Tôn trọng kiến trúc hiện có.** Ghi trong skill luồng dữ liệu, các module chính và các bẫy của thư viện.
5. **Kiểm tra nguồn dữ liệu:** giấy phép, giới hạn tốc độ (rate limit), CORS.
6. **Ghi rủi ro.** Nêu điều gì không kiểm được trong sandbox và cách mock.

**Mẫu phân tích**

```markdown
**[TechLead] Phân tích**
- **<Mục>:** nguyên nhân: …; cách làm: …; file: `src/...`
  - chi phí: +N draw call / +N tam giác / +N ms; trong ngân sách: có/không
- **Kiểm tra:** unit test …; Playwright …; benchmark
- **Rủi ro:** …
```

**Khi nào dừng lại hỏi chủ dự án**
- Có chi phí bật mặc định.
- Đổi điều khoản, bỏ tính năng hoặc đổi URL công khai (khi chủ dự án chưa yêu cầu).
- Hai cách làm đánh đổi trải nghiệm rõ rệt mà PO chưa chọn.

**Mục "Bài học kỹ thuật"** cộng dồn qua từng đợt.

---

## 6. Developer, QA, Steward, Release

### Developer
- **Nhánh:** tạo `feature/vX.Y.Z` từ `master` mới nhất. Nếu PR cũ của nhánh đã merge thì tạo lại nhánh, không chồng commit lên lịch sử đã merge.
- **Debug hook:** dòng `window.__city = city // DEBUG-REMOVE` cho Playwright truy cập cảnh, không bao giờ commit.
  - Script `debug-hook.sh on|off` bật/tắt hook.
  - Script `commit.sh "msg"` gỡ hook, commit kèm trailer attribution, rồi gắn hook lại.
- **Bản đồ mã nguồn:** bảng "vùng → file" để agent mới không phải dò.
- **Quy ước code:**
  - viết giống code xung quanh;
  - comment giải thích *vì sao*, có số issue;
  - hàm dữ liệu thuần để test được trong Node;
  - dịch vụ ngoài có cache, throttle và nhánh offline.
- **Trước khi push:** `npm run typecheck && npm test && npm run build`, thêm `npm run bench` nếu đụng hiệu năng.
- **Commit:** Conventional Commits viết tiếng Anh; body ghi số đo trước → sau; cuối là `Refs #N`.
- **Bẫy đã gặp:**
  - `vColor` là vec4 trong three r186;
  - trang mới dùng MapLibre phải gọi `setWorkerUrl`;
  - `pkill -f` khớp chính lệnh đang chạy nên tự giết shell;
  - `str.replace` thất bại im lặng, nên luôn `assert` chuỗi gốc có trong file;
  - chỉ dùng thư viện đã phát hành ≥ 2 tuần và ghim đúng phiên bản.

### QA (`qa-visual`)
- **Công cụ:** Playwright với Chromium swiftshader đã cài sẵn trong sandbox; không chạy `playwright install`.
- **Chuẩn bị:** build, chạy `vite preview --port 4173 --strictPort` ở nền.
- **Script:**
  - `shoot.cjs <bbox> '[["tên","đoạn JS camera/giờ"]]'`: dựng bbox, in thống kê, chụp ảnh và ghép lưới. Biến môi trường: `STYLE`, `DUMP`, `GEO`, `W`/`H`.
  - `overlaps.py dump.json`: đếm cặp footprint chồng nhau theo nguồn.
  - `grid.py`: ghép ảnh trước/sau.
  - `google-mock.cjs`: mock toàn bộ API Google.
- **Kiểm theo loại thay đổi:**
  - dữ liệu: đếm trước và sau;
  - tương tác: đọc `getBoundingClientRect`, mô phỏng chuột, so `location.hash`;
  - hiệu năng: benchmark;
  - điện thoại: `devices['iPhone 13']`.
- **Dịch vụ không gọi được** (Overpass, Google không có key): mock bằng `ctx.route`. Báo cáo ghi rõ phần nào chỉ mới kiểm bằng mock.

### Steward (GitHub)
- **Công cụ:** không có `gh`. Dùng tool MCP `mcp__github__*`: `create_pull_request`, `pull_request_read` (`get_check_runs`), `merge_pull_request`, `issue_write`.
- **Theo dõi PR:** `subscribe_pr_activity`, không poll bằng sleep.
- **Push:** `git push -u origin <branch>`. Lỗi mạng thì thử lại sau 2s, 4s, 8s, 16s.
- **Tag:** proxy chặn push tag. Hướng dẫn chủ dự án vào Releases, tạo tag mới, chọn Target là commit merge (đưa SHA đầy đủ khi tag bản cũ).
- **PR:**
  - tiêu đề `vX.Y.Z: <tóm tắt>`;
  - body tiếng Việt, nhóm theo vùng thay đổi, có `Closes #N` / `Refs #N`;
  - mục **Kiểm tra** ghi lệnh đã chạy, số benchmark, phần nào chỉ kiểm bằng mock;
  - kết thúc bằng các dòng attribution.
- **Comment GitHub:** chỉ comment khi cần, kết thúc bằng footer `---\n_Generated by [Claude Code](https://claude.ai/code)_`.
- **Merge:**
  - khi job `build` = success (job `deploy` bị skip trên PR là bình thường);
  - head SHA phải bằng `git rev-parse HEAD` và `git status` phải sạch;
  - dùng `merge_pull_request` với `expectedHeadSha`.
- **CI đỏ:** tái hiện cục bộ, sửa rồi push. Không skip test, không push commit rỗng.
- **Sau merge:** deploy tự chạy; báo link bản chạy và việc tạo tag.

### Release (`release-checkpoint`)

Checkpoint `docs/releases/vX.Y.Z.md` giữ đúng 10 mục, theo đúng tiêu đề của bản trước:

```
# <Dự án> vX.Y.Z: release note và checkpoint
> Ngày · Commit (tag tạo trên GitHub) · Bản chạy. "Tài liệu này là điểm khôi phục ngữ cảnh… thay cho [vPrev]"
## 1. Sản phẩm là gì              (yêu cầu của chủ dự án, giữ nguyên đánh số)
## 2. Tính năng mới trong vX.Y.Z   (bảng Nhóm | Tính năng | Issue + số liệu trước/sau)
## 3. Kiến trúc: phần thay đổi    (sơ đồ file/luồng + ghi chú kỹ thuật)
## 4. Nguồn dữ liệu và giới hạn đã biết (bảng nguồn mới: truy cập, giấy phép; "Đã biết, chưa sửa")
## 5. Môi trường của agent        (mẹo sandbox mới)
## 6. Quy trình làm việc đã thống nhất
## 7. Lệnh hay dùng
## 8. Trạng thái issue            (✅ / 🟡 / ⏸️ / 🔒)
## 9. Gợi ý việc tiếp theo (chưa thống nhất; phải qua quy trình PO/TL)
## 10. Lịch sử thay đổi          (git log --oneline master..HEAD)
```

- **README:**
  - thêm khối "Mới trong vX.Y.Z";
  - thêm dòng cho nguồn dữ liệu mới vào bảng nguồn;
  - thêm dòng vào danh sách phiên bản.
- **CLAUDE.md:**
  - trỏ tới checkpoint mới;
  - thêm dòng tóm tắt nếu kiến trúc thay đổi;
  - có dòng trỏ tới bộ skill.

---

## 7. Các mẫu cần chép nguyên

**Trailer commit** (lấy đúng dòng session yêu cầu; không ghi model ID):

```
Co-Authored-By: Claude <noreply@anthropic.com>
```

**Cuối body PR:**

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Footer comment GitHub:**

```
---
_Generated by [Claude Code](https://claude.ai/code)_
```

**Lệnh kiểm tra trước push:**

```bash
npm run typecheck && npm test && npm run build && npm run bench
```

---

## 8. Hướng dẫn cho session nhận file này

1. **Đọc repo hiện tại:** README, CLAUDE.md, cấu trúc `src/`, CI (`.github/workflows/`), lệnh trong `package.json`, issue và label đang có trên GitHub.
2. **Tạo 7 skill** ở mục 2 trong `.claude/skills/`. Đổi `<project>-workflow` thành tên dự án.
3. **Thay ví dụ Tiny Map bằng thông tin của repo mới:**
   - bản đồ mã nguồn;
   - ngân sách hiệu năng (lấy từ benchmark hoặc CI của repo, nếu có);
   - lệnh kiểm tra;
   - URL deploy;
   - ràng buộc sản phẩm và các quyết định đã chốt;
   - bẫy kỹ thuật của stack.
   Giữ nguyên quy trình, mẫu issue, mẫu checkpoint và quy ước GitHub.
4. **Viết script đi kèm cho stack mới:**
   - `commit.sh`, và `debug-hook.sh` nếu cần hook debug;
   - script chụp ảnh hoặc kiểm tra tương ứng với app (web: Playwright; CLI: chạy lệnh và so đầu ra).
5. **Kiểm tra cú pháp:** `bash -n`, `node --check`, `python3 -m py_compile`.
6. **Chưa có checkpoint:** tạo `docs/releases/v0.0.1.md` theo mẫu 10 mục, mô tả hiện trạng repo.
7. **Thêm vào CLAUDE.md** dòng trỏ tới bộ skill và checkpoint mới nhất.
8. **Commit trên nhánh `feature/skills`**, mở PR, merge khi CI xanh (theo skill `steward`).
