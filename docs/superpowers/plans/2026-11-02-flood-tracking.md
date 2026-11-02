# Flood Points Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 💧 toggle on the OSM page that shows flooded stations (Hà Nội, observed) and flood-risk zones (TP.HCM, forecast) around the built area, as blue discs with labels and one line in the info card.

**Architecture:** Two undocumented JSON feeds without CORS are reached through two new paths on the existing Cloudflare relay (`proxy/flights-worker.js`). A pure data module parses both into one `FloodPoint` shape; a lazily loaded scene layer draws them like the planes; `main.ts` polls every 5 minutes while the toggle is on.

**Tech Stack:** TypeScript, Three.js (`InstancedMesh`), Vitest, Cloudflare Worker (plain JS), Vite dev proxy.

**Spec:** `docs/superpowers/specs/2026-11-02-flood-tracking-design.md`

## Global Constraints

- Start Task 2 only after PR #43 (`fix/flights-relay`) is merged; first `git rebase master`. Task 2 edits the adsb.lol version of the worker.
- **Do not deploy the relay or merge the branch** until the owner confirms permission from HSDC and Tuổi Trẻ Thành phố Bác (spec, "Permission gate").
- No new npm dependencies. Vietnamese UI copy, exact strings as given in the tasks.
- No network in tests: use `tests/fixtures/hsdc-hanoi.json` (45 stations, all `Flood_level1`) and `tests/fixtures/tuoitre-forecasts.json` (11 zones: 6 `low`, 5 `watch`), saved 2026-11-02.
- `npm run typecheck && npm test && npm run build` green on every commit. The layer is off in `?bench`, so the bench budget (40 draw calls, 500k triangles) does not change.
- Upstreams: `https://thoatnuochanoi.vn/ungngap/api/flood/getflood` and `https://bandotrieucuong.tuoitrethanhphobac.vn/api/forecasts`.
- Region boxes: Hà Nội `20.53–21.39 N, 105.28–106.03 E`; TP.HCM `10.30–11.20 N, 106.30–107.20 E`.

## Review Focus

1. HSDC `Icon` values never seen yet (`Flood_level4.png`, a renamed file, empty): must map to a level without throwing. Test in Task 1 (`hsdcLevel`).
2. Bad coordinates in a feed (`"Lat": ""`, `"21,03"`, missing): that point is skipped, the rest still show. Test in Task 1 (`parseHsdc skips points without a usable position`).
3. Upstream returns an HTML error page or 5xx: the card says `💧 Không lấy được dữ liệu ngập`, previous discs stay, polling continues. Test in Task 1 (`fetchFlood rejects on non-JSON and on 5xx`); wiring in Task 4.
4. Area outside both cities: no request is made at all. Test in Task 1 (`floodRegion`), wiring in Task 4.
5. A TP.HCM zone (`radius_m` 900) bigger than the model: the disc is clamped to the model, not spilling across the ground slab. Test in Task 3 (`clamps a large zone to half the model`).

---

### Task 1: Flood data module

**Files:**
- Create: `src/data/flood.ts`
- Test: `tests/flood.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FloodLevel = 0 | 1 | 2 | 3;
  export type FloodRegion = 'hanoi' | 'hcm';
  export interface FloodPoint { id: string; name: string; lat: number; lon: number; level: FloodLevel; radiusM: number; source: FloodRegion }
  export const FLOOD_SOURCE: Record<FloodRegion, string>; // { hanoi: 'Thoát nước Hà Nội', hcm: 'Bản đồ triều cường (Tuổi Trẻ)' }
  export function hsdcLevel(icon: unknown): FloodLevel;
  export function tuoiTreLevel(level: unknown): FloodLevel;
  export function parseHsdc(json: unknown): FloodPoint[];
  export function parseTuoiTre(json: unknown): FloodPoint[];
  export function floodRegion(lat: number, lon: number): FloodRegion | null;
  export function floodUrl(relay: string, region: FloodRegion): string;
  export function fetchFlood(relay: string, region: FloodRegion, signal?: AbortSignal): Promise<FloodPoint[]>;
  export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number;
  export function floodSummary(points: FloodPoint[], region: FloodRegion, lat: number, lon: number, time: string): string;
  ```

