# Decisions

Append-only. Numbered, dated, and each one records what was *checked*, not what was
assumed. Builders may add entries about their own module; anything touching core, units,
events or the module API is the integrator's to write.

---

### 1 — 2026-09-07 — Stack: three.js + Vite, plain ES modules, no TypeScript

three `0.185.1`, Vite `8.2.2`, `"type": "module"`, no build-time codegen inside `src/`.
Node ≥ 20 for tools only. `puppeteer-core` drives the system Google Chrome rather than
downloading a Chromium, so the screenshot harness starts in ~1 s and uses the real GPU.

**Why:** the brief asks for plain ES modules; a bundler-agnostic `src/` also means an agent
can reason about a file without reasoning about a build.

---

### 2 — 2026-09-07 — PDSMS smart-drawing palettes are north-up; no flip needed

`.pdsts` smart grids are 5×3 with 13 filled slots. Slot *n* (row-major) carries the
neighbour signature in `SmartGrid.smartUnits[n]` from the PDSMS Java source, in the order
`[top, bottom, left, right, tl, tr, bl, br]`.

The open question was whether PDSMS's "top" is our north (−Z) or our south (+Z), since a
palette may be drawn bottom-up. **Settled empirically.** The grass/path set's four inner
corners were measured: `grass_path_cornerinUL`'s transition-textured triangle sits at cell
(0.67, 0.33) — north-east — which is exactly the corner `smartUnits[3]` leaves empty. The
other three agree. A vertical flip *or* a 180° rotation would have broken that agreement,
so `top = north` and the slot order is row-major as written.

Four of our own slot **names** were wrong and are fixed: slots 3/4/8/9 are
`inner_ne`, `inner_nw`, `inner_se`, `inner_sw` (they had ne↔se and nw↔sw swapped).

`tiles.autotile.setFlipped()` survives as an escape hatch; it should stay unused.

---

### 3 — 2026-09-07 — City structures are authored by us; no PDSMS tileset has them

Every `.pdsts` in the vendored Map Studio tree was parsed and its model list read. **There
is no Pokémon Center, Mart, or any complete building** in any of them. The only building
geometry that exists is modular fragments — `HouseWall*`, `window`, `glassmiddle`,
`stagecorner` (HGSS New Bark, Platinum House Indoor) — plus `HouseMedieval`, `Rancho` and
`Tower` in Sylvan Town, which are the wrong genre entirely.

So the Pokémon Center, the Mart and the town houses are **modelled by us** in Blender
through the MCP server (`.mcp.json`, verified connected), textured with pixel art we author
at the AdAstra texel density (**32 px per world unit**; the shipped textures run 8–64 px and
32 is the mode), in the BW2 colour language — red roof, cream walls, glass doors, the
Poké Ball mark.

This is authored art in the reference style, not programmer art. A coloured box standing in
for a Pokémon Center is a gauntlet failure, not a milestone.

---

### 4 — 2026-09-07 — Sprite-sheet layouts, measured from the shipped art

**Pokémon** (`assets/overworld/<species>/{normal,shiny}.png`): 64×128, 32 px frames,
2 columns × 4 rows. Rows are `[north(back), west, south(front), east]`. Verified: rows 1 and
3 are exact horizontal mirrors — 1024/1024 pixels — which is the signature of a left/right
pair, and the row-0/row-2 silhouettes are unmistakably back and front.

**Trainer** (`assets/trainer/{hero,heroine}.png`): 32×768, 24 frames, single column.
The six back-facing frames are unambiguous (4–8 skin-tone pixels versus 18–24 for every
other frame) and were confirmed by eye. The twelve side frames split into two exact mirror
sets. Grouping:

```
north  [0, 7, 8, 9, 10, 20]      south  [11, 12, 13, 21, 22, 23]
sideA  [1, 2, 3, 14, 15, 16]     sideB  [4, 5, 6, 17, 18, 19]
mirrors: 1↔6  2↔4  3↔5  14↔17  15↔19  16↔18
```

**Still open:** which mirror set is west, and the within-group walk-cycle order. Neither is
decidable from the pixels — the `pokemon` builder must walk the trainer left on screen,
screenshot it, and record the answer here.

