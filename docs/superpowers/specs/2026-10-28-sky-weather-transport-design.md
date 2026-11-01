# Styles back, sky, weather, boats and live planes (OSM page)

Date: 2026-10-28 · Branch: `feature/sky-weather-transport` (based on `feature/toy-style`, PR #35, which is not merged yet) · Page: `/openstreetmap/` only; the Google page (`/`) is untouched.

## Request (owner, verbatim)

1. Bring back the style selection button (Khối, siêu thực, Đồ chơi (toy, the current one)).
2. Add a sky to the scene.
3. Add a weather selector to switch between different weather conditions.
4. Add land and water transportation vehicles.
5. Add air transportation, including airplanes with real-time flight data fetched from live flight tracking APIs.

The owner skipped the design questions ("just go ahead"). Everything below that is not in the request is **the agent's call**, marked (call), and recorded so the owner can overturn it.

## What exists already (do not rebuild)

- Land traffic: motorbikes, cars, buses, trucks and bicycles on roads, people on paths, trains on rail lines (`src/scene/traffic.ts`). Item 4 therefore adds **water** vehicles; land stays as it is. (call)
- Weather: live conditions from Open-Meteo (`src/services/weather.ts`), `CityScene.setCloud(c)`, `CityScene.setRain(on)`, a rain toggle `#btn-rain`.
- Moods: `moodLighting(sun, rising, cloud)` gives `sky`, sun and hemisphere colours for the time of day. Background today is the flat colour `L.sky` plus `THREE.Fog`.
- Master's old styles live in git: `git show master:src/scene/colorMode.ts`, `master:src/scene/realistic.ts` (742 lines; PBR material swap, three's `Sky`, wet roads), `master:tests/realistic.test.ts`, and the `#btn-mono` / `?style=` / `tinymap:colorMode` plumbing in `master:src/main.ts`.

## Decisions

### 1. Styles: Khối / Siêu thực / Đồ chơi
- "Khối" means master's **"Có màu"** look: plain coloured blocks with the buildings' own colours (no pastel mapping), sharp corners, no plinth, no chimneys. Master's "Đơn sắc" is not coming back. (call)
- "Siêu thực" is master's realistic view: PBR materials with procedural detail, three's atmospheric `Sky`, wet roads in rain, on top of the **Khối** geometry. (call)
- "Đồ chơi" stays exactly as on `feature/toy-style` and stays the default.
- Pick the style **before building** (next to the mood picker) and switch it in the 3D toolbar with one button `#btn-style` that cycles Đồ chơi → Khối → Siêu thực, its label naming the current style. The choice persists in `localStorage` `tinymap:style` and can be forced with `?style=toy|block|real`. Old values `color`/`mono` read as `block`. (call)
- Switching style in 3D **rebuilds the scene from the data already loaded** (no network), keeping the camera, time, mood and weather. Build-time style is simpler than live uniforms because toy colours, geometry and the GLB bake all depend on it. (call) GLB export matches the style on screen.
- Toy instancing places vertices in the vertex shader (`aCorner`, `aOffset`, …). Siêu thực must not swap that shader away and collapse the houses: realistic materials either keep the same vertex placement or the Khối style builds non-toy geometry. Either is fine as long as houses keep their real size.

### 2. Sky
- A sky dome replaces the flat background in Đồ chơi and Khối: vertical gradient, horizon colour = the mood's `sky` colour (so fog blends into it), zenith a deeper tint of it, a soft sun glow on the sun's side, a few stars at night. Not affected by fog, follows the camera. (call)
- Low-poly puffy clouds (one instanced mesh) drifting slowly; how many depends on the cloud cover (0 → none, 1 → overcast). They use the mood lighting so they turn pink at golden hour and grey-blue at night. (call)
- Siêu thực uses three's `Sky` as master did, with the same cloud layer.
- Budget: sky + clouds ≤ 2 draw calls, ≤ 6,000 triangles.

