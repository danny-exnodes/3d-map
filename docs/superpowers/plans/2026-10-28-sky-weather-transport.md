# Styles, sky, weather, boats and live planes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the OSM page, add a sky with clouds, a weather selector, boats on water, live planes, and bring back the Khối / Siêu thực styles next to Đồ chơi.

**Architecture:** Each feature is its own module under `src/scene/` (render) or `src/data/` (data), wired by `CityScene` and `src/main.ts`. Style is a build-time option (`CityScene.build(data, …, style)`); switching rebuilds from loaded data. Planes are lazy-loaded and read through a relay (Vite proxy in dev, Cloudflare Worker source in the repo).

**Tech Stack:** Vite, TypeScript, Three.js (addons allowed), Vitest, Playwright bench.

**Spec:** `docs/superpowers/specs/2026-10-28-sky-weather-transport-design.md`

## Global Constraints

- Branch `feature/sky-weather-transport`; commit messages end with ` (sky-weather-transport)`. No push.
- After every task: `npm run typecheck && npm test && npm run build` pass.
- Bench `node bench/run.cjs 'http://localhost:5173/openstreetmap/?demo&bench'` (dev server already on 5173 — never start another): ≤ 40 draw calls, ≤ 500,000 triangles. Report the numbers in every task report.
- Bench mode pins: clock 12:00 (exists), style toy, weather `clear`, planes off.
- UI copy in Vietnamese; no new npm dependencies; no network in tests.
- Per-feature allowance: sky+clouds ≤ 2 draw calls / 6k tris; rain 1 call (only while raining); boats ≤ 2 calls / 15k tris; planes ≤ 1 call / 10k tris.
- Lightning: flash ≤ 150 ms, gap 4–12 s.
- Never fake planes: no relay or failed fetch → no planes + a note.

## Review Focus

1. Switching style or weather repeatedly leaks GPU objects (geometries/materials not disposed) — `renderer.info.memory` must return to the same counts after Toy→Khối→Toy.
2. An area with no water, no waterways, or only tiny ponds — boats module must create nothing and not throw.
3. Relay down / 429 / malformed JSON / aircraft without `lat`/`lon`/`alt_baro` (`"ground"` string) — planes skip bad rows, keep last good set until stale, never throw into the render loop.
4. Old saved values (`tinymap:colorMode` = `mono`, `?style=color`) — read as `block`, never crash.
5. Pixel mode and the 375 px layout — new toolbar buttons and the weather menu fit and are reachable by keyboard.

---

### Task 1: Sky dome and clouds

**Files:**
- Create: `src/scene/sky.ts`, `tests/sky.test.ts`
- Modify: `src/scene/CityScene.ts` (`applySky`, `setCloud`, update loop, `build`/`clear`)

**Interfaces:**
- Produces: `skyGradient(horizon: THREE.Color, night: number): { top: THREE.Color; horizon: THREE.Color }`; `cloudCount(cover: number): number` (0 → 0, 1 → 48, monotonic, integer); `class SkyDome { mesh: THREE.Mesh; update(horizon: THREE.Color, sunDir: THREE.Vector3, night: number, cameraPos: THREE.Vector3): void; dispose(): void }`; `class CloudLayer { mesh: THREE.InstancedMesh; setCover(c: number): void; setLight(color: THREE.Color): void; update(dt: number): void; dispose(): void }` — `CloudLayer` takes `(extent: number)` (model half-size in m) and places clouds 250–450 m up across ±3× extent.
- Consumes: `moodLighting(...)` result `L.sky`, `SunState.night`.

- [ ] Write `tests/sky.test.ts`: `skyGradient` returns `horizon` equal to input and a `top` with lower lightness than horizon for day and night; `cloudCount(0) === 0`, `cloudCount(1) === 48`, `cloudCount(0.5)` between, non-decreasing over 0..1 in 0.1 steps; `new CloudLayer(500)` then `setCover(0)` leaves `mesh.count === 0` and `setCover(1)` gives 48; dome material has `fog === false` and `depthWrite === false`.
- [ ] Run `npx vitest run tests/sky.test.ts` → FAIL (module missing).
- [ ] Implement `src/scene/sky.ts`: dome = inverted low sphere (≤ 32×16 segments) with a small `ShaderMaterial` (gradient by view elevation, sun glow, hashed stars when `night > 0.5`), `renderOrder` first, centred on the camera each frame. Clouds = merged 3–5 icosphere puffs (detail 1) as one `InstancedMesh`, `MeshLambertMaterial` with `flatShading`, drift with wind along +x, wrap around.
- [ ] Wire in `CityScene`: `applySky` drives the dome instead of `scene.background` (keep `scene.background` set too, for the frame before the dome exists); `setCloud` also calls `clouds.setCover`; dispose both in `clear()`/`dispose()`.
- [ ] Run tests, typecheck, build, bench; screenshot noon/golden/night with clouds 0 and 0.8 (scratch script, not committed) and look at them.
- [ ] Commit: `feat: sky dome with mood gradient, sun glow and stars, low-poly drifting clouds by cloud cover (sky-weather-transport)`