- [ ] **Step 1: Write the failing tests** in `tests/flood.test.ts` (fixtures read with `readFileSync` + `JSON.parse`, as `tests/flights.test.ts` does):

```ts
describe('hsdcLevel', () => {
  it('maps Flood_level<N> to N-1, clamped, and anything else to 0', () => {
    expect(hsdcLevel('202608311105287262087_Flood_level1.png')).toBe(0);
    expect(hsdcLevel('x_Flood_level2.png')).toBe(1);
    expect(hsdcLevel('x_Flood_level4.png')).toBe(3);
    expect(hsdcLevel('x_Flood_level9.png')).toBe(3);
    for (const v of ['', 'flood.png', null, 42, undefined]) expect(hsdcLevel(v)).toBe(0);
  });
});
describe('tuoiTreLevel', () => {
  it('maps the named levels and treats unknown ones as 1', () => {
    expect([tuoiTreLevel('low'), tuoiTreLevel('watch'), tuoiTreLevel('high')]).toEqual([0, 1, 2]);
    for (const v of ['severe', 'critical', 'very_high']) expect(tuoiTreLevel(v)).toBe(3);
    expect(tuoiTreLevel('new-level')).toBe(1);
    expect(tuoiTreLevel(undefined)).toBe(1);
  });
});
describe('parseHsdc', () => {
  it('reads the recorded 45 stations', () => {
    const ps = parseHsdc(hsdcFixture);
    expect(ps).toHaveLength(45);
    expect(ps[0]).toEqual({ id: 'hn-3', name: 'Cao Bá Quát (cổng Cty Môi trường đô thị)', lat: 21.03018, lon: 105.8395, level: 0, radiusM: 0, source: 'hanoi' });
  });
  it('sizes stations by level: 40, 70, 100 m', () => {
    const one = (icon: string) => parseHsdc({ Code: 1, Content: [{ TramId: '1', TenTram: 'A', Lat: '21.03', Lng: '105.85', Icon: icon }] })[0].radiusM;
    expect([one('x_Flood_level2.png'), one('x_Flood_level3.png'), one('x_Flood_level4.png')]).toEqual([40, 70, 100]);
  });
  it('skips points without a usable position', () => {
    const c = [{ TramId: '1', TenTram: 'A', Lat: '', Lng: '105.8' }, { TramId: '2', TenTram: 'B', Lat: '21,03', Lng: '105.8' }, { TramId: '3', TenTram: 'C' }, { TramId: '4', TenTram: 'D', Lat: '21.03', Lng: '105.85' }];
    expect(parseHsdc({ Code: 1, Content: c }).map((p) => p.id)).toEqual(['hn-4']);
    for (const junk of [null, {}, { Content: 'x' }, []]) expect(parseHsdc(junk)).toEqual([]);
  });
});
describe('parseTuoiTre', () => {
  it('reads the recorded 11 zones with their radius', () => {
    const ps = parseTuoiTre(ttFixture);
    expect(ps).toHaveLength(11);
    expect(ps[0]).toMatchObject({ id: 'hcm-1', name: 'Thảo Điền - An Khánh', lat: 10.803, lon: 106.735, level: 0, radiusM: 900, source: 'hcm' });
    expect(ps.filter((p) => p.level === 1)).toHaveLength(5);
  });
});
describe('floodRegion', () => {
  it('knows Hà Nội and TP.HCM and nothing else', () => {
    expect(floodRegion(21.03, 105.85)).toBe('hanoi');
    expect(floodRegion(10.78, 106.7)).toBe('hcm');
    expect(floodRegion(16.05, 108.2)).toBeNull(); // Đà Nẵng
    expect(floodRegion(NaN, 105.85)).toBeNull();
  });
});
describe('fetchFlood', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('calls <relay>/flood/<region> and parses by region', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(hsdcFixture)));
    vi.stubGlobal('fetch', f);
    expect(await fetchFlood('https://r.test/', 'hanoi')).toHaveLength(45);
    expect((f.mock.calls[0] as unknown[])[0]).toBe('https://r.test/flood/hanoi');
  });
  it('fetchFlood rejects on non-JSON and on 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>down</html>')));
    await expect(fetchFlood('/flights-api', 'hcm')).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })));
    await expect(fetchFlood('/flights-api', 'hcm')).rejects.toThrow();
  });
});
describe('floodSummary', () => {
  const at = (level: FloodLevel, dLat: number): FloodPoint => ({ id: 'x' + dLat, name: 'X', lat: 21.03 + dLat, lon: 105.85, level, radiusM: 40, source: 'hanoi' });
  it('counts level >= 1 within 5 km, with observed or forecast wording', () => {
    expect(floodSummary([at(2, 0.01), at(1, 0.02), at(0, 0.01), at(3, 0.1)], 'hanoi', 21.03, 105.85, '14:05')).toBe('💧 2 điểm đang ngập trong 5 km · Thoát nước Hà Nội · cập nhật 14:05');
    expect(floodSummary([], 'hanoi', 21.03, 105.85, '14:05')).toBe('💧 Không có điểm ngập nào trong 5 km · Thoát nước Hà Nội · cập nhật 14:05');
    expect(floodSummary([{ ...at(1, 0), source: 'hcm' }], 'hcm', 21.03, 105.85, '14:05')).toBe('💧 1 điểm có nguy cơ ngập trong 5 km · Bản đồ triều cường (Tuổi Trẻ) · cập nhật 14:05');
    expect(floodSummary([], 'hcm', 21.03, 105.85, '14:05')).toBe('💧 Không có điểm nguy cơ ngập nào trong 5 km · Bản đồ triều cường (Tuổi Trẻ) · cập nhật 14:05');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/flood.test.ts`. Expected: FAIL, cannot resolve `../src/data/flood`.