### 3. Weather selector
- Choices (call): **Tự động** (live Open-Meteo, today's behaviour, default) · **Nắng** · **Nhiều mây** · **Mưa** · **Dông** (heavier slanted rain, dark sky, lightning flashes) · **Sương mù**. No snow (Việt Nam).
- One toolbar button `#btn-weather` (replaces `#btn-rain`) showing the current choice's icon; it opens a small menu of the six. Persists in `tinymap:weather`; `?weather=auto|clear|cloudy|rain|storm|fog`. In Tự động, the weather card shows the live reading; in the others it says the weather is chosen by hand. (call)
- Each choice maps to: cloud cover, rain amount (none / normal / heavy), wind slant, fog distance, lightning on/off, light dimming. Lightning = a short (≤ 150 ms) brightening of the hemisphere light every 4–12 s plus a brief flash in the clouds; never strobe faster than that (photosensitivity).
- Siêu thực roads get wet in Mưa/Dông (master's `uWet`).
- Bench pins weather to Nắng (no network in CI).

### 4. Boats (water vehicles)
- Boats sail on waterways (`data.waterways`, width ≥ 6 m) along their line, and on water areas (`data.areas` kind `water`) ≥ 0.5 ha, wandering between random points inside the polygon. They never leave the water. (call)
- Kinds: small boat (all water), swan pedal boat (lakes only, Hồ Tây style), barge (rivers ≥ 30 m wide). Toy pastel colours in Đồ chơi, plain colours in Khối/Siêu thực. Density ≈ 1 per 5,000 m² of water, capped at 60. (call)
- ≤ 2 draw calls, ≤ 15,000 triangles total. They bob gently.

### 5. Live planes
- **Data:** readsb JSON from `opendata.adsb.fi` (`/api/v2/lat/{lat}/lon/{lon}/dist/{nm}`), polled every 15 s within 40 nm of the area centre. (call) Free feeds have no CORS headers (checked from a browser on 2026-10-28: adsb.fi, adsb.lol, OpenSky, airplanes.live all fail), so the page talks to a **relay**:
  - dev: a Vite `server.proxy` route `/flights-api` → `https://opendata.adsb.fi/api`;
  - published site: a Cloudflare Worker whose source lives in the repo (`proxy/flights-worker.js`): only forwards that one path pattern, allows only the app's origins, caches 10 s at the edge. **Deploying it is the owner's step**; its URL is then set in `src/data/flights.ts` (`DEFAULT_FLIGHTS_RELAY`, empty for now) or by the user in `localStorage` `tinymap:flightsRelay` / `?flights=<url>`.
  - With no relay configured, or when the fetch fails, there are **no planes**, and a one-line note says why. Never fake planes. (call)
- **Display:** a low-poly toy plane per aircraft (one instanced mesh; helicopters drawn as planes), heading from `track`, moving smoothly between polls by dead reckoning from `gs`/`track`, dropped after 60 s without an update. Real positions would be invisible (planes 1–10 km up, the model 1–2 km wide), so: horizontal distance from the centre is true inside the model and compressed outside it (40 nm lands within about 3× the model's half-size), altitude is compressed to 150–900 m, and planes are drawn about 4× real size. Positions are therefore "where, roughly", not survey-accurate. (call)
- A label with the callsign (DOM label like POIs) on the nearest few planes; clicking a plane shows callsign, type, altitude in m, speed in km/h. A toolbar toggle `#btn-flights` (✈), on by default when a relay is set. (call)
- Lazy-loaded module; off in `?bench`. ≤ 1 draw call, ≤ 10,000 triangles.

## Constraints
- Bench (`?demo&bench`, noon, toy, Nắng, no planes) stays ≤ 40 draw calls and ≤ 500k triangles. Today: 35 / 443,596.
- Worst hour (17:30) was 598,972 triangles against the 600k CI limit. After this work it must be ≤ 570k (5% headroom); fewer night-bulb segments is allowed to get there.
- `npm run typecheck && npm test && npm run build` green on every commit; Vietnamese UI copy; no new npm dependencies (three addons are fine).
- No network in tests or in bench; flights tested with a recorded fixture.
- Close with a checkpoint `docs/releases/v0.0.7.md` in the same structure as v0.0.6, and README updated.

## Non-goals
Snow, ships on the sea, flight paths/history, airports, sounds, a flight list panel, new land vehicle kinds.

## Owner steps after merge
Deploy `proxy/flights-worker.js` (Cloudflare, free plan) and put its URL in `DEFAULT_FLIGHTS_RELAY`; until then the published site shows no planes. Create/label the issue for this work (repo process).