### Task 2: Weather selector

**Files:**
- Create: `src/scene/weather.ts`, `tests/weather.test.ts`
- Modify: `src/scene/CityScene.ts` (replace `setRain(on)` with `setWeather(p)`; rain amount/slant; fog distance; lightning), `src/main.ts` (weather section), `openstreetmap/index.html` (`#btn-weather` + menu replaces `#btn-rain`), `src/style.css`

**Interfaces:**
- Produces: `type WeatherKind = 'auto' | 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog'`; `WEATHER_KINDS: readonly WeatherKind[]` (that order); `WEATHER_LABEL: Record<WeatherKind, string>` = Tự động, Nắng, Nhiều mây, Mưa, Dông, Sương mù; `WEATHER_ICON` = 🔄 ☀️ ☁️ 🌧️ ⛈️ 🌫️; `interface WeatherPreset { cloud: number; rain: 0 | 1 | 2; slant: number; fogScale: number; lightning: boolean; dim: number }`; `weatherPreset(kind: Exclude<WeatherKind,'auto'>): WeatherPreset`; `kindFromLive(w: Weather): Exclude<WeatherKind,'auto'>` (uses `code`/`rain`/`cloudCover`); `parseWeatherKind(s: string | null): WeatherKind | null`; `CityScene.setWeather(p: WeatherPreset): void`.
- Consumes: `Weather` from `src/services/weather.ts`; `CloudLayer.setCover` (Task 1).

- [ ] Write `tests/weather.test.ts`: `clear` → cloud ≤ 0.1, rain 0, lightning false, fogScale 1; `storm` → rain 2, lightning true, cloud ≥ 0.9, dim > `rain`'s dim; `fog` → fogScale < 0.5, rain 0; `kindFromLive` maps code 0 → clear, 3 → cloudy, 45 → fog, 61 → rain, 95 → storm; `parseWeatherKind('storm') === 'storm'`, `parseWeatherKind('snow') === null`, `parseWeatherKind(null) === null`.
- [ ] Run → FAIL. Implement `src/scene/weather.ts`.
- [ ] `CityScene.setWeather`: cloud via existing `setCloud`; rain Points count 6000 (rain 1) / 12000 (rain 2) with `slant` applied in the update; fog near/far multiplied by `fogScale` (keep the per-build `ext` values); `dim` scales sun and hemi intensity after `moodLighting`; lightning timer per spec (≤ 150 ms flash, 4–12 s gap) boosting hemi intensity and cloud colour. Remove `setRain`.
- [ ] UI: `#btn-weather` shows the current icon, `aria-haspopup="menu"`; menu of six `button[role=menuitemradio]` with `aria-checked`; Esc/click-outside closes. `auto` keeps `loadWeather` behaviour (via `kindFromLive`); others apply the preset and set `#w-label` to `<label> (chọn tay)`. Persist `tinymap:weather` (try/catch), `?weather=` wins. Bench forces `clear`.
- [ ] Tests, typecheck, build, bench; screenshot each of the six at noon and `storm` at night.
- [ ] Commit: `feat: weather selector (auto, sunny, cloudy, rain, storm with lightning, fog) replaces the rain toggle (sky-weather-transport)`

### Task 3: Boats on rivers and lakes

**Files:**
- Create: `src/scene/boats.ts`, `tests/boats.test.ts`
- Modify: `src/scene/CityScene.ts` (create in `build`, update in loop, dispose in `clear`)

**Interfaces:**
- Produces: `type BoatKind = 'boat' | 'swan' | 'barge'`; `interface BoatRoute { kind: 'line'; pts: XZ[]; width: number } | { kind: 'area'; ring: XZ[]; areaM2: number }`; `boatRoutes(data: CityData, proj: LocalProjection): BoatRoute[]` (waterways width ≥ 6 m; water areas ≥ 5,000 m²); `boatCount(route: BoatRoute): number` (≈ length×width or area / 5,000 m², at least 1, total capped at 60 by the caller); `pointInRing(p: XZ, ring: XZ[]): boolean`; `class Boats { group: THREE.Group; constructor(routes: BoatRoute[], seed: number, toy: boolean); update(dt: number, time: number): void; positions(): XZ[]; dispose(): void }`.
- Consumes: `XZ` from `./geometry`, `LocalProjection`, `toyColor`/`TOY_WATER`-era palette from `./toyPalette` when `toy`.

