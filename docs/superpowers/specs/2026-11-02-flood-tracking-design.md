# Flood points on the OSM page (Hà Nội, TP.HCM)

Date: 2026-11-02 · Branch: `feature/flood-tracking` (from `master` 9faaa20) · Page: `/openstreetmap/` only.

## Request (owner, verbatim)

> check giúp tôi, chúng ta đã làm tracking chỗ nào bị ngập lụt chưa → không cần soạn, lên plan và research chỗ đó giúp tôi

Nothing about flooding exists yet: no code, no issue, no PR, not on the roadmap (#1). Everything below that is not in the request is **the agent's call**, marked (call), so the owner can overturn it.

## Research (2026-11-02)

| Source | What it gives | Machine-readable? | Notes |
| --- | --- | --- | --- |
| **Thoát nước Hà Nội (HSDC)**, `https://thoatnuochanoi.vn/ungngap/api/flood/getflood` (GET) | 45 automatic flood stations: `TramId`, `TenTram`, `Lat`/`Lng` (strings), `Icon` (`<timestamp>_Flood_level<N>.png`) | Yes, JSON `{"Code":1,"Content":[…]}` | **Real observations**, same feed as the iHanoi "Bản đồ mưa ngập" app. No CORS header. No documented licence or terms. On 2026-11-02 (dry) all 45 were `Flood_level1`. |
| **Bản đồ triều cường (Tuổi Trẻ Thành phố Bác)**, `https://bandotrieucuong.tuoitrethanhphobac.vn/api/forecasts` (GET) | 11 TP.HCM risk zones: `zone_id`, `name`, `lat`, `lng`, `radius_m` (e.g. 900), `streets[]`, `level` (`low`, `watch` seen), `risk_score`, `depth_label`, `summary`, `window_start/end`, rain and tide figures | Yes, JSON array | **Forecast**, not observation: their own model from Open-Meteo rain, tide and flood history. Also `/api/tides`, `/api/overview`, `/api/incidents` (community reports, empty today). No CORS header. Undocumented, no stated licence. |
| Sở Xây dựng TP.HCM list (159 regular flood points, Jan 2026) | Street names | No coordinates | Press maps (VnExpress) estimate positions; not reusable. |
| OpenStreetMap `flood_prone=yes` / `hazard=flood*` | Tagged roads | Yes (Overpass) | Only **8** features in both cities: too sparse. |
| Open-Meteo Flood API (GloFAS) | River discharge, ~5 km, daily | Yes, CORS | Big rivers only; says nothing about street flooding. |
| Open-Meteo Marine `sea_level_height_msl` | Hourly modelled sea level (tide) | Yes, CORS | Usable later for a TP.HCM tide line; not in this round. |
| Terrain (DEM) for low spots | — | — | The scene has **no terrain**: ground is flat at y = 0 and the z14 "height tiles" are building heights. A rain + terrain model is out of scope. |

## Decisions

### Data
- Two sources, both through the existing Cloudflare relay (`proxy/flights-worker.js`, deployed as `tinymap-flights`), because neither sends CORS headers. (call)
  - `/flood/hanoi` → HSDC `getflood` (observed).
  - `/flood/hcm` → Tuổi Trẻ `api/forecasts` (forecast).
- **Permission gate:** both feeds are undocumented and unlicensed. The relay routes are not deployed, and the branch is not merged, until the owner confirms the data owners allow it (HSDC; Tuổi Trẻ Thành phố Bác). Code and tests can be written before that.
- Region is chosen from the area centre: Hà Nội box `20.53–21.39 N, 105.28–106.03 E`; TP.HCM box `10.30–11.20 N, 106.30–107.20 E`. Anywhere else: no request, a one-line note. (call)
- Levels, one scale `0..3` (0 = dry, not drawn): (call)
  - HSDC: `Flood_level<N>` → `N − 1`, clamped to 0..3; no match → 0. The meaning of N ≥ 2 has not been seen yet (dry day): verify on the first rainy day.
  - Tuổi Trẻ: `low` → 0, `watch` → 1, `high` → 2, `severe`/`critical`/`very_high` → 3, any other value → 1.
- Poll every 5 minutes while the layer is on and the 3D view is visible; 15 s timeout. (call)

### Display
- Toolbar toggle `#btn-flood` 💧 "Điểm ngập", **off by default**, persisted in `localStorage` `tinymap:flood`, forced with `?flood=1|0`. Hidden and off in `?bench`. (call)
- Points within the model: a translucent blue disc on the ground (one instanced mesh, ≤ 1 draw call), radius by level for stations (1 → 40 m, 2 → 70 m, 3 → 100 m), the zone's `radius_m` for forecasts, clamped to half the model size. A DOM label `💧 <name>` like the POI labels. (call)
- Card line `#i-flood` under `#i-flights`:
  - `💧 <n> điểm đang ngập trong 5 km · <source> · cập nhật HH:MM` (n counts level ≥ 1 within 5 km of the centre), or `💧 Không có điểm ngập nào trong 5 km · …`;
  - TP.HCM wording says "nguy cơ ngập" (forecast), Hà Nội says "đang ngập" (observed);
  - outside both cities: `💧 Chưa có dữ liệu ngập cho khu vực này`;
  - fetch failed: `💧 Không lấy được dữ liệu ngập` (last points stay).
- Source labels: `Thoát nước Hà Nội`, `Bản đồ triều cường (Tuổi Trẻ)`.

## Constraints
- No new npm dependencies. Vietnamese UI copy. `npm run typecheck && npm test && npm run build` green on every commit.
- No network in tests or bench: recorded fixtures `tests/fixtures/hsdc-hanoi.json`, `tests/fixtures/tuoitre-forecasts.json` (saved 2026-11-02).
- Bench unchanged (layer off in bench): ≤ 40 draw calls, ≤ 500k triangles.
- The relay keeps its rules: only the app's origins, only listed paths.

## Non-goals
Rain-plus-terrain flood modelling, tide line, community reports, push alerts, other cities, flood history, clicking a disc for a card.

## Owner steps
1. Ask HSDC and Tuổi Trẻ Thành phố Bác whether the app may show their data (with attribution).
2. After yes: redeploy the relay (`npx wrangler deploy flights-worker.js --name tinymap-flights --compatibility-date 2026-10-01` in `proxy/`), merge.
3. On the first rainy day, check a flooded HSDC station's `Icon` and confirm the level mapping.