---

### 5 — 2026-09-07 — Tile geometry is rewound at export against the artist's normals

DS tileset authors do not keep a consistent triangle winding, because PDSMS renders with
backface culling off and nothing forces them to. Converting Z-up/Y-south to Y-up/Z-south
mirrors two axes on top of that, flipping handedness.

Symptom before the fix: roughly half the ground tiles were invisible under a `FrontSide`
material while still casting shadows — three renders shadows from `shadowSide`, the
*opposite* face, so backwards geometry casts a shadow it does not fill.

`tileToTriangles` now compares each triangle's geometric normal with the average of the
three normals the artist stored and swaps two vertices when they disagree. 2365 of 2402
AdAstra triangles are consistent afterwards; the remaining 37 are on double-sided
billboards whose stored normals genuinely point sideways, and their materials are
`DoubleSide` anyway.

---

### 6 — 2026-09-07 — The texture decides what a tile *is*, not its OBJ name

`grass.obj` appears five times in the AdAstra set, painted as grass (`grass01ax`), as stone
paving (`gake_michi`) and as deep water (`mizu_sita2`). Classifying by OBJ name produced a
lawn with water and paving stones scattered through it.

The classifier now takes its category from the **dominant texture** (the one covering the
most vertices), and names the model after that texture — `ground/grass`, `path/stone_path`,
`water/water_deep`. The OBJ name wins only for categories a texture cannot express: cave,
tree, bridge, stairs, ledge, prop, building, light, fence, wall, interior, plant, decal.

Consequence for map authors: **select tiles by category and tag, never by name.**

---

### 7 — 2026-09-07 — Tiles carry `baseY`; ground-level queries exclude raised tiles

Several tiles are authored on top of a five-unit cliff — `grass_v2` (id 81) has its geometry
at y = 5. Placed at ground level it floats, leaving a hole with sky showing through. This
was the second half of the "black squares in the lawn" bug.

Every model now carries `baseY` (its own geometry's minimum Y) and gains the tag `raised`
when that is ≥ 0.5. `tiles.find()` filters raised tiles out unless the caller asks for them
by tag or passes `maxBaseY`.

---

### 8 — 2026-09-07 — PDSMS global texture mapping is reproduced per instance

Eleven AdAstra tiles set `GLOBALMAPPING`: their baked UVs cover one cell of a larger pattern
and Map Studio derives the rest from world position (`GLOBALTEXSCALE`, 0.25–1). Rendering
the baked UVs alone stretches a quarter of the texture over the whole tile.

The pack carries `globalUv` and `uvScale`; `InstancedWorld` attaches an `aUvOffset`
instanced attribute of `(cx·scale, cz·scale)` and patches the material to add it to `vMapUv`.
A 64×64 lawn therefore shows a 4×4-cell repeat instead of one stamp per square.

---

### 9 — 2026-09-07 — Git LFS stays off

Carried forward from the previous attempt's `.gitattributes`, which was disarmed with a
long explanation. Total asset weight today: `assets/overworld` is 5.12 MB across 2506 PNGs,
plus `public/generated/tiles` at ~9 MB. Three orders of magnitude under any reason to
migrate. Re-add the filter in the same commit that installs `git-lfs` and runs
`git lfs migrate import`, never before.

---

### 10 — 2026-09-07 — The screenshot harness renders on the real GPU by default

SwiftShader produces the same pixels but at ~12 fps, so a software frame rate cannot be
checked against the ≥ 50 fps budget. `tools/shots/shoot.js` uses the system GPU; pass
`--software` for bit-identical output across machines.

The harness also settles, **discards that fps window**, and measures a fresh one, so the
number in the log is steady state rather than shader compilation. Measured baseline at
1920×1080: city 60 fps / 159 draw calls / 15 k triangles / 9 programs, zero console errors.

---

### 11 — 2026-09-07 — The sky is painted first with no depth test

A sky pinned to the far plane by `gl_Position.z = gl_Position.w` fails a `LESS` depth test
against a cleared depth buffer and silently never draws. The sky dome now renders at
`renderOrder -1000` with `depthTest: false` and `depthWrite: false`, so it paints the
background and everything else lands on top.