- [ ] Write `tests/boats.test.ts` with a 200×100 m rectangular lake polygon and a 300 m river line 40 m wide: `boatRoutes` returns both; a 40×40 m pond and a 4 m ditch are skipped; `boatCount` of the lake (20,000 m²) is 4; after `new Boats(routes, 1, true)` and 600 `update(0.1, t)` steps every `positions()` point is inside the lake ring or within width/2 of the river line; `swan` never appears on the river, `barge` never on the lake; `boatRoutes` on data with no water returns `[]` and `new Boats([], 1, true).group.children.length === 0`.
- [ ] Run → FAIL. Implement: area boats pick random target points inside the ring (rejection sampling) and only accept a leg whose sampled points (every 5 m) are all inside; line boats run along the polyline offset to the right of travel, U-turn at the ends. Each kind is a tiny merged low-poly geometry; all kinds share one `InstancedMesh` per material (≤ 2 meshes), per-instance colour; gentle bob (±0.15 m, slow roll). Seeded `rng` from `src/data/rand`.
- [ ] Wire into `CityScene` (style flag can be `true` until Task 4 passes the real style); hide under `TUNNEL_COVERED`-style rules is not needed.
- [ ] Tests, typecheck, build, bench (demo city has a river — report boats and draw calls); screenshot the demo river and a snapshot with a lake (`public/snapshots/`).
- [ ] Commit: `feat: boats, swan pedal boats and barges sail rivers and lakes and stay on the water (sky-weather-transport)`

### Task 4: Style plumbing and the Khối style

**Files:**
- Create: `src/scene/style.ts`, `tests/style.test.ts`
- Modify: `src/scene/CityScene.ts` (`build(data, onProgress, style)`, `style` getter, `exportGLB`), `src/scene/buildings.ts`, `src/scene/prototypes.ts`, `src/scene/toyGeometry.ts` (params instead of constants where Khối needs zeros), `src/scene/landscape.ts`, `src/scene/details.ts`, `src/scene/traffic.ts`, `src/scene/boats.ts` (colours by style), `src/main.ts`, `openstreetmap/index.html`, `src/style.css`

**Interfaces:**
- Produces: `type Style = 'toy' | 'block' | 'real'`; `STYLES: readonly Style[]` = toy, block, real; `STYLE_LABEL` = Đồ chơi, Khối, Siêu thực; `parseStyle(s: string | null): Style | null` (`color`/`mono` → `block`); `toyParamsFor(style: Style): { radius: number; plinthH: number; roofBevel: number; chimneys: boolean; pastel: boolean }` (toy → today's `TOY` values, block/real → zeros/false); `CityScene.build(data, onProgress, style: Style = 'toy')`; `CityScene.style: Style`.
- Consumes: `bakeToyInstance`/`bakeToyInstances` must take the params so GLB export matches the screen.

- [ ] Write `tests/style.test.ts`: `parseStyle` for toy/block/real/color/mono/null/'x'; `toyParamsFor('block')` all zero/false; `toyParamsFor('toy')` equals the current `TOY` values; with block params, `bakeToyInstance` of a 10×6×9 m house returns a bounding box exactly 10×9×6 (no plinth, no rounding); with toy params the result is unchanged from today (reuse an existing toyGeometry test expectation).
- [ ] Run → FAIL. Implement. Khối: original building colours (no `toyColor`), sharp corners, no plinth, no chimneys, master's simpler window look (see `git show master:src/scene/buildings.ts`), landscape/details/traffic/boats in their non-pastel master colours where master had them. Đồ chơi must render pixel-identical to before for the bench scene (compare bench screenshot before/after).
- [ ] UI: style picker (three buttons, `aria-pressed`) beside `#mood-picker` before building; `#btn-style` in the 3D toolbar cycles toy → block → real and shows the current label; switching in 3D rebuilds from `city.data` keeping camera (`saveView`/`restoreView`), time, mood, weather. Persist `tinymap:style` (try/catch); `?style=` wins; old `tinymap:colorMode` read once through `parseStyle`. Until Task 5, `real` builds as `block`.
- [ ] Check Review Focus 1: log `renderer.info.memory` after Toy→Khối→Toy in a scratch Playwright script; geometries/textures return to the first count (±2).
- [ ] Tests, typecheck, build, bench (toy, must match before: 35 calls); screenshots Đồ chơi vs Khối, same view.
- [ ] Commit: `feat: style picker brings back Khối (plain coloured blocks) next to Đồ chơi; switching rebuilds from loaded data (sky-weather-transport)`

### Task 5: Siêu thực style

**Files:**
- Create: `src/scene/realistic.ts` (restored from `git show master:src/scene/realistic.ts`, adapted), `tests/realistic.test.ts` (restored from master, adapted)
- Modify: `src/scene/CityScene.ts`, `src/scene/sky.ts` (dome hidden in real; three `Sky` shown), Task 2's wet-road hook, `src/main.ts`

**Interfaces:**
- Consumes: `Style` (Task 4) — `real` builds Khối geometry then applies realistic materials; `WeatherPreset.rain` (Task 2) drives `realUniforms.uWet` (0 dry, 0.6 rain, 1 storm); `CloudLayer` (Task 1) stays visible over three's `Sky`.
- Produces: `applyRealistic(root, renderer, scene)` / `removeRealistic()` or master's equivalents — keep master's API names.

- [ ] Restore the test file from master first; run → FAIL (module missing). Restore `realistic.ts`; adapt to today's code (moods instead of the removed `lighting()`, sun position from `SunState`, no GTAO unless it fits the budget). Instanced buildings must keep their size and position (Review: a house's world bounding box under real equals the one under block within 1 cm — add this test).
- [ ] Bench with `?demo&bench&style=real` once and report its draw calls/triangles in the report (not a CI gate); default bench unchanged.
- [ ] Screenshots: real at noon, golden, night, and in Mưa.
- [ ] Commit: `feat: Siêu thực style is back: PBR materials, atmospheric sky and wet roads on the Khối geometry (sky-weather-transport)`