- [ ] **Step 3: Implement `src/data/flood.ts`.** Parse defensively (`Number(...)` on strings, `Number.isFinite` checks; a comma decimal is not a number). HSDC: `id = 'hn-' + TramId`, `name = TenTram`, `radiusM = [0, 40, 70, 100][level]`. Tuổi Trẻ: `id = 'hcm-' + zone_id`, `radiusM = radius_m` (0 when missing). `floodUrl` strips trailing slashes like `flightsUrl` does. `fetchFlood` throws on `!res.ok` and lets `res.json()` throw on HTML. `distanceKm`: equirectangular (`cos` of mean latitude), enough at 5 km.

- [ ] **Step 4: Run** `npx vitest run tests/flood.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/flood.ts tests/flood.test.ts tests/fixtures/hsdc-hanoi.json tests/fixtures/tuoitre-forecasts.json
git commit -m "feat: flood data from Thoát nước Hà Nội and Bản đồ triều cường (parse, region, summary)"
```

### Task 2: Relay routes

**Files:**
- Modify: `proxy/flights-worker.js` (the `relayPath`/`fetch` code)
- Modify: `vite.config.ts:57` (dev proxy)
- Modify: `proxy/README.md`
- Test: `tests/flightsWorker.test.ts`

**Interfaces:**
- Consumes: `floodUrl` paths from Task 1 (`/flood/hanoi`, `/flood/hcm`).
- Produces: `export function upstreamFor(url: URL): string | null` in the worker. The full upstream URL for an allowed path, else null. `relayPath` stays exported and unchanged.

- [ ] **Step 1: Write the failing tests** (add to `tests/flightsWorker.test.ts`):

