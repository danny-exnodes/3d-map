# Toy style for the OpenStreetMap builder: design

> Date: 2026-10-27 · Page: `/openstreetmap/` (`src/main.ts`, `src/scene/`) · Status: draft, waiting for the owner's approval

## 1. Intent

The owner wants the city model to look **cozy and toy-like**, in the spirit of the "cozy low-poly" models on CGTrader (https://www.cgtrader.com/low-poly-3d-models/cozy). Today the model aims at realism: cool white light, grey weathered facades, sharp boxes, and a "Siêu thực" mode with physically based materials. The new direction is a miniature you want to pick up: chunky rounded houses, soft pastel colours, plump trees, soft shadows, and a tilt-shift blur that makes the whole thing read as a table-top model.

The look was chosen from browser mockups during brainstorming (four moods, each shown as "Soft" and "Toy"). The owner picked **Toy** and asked for it to **replace** the existing styles.

## 2. Goals

1. **One visual style: Toy.** It replaces the three current styles: Có màu, Đơn sắc (#7) and Siêu thực (#19). The "Soft" variant from the mockups is not kept either.
2. **Four moods tied to the day/night cycle.** The cycle passes through the moods in order:

   | Sun position | Mood | Character |
   | --- | --- | --- |
   | Morning, sun rising | **A · Clean daylight** | cool, clear, bright |
   | Sun high | **B · Sunny pastel** | warm noon, soft blue sky |
   | Sun low (before sunset) | **C · Golden hour** | low orange sun, peach sky, long soft shadows |
   | Night | **D · Evening glow** | lilac dusk sky, warm lit windows and lamps |

   Pressing ▶ plays one toy day, and the moods blend smoothly into one another.
3. **A mood picker before building.** Four small preview cards sit above the **Dựng 3D** button. The page still opens at the area's real current time, as it does today, and the picker highlights the mood that time falls in (owner's decision). Choosing a mood sets the clock to that mood's time of day, and the city is built in that light. While the slider is dragged, the highlight follows whichever mood is strongest. After building, the same four choices replace the **◑ Có màu** button in the 3D toolbar, so people can jump between moods without rebuilding. The time slider still moves freely between them.
4. **Toy geometry for ordinary houses**, as in the mockup:
   - squat, chunky bodies with clearly rounded corners;
   - a slightly darker base (plinth) under each house;
   - thick roofs that overhang the walls and have rounded edges;
   - a chimney on some pitched roofs, and a fat slab with a round water tank on some flat roofs;
   - round-cornered windows with light frames, and a door with a knob on low houses.
5. **Toy landscape:** plump round trees with short thick trunks, small bushes in parks, and chunkier lamp posts with round heads.
6. **Soft shadows** and gentle contrast, using ACES tone mapping and blurred shadow edges.
7. **Tilt-shift blur** that adds the miniature feel.

## 3. Non-goals

- The Google page (`/`, `src/google/`) does not change.
- These features stay as they are and only get re-coloured where needed: pixel mode, rain, space view, the height-source view 📏 (#3), traffic, the location pin, the building card, offline maps and GLB export.
- Landmarks and complex buildings keep their **real footprint**. They are not turned into rounded boxes (see §6.3).
- No per-user custom palettes and no style editor.

## 4. Anti-goals: it fails if…

- The map stops being a faithful model of the place. Footprints, positions and heights must stay true; the toy look comes from shape, colour and light, not from moving or resizing buildings. **Heights are not squashed** (owner's decision).
- It runs noticeably slower or breaks the benchmark budget without that being agreed (§5).
- Night stops being readable. Mood D must still show the streets, lit windows and lamps clearly.
- The rounded corners look stretched or smeared on long or tall buildings (§6.2).

## 5. Constraints

- **Process (repo CLAUDE.md, issue #1):** this work needs its own GitHub issue with PO and TechLead sign-off and the `status: ready` label before code starts. Work happens on `feature/toy-style` and ends with a PR and green CI. When the work is done, write `docs/releases/v0.0.6.md` in the same structure as v0.0.5.
- **Before pushing:** `npm run typecheck && npm test && npm run build && npm run bench`.
- **Benchmark budget** (`bench/budget.json`, demo city): CI fails beyond +20% of each budget.
  - **Triangles:** the owner agreed to raise the budget from 300k to **500k**, because the reviewer's estimate for rounded houses and round trees is 450–500k (today's total is 260k: about 1,027 instanced houses at 8–10 triangles and 2,014 trees at 40). Change `bench/budget.json` in the same PR.
  - **Draw calls:** the budget stays at **40** (today 36). New parts such as chimneys, tanks and bushes must be merged into existing meshes, not added as new ones.
  - Rounded geometry stays low-poly: a 1–2 segment bevel with smooth normals, not the 4-segment `RoundedBoxGeometry` from the mockup.
  - Going over these new numbers is again a decision for the owner, not something the builder does quietly.
- **Worker boundary:** geometry is built in the worker and crosses to the main thread through `src/scene/serialize.ts`, where materials are described by `kind` plus parameters. Toy geometry is built in the worker too, and any new material kind needs a `MaterialDesc` kind.
- **Instanced prototypes are scaled non-uniformly** (`src/scene/prototypes.ts`: unit geometry × `(w, height, l)`). See §6.2.

## 6. The decided "how"

### 6.1 Removing the three old styles

Remove all of the following:
- `src/scene/colorMode.ts` and `src/scene/realistic.ts`;
- `tests/realistic.test.ts`;
- in `CityScene.ts`: every `colorMode === 'real'` branch, `applyRealism`, `setColorMode` / `currentColorMode`, `monoSky`, `patchObject` and the `bakeMono` call in GLB export;
- in `main.ts`: `btn-mono`, the `?style=` URL parameter and the `tinymap:colorMode` localStorage key.

Old `?style=` links must still open the page; the parameter is just ignored. Update the GLB button's tooltip, because "theo chế độ màu đang chọn" no longer means anything. GTAO was only switched on for "real". Whether it stays off or is re-tuned for the toy look is the builder's call, within the budget.

### 6.2 Rounded prototypes without stretched corners (decided: corner-preserving scaling)

Instanced houses come from one unit mesh that is scaled per house. A rounded unit box scaled to 4 × 30 × 12 m would get stretched, oval corners. **Decision:** keep instancing and make the scaling preserve the corners. Each unit-mesh vertex stores which corner it belongs to (a sign per axis) and its offset from that corner. The vertex shader places it at `sign × (halfSize − r) + offset`, so the bevel radius stays the same real size on every house. The same applies to the plinth, the roof slab and the pitched roofs (ridge and eave bevels). The window shader already works in world space, so it keeps working.

**Nothing crosses the true footprint (my call).** Real OSM tube-house rows share walls with no gap; the demo city leaves gaps, so the problem only shows on real data. The mockup's outward plinth and overhang would therefore cut into neighbouring houses and flicker. Instead, measure everything inward from the footprint:
- the plinth is the true footprint;
- the body is inset about 0.3 m from it;
- the roof overhang reaches back out to the footprint edge and no further.

This keeps the toy silhouette (a base wider than the body, a roof wider than the walls) with no neighbour checks in the worker.

**GLB export bakes the toy shape (my call).** The corner-preserving placement exists only in the vertex shader, so a plain export of instanced meshes would give stretched corners. On export, each prototype instance is baked to real geometry on the CPU with the same corner maths. Put that maths in one TypeScript function that is unit-tested, and mirror it in the GLSL. The exported file gets bigger; windows stay shader-only, as they are today.

### 6.3 Exactly modelled buildings (landmarks, complex footprints, parts, podium towers)

These keep their real footprint and roof shapes. They get:
- the toy palette;
- no weathering (§6.4);
- the plinth where `minHeight == 0`;
- softened edges where it is cheap, such as smooth normals across wall corners or a small top-edge bevel.

How far to go here is the builder's call, within the budget.

### 6.4 Building shader

Remove the weathering block in `createBuildingMaterial` (#28: desaturation, blotches, rain streaks, grime at the foot). It works against the toy look. Restyle the windows as rounded rectangles with a light frame and keep the existing lit-window logic (`uLit`, `uNight`). Keep the facade-material tints (#5), but make them softer. Keep the height-source view (`uSourceView`) and the selection highlight unchanged.

### 6.5 Palette: one fixed toy palette (my call)

Building colours are baked into vertex and instance colours at build time. **My call:** there is a single toy pastel palette for walls and roofs, and the moods differ only in light, sky, fog, shadow softness and emissive glow. That is what makes a smooth blend through the day possible without rebuilding. Mood A therefore keeps the pastel buildings; it differs from B in its cooler, clearer light, not in grey walls.

Map today's archetype colours (`src/data/buildings.ts`) and OSM `building:colour` / `roof:colour` onto the nearest toy pastel, so buildings still differ from each other. Roads, pavements, grass, water and ground move to the warm toy colours from the mockup.

### 6.6 Moods follow the sun, not the clock

Mood blending is keyed on the **sun's altitude and `SunState.night`**, as `lighting()` in `src/scene/sun.ts` does today with its DAY/DUSK/NIGHT colours. Fixed clock hours are not used, because sunset in Hà Nội moves by more than an hour across the year. `lighting()` is replaced by a function that blends the four mood keyframes: sky, fog, sun colour and intensity, hemisphere sky and ground colours, and exposure. The keyframes are:
- morning (sun rising and in the east half): A;
- high sun: B;
- low sun (before sunset): C;
- night: D.

The moonlight fallback in `setTime` stays.

**Picker → clock:** choosing a mood finds, for the current area and date (`sunState`), the time of day where that mood is strongest, and sets the time slider to it. For example, C is the time when the sun is about 8° above the horizon in the afternoon, and D is about an hour after sunset. Mood A is the morning equivalent. The chosen mood is not remembered between visits, because the page always opens at the real time (§2.3).

### 6.7 Tilt-shift

Add horizontal and vertical tilt-shift passes, using three's `HorizontalTiltShiftShader` and `VerticalTiltShiftShader`, to the existing composer in `CityScene` before `OutputPass`. The sharp band sits at the screen centre. The blur strength is scaled by camera pitch: full in the default oblique view, fading to none in the top-down view (⊡) and at very low, near-horizontal angles, where a fixed band would blur the wrong things. There is no on/off toggle (my call).

**Bench (my call):** `CityScene.measureRender()` renders without the composer, so bloom and the other passes are already outside the triangle and draw-call numbers. Keep it that way, because measuring through the composer would re-baseline every metric. The two tilt-shift passes are full-screen quads; check their cost by watching frame time in the demo city, not with a new CI metric.

### 6.8 Landscape and props

- **Trees** (`landscape.ts` `buildTrees`): a round smooth crown, sometimes with a second smaller blob, and a short thick trunk. They stay instanced.
- **Parks:** a few instanced bushes.
- **Lamp posts:** thicker posts with a round head; the night bulbs and light pools stay.
- **Vehicles, people and trains** only get re-tinted to the palette (no new geometry) unless the budget allows more.

## 7. Left to the builder

- Merging chimneys, water tanks, bushes and second tree blobs into existing instanced meshes where possible, so draw calls stay within budget.
- Exact palette values and mood keyframe values. Start from the mockup values in §10.
- Bevel segment counts and radii, within the triangle budget.
- How much softening the exact buildings get (§6.3).
- The picker cards' visuals: a rendered thumbnail or a simple illustrated swatch per mood. They must work at phone width, and the UI text is in Vietnamese.
- Whether GTAO is used.
- Test updates: `prototypes.test.ts`, `roofs.test.ts` and `serialize.test.ts` change, and `realistic.test.ts` is deleted. Add a unit test for mood blending and for picker → clock (C lands before sunset on both a December and a June date in Hà Nội).

## 8. Acceptance

1. `/openstreetmap/` has no Có màu / Đơn sắc / Siêu thực button. The four-mood picker appears above **Dựng 3D**, with the mood of the current real time highlighted, and in the 3D toolbar after building.
2. Ordinary houses look like the Toy mockup: rounded, chunky, on a base, with thick overhanging roofs. The corners look the same on small and large buildings.
3. ▶ plays a day that passes A → B → C → D and back to A without jumps.
4. Choosing C sets the clock to shortly before that day's sunset for the area.
5. Night (D) shows lit windows, lamps and readable streets.
6. The height-source view, selection, pixel mode, rain, space view, GLB export and traffic still work.
7. `npm run typecheck && npm test && npm run build` pass, and `npm run bench` stays within the new budget (500k triangles, 40 draw calls).

## 9. Owner decisions (2026-10-27)

- **Triangle budget:** raised to 500k; the draw-call budget stays at 40.
- **Opening clock:** the page opens at the real current time, and the picker highlights the matching mood.
- **Height squashing:** no. Toy proportions come from the bevels, the plinth and the roofs.

## 10. Reference: mockup values

The mockups were throwaway pages served from a temporary folder. These are the mood values they used, as a starting point.

| Mood | Sky | Sun colour, intensity | Hemisphere sky / ground, intensity | Exposure |
| --- | --- | --- | --- | --- |
| A | `#a9d8f2` | `#ffffff`, 2.0 | `#cfe3ff` / `#e0d4b8`, 1.6 | 1.0 |
| B | `#cdeaf3` | `#fff0d8`, 1.9 | `#e3f0ff` / `#f0dcc0`, 1.7 | 1.05 |
| C | `#f8cfab` | `#ffb36b`, 2.6 | `#ffe0c2` / `#c4b0d4`, 1.2 | 1.0 |
| D | `#7a76a8` | `#a9b0ff`, 0.6 | `#9692cc` / `#4a4160`, 0.9 | 1.1 |

| Toy palette | Values |
| --- | --- |
| Walls | `#f6e3c6` `#f4c7b8` `#cfe5d0` `#f7d9e3` `#fbeec1` `#d6e2f2` |
| Roofs | `#e08a70` `#d47560` `#eba37c` `#9fb5d4` |
| Ground / grass / road | `#f2e7d0` / `#b5d99b` / `#e0d0b0` |
| Trees | `#8cc977` `#a6d683` `#79b86b` |
| Lit windows (night) | `#ffd890`, emissive `#ffb347` |
| Plinth | wall colour × 0.78 |

The mockup's toy proportions were: corner radius about 1.1 m on a 4.4 m wide house, plinth 0.7 m tall and 0.35 m wider on each side, roof overhang 0.6 m, roof bevel 0.7 m, and window frames 1.35 m with 1.0 m glass. In the real build these are measured inward from the true footprint (§6.2).