### Task 6: Flight data and relay

**Files:**
- Create: `src/data/flights.ts`, `tests/flights.test.ts`, `tests/fixtures/adsbfi-hanoi.json` (already recorded by the controller on 2026-10-28: 13 aircraft from `https://opendata.adsb.fi/api/v2/lat/21.03/lon/105.85/dist/40`; `VJC939` has `alt_baro: "ground"`, `NOPOS` has no `lat`/`lon`), `proxy/flights-worker.js`, `proxy/README.md`, `tests/flightsWorker.test.ts`
- Modify: `vite.config.ts` (`server.proxy['/flights-api']` → `https://opendata.adsb.fi/api`, `changeOrigin: true`)

**Interfaces:**
- Produces: `interface Flight { hex: string; callsign: string; type: string; lat: number; lon: number; altM: number; gsMs: number; trackDeg: number; seenAt: number }`; `parseFlights(json: unknown, now: number): Flight[]` (accepts `aircraft` or `ac`; skips rows without numeric lat/lon; `"ground"` → altM 0; feet → m, knots → m/s; `seen_pos` subtracts from `now`); `DEFAULT_FLIGHTS_RELAY = ''`; `flightsRelay(search: string, storage: Storage | null, dev: boolean): string | null` (`?flights=` > `tinymap:flightsRelay` > `DEFAULT_FLIGHTS_RELAY` > `'/flights-api'` when `dev` > null); `flightsUrl(relay: string, lat: number, lon: number, nm: number): string` → `<relay>/v2/lat/<lat 4dp>/lon/<lon 4dp>/dist/<nm>`; `fetchFlights(relay, lat, lon, nm, signal?): Promise<Flight[]>` (throws on non-2xx); worker `export default { fetch(request) }` and `export function relayPath(url: URL): string | null` (only `/v2/lat/<num>/lon/<num>/dist/<1-250>`), origin allowlist `https://danny-exnodes.github.io`, `http://localhost:5173`, 10 s cache.

