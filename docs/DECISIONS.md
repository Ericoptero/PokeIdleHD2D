# Decisions

Numbered from **#71**. Entries #1–#70 are closed in `docs/DECISIONS-ARCHIVE.md`; the
numbering runs across both files so a citation like `DECISIONS #61` is never ambiguous.

**Write an entry when a choice constrains future code and the reason is not obvious from
reading that code.** A tuning value, a workaround for a library bug, a rule that looks
arbitrary until you know what it prevents. Cite it from the code it constrains
(`// DECISIONS #71`) — the citation is what makes the entry findable later.

**Do not write an entry for what happened.** No round reports, no measurement tables, no
before/after screenshots, no "the critic said X". That material is 55–60% of the archive
and is why the archive became unreadable. It belongs in the commit message, which is where
this repo has always put it well.

Format — the decision, then why, then what it costs:

```
### 71 — 2026-09-09 — The cold-start budget is measured against the build, not the dev server

§7 has budgeted "time to `__READY__` ≤ 6 s cold" since the harness was written, and nothing
ever asserted it. Turning the assertion on against the dev server produced this:

| | warm dev server | cold dev server | production build |
| --- | --- | --- | --- |
| `/` and `?scene=` | 3.6–5.0 s | 7.5–10.9 s | measured by the gate |
| `?showcase=` | 4.5–6.0 s | 9.4–15.0 s | not measured |

The page's own boot did not change between those columns. What changed is that Vite's dev
server hands the browser several hundred separate ES modules and compiles them on demand, so
the first request to a route pays for the whole graph and a warm one does not. A budget
asserted there fails or passes on how recently someone else loaded the same URL.

**`readyMs` is therefore recorded on every shot and asserted on none of them.** The budget is
checked once per gate run, by `tools/gate.js → coldBoot()`, against the production bundle
served by `vite preview` — the bytes a player actually downloads.

**Why:** the alternatives were worse. Warming the server first would have measured nothing.
Raising the number until the dev server passed would have set the player's budget at 15 s to
accommodate a bundler the player never runs. Splitting it by URL — which is what this entry
said in its first draft, before the cold run — treated the symptom: showcases looked slower
only because they are shot after the scenes, on a server the scenes had already warmed.

**Cost:** one boot path is measured instead of twenty-two, so a route that is slow for its own
reasons — a showcase that stages an enormous scenario — will not be caught by this budget. The
draw-call and text floors in `tools/shots/boot.js` still cover every route; only the timing
does not.

---

### 72 — 2026-09-10 — The fight is stepped rather than resolved, an ally faint is not the end of it, and a Potion stops being a Revive

`ARCHITECTURE.md` has said since DECISIONS #61 that "the visible fight calls `turn()` once every
few sim steps so it can be animated and screenshotted". It never did. `encounter.begin()` called
`battle.resolve()` synchronously at `index.js:654` — **before a single frame was drawn** — and
`ui/panels/battle.js` said so in its own header: "It is a readout of a *finished* fight." The
tell is that `battle.turn()`, pure and published since the engine landed, had **zero callers in
`src/`**. §5.12 recorded the truth and §5.17 recorded the intention, and the code agreed with
neither for long enough that a grep was the only way to find out which.

**(a) `stepper()` is the implementation; `resolve()` is a drain of it.** Not a wrapper over
`turn()` — the two hooks are the point. `between(state) → Action[]` lands heals, ethers and
revives between two turns; `nextAlly(state) → Combatant|null` sends out the next party member.
Both are pure and **neither may draw randomness**, which is what keeps the turn stream
`root/battle/<index>/<turn>` exactly where it was. The evidence is `battle/selftest.js` 24–29:
the golden fight (Oshawott L12 vs Caterpie L8 at IVs 20, seed 1337 index 12) still reports
winner `a`, 2 turns, ally HP 34, `hpFraction` 0, transcript length 7 and `watergun` first —
**verbatim**, and check 37 asserts a stepped fight is `JSON.stringify`-identical to a drained one.
If those ever move together, the hook has leaked a draw and every replay in the game is wrong.

**`battle` never sees a bag.** Every Action carries its item id and the *caller* debits, so one
decision implementation serves a live `economy.take()` and an offline carry.

**(b) An ally faint stops being terminal, and `winner` is redefined.** `turn()` calls a fight
over the instant either side hits zero, which is right for the turn and wrong for the duel: the
brief says a revival may fire, that the next member steps up, and that only an empty party loses
the hunt. So the *stepper* owns it — revive first, swap second, wipe third — and `winner: 'b'`
now means **the party ran out**. Measured live in the forest: a lead Oshawott fainted on turn 3
and the fight ran to turn 10 and was won by the Snivy behind it.

**(c) The strike is a derived event, not a reshaped transcript.** The brief's list (attacker,
target, move, damage, effectiveness, crit, miss, faint) is not any single transcript event:
`move` and `damage` are separate, `species` is the *victim* on `damage`/`miss`/`immune` and the
*actor* on `move`/`recoil`/`drain`, a multi-hit collapses into one `damage` with `hits > 1`, and
`faint` carried no `actor` at all. Reshaping them would have moved the transcript-length golden
and broken `lineFor`'s thirteen kinds. So `battle/strike.js` folds on top, `encounter` emits
`battle:strike` (because `battle` has no `ctx` and must keep none), and the one change to the
transcript is **additive**: `faint` gains `actor`, without which a Caterpie-versus-Caterpie
mirror — which the meadow table produces — cannot say which one fell.

**(d) A Potion was a working Revive, and had been all along.** `pokemon/instance.js heal()` took
a 0 HP Pokemon to 20 with no guard, so the brief's "fainted Pokémon cannot participate" was
unenforceable the moment an auto-heal list existed: the first rule would resurrect whatever had
just gone down, for ₽200. `heal()` refuses `hp <= 0` now and `revive()` refuses `hp > 0`, and
`{ revive: true }` is the Pokemon Center's escape hatch and nothing else's. The old
`pokemon/selftest.js` check 25 asserted the broken behaviour ("a full heal restores maxHp",
healing from 0) and was rewritten with the rule rather than around it.

**(e) `Ether` and `Max Ether` are new, because there was nothing to restore PP with.** Per-move
PP and Struggle have been modelled since the turn engine landed and no item anywhere in the tree
put PP back, so a long hunt ended in a Pokemon flailing at 50 power with recoil and no
purchasable answer. ₽1,200 for 10 PP and ₽2,000 for a slot — ₽120 per PP against a Potion's ₽10
per HP, because a point of PP is worth several turns of attacking and a point of HP is worth one
hit. Both satisfy the no-arbitrage clamp `economy/selftest.js` holds every money-priced item to.

**(f) Two beats are presentation and must never be rules.** `config.turnSteps` (24, so one
exchange is 1.2 s) and `config.reviveSeconds` (5) are counted in **sim steps**, because the
harness freezes the clock and a beat measured in wall time cannot be stopped on an exact frame
(#14). In a fold they are **zero**: a revive costs the item and nothing else. Charging it turns
instead would mean skipping both sides (a no-op) or only the enemy's (a free heal a player would
farm), and either way the fold would need a clock it does not have.

**(g) The card had to become live, and two of its readings were wrong the moment it did.**
`win: null` rendered as `Lost after 3` — a defeat printed on screen in the middle of a fight the
party went on to win — so the verdict has three values now. And both HP bars read
`pokemon.lead()`, which is not written back until the last blow, so they showed full health under
a transcript that said somebody had fainted. The card reads the stepper's state while the fight
runs, which also fixes *which* Pokemon it names after a swap. `lineFor` had the mirror of that
bug: it credited a move to `names[ev.actor]`, so Oshawott's Tackle was labelled Snivy once Snivy
replaced it; the event's own `species` wins now.

**(h) The move callout is on the 2-D canvas, and its lift is measured.** Text in 3-D would need a
second font atlas as a texture and a draw call per balloon; projected through `ui.project()` it
costs zero (#34a), and under the orthographic camera the projection is exact with no depth divide
to make it disagree with the sprite below it. Two numbers came out of looking at the frame rather
than reasoning about it: **3.1 world units of lift**, because a sprite is 2.83 tall (#18) and at
2.15 the balloon lay across the face of the Pokemon speaking; and a **horizontal lean**, because
`encounter` stages the wild two cells in front of the party's Pokemon and a sprite covers exactly
two tiles of ground depth on screen — so a balloon lifted clear of the wild's head lands
precisely on the Pokemon, every time, and no vertical lift can separate them.

**(i) `THROWS_PER_FAINT = 1` and `WIPE_PENALTY = 0.10` are exported and pinned.** One throw per
defeated wild was true only by accident before — `resolve()` cleared `active` at the end of the
first one — and an accident is not something a reader can rely on. Both are the kind of constant
a later change relaxes quietly ("a second ball so a rare one is not lost"), and the pity ladder
`economy/pricing.js` is anchored to only measures anything while a throw costs a *victory*.

**(j) The wipe is emitted, not executed.** `encounter` pays, heals and emits `party:wiped`;
`travel` listens and hops on the next frame. Doing it inline would re-enter `travel.go()` — async,
serialised behind `busy`, and itself a caller of `encounter.cancel()` — from inside the encounter
it is cancelling, which is how a deadlock gets written.

**(k) The production build shipped with no sprite art, and every stage of the gate was green.**
`publicDir` copies `public/`; `assets/` was reachable in dev only because Vite serves the project
root. So `vite preview` — the bytes a player downloads — drew all 1,253 creatures and the trainer
as untextured quads. It survived because of *where the gate looks*: `boot.js` and `regress.js`
shoot the **dev server**, so a file that never reached the build is still there for the capture,
and the one stage that uses the build (`coldBoot`, #71) measures time to `__READY__` — and an
untextured quad is exactly as fast to draw as a textured one.

The fix is a build plugin; the part worth keeping is the **check**. `tools/gate.js`'s build stage
now asserts that every `/assets/<root>/` URL `src/` constructs is a root `vite.config.js` copies,
and that each one landed in `dist/` non-empty. Both halves are *derived* — the roots from the
config, so the plugin and the check cannot disagree, and the URLs from a grep of `src/`, so a
fetch added tomorrow is covered tomorrow. `props/` and `structures/` are deliberately not copied:
they are OBJ/MTL build input that `tools/assets/build-tiles.js` bakes into `public/generated/`,
and shipping them would put a megabyte in front of a player for nothing.

**(l) Two things were running the hunt at once.** `idle/index.js` tracked `document.hidden` for
*reporting* and never as a gate — `reconcile()` fires from worker beats, frames and
`visibilitychange` alike — so a tab you were watching had `encounter` stepping real fights on the
map **and** `idle` folding a model of the same loop beside it. It was harmless only because
`pure.resolve` runs with the writeback off, and it stops being harmless the moment
`gains.progress` carries party HP and a bag: two drivers would damage one party and spend one bag
twice, and no check in the tree would notice.

So: **exactly one driver at a time.** Visible → `encounter`; hidden → `idle`; closed → `offline`.
The second is still measured and `lastWallMs` still advances when the fold is skipped, so a
discarded second can never be paid twice later — it is simply not that module's second. And the
**encounter counter changes hands at the edge**: there is one index space (#61(f)) and there were
two counters walking it independently, which is that entry's own disagreement arriving from the
other end. Measured in the forest: 300 s visible folds nothing (`watchedS 300.27`, 0 encounters);
the same 300 s hidden folds 10; coming back leaves `encounter.progress().encounters` at 10 rather
than at 0, so it resumes where the fold stopped instead of re-walking indices it already spent.

`idle.driver()` is published and `?debug=1` draws it, because "exactly one driver" is a claim a
screenshot should be able to settle rather than one a comment asserts — the same reasoning
`?break=` was added under (#70).

**Cost.** `ui` gains a `tick` hook it did not have, because a callout's life is a count of sim
steps and spending it at render rate made a balloon expire between two `__HOOKS__.step()` calls
with no simulated time passing. And `battle`'s API grew five members; §5.17 was rewritten, along
with four claims in it that were already wrong before this work started (`turn`'s phantom
`turnNo` argument, a `ppSpent` field `resolve` never returned, `movesFor` returning "exactly 4"
when it returns 1–4, and `moves()` where the code has `moveIds()`).

---

### 73 — 2026-09-10 — A hunt walks to its wildlife: one step off the circuit, both legs queued at once

DECISIONS #67 moved the trigger from a tile to a slot and set the reach to **2**, and the
reasoning was right for what the game did then: a slot is authored at Chebyshev 2 from the
circuit, so a reach of 1 could never fire from a cell on the path — measured, 23 encounters over
four laps and every one from tall grass. The brief asks for something else. A battle should begin
when the trainer's Pokémon **physically reaches** a living wild, and the party should move toward
the next living target rather than walk past one at shouting distance.

**(a) The detour is exactly one step, and the geometry is what proves it.** `slotsForLoop` tries
only *axial* offsets — `[±2,0]`, `[0,±2]` — from a specific perimeter cell, and its `near()` test
already rejected any candidate with a loop cell at Chebyshev < 2. So the midpoint between the path
cell and the slot is Chebyshev 1 from both **and is provably never a loop cell**. That kills the
path search the first design reached for: a slot records `from`, `step` and `approach`, and the
detour is the pair `[step, opposite(step)]`.

**(b) Both legs are queued at commit time, and that is the load-bearing choice.** Nothing has to
run when the fight ends to bring the party home — so a `hunts` quarantined mid-duel cannot strand
the queue off its own route, which is §2.1's rule applied to a walk rather than to a frame.

**(c) It is drained AHEAD of the autopilot, so the route never learns it happened.** `route.next`
is not called on a queued step, so a scripted route's index cannot advance; the head returns to the
cell it left owing exactly the step it owed before. Checked against `route.js` itself rather than
reasoned about (`simulation/selftest.js`): six steps of `'e4 s4 w4 n4'` leaves the route at index 6
on (14,12); a `[NORTH, SOUTH]` leg returns the head to (14,12) with the index still 6, and the next
four steps are `s s w w` — exactly what it owed. `audit()` is untouched because it walks
`loop.cells`, which a detour never edits.

**One defect this found in itself.** The first cut drained the detour *before* testing `paused`,
so `pause(true)` — which is what a battle does — did not stop it: the head walked the return leg
**during the fight** and the wild was left punching an empty cell. Measured on the frozen frame:
head and trainer on the same cell at (32,29) with the wild staged two away. `paused` gates the
detour now, which is what makes queuing both legs work at all — the queue freezes with the return
leg in it and `pause(false)` on `encounter:resolved` walks it home.

**(d) `slotEngageTiles` goes 2 → 1.** At 2 the encounter fires from the path *before* the detour is
taken and the party never leaves the circuit at all. The number that was right in #67 is wrong now
for the same reason it was right then: it measures the distance from the walk, and the walk moved.

**(e) The wild fights where it was standing.** `stageCell()` put it two cells in front of the head,
which is what a tall-grass encounter wanted; after a detour that would move the creature away from
the spot the player just walked to. A slot encounter stages on the slot's own cell.

**(f) Wild Pokémon are solid, and the same arithmetic is why that cannot wedge anything.** The
worry was a tethered wild drifting onto the path and stalling a `strict` route. It cannot: a slot
is at Chebyshev exactly 2 from the circuit (`audit()` asserts it on every `enter()`) and the tether
radius is 1, so **a wild's reachable set never touches a loop cell**. The only blocked cell a
walker can meet is a detour's approach, and `holdNpc` freezes the target at commit — because a
creature that drifts a tile between the commit and the arrival turns a two-step detour into a miss.
Only `hunts` opts its wildlife in; the city's NPCs stay walk-through.

**(g) The decorative-wildlife fallback is deleted.** `spawnWild` fell back to the biome's
`wildCells` scatter when a map got no circuit, and those creatures sit at no slot — `takeSlot` has
nothing to hand over and a player can walk past them forever. The brief is explicit that every wild
visible on a hunt map must be huntable, so a map with no loop now stands empty and warns. A wood
with no animals is a legible bug; a wood full of animals that cannot be fought is not.

**(h) `lapSteps` is reset in `enter()`.** It carried across a biome change, so the first lap of a
new hunt healed early by however many steps the previous one had banked.

**Measured, forest, three slots:** 3 detours → 3 battles started, ended and resolved, engaged in
lap order (slots 0, 1, 2); the head left the circuit at exactly three cells, which are the three
authored approaches; `audit()` `ok: true, checked: 9, fails: []`; **zero console errors and zero
warnings**, so `strict` never stalled. `shots/out/contact.png` is the Oshawott standing next to a
shiny Seedot with both moves called out and the trainer behind it on the path.

**(i) The tall-grass step roll is deleted everywhere, and the city table with it.** #61(h) kept the
lobby's 23 rows on the argument that a walkable map the player drives is played differently from a
hunt. The brief asks for the random-encounter system to go, and with slots and a detour there is
nothing left for it to do: a hunt meets what is standing on a slot, and the city is a Center, a
Mart and a plaza. `roll()`, `stepRollAt`, `stepRate`, `STEP_RATE` and the `step/0` stream pin all
go; `roll/7` and `catch/5/1` did not move, which is the evidence the index space survived.

The city table is **emptied and not deleted**, and the difference is the bug it prevents:
`tableFor` falls back to **meadow** for a biome not in `BIOMES`, so dropping the key would have the
lobby quietly spawning the meadow's wildlife through `idle` rather than none at all. A silent wrong
answer in place of a loud empty one. `validate()` moved with the rule — a table with no rows is a
deliberate empty and is skipped; a table with rows that leave an hour bare is still a bug.

A tab closed in the city now accrues nothing, which is a real behaviour change and is the point:
the hunt is the game.

**(j) `biome.walk` was deleted and put back, and what that measured is worth more than the change.**
The plan for this phase was to delete the pre-loop authored routes so `/` and every showcase walk
one circuit — an open STATUS item since the loop landed. Done, and the gate said: `hunts/meadow/21`
`over200Pct 1.198 -> 0`, `max 255 -> 161`. The night frame had lost its brightest pixels, and
looking at it, its **motivated light source** — flat blue darkness with wildlife in it, which is the
one thing four rounds of blind A/B lost on every round (§0).

The cause is not the staging. Measured on the running page: the meadow's found circuit is a
**6×17 corridor at x 38–43**, fifty cells of a 64×60 map, and the campfire that is its only night
practical sits at (25,32) — **14 cells away**, with the `lane` marker the showcase frames 23 away.
The circuit does not visit the places the biome composes. `biome.walk` had been hiding that
completely: it stages every showcase and preset at the *markers*, so **every hunt frame this project
has ever judged shows a part of the map the game does not walk.**

So the deletion is reverted, and the defect is filed with its numbers. Deleting the second route is
still right and still has to happen; it lands after the circuit visits the composition, because the
alternative is shipping a lightless night frame to close a bookkeeping item. A green gate that costs
a frame its practical is the gate being wrong about what it can see, not permission.

---

### 74 — 2026-09-10 — The circuit was a corridor in a corner, and one route means the showcases walk it too

Phase B shipped a detour that reaches the creature standing on a slot (#73), and the party still
never got near one — in the view a person is most likely to open. Measured in
`?showcase=hunts&mode=meadow`: **53 cells visited, two of them on the loop, zero encounters in two
thousand ticks.** Three separate defects, each hiding the next.

**(a) `findRectangle` returned the first rectangle that fit, and walked height-major.** `size` from
`max` down, and for each `size` a width from `size` down to `min` — so the entire width sweep at
size 22 ran before size 21 began, and a **6×22 corridor was accepted before a 21×21 square was ever
tried**. On the shipped meadow that produced a 6×17 ring at x 38–43: fifty cells of a 64×60 map,
hugging one edge, with the campfire that is the biome's only night practical **14 cells away** and
the marker every showcase frames 23 away.

It scores now, and each term is there for something a picture shows: **area**, because a bigger ring
walks more of the map and holds more slots; **squareness**, because a corridor reads as a corridor
and at Chebyshev 2 its two sides compete for the same cells, which is why a narrow ring thins its
own slots; and **composed ground**, the share of the ring standing on `preferTags`, which is what
pulls the circuit onto the trail the biome laid and past the lamps that make a frame worth looking
at. An area floor derived from the best score so far keeps the sweep from being exhaustive.

| | before | after |
| --- | --- | --- |
| meadow | 50 cells, 6×17, **5 slots**, light 14 away | **78 cells, 26×13, 9 slots, light 1 away** |
| forest | — | 68 cells, 8 slots, light 2 away |
| coast | — | 82 cells, 9 slots |
| cave | — | 56 cells, 8 slots, lights 1 away |

Nine slots is the number `SLOTS` asks for, so this also closes the open item that said slots thin as
the circuit bends: they were thinning because the ring was narrow, not because it was bent.

**(b) `biome.walk` is deleted, and `setFormation` is the wrong door.** The authored routes predate
the found loop (#65) and survived it, so `/` walked the circuit and every showcase walked
`'e16 n2 e10 s2'`. Replacing them with the found loop staged **nothing moving at all**, because
`setFormation` refuses to start an autopilot under `config.showcase` — a showcase stages its own
frame. `stageWalk` had been going through `sim.walk()`, which bypasses that guard, and so does its
replacement; `enter()` has already set the formation, so all a staging call has to hand over is the
route.

**(c) Two bugs the first working version then showed, both measured.** The head ping-ponged:
**216 detours in 2000 ticks over twelve cells of map**, because nothing took the creature — a
showcase does not arm `encounter` — so the head stepped back onto the cell it left, the
`player:enteredTile` for that cell fired again, and it committed the same detour forever. One
attempt per slot per lap, cleared on `hunt:lap`, which is also the honest reading of *move toward
the next nearby living target*. And the coast walked **63 of 70 visited cells off its own loop**,
because the staged trainer was handed `dirs[best + gap]` — the head's next step — where `Line.place`
lays the whole queue along the direction of travel at the **trainer's own** cell. The staged start
also has to begin a straight run of `gap + 1`, which is DECISIONS #65(c) for the third time and now
asserted where a start is chosen rather than only where the ring is opened.

**What the frames say.** `hunts/meadow/21` had lost its motivated light entirely when this phase was
first attempted — flat blue darkness, which is what four rounds of blind A/B lost on every round —
and that is why the deletion was reverted rather than accepted. With the circuit fixed the campfire
is **in frame, lighting the trainer**, on the composed bank of the brook. The forest's default
framing moved from `clearing` (13 cells from its fire) to `path` (6 from the fire, 1 from the
circuit), which puts the fire centre-frame instead of raking in from the right edge.

**Baseline re-accepted, frames named:** `hunts/meadow/12`, `hunts/meadow/21`, `hunts/forest/12`,
`hunts/forest/17.5`, `hunts/forest/21`, `hunts/coast/12`, `hunts/cave/12`. Every one was looked at.
`hunts/cave/12` reads as a regression by histogram (`over200Pct 1.175 → 0.748`) and is a better
picture: a torchlit gallery with four creatures, a mine cart and a cool blue pool, instead of a
tighter shot of less of it.

---

### 75 — 2026-09-10 — Every species gets its own drop table, the bag splits into two views, and the opening purse is not "earned"

**(a) A per-species table, derived, on a fixed draw budget.** 1253 hand-written tables is not a
thing anyone keeps correct, so a table is derived from what `species.json` already carries — and
the derivation reuses **`pokemon/evolution.js`'s type → material map**, so the wood full of Grass
types is where mushrooms come from and mushrooms are what a Grass evolution costs. Four rows: the
biome's ladder, the species' own type's material, its second type's a rung lower, and its family's
best rung if it is a big species. `SPECIES_DROPS` is the hand-authored override and is empty,
which is an honest statement that nothing has earned one yet.

**The order of those rows is a balance decision, and the obvious order was wrong.** Putting the
species' own type first moves the main payout from *rarity* to *typing*, because the four families
do not carry the same money — `star` tops out at a Comet Shard (₽60,000) and `pearl` at a Pearl
String (₽15,000). Measured: a Gible in a forest went from a Balm Mushroom (₽25,000) to a Comet
Shard at the same 46 %, quadrupling the top of the drop curve as a side effect of a table *shape*.
So the place leads and the species flavours it, and the economics are where #68 left them.

**A second thing the arithmetic hid:** rows are independent coins, so adding them raises the chance
a win pays *anything* even though no single row got likelier. At 0.46/0.28/0.15 the measured rate
was **66.6 %** against `DROP_CHANCE` 0.46 — a 45 % rise in hunt income smuggled in as a shape. The
per-row odds are now chosen so the aggregate lands back on 46 % (measured 45.2 % over 20,000 rolls,
asserted in the selftest over a sweep rather than trusted from the arithmetic).

**Determinism: eight draws, always.** One whether/quantity pair per row of `MAX_DROP_ROWS`, taken
before anything is decided and discarded where a row does not exist. Without the budget the stream
position would depend on which species a slot happened to be holding — and a slot respawns a
different species every time it refills, which would renumber the loot of every encounter after it.

**And a cache bug the selftest caught, not the eye.** `tableFor` keyed its memo on the species
*name*, so every nameless caller shared one entry under `null` and a rate-40 rare was handed a
rate-255 common's rows. The key is every input it reads now.

**(b) The mirrored catalogue gets a seam rule.** `encounter` may not import `pokemon`'s internals
and neither table belongs in `core`, so the twelve treasures and the type map are copied — and
`tools/seams/run.js` **rule 7** holds the copy to the original by name and by value, plus checks
every id is a real item. Rule 5 sets the precedent and exists because exactly this kind of copy
drifted once with nothing able to notice. Proved it fires by flipping `water: 'pearl'` to
`'mineral'` and watching it fail.

**(c) Stash and Bag are two views of ONE Map.** The item id already carries the answer —
`category: 'treasure'` is loot, everything else is something a hunt spends. Splitting the Map
forks `count`, `give`, `take`, `inventory`, `bagSize`, `stackCap` and `multipliers` (which scans
the bag for `passive` items) for no behaviour, and makes a re-categorised item **unrecoverable**:
it would sit in the wrong container in every existing save with no way for a migration to guess.
Derived, it moves for free. Both views return the same eleven-field row, which is how "the HUD
renders both consistently" stops being a promise and becomes a type.

**(d) Sell-Lock bites on the automation, not at the counter.** The brief calls it a lock on
*automatic* selling. `economy.sell()` ignores it — a player standing at the shop asking to sell
something is not what it protects against, and refusing them there is a trap — and `planSell` skips
a locked id **before its rules run**, so no ruleset can outvote the player's own instruction. That
is stricter than auto-release's protective rules, which can at least be reordered.

**(e) `FIELD_START_MONEY` is ₽100,000 and is deliberately not earned.** **Checked, not assumed:**
`state.add` did `if (applied > 0) stats.earned[id] += applied` with no `raw` test, and
`progress().totalEarned` is `floor(stats.earned.money)` — the number every money-priced shelf is
unlocked against (Department Store ₽150,000, Full Restore ₽400,000). At ₽3,000 counting the start
credit was noise; at ₽100,000 it would put a brand-new save two thirds of the way to a gate it is
meant to earn. `earned: false` is one line, against the alternative of lifting every gate ~3× and
re-balancing a ladder nobody has measured.

The kit the purse is sized against is what a lap actually consumes — 20 balls, 10 Potions, 3 Super
Potions, 2 Revives, 3 Ethers, ₽10,600 — and the selftest asserts it is under a quarter of the
purse, because "enough for a kit" can be technically true and practically a lie.

**(f) `BUY_COOLDOWN` is not new state.** The brief names a cooldown between automatic purchase
cycles; `restock` already declared one as `everyS`, counted in the automation engine's own **sim
seconds** (`due()`/`mark()`). Naming it is what makes the brief's word point at something a reader
can find. Wall-clock milliseconds in `economy` would have been a third clock, unreplayable in a
fold, and a save key for no reason.

**No document migration.** `economy/state.js` already migrates its own slice and §5 requires
`loadState` to tolerate an older one, so `sellLock` defaults to `[]` slice-side and
`offline/migrations.js CURRENT_VERSION` stays at 4. A version bump is for a shape change that
crosses slices, and this is not one.