```ts
describe('upstreamFor', () => {
  it('maps the readsb query and the two flood paths, nothing else', () => {
    expect(upstreamFor(u('/v2/lat/21.0300/lon/105.8512/dist/40'))).toBe('https://api.adsb.lol/v2/lat/21.03/lon/105.85/dist/40');
    expect(upstreamFor(u('/flood/hanoi'))).toBe('https://thoatnuochanoi.vn/ungngap/api/flood/getflood');
    expect(upstreamFor(u('/flood/hcm'))).toBe('https://bandotrieucuong.tuoitrethanhphobac.vn/api/forecasts');
    for (const p of ['/flood', '/flood/', '/flood/danang', '/flood/hanoi/', '/flood/hanoi/x', '/flood/HANOI', '//flood/hanoi']) expect(upstreamFor(u(p))).toBeNull();
  });
});
// inside describe('fetch'):
it('forwards /flood/hanoi for an allowed origin and 403s a foreign one', async () => {
  const r = await run('https://danny-exnodes.github.io', '/flood/hanoi');
  expect(r.status).toBe(200);
  expect((up.mock.calls[0] as unknown[])[0]).toBe('https://thoatnuochanoi.vn/ungngap/api/flood/getflood');
  expect((await run('https://evil.test', '/flood/hanoi')).status).toBe(403);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/flightsWorker.test.ts`. Expected: FAIL, `upstreamFor` is not exported.

- [ ] **Step 3: Implement.** A `FLOOD` map `{ '/flood/hanoi': '<HSDC url>', '/flood/hcm': '<Tuổi Trẻ url>' }`, looked up by exact `url.pathname`. `upstreamFor` returns `FLOOD[path]` or `UPSTREAM + relayPath(url)`. In `fetch`, use `upstreamFor` for both the upstream request and the cache key (`new Request(upstream)`). Flood responses get `Cache-Control: public, max-age=60`; flights keep 10 s. Send `User-Agent: tinymap-flights/1.0 (+https://github.com/danny-exnodes/3d-map)` on upstream requests. Update the header comment and `proxy/README.md` (the two new paths, their sources, that data is shown with permission).
  In `vite.config.ts`, add `'/flights-api/flood/hanoi'` and `'/flights-api/flood/hcm'` proxy entries **before** `'/flights-api'` (Vite matches keys in order), each with `changeOrigin: true` and a `rewrite` to the upstream path.

- [ ] **Step 4: Run** `npx vitest run tests/flightsWorker.test.ts`. Expected: PASS. Then `npm run typecheck`. Expected: exit 0.