- [ ] Write `tests/flights.test.ts` against the fixture: count = 12 (rows with lat/lon); ground row altM 0; `LAO924` (38,000 ft) → 11,582.4 m ±1; its 475.2 kt → 244.5 m/s ±0.1; callsign trimmed; `parseFlights({})` → `[]`, `parseFlights(null)` → `[]`; `flightsRelay` precedence (5 cases incl. `dev=false` + nothing → null); `flightsUrl('/flights-api', 21.03, 105.85, 40)` → `/flights-api/v2/lat/21.0300/lon/105.8500/dist/40`; `fetchFlights` with a stubbed `fetch` returning 429 rejects.
- [ ] Write `tests/flightsWorker.test.ts`: `relayPath` accepts the valid path, rejects `/v2/all`, `/../x`, dist 0 and 999, non-numeric lat; `fetch` with a disallowed `Origin` → 403; allowed origin echoes `Access-Control-Allow-Origin` (stub global `fetch` and `caches`).
- [ ] Run → FAIL. Implement. Then check the dev proxy for real once: `curl -s localhost:5173/flights-api/v2/lat/21.03/lon/105.85/dist/40 | head -c 200` (report the output; network in this one manual check only).
- [ ] Commit: `feat: live flight data from adsb.fi through a relay: parser, dev proxy, Cloudflare Worker source (sky-weather-transport)`

### Task 7: Planes in the scene

**Files:**
- Create: `src/scene/aircraft.ts`, `tests/aircraft.test.ts`
- Modify: `src/scene/CityScene.ts`, `src/main.ts`, `openstreetmap/index.html` (`#btn-flights`), `src/style.css`

**Interfaces:**
- Consumes: `Flight`, `fetchFlights`, `flightsRelay`, `flightsUrl` (Task 6).
- Produces: `displayRadius(d: number, half: number): number` (identity for d ≤ half; above, monotonic and `displayRadius(74_080, half) ≤ 3 * half`); `displayAltitude(altM: number): number` (0 → 150, ≥ 12,000 → 900, monotonic); `deadReckon(f: Flight, now: number): { lat: number; lon: number }`; `class Aircraft { group: THREE.Group; constructor(proj: LocalProjection, half: number); setFlights(fs: Flight[], now: number): void; update(now: number, camera: THREE.Camera): void; pick(ray: THREE.Raycaster): Flight | null; dispose(): void }` (drops flights older than 60 s; one `InstancedMesh`, plane drawn ~4× real size; labels for the 6 nearest via the scene's label layer).

- [ ] Write `tests/aircraft.test.ts`: `displayRadius` identity below half, monotonic, cap; `displayAltitude` ends and monotonic; `deadReckon` of a flight heading 90° at 100 m/s after 10 s moves ≈1,000 m east (±5 m) and not north; `setFlights` then `update(now + 61_000)` hides that plane (`mesh.count` 0).
- [ ] Run → FAIL. Implement `aircraft.ts` (lazy-imported by `CityScene`/`main.ts` only when planes are on).
- [ ] UI: `#btn-flights` ✈ toggle, `aria-pressed`, on by default when `flightsRelay(...)` is not null, hidden in bench; poll every 15 s while the 3D view is visible and the tab is visible (`document.visibilityState`), abort on area change; info line `✈ N máy bay · adsb.fi · cập nhật hh:mm:ss`; no relay → `✈ Chưa cấu hình nguồn chuyến bay` ; fetch error → `✈ Không lấy được dữ liệu chuyến bay` and keep last planes until stale. Click on a plane shows callsign, type, altitude (m), speed (km/h) in the existing info card or a small popup.
- [ ] Manual check in dev (real network through the proxy): build the Khương Thượng example, wait 30 s, screenshot with planes; report how many came back.
- [ ] Tests, typecheck, build, bench (planes off → unchanged).
- [ ] Commit: `feat: live planes over the map: toy aircraft placed from adsb.fi with compressed distance and altitude, labels, click info (sky-weather-transport)`

### Task 8: Budgets, docs, checkpoint

**Files:**
- Modify: `src/scene/landscape.ts` (night bulb segments, only if needed), `README.md`, `CLAUDE.md` (point to v0.0.7), `bench/budget.json` (only if a ruling allows)
- Create: `docs/releases/v0.0.7.md` (same structure as `docs/releases/v0.0.6.md`, Vietnamese)

- [ ] Measure the forced-clock bench (scratch `b.cjs` pattern: `?demo&bench` with the slider forced) at 06:00, 12:00, 17:30, 19:00, 23:00 for toy/clear, and 17:30 toy/storm. If 17:30 > 570,000 triangles, reduce night-bulb sphere segments until it is ≤ 570,000, re-measure.
- [ ] Write v0.0.7 checkpoint: what changed per feature, rulings from the ledger, per-hour table, relay deployment steps for the owner, known limits (planes positions compressed; no planes on the published site until the Worker is deployed).
- [ ] README: styles, sky, weather selector, boats, planes + relay setting.
- [ ] typecheck, test, build, bench.
- [ ] Commit: `docs: v0.0.7 checkpoint for styles, sky, weather, boats and live planes; worst-hour triangle headroom (sky-weather-transport)`
