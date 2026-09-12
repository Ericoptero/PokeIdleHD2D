# 019 — a move's effect, rebuilt as three shaders instead of eighteen painted textures

Status: done                 Branch / commit: Ericoptero/hunt-battle

## Why
The user's own words: "Os efeitos visuais dos ataques são amadores e horríveis, refaça-os,
quero algo muito bem feito e bonito, moderno e complexo para MMORPG de elementos" — the current
pixel-art strike effects (`strikes.js`, DECISIONS #79) read as amateurish and the user asked for
a modern, elemental MMORPG look. During planning the user was asked directly and chose "Totalmente
moderno (shader)" over a pixel-art-consistent redesign — an explicit, deliberate exception to the
project's usual doctrine (CLAUDE.md's "Compose from real geometry... a flat-shaded primitive is a
bug, not a milestone", echoed in `strikes.js`'s own header as "Never a coloured primitive
(ARCHITECTURE §9)"). This slice is that exception, named and dated, for this one system only.

## Inspected before writing this slice
- `src/encounter/strikes.js` (whole file) — the system being replaced: eighteen `{C,E}` hex
  pairs (`ELEMENT`), three pixel-art shapes painted to canvas (`IMPACT_ART`/`BOLT_ART`/
  `FIELD_ART`/`MOTE_ART`) via `ball.js`'s `paint`/`texture`, one `MeshBasicMaterial` quad per
  shape plus one `InstancedMesh` mote field, driven by a `play({shape,type,from,to,steps})` /
  `phase(p)` / `hide()` / `refit()` / `dispose()` API that `encounter/index.js` calls at three
  sites (live duel tick, `stageStrike` showcase tool, and via the module's `frame` hook for
  `refit()`). This exact API contract is what the new system must keep, so `index.js`'s own
  changes stay to an import swap and a hook rename.
- `src/environment/weather.js` (whole file) — the shader pattern to copy, named explicitly in
  the plan: one `ShaderMaterial`, one hand-built `BufferGeometry` of N quads sharing one draw
  call, per-particle placement computed **entirely in the vertex shader** from a per-vertex
  `aSeed` attribute plus uniforms — no per-frame CPU matrix updates, no `InstancedMesh`. Its
  `uTime` accumulates wall-clock `dt` but is gated `if (!config.timeFrozen) fxTime += dt`
  (`environment/index.js:954`) — this project's precedent for a shader that still respects a
  frozen screenshot. This slice's own particles read `uPhase` (the strike's own `[0,1]`,
  computed exactly as `strikes.js` already does — a sim-step ratio) instead of wall time, which
  is a stricter, simpler version of the same freeze guarantee: there is no clock to gate at all.