- [ ] **Step 5: Check from Cloudflare without deploying.** In `proxy/`: `npx wrangler dev flights-worker.js --remote --compatibility-date 2026-10-01`, then
  `curl -s -H 'Origin: http://localhost:5173' localhost:8787/flood/hanoi | head -c 200` and the same for `/flood/hcm`.
  Expected: JSON from both. If an upstream answers 403 from Cloudflare (as adsb.fi did), stop and report: that source needs another route (baked by the owner's machine, or a different host).

- [ ] **Step 6: Commit**

```bash
git add proxy/flights-worker.js proxy/README.md vite.config.ts tests/flightsWorker.test.ts
git commit -m "feat: relay /flood/hanoi and /flood/hcm (no CORS upstream), dev proxy for both"
```

### Task 3: Flood layer in the scene

**Files:**
- Create: `src/scene/flood.ts`
- Modify: `src/scene/CityScene.ts` (fields near `:86-89`, `clear` near `:413`, frame loop near `:820`, new methods after `setFlights` near `:536`)
- Modify: `src/style.css:109` (label style)
- Test: `tests/floodLayer.test.ts`

**Interfaces:**
- Consumes: `FloodPoint` from Task 1; `LocalProjection` from `src/geo/projection.ts`.
- Produces:
  ```ts
  export class FloodLayer {
    readonly group: THREE.Group;
    readonly mesh: THREE.InstancedMesh;
    constructor(proj: LocalProjection, half: number, opts?: { labelLayer?: HTMLElement });
    setPoints(points: FloodPoint[]): void;
    updateLabels(camera: THREE.Camera): void;
    dispose(): void;
  }
  // CityScene:
  setFlood(points: FloodPoint[] | null): Promise<void>; // null removes the layer
  get floodCount(): number;                              // discs drawn
  ```

- [ ] **Step 1: Write the failing tests** in `tests/floodLayer.test.ts` (projection set up as in `tests/aircraft.test.ts`, bbox around 21.03 N, 105.85 E, `half = 400`):

```ts
const p = (o: Partial<FloodPoint>): FloodPoint => ({ id: 'a', name: 'A', lat: 21.03, lon: 105.85, level: 2, radiusM: 70, source: 'hanoi', ...o });
it('draws flooded points inside the model and skips dry or outside ones', () => {
  const l = new FloodLayer(proj, 400);
  l.setPoints([p({}), p({ id: 'b', level: 0 }), p({ id: 'c', lat: 21.2 })]);
  expect(l.mesh.count).toBe(1);
  l.dispose();
});
it('clamps a large zone to half the model', () => {
  const l = new FloodLayer(proj, 400);
  l.setPoints([p({ radiusM: 900, source: 'hcm', level: 1 })]);
  const m = new THREE.Matrix4(); l.mesh.getMatrixAt(0, m);
  expect(new THREE.Vector3().setFromMatrixScale(m).x).toBeCloseTo(400);
  l.dispose();
});
it('caps the disc count at 64', () => {
  const l = new FloodLayer(proj, 400);
  l.setPoints(Array.from({ length: 80 }, (_, i) => p({ id: 'p' + i })));
  expect(l.mesh.count).toBe(64);
  l.dispose();
});
```

- [ ] **Step 2: Run** `npx vitest run tests/floodLayer.test.ts`. Expected: FAIL, cannot resolve `../src/scene/flood`.

- [ ] **Step 3: Implement `FloodLayer`.**
  - One `InstancedMesh` of `CircleGeometry(1, 32)` rotated flat, capacity 64, `MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false })`, `renderOrder = -3`, y = 0.3, name `'flood'`.
  - A point is drawn when `level >= 1` and its projected centre lies inside `|x| <= half && |z| <= half`. Scale = `min(radiusM, half)`.
  - Labels: when `labelLayer` is given, one `div.poi-label.flood-label` per drawn point with `textContent = name` (text only, never HTML). Positions are projected in `updateLabels` the way `Aircraft.updateLabels` does (hide when behind the camera or off-screen).
  - CityScene:
    - `setFlood` lazy-imports `./flood` (like `setPlanes`) and keeps the last points so a rebuilt scene can redraw them.
    - `clear` drops the layer next to `dropAircraft()`.
    - The frame loop calls `this.flood?.updateLabels(this.camera)` after the aircraft update.
  - CSS: `.flood-label { background: #2563eb; }` and `.flood-label::before { content: '💧 '; }`.

- [ ] **Step 4: Run** `npx vitest run tests/floodLayer.test.ts`. Expected: PASS. Then `npm run typecheck`. Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/scene/flood.ts src/scene/CityScene.ts src/style.css tests/floodLayer.test.ts
git commit -m "feat: flood layer (blue discs and labels) in the 3D scene"
```

### Task 4: Toggle, polling and card line

**Files:**
- Modify: `openstreetmap/index.html:113` (card line), `:124` (button)
- Modify: `src/main.ts` (next to the flights block, `:976-1114`; calls at `:316`, `:962-963`, `:1104`, `:1111`)

**Interfaces:**
- Consumes: `floodRegion`, `fetchFlood`, `floodSummary` (Task 1); `CityScene.setFlood`, `floodCount` (Task 3); `flightsSource` (existing relay base in `main.ts`).

- [ ] **Step 1: Markup.**
  - `<div class="muted small" id="i-flood" hidden></div>` goes right after `#i-flights`.
  - `<button id="btn-flood" class="toggle" title="Điểm ngập (Hà Nội, TP.HCM)" aria-pressed="false">💧</button>` goes right after `#btn-flights`.

- [ ] **Step 2: Wiring in `main.ts`**, mirroring the flights block:
  - `FLOOD_KEY = 'tinymap:flood'`.
  - `floodOn = !BENCH && (?flood=1 → true, ?flood=0 → false, else stored '1')`, default false.
  - `FLOOD_POLL_MS = 300_000`, `FLOOD_TIMEOUT_MS = 15_000`.
  - `showFloodLine()`: button `.on`/`aria-pressed`, hidden in BENCH, disabled when `!flightsSource || busy`. Line text: `''` when off.
  - `syncFlood()`:
    - when off: `city.setFlood(null)` and clear the line;
    - when on: region from the area centre; `null` → line `💧 Chưa có dữ liệu ngập cho khu vực này`, no request;
    - else `pollFlood()`.
  - `pollFlood()`:
    - `fetchFlood(flightsSource, region, signal)` → `city.setFlood(points)`;
    - line = `floodSummary(points, region, lat, lon, HH:MM)`;
    - on error: `💧 Không lấy được dữ liệu ngập`, keep the old points;
    - reschedule while on and visible, aborting on toggle off, view change or rebuild.
  - Click handler: flip `floodOn`, store `'1'`/`'0'` (try/catch, as `FLIGHTS_KEY`), `syncFlood()`.
  - Call `syncFlood()` at each place `syncFlights()` is called, and stop it in `rebuildInStyle` next to `stopFlights()`.

- [ ] **Step 3: Run** `npm run typecheck && npm test && npm run build`. Expected: typecheck exit 0, all tests pass, build OK.

- [ ] **Step 4: Check in the browser** (dev server, relay not deployed: set `localStorage.setItem('tinymap:flightsRelay', '/flights-api')` so requests go through the Vite proxy):
  - Hà Nội `#bbox=21.025,105.835,21.035,105.845` (contains station "Cao Bá Quát"), 💧 on. Expected: the line reads `💧 … trong 5 km · Thoát nước Hà Nội · cập nhật …`. A dry day shows "Không có điểm ngập nào"; that's correct.
  - To see a disc on a dry day, stub one station to level 3 in DevTools: `fetch` override returning the fixture with one `Icon` set to `x_Flood_level4.png`. Expected: blue disc and `💧 Cao Bá Quát…` label.
  - TP.HCM `#bbox=10.798,106.730,10.808,106.740` (Thảo Điền). Expected: the forecast wording.
  - Đà Nẵng `#bbox=16.05,108.20,16.06,108.21`. Expected: `💧 Chưa có dữ liệu ngập cho khu vực này`, and no request in the Network panel.
  - Reload: the toggle state persists. `?flood=0` forces it off.
  - Remove the localStorage relay afterwards.

- [ ] **Step 5: Commit**

```bash
git add openstreetmap/index.html src/main.ts
git commit -m "feat: 💧 flood toggle: polls every 5 min, card line, persists in tinymap:flood"
```

### Task 5: Docs and checkpoint

**Files:**
- Modify: `README.md` (feature line next to "Máy bay thật", line 48; data source table)
- Create: `docs/releases/v0.0.9.md` via the `release-checkpoint` project skill

- [ ] **Step 1:** README:
  - add a "**Điểm ngập**" bullet saying what each city shows (observed vs forecast), that it updates every 5 minutes, and that it needs the relay;
  - add the two sources to the data source table, noting "dùng khi được phép".
- [ ] **Step 2:** Write the checkpoint with the `release-checkpoint` skill. List the owner steps from the spec, including the level mapping to confirm on a rainy day.
- [ ] **Step 3: Run** `npm run typecheck && npm test && npm run build`. Expected: all green.
- [ ] **Step 4: Commit** `git commit -am "docs: v0.0.9 checkpoint, README flood points"` (add the new checkpoint file first).