- `src/encounter/index.js` — the three call sites (`:634-647` live tick, `:1541-1558`
  `stageStrike`, `:1800-1802` the `frame` hook calling `refit()`) and `emitStrike`/`scene.vfx`
  (`:462-484`, DECISIONS #86/#87): `scene.vfx` currently carries only `{at, shape, type,
  toWild}` — no `crit`/`effectiveness` — so the plan's "super-effective adds a second ring,
  crit adds a white flash" needs two more fields threaded through here and into `play()`.
- `src/battle/types.js` — `typeColour(type)` → `{core, edge, ink}` (DECISIONS #87), now the
  read for `core`/`edge` too: DECISIONS #87 already flagged `strikes.js`'s copy as "unmoved...
  that file is rewritten wholesale in the next slice", so this is that move.
- `src/encounter/selftest.js:30,437-462` — the checks importing `ELEMENT`/`elementOf`/`shapeOf`
  from `strikes.js` (eighteen looks, core-brighter-than-edge, shape-by-category, fallback);
  superseded by `battle/selftest.js` #61-66 for the colour half (DECISIONS #87) — this slice
  removes the dead half here and keeps only what is genuinely new: shape resolution now lives
  in `vfx/elements.js`, and gets the "profile resolves for every type" / "beats cover [0,1] with
  no gap" / "particle count ≤ the field's own size" checks the plan asks for.
- `src/encounter/showcase.js:809-814,1008-1013` — `vfx-contact`/`vfx-projectile`/`vfx-field`
  modes and the `vfxType` URL override; kept working unchanged since `stageStrike`'s own
  signature only gains two optional fields (`crit`, `effectiveness`), both defaulted.
- `tools/shots/regress.js:57-58` — the existing `encounter/vfx/12`/`encounter/vfx/21` rows
  (both `mode: 'vfx-contact'`); the plan's own acceptance asks for two more, one per delivery
  shape not yet covered by a row.
- `tools/shots/shoot.js:210,212` — the hard budgets this slice has to fit inside: `drawCalls >
  1500` and, the one that actually binds for a shader rewrite, `programs > 60`. Three new
  `ShaderMaterial`s (particles, beam, ground) is three programs; checked against a real boot
  before committing (see Result).
- `docs/DECISIONS.md` #79 — corrects a fact this slice's own citations need right: the outdoor
  preset's bloom threshold is **1.15 at noon**, dropping to **0.85 at 21:00** with strength
  raised to 1.15 (`core/config.js`'s `0.72` is only the un-overwritten default) — not the "0.72"
  `strikes.js`'s own header cites. The new particle/beam cores are tuned against these real
  numbers, not the stale ones.

## Files / modules affected
Deleted: `src/encounter/strikes.js`. New: `src/encounter/vfx/elements.js`,
`src/encounter/vfx/particles.js`, `src/encounter/vfx/beams.js`, `src/encounter/vfx/ground.js`,
`src/encounter/vfx/play.js`, `src/encounter/vfx/elements.test.js`,
`src/encounter/vfx/elements-shader-codes.test.js` (from the tester's independent pass — see
Result), `tests/flows/vfx-real-fight.spec.js` (likewise). Changed: `src/encounter/index.js`
(import swap, `scene.vfx`/`emitStrike`/`stageStrike` gain `crit`/`effectiveness`, `frame` →
`lateFrame`), `src/encounter/ball.js` (a `refit()` doc comment, `frame`→`lateFrame`),
`src/encounter/selftest.js` (drop the dead `strikes.js` checks, add the new
profile/beat/particle-count ones), `src/encounter/showcase.js` (the three `vfx-*` staged
phases), `tools/shots/regress.js` (two new matrix rows), `docs/baseline.json`, `ARCHITECTURE.md`
(§5.6, §9), `docs/DECISIONS.md` (#88, the named exception), `docs/STATUS.json` (a new,
unrelated, pre-existing bug found along the way — see Result).

## Expected behaviour
- Eighteen types read as eighteen distinct-feeling effects, not eighteen recolours of one
  star: each type resolves to a `{motion, role, intensity}` profile (`vfx/elements.js`) —
  a law of movement (rise / fall / zigzag / orbit / spiral) crossed with a particle identity
  (spark / ember / shard / droplet / leaf / dust) — layered on top of the shared `core`/`edge`
  colour from `battle.typeColour`.
- Every strike plays in four beats covering `[0,1]` with no gap: **charge** at the attacker,
  **delivery** (contact: a billboarded arc slash between the two; projectile: a travelling
  beam with a particle trail; field: a ground ring growing under the target), **impact** (an
  additive flash, the ground ring's shockwave, a particle burst with a brief hit-stop), and
  **resolve** (the particle field fading out). Timed per delivery shape (`vfx/elements.js`'s
  `BEATS` table).
- A super-effective hit adds a second, larger, slightly delayed ring pulse; a critical hit adds
  one frame of a brighter, whiter flash on top of the ordinary impact — both read straight off
  `scene.vfx.effectiveness`/`scene.vfx.crit`, threaded from the real strike (or from
  `stageStrike`'s own optional fields, for a showcase).
- The whole system is three draw calls while something is playing (particles, beam, ground)
  and zero otherwise — well inside `drawCalls > 1500`, and three `ShaderMaterial`s inside
  `programs > 60`.
- Nothing here reads a clock: every one of the three sub-effects is a pure function of the
  strike's own `phase` in `[0,1]`, so a frozen showcase frame is the same picture twice
  (DECISIONS #14), exactly as `strikes.js` already guaranteed.

## Acceptance criteria
- `npm run gate` exits 0.
- `node src/encounter/selftest.js` green: every type resolves to a profile; every
  (shape × type) has a beat timeline; a shape's beats cover `[0,1]` with no gap and no overlap;
  the particle field's live count never exceeds its own allocated size.
- `node src/battle/selftest.js` still 67/67 (untouched by this slice — `typeColour` is read,
  not changed).
- `npx vitest run` green, including new pure-logic tests for `elements.js`'s profile/beat
  tables (no `three`, no `ctx` — plain data).
- A real boot (`npm run boot` / the gate's own `boot` stage) reports `programs ≤ 60` and
  `drawCalls ≤ 1500` with an effect playing.
- Screenshots looked at, one per delivery shape at both bloom regimes (noon 1.15 threshold,
  21:00 0.85 threshold/1.15 strength): a fire contact reads as an orange slash-and-burst on the
  target; an ice projectile reads as a travelling shard with a trailing glitter, landing in a
  small icy burst; a psychic field reads as a swirling ring under the wild. None of the three
  washes out to a flat white blob at either hour.
- `tools/shots/regress.js`: `encounter/vfx-projectile/12` and `encounter/vfx-field/21`
  (new rows) plus the existing `encounter/vfx/12`/`encounter/vfx/21` (contact) all pass or are
  `--accept`ed with the frames named in the commit — a deliberate visual rewrite is expected to
  move these.

## Tests required
- `src/encounter/vfx/elements.test.js` — pure: eighteen profiles exist and are one of the
  five/six enum values; `shapeOf` unchanged behaviour (status→field, physical→contact, else
  projectile, null-safe); `BEATS` for every shape covers `[0,1]` with `to[i] === from[i+1]`,
  `from[0] === 0`, `to[last] === 1`; `beatAt` returns the right beat/local-k at boundaries.
- `particles.js`/`beams.js`/`ground.js` get no dedicated `.test.js` — there is no project
  precedent for unit-testing a `three`/`ShaderMaterial` file (`weather.js`, `ball.js` have
  none; both are verified by screenshot only), and this slice does not start one: the shader
  source is a string vitest cannot execute, and the geometry/uniform wiring is exercised for
  real by the showcase screenshots below, not simulated.
- `src/encounter/selftest.js` — the browser-reachable checks this module already runs under
  `selfTest()`: every type resolves to a profile, every shape has a beat timeline, the beats
  cover `[0,1]`, the particle field's allocated size stays within its own declared cap.
- `src/encounter/vfx/elements-shader-codes.test.js` (new, from the tester's independent pass) —
  a real gap the above missed: `PROFILE`'s `motion`/`role` values were checked against the
  `MOTION`/`ROLE` enums but never against the numeric `MOTION_CODE`/`ROLE_CODE` maps
  `particles.js` actually reads, so a motion or role added to the enum without a matching code
  entry would pass every other check while handing the shader an `undefined` uniform.
- `tests/flows/vfx-real-fight.spec.js` (new, from the tester's independent pass) — the property
  nothing else reaches: that a **real** `battle:strike` (not `stageStrike`'s manufactured call)
  actually puts the three named meshes in `ctx.three.scene` and makes at least one visible, with
  zero console errors; that `encounter`'s registry descriptor answers to `lateFrame` and not a
  stale duplicate `frame` key; and that a real thrown ball (via the actual `KeyZ` hotkey) still
  renders correctly end to end through the renamed hook.
- `tools/shots/regress.js`'s new/existing VFX rows, looked at by eye per the Verification
  section below — a histogram cannot see a shape, DECISIONS #79's own lesson.

## Verification in the real application
`npm run shot -- --showcase encounter --mode vfx-contact --vfxType fire --tod 12`,
`--mode vfx-projectile --vfxType ice --tod 21`, `--mode vfx-field --vfxType psychic --tod 21`,
`--mode vfx-contact --vfxType electric --tod 21` (the exact case DECISIONS #79 records losing a
round to at the old bloom threshold) — each opened and looked at, not just measured.

## Docs to touch
ARCHITECTURE §5.6 (hooks list: `frame`→`lateFrame`; the VFX paragraph rewritten for the new
files), §9 (the named pixel-art exception), DECISIONS #88 (the exception itself, dated, with the
user's own request as the citation), `docs/STATUS.json`.

## Out of scope
Re-authoring `ball.js`'s own effects (the throw arc, the shiny shimmer, the capture burst) —
those are not the "attack" effects the brief is about and stay pixel art. Per-move (rather than
per-type × per-shape) authoring — 721 moves still cross eighteen types and three shapes, not
721 bespoke timelines, for the same reason DECISIONS #79 gave the first time. Sound.

## Result
`npm run gate` green in 421s: lint 2.9s, typecheck 0.5s, seams 1.7s, unit 1.0s, build 3.8s,
coldboot 4.2s, boot 127.3s (24/24 entry points, `encounter` showcase measured directly at 17
programs / 54 draw calls, well inside the 60/1500 budgets), flows 112.2s (29/29), parity 54.3s,
regress 112.9s: 3 improved (`encounter/vfx/21`, `boot/12` ×2, all directions preferred), 2
moved (the two new rows, `encounter/vfx-projectile/12` and `encounter/vfx-field/21`, no prior
baseline) — `--accept`ed in this commit, re-verified 0/0/0 against the accepted baseline
afterward. `node src/encounter/selftest.js` 83/83 (new checks: profile/beat coverage, particle
cap). `node src/battle/selftest.js` 67/67, unchanged. `npx vitest run` 81 passed | 1 expected
fail (the pre-existing pinned `research-unmintable` bug, unrelated), including
`elements.test.js`'s 13 new cases.

**One real bug, found by screenshot, not by any static check**: the ribbon's width was first
added along a fixed view-space axis, which for a bowed arc at this camera's pitch is nearly
parallel to the bow's own sweep — the two offsets stacked instead of cancelling, so the
"ribbon" filled in as one solid wedge the size of the whole swept arc rather than a thin stroke
tracing it. Caught by staging a solid-magenta test fill and finding it exactly the size and
shape of a nearby terrain prop it should have been much smaller than. Fixed by computing the
curve's own on-screen tangent (sampling a second point a hair further along and projecting that
too) and offsetting perpendicular to *that*, not to a fixed axis — DECISIONS #88. A second,
smaller issue in `ground.js`: the ring's fragment shader judged distance in the raw `[-1,1]` UV
square rather than world units, so a `uRadius` of `0.5` did not mean what it said; fixed by
baking the plane's own half-width into the shader.

The showcase's own staged phases (`vfx-contact`/`vfx-projectile`/`vfx-field`) moved from
0.25/0.45/0.5 to 0.58/0.72/0.65 — the old values were tuned for a hard-edged painted quad
already at full opacity the instant it appeared; this system's brightness genuinely ramps
through its own beat, so two of three shapes were caught early in charge/deliver, before the
burst had anything to show. Retuned to land inside each shape's own impact beat instead.

Verified by screenshot (`npm run shot -- --showcase encounter --mode vfx-contact --vfxType fire
--tod 12`, `vfx-projectile`/ice/21, `vfx-field`/psychic/21, `vfx-contact`/electric/21 — the
exact hard case DECISIONS #79 recorded losing a round to): a fire contact reads as a bright
ember burst with a visible golden arc beneath it; an ice projectile is a pale-blue comet with a
trailing streak; a psychic field is a magenta ring glowing under the wild with motes rising
through it; an electric contact at night is a clean bright flash with a faint ring, not a washed
white blob. Also checked end-to-end in a real (non-showcase) fight at
`?scene=hunt-meadow&seed=1337`: a normal-type Tackle produced an appropriately modest burst
(`normal`'s own `intensity: 0.7`, the lowest of the eighteen) alongside the balloon, nameplate
and floater from slices 016–018 on the same frame, zero console errors.

**Review found one serious, real mistake in this same session: the baseline itself was briefly
destroyed.** The first `regress.js --accept` ran with no dev server on the default port; the
command still exits 0, and because `compare()` only diffs metrics present on both sides, a
baseline of bare `error` placeholders makes every future run report a false "0/0/0 clean" —
this slice's own commit would have silently disabled the whole project's visual-regression net,
not just its own two new rows. Fixed before commit: restored `docs/baseline.json` from `HEAD`,
re-ran `--accept` against a curl-verified-live server, and confirmed every one of the 20 rows
holds real numeric fields before trusting it — the re-derived diff (3 improved, 2 moved) matches
what this Result section already claimed above. Review also flagged the contact arc as reading
like a filled dome, not "a thin stroke"; traced to the showcase's fixed staging position sitting
a wild Marill directly in front of a terrain mushroom decal of a similar warm colour and
silhouette — confirmed by isolating the beam mesh alone and finding no wedge, only the
pre-existing decal. The beam *was* under-tuned on its own separate merits, though: sampled at a
pure mid-deliver phase, the arc alone was close to invisible against noon-bright grass. Retuned
(width `0.32→0.5`, bow `0.55→0.7`, a `sqrt` opacity ramp so the slash reads early in the swing)
— confirmed this did not move `regress`'s own VFX rows outside tolerance. Two more minor items:
a redundant `ground.hide()`/`beam.hide()` pair immediately overwritten by the shared
impact-shockwave block a few lines later (tidied), and `particles.js`'s `mesh.visible = true`
being unconditional unlike `beams`/`ground`'s opacity-gated visibility (harmless — a particle
field has no single opacity to gate on — documented with a comment instead of restructured).

**The tester's independent pass found three more real gaps**, all fixed by keeping the new
files as permanent coverage rather than throwaways: `MOTION_CODE`/`ROLE_CODE` were checked for
internal self-consistency but never against `PROFILE`'s actual values, so a motion or role added
to the enum without a matching code entry would pass every existing check while handing
`particles.js` an `undefined` shader uniform at runtime — closed by
`vfx/elements-shader-codes.test.js` (proven to fail by adding an uncovered `BOUNCE` motion,
confirmed both existing suites stayed green, then reverted). No test drove a **real** fight
through the new VFX at all — closed by `tests/flows/vfx-real-fight.spec.js`, which also proves
`frame`→`lateFrame` is a genuine rename rather than a stale duplicate key (reading
`ctx.registry.descriptor('encounter')` directly) and that a real thrown ball still renders
end to end through it. Verifying that rename via the showcase's own `mode=throw`, as first
suggested, turned out to be unreliable for an unrelated reason found along the way: that mode
(and `shake`/`caught`/`escaped`/`night`) never reaches an airborne ball at all — independently
reproduced (`scene().stage` sticks at `'fight'`) and confirmed pre-existing via the tester's own
git-stash round-trip against pre-019 `HEAD`; logged as `docs/STATUS.json`'s
`showcase-throw-family-stuck`, out of scope to fix here.

**A note on gate reliability, not on this slice's own correctness.** Two full `npm run gate`
attempts after the fixes above failed on fps budgets (`boot`'s `tiles`/`preview` showcases) and
three unrelated flow tests (position/timing assertions in `field-encounter`/`plates`/
`pokecenter` specs, none touching VFX) — traced to an **orphaned headless-Chrome process left
running from hours earlier** in the shared environment, consuming real CPU/GPU. Killed; a clean
re-run passed every stage in 314s with no changes to app code. Final, trustworthy numbers below.

Final `npm run gate`, clean environment: 314s total — lint 2.6s, typecheck 0.5s, seams 1.6s,
unit 1.2s, build 3.9s, coldboot 5.6s, boot 101.2s (24/24, `encounter` showcase 17 programs / 54
draw calls), flows 73.8s (**32/32**, including the tester's 3 new flow tests), parity 37.7s,
regress 86.0s (0 improved/0 regressed/0 moved against the now-correct accepted baseline).
`node src/encounter/selftest.js` 83/83. `node src/battle/selftest.js` 67/67, unchanged.
`npx vitest run` clean including `elements.test.js` (13) and `elements-shader-codes.test.js` (3).
