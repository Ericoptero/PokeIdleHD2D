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

Format — a `### NN — YYYY-MM-DD — title` heading, then the decision, then why, then what it
costs:

```
The decision, in one bold sentence, and the paragraphs that make it checkable from the code.

**Why:** the alternatives, and what each one would have cost.

**Cost:** what this constrains, and what it will not catch.
```

---

### 71 — 2026-09-09 — The cold-start budget is measured against the build, not the dev server

§7 has budgeted "time to `__READY__` ≤ 6 s cold" since the harness was written, and nothing
ever asserted it. Measured 2026-09-09 against the dev server: 3.6–6.0 s warm, 7.5–15.0 s cold.

The page's own boot did not change between those runs. What changed is that Vite's dev
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
`ui/panels/battle.js` said so in its own header, "Why it reads a finished fight". The
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
→ Superseded by #80: `nextAlly` asks `automation.chooseLead`; party order is only the fallback.

**`battle` never sees a bag.** Every Action carries its item id and the *caller* debits, so one
decision implementation serves the watched fight and the fold alike — both through `encounter`'s
`economy.take()`, because the fold drains the same closure and carries no items of its own.

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
just gone down, for ₽200. `heal()` refuses `hp <= 0` now and `revive()` refuses `hp > 0`;
`{ revive: true }` is passed by the Pokemon Center (`pokemon.reviveAll`) and by `encounter`'s
post-fight writeback when a Revive was used mid-duel — and a level-up or evolution still raises a
fainted member to 1 HP, because `refreshStats` keeps the HP *fraction* with a floor of 1. The old
`pokemon/selftest.js` check 25 asserted the broken behaviour ("a full heal restores maxHp",
healing from 0) and was rewritten with the rule rather than around it.

**(e) `Ether` and `Max Ether` are new, because there was nothing to restore PP with.** Per-move
PP and Struggle have been modelled since the turn engine landed and no item anywhere in the tree
put PP back, so a long hunt ended in a Pokemon flailing at 50 power with recoil and no
purchasable answer. ₽1,200 for 10 PP and ₽2,000 for a slot — ₽120 per PP against a Potion's ₽10
per HP, because a point of PP is worth several turns of attacking and a point of HP is worth one
hit. Both satisfy the 90 % resale clamp: `economy/selftest.js` check 28 pins the two ethers to
it, and the every-item sweep is `economy.selfTest()`, which runs in the browser, not under seams.

**(f) Two beats are presentation and must never be rules.** `T.TURN` in `encounter/index.js`
(24 sim steps, so one exchange is 1.2 s — `config.turnSteps` is declared but not read; wire it
or delete it) and `config.reviveSeconds` (5 s, ×20 into 100 sim steps) are spent in **sim
steps**, because the harness freezes the clock and a beat measured in wall time cannot be stopped
on an exact frame (#14). In a fold they are **zero**: a revive costs the item and nothing else.
Charging it turns instead would mean skipping both sides (a no-op) or only the enemy's (a free
heal a player would farm), and either way the fold would need a clock it does not have.

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
`travel` listens and hops from a queued microtask, once the synchronous emit has returned. Doing
it inline would re-enter `travel.go()` — async, serialised behind `busy`, and itself a caller of
`encounter.cancel()` — from inside the encounter it is cancelling, which is how a deadlock gets
written.

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
they are OBJ/MTL build input that `tools/assets/build-structures.js` (once per slug: `structures`
by default, `--src assets/props --slug props`) bakes into `public/generated/tiles/`, and shipping
them would put a megabyte in front of a player for nothing.

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
other end. Measured 2026-09-10, forest: 300 s visible folds nothing, the same 300 s hidden folds
10, and the counter comes back at 10 rather than 0.

`idle.driver()` is published and `?debug=1` draws it, because "exactly one driver" is a claim a
screenshot should be able to settle rather than one a comment asserts — the same reasoning
`?break=` was added under (#70).

**Cost.** `ui` gains a `tick` hook it did not have, because a callout's life is a count of sim
steps and spending it at render rate made a balloon expire between two `__HOOKS__.step()` calls
with no simulated time passing. And `battle`'s API grew five members; §5.17 was rewritten, along
with two of the four claims in it that were already wrong before this work started (`turn`'s
phantom `turnNo` argument and a `ppSpent` field `resolve` never returned); the other two —
`movesFor` returning "exactly 4" when it returns 1–4, and `moves()` where the code has
`moveIds()` — outlived that rewrite.

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

**Measured 2026-09-10, forest, three slots:** 3 detours → 3 battles in lap order, `audit()` ok,
zero console errors or warnings — `strict` never stalled.

**(i) The tall-grass step roll is disconnected everywhere, and the city table with it.** #61(h)
kept the lobby's 23 rows on the argument that a walkable map the player drives is played
differently from a hunt. The brief asks for the random-encounter system to go, and with slots and
a detour there is nothing left for it to do: a hunt meets what is standing on a slot, and the city
is a Center, a Mart and a plaza. `roll()`, `stepRollAt`, `stepRate`, `STEP_RATE` and the `step/0`
stream pin all go; `roll/7` and `catch/5/1` did not move, which is the evidence the index space
survived. `stepRoll`/`stepValue` still sit in `rolls.js`, uncalled, and go the next time that file
is touched.

The city table is **emptied and not deleted**, and the difference is the bug it prevents:
`tableFor` falls back to **meadow** for a biome not in `BIOMES`, so dropping the key would have the
lobby quietly spawning the meadow's wildlife through `idle` rather than none at all. A silent wrong
answer in place of a loud empty one. `validate()` moved with the rule — a table with no rows is a
deliberate empty and is skipped; a table with rows that leave an hour bare is still a bug.

A tab closed in the city now meets no species — `rollAt` returns null on the empty table — but
`idle/accrual.js` still pays the city's passive EXP and per-event EXP on those null encounters, so
"accrues nothing" is not yet true; money was already zero everywhere (`BASE_MONEY = 0`). The
hunt is the game, and closing that gap is open work.

**(j) `biome.walk` was deleted and put back, and what that measured is worth more than the change.**
Deleting the pre-loop authored routes so `/` and every showcase walk one circuit cost
`hunts/meadow/21` its only night practical (`over200Pct 1.198 → 0`): the meadow's found circuit
was a 6×17 corridor at x 38–43, fourteen cells from the campfire, and `biome.walk` had hidden that
by staging every showcase and preset at the *markers* — so **every hunt frame this project had
ever judged showed a part of the map the game does not walk.** Reverted here, because a green gate
that costs a frame its practical is the gate being wrong about what it can see, not permission.
→ Reversed by #74(b): the circuit was fixed and `biome.walk` deleted one entry later.

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

Measured 2026-09-10: the meadow ring went 50 cells, 6×17, 5 slots, light 14 away → 78 cells,
26×13, 9 slots, light 1 away; forest 68 cells / 8 slots, coast 82 / 9, cave 56 / 8.

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

**Baseline re-accepted 2026-09-10** for the seven hunts rows, every frame looked at; `hunts/cave/12`
reads as a regression by histogram (`over200Pct 1.175 → 0.748`) and is the better picture.

---

### 75 — 2026-09-10 — Every species gets its own drop table, the bag splits into two views, and the opening purse is not "earned"

**(a) A per-species table, derived, on a fixed draw budget.** 1253 hand-written tables is not a
thing anyone keeps correct, so a table is derived from what `species.json` already carries — and
the derivation mirrors **`pokemon/evolution.js`'s type → material map** (a copy, held equal by
seams rule 7 because `encounter` may not import it), so the wood full of Grass types is where
mushrooms come from and mushrooms are what a Grass evolution costs. Four rows: the
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
per-row odds are now chosen so the aggregate lands back near 46 % (the arithmetic says 44.6 %; the
selftest sweeps 3,000 rolls and asserts within ±4 points rather than trusting the arithmetic).

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
Potions, 2 Revives, 3 Ethers, ₽15,700 — and the selftest asserts it is under a quarter of the
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

---

### 76 — 2026-09-10 — The fight decides for itself: four automations that are not on a cadence, and a gate that could never open

**(a) `src/automation/duel.js` is pure, and that is the requirement rather than the taste.** The
visible fight steps `battle.stepper` and calls these between turns; `idle` and `offline` drain the
same stepper and call the same functions. Anything that decided differently in one path would make
a replayed fight a different fight (#72). So no function here draws a coin, reads a clock or
reaches a module, and it runs under Node against literals.

**Items are named, never spent.** `applyAction` in `battle` changes the combatant and **the caller
debits** — `encounter`'s `between` wrapper through `economy.take()`, on the watched fight and on
the closed-tab fold alike, because the fold's `pure().resolve` builds the same closure and neither
`idle` nor `offline` carries items (both carry money and tokens only). That is what lets one
implementation serve both, and it is why `automation` gets a `stock` snapshot rather than an
inventory.

**(b) None of the four is in `PASSES`, and `everyS: 0` says so.** `PASSES` is the round-robin
tick; heal, revive and ether run *between turns* and lead runs *at engagement*. On a cadence they
would fire against no fight at all — which is exactly the trap `hunt` and `catch` already sit in,
declaring an `everyS` that nothing reads. Naming the two call sites beats adding a third.

**(c) The healing ladder is an ordered list and not a condition tree, and the reason is the bag.**
The brief's rule is *the first enabled rule whose HP threshold has been reached **and whose item is
available***. The rules engine cannot see an inventory, so a ruleset can express the threshold and
not the stock — and a ladder that stops at the first *threshold* it meets reports nothing when that
bottle has run out, leaving a party at 8 % HP holding a shelf of Potions it never reaches. So
`ladder` and `order` join the setting types, coerced and shape-checked on restore because a save is
a file a player can edit and a malformed rung would be a silent no-op at the worst possible moment.

Dearest-first is the ordering the brief gives and the selftest asserts it as a property: a Potion at
10 % HP does not prevent the faint it was spent on, and the faint costs the item *and* the Pokémon.

**(d) Auto-Lead weights offence, then defence, then health — spread far enough apart that the order
is the order.** `offence * 1000 + defence * 10 + health`, so a good matchup at 5 % HP still outranks
a bad one at full, and health only ever separates equals. Fainted members are never eligible, which
is the rule a Potion could break until #72. The type chart is injected rather than imported:
`automation` may not reach into `battle`, and a pure function with two stubs is testable in Node.

This closes the top open item, which has read *"a Water starter walks into a Grass wood"* since
DECISIONS #68(d) measured it. Live in the forest: one lead change, Tepig to the front.
→ Superseded by #80: the offence term was inert until the move resolver was injected, so that
lead change was decided by defence and health; the rule is also asked at every swap now.

**(e) An unlock gate could not be met, and nothing had noticed because nothing had tried.**
`automation`'s `progress()` returned three hand-listed keys — `dexCaught`, `stored`, `money`. Every
shipped automation gated on the first two, so it worked. The first one to gate on `battlesWon` read
`Number(undefined) || 0` and the gate could **never** open: measured at 21 battles won, with
`unlock('heal')` still answering *"needs 5 battlesWon (0)"*. It spreads `economy.progress()` now, so
a gate can name any counter the ledger keeps and a new one is covered the day it lands.

`money` changed meaning with it, from the **balance** to `totalEarned`. Its own label in
`requirementText` has always read "₽ earned", and every money-priced shop gate is measured on
`totalEarned` — so a wallet spent down was quietly re-locking things it had never unlocked. No
shipped automation gates on it, so this is a latent mislabel fixed rather than a behaviour change.

**(f) A builtin added after a save now reaches it, appended.** The old line was
`from.rules?.length ? clone(from.rules) : defaultRules(id)` — a saved list won outright, so a rule
shipped after a player's last save could never reach them, which the brief forbids in as many
words. New builtins go on the **end** and a saved rule always keeps its place: the engine is
first-match-wins, so inserting one would let a shipped default outvote an ordering the player
chose, and reordering somebody's list from a patch note is a reset with extra steps.

**Measured 2026-09-10, forest, twelve encounters with the four on:** the ladder fell through an
empty Max Potion rung to Super Potions, 8 Potions and 1 Ether were debited, party alive, zero errors.

---

### 77 — 2026-09-10 — The automation panel: reordering is buttons, and a control has to be reachable rather than drawn

`automation` has published `schema()`, `fields()`, `operators()`, `addRule`, `updateRule`,
`removeRule`, **`moveRule`**, `settings()` and `configure()` since it was written, and §5.11 has
called that "the schema `ui` renders from" for as long. Nothing rendered it: `moveRule` had **zero
callers anywhere in `src/`**, and after #76 four automations that decide what happens inside a
fight were configurable only from a console. Four automations nobody can see are not shipped.

**(a) Reordering is `^`/`v` buttons, and drag was rejected on the mechanism rather than the
taste.** The HUD is one 2-D canvas whose hit-region list is rebuilt every paint (`screen.js`);
there is no pointer capture, no drag state, and nothing that survives a repaint mid-gesture.
Building that for lists that ship at most nine rows (auto-release's; the engine caps any at
`MAX_RULES` 64) would be a subsystem in service of a flourish. Two buttons per row work on pointer
and touch and say what they do — no key moves a rule — and land exactly on the primitive that was
already there.

**(b) Every list draws its rank, because first-match-wins is invisible otherwise.** The healing
ladder, the rulesets and the ball tiers are all "the first one that applies". A player who cannot
see that writes a first row that eats every case and then reports the automation as broken. The
number is in the margin of every row and the footer says it in words.

**(c) The panel list moved to `input.js`, and both halves are now checked.** `ui/selftest.js` runs
under Node and cannot import `index.js` — it reaches a canvas at init — so the Node check carried
its **own hand-written copy** of which panels exist, and failed the day one was added. That is the
check being brittle, not the panel being wrong. `PANEL_IDS` lives beside the shortcut map now, the
Node check derives from it, and `ui.selfTest()` asserts the live `PANELS` object matches — so
neither half can quietly stop being true.

The shortcut is `U`, not `A`: `A` is *walk left*, and `selftest.js` caught it in the same run.

**(d) `screen.regions()` publishes the clickable boxes of the last paint.** A diagnostic surface
like `bus.spy()`, and it earns its place immediately: a button drawn under another panel, or off
the buffer, looks **identical in a screenshot** to one that works. With it a capture can drive the
shipped pointer path and assert what actually changed. Used exactly that way to check this panel
in: the `+` took the ladder's first rung from 10 % to 15 %, `v` swapped it below Hyper Potion, and
`up-sell-balls` reordered a ruleset — measured as `[10,22,32,45] → [22,15,32,45]` and
`[unsellable, balls, …] → [balls, unsellable, …]`, through real `pointerdown` events at real
canvas coordinates.

**Two things the frames caught.** The selected row's blurb was drawn in a fixed grey over the
selection highlight — the one line in the panel you could not read — and now follows the row's own
ink. And the ladder printed `Maxpotion`, because the panel was title-casing an item **id**;
`economy` owns the catalogue and is the only thing that knows it is called a Max Potion.

**What is deliberately not here.** Rule *authoring* — adding a condition, picking an operator — is
not in this panel. Every rule can be reordered, switched off and read, which is what the four new
automations need; a condition builder is a second panel's worth of work and nothing is blocked on
it. Saying so beats shipping half of one.

---

### 78 — 2026-09-10 — A budget is spent by what an item does, not by what shelf it is on

Two halves of the brief that #76 left: the per-species ball ladder, and Auto-Buy's targets and
category priority.

**(a) `item.category` cannot express the brief's order, and that is the whole difficulty.** The
brief spends a budget *Healing → Revival → PP restoration → Poké Balls*, and **three of those four
are `category: 'medicine'`**. Rule order got most of the way there and could not finish: one
medicine rule ordered its items by price, so a thin wallet bought twenty Potions instead of the
one Max Potion that keeps a party standing — which is exactly the "must not simply purchase the
cheapest item first" the brief forbids.

So `economy.purchaseClass(id)` reads what an item **does** — `heal.revive` makes it a revival,
`heal.pp` makes it PP, `heal.hp` makes it healing, `category: 'ball'` a ball — and is derived, so
an item added tomorrow is classed the day it lands. It is exposed through the API because
`automation` may not import `economy`'s internals. Price still breaks ties *inside* a class, which
is the one place cheapest-first is right.

**(b) A target the player typed beats a default a rule shipped with.** `targets` is
`{itemId: count}` — the brief's own "10 Potions, 5 Ethers, 20 Poké Balls" — and it wins over a
rule's `upTo`. An item with a target is bought whether or not a rule happens to name it, because
a number somebody entered is an instruction and a rule they never edited is a suggestion.

**(c) The ball ladder is a preference, not an override.** The brief asks for a chosen first,
second and third — per species in Advanced mode — *and* for a fallback to "the best available
option". So `decideBall` walks the ladder, takes the first ball actually in the bag, and falls
through to the cost-per-catch optimiser when none of them is there. A ladder can therefore never
make the choice **worse** than not having one. Measured: with only Great Balls in the bag a
`['ultraball','greatball','pokeball']` ladder answers `greatball` with `why: 'your ladder'`.

**One thing that had to be said out loud in code.** `ballSettings()` is a deliberate *whitelist* —
`ball.js`'s optimiser takes a fixed shape and a stray key from a save would reach it silently — so
the three new keys are listed there rather than spread in. The ladder was written, saved, coerced
and ignored until they were, which is the whitelist working and then being wrong.

**(d) Two more setting types, both maps.** `targets` (`{id: count}`) and `ladders`
(`{key: id[]}`) join `ladder` and `order`. Every one is shape-checked on restore rather than
trusted, because a save is a file a player can edit and a malformed ladder is a silent no-op at
the moment a shiny appears. And `defaultSettings` deep-copies them: a shared object handed to a
save is a default the player cannot edit — or worse, one they can edit for every save in the tab.

---

### 79 — 2026-09-10 — A move's look is eighteen palettes crossed with three deliveries, and four render bugs that all looked identical

The brief asks for "modern, polished animations based on their move and elemental type" across a
table of **721 moves**. The thing to author is therefore not 721 animations but the crossing:
**eighteen elemental palettes × three delivery shapes** — contact, projectile, field — read off
the move record so a move added to `moves.json` tomorrow is covered tomorrow. Measured over the
shipped table: **291 contact, 240 field, 190 projectile, zero unmapped types.**

**It lives in `encounter`** for the reason §5.17 gives: `battle` is arithmetic and holds no
`three`, `ui` is a 2-D canvas, `pokemon/field.js` is the generic sprite instancer — and
`encounter` already stages the duel *and* already ships 3-D pixel-art VFX in `ball.js`, whose
helpers this file now shares rather than copies.

**Four bugs, and the reason they cost so much is that every one of them looked the same.** An
effect that is present, `visible: true`, positioned on the target, unculled, with a 16×16 texture
carrying 128 painted pixels — and nothing on screen. Each was found by a different instrument, and
listing them is the point of this entry:

1. **`FrontSide`.** A `PlaneGeometry` faces +Z and this camera looks north and down, so an
   un-rotated quad faces away. `ball.js` has carried `DoubleSide` since it was written.
2. **Depth.** A creature sprite is an alpha-tested quad that *writes depth*, and an impact lands
   on the same cell — at equal depth the sprite wins. The billboards are `depthTest: false` now;
   the ground glyph keeps its test, because a ring on the floor *should* go behind a hill.
3. **A material compiled without its map.** Created with `map: null`, three compiles a shader
   with no `USE_MAP`; assigning `.map` afterwards left it drawing **flat white**. A control quad —
   a plain magenta square added beside it — is what separated "the mesh pipeline is broken" from
   "this material is". Materials are built *with* their texture now.
4. **The screenshot itself.** The settle before the shutter — `spin(settle)`, 30 rAF frames by
   default and 40 from regress, then 60 more after the metrics reset — let `registry.tick` run on
   and the effect expire; the sparkles that survived were the **shiny's shimmer from `ball.js`**, not
   the strike. `encounter.freeze(true)` before the frame is the fix and is exactly what that
   method exists for (DECISIONS #14).

**The art, and the trap `ball.js` already recorded.** The first impact was a solid block of core
colour and it read as a pale wash over the creature it landed on — because `bloomThreshold` is
1.15 at noon (the outdoor preset's value; `core/config.js`'s 0.72 is only the default `environment`
overwrites) and a shape whose *whole silhouette* clears it stops being a shape. It is outline and
thin arms around a two-pixel core now, so the bloom has something small to catch and the dark
outline keeps the form under it. `selftest.js` pins the property that follows: **every palette's
core is brighter than its own edge.**

**The contact sheet, and the correction it forced.** This entry first said the effect read as a
flash rather than a hit, and filed a tuning pass. That verdict was **wrong, and wrong for an
instructive reason**: every frame it was based on had been caught at whatever phase a live fight
happened to be in, on a `normal`-type move — a near-white core on green grass, half of it behind a
callout. The effect was fine; the *observation* was not.

So `encounter.stageStrike({ shape, type, phase })` is a showcase tool now, and
`?showcase=encounter&mode=vfx-contact|vfx-projectile|vfx-field` with `&vfxType=<element>` stages
any of the fifty-four combinations at an exact beat. Looked at: a fire contact at noon is an
orange four-armed star on the target, a fire projectile is a bolt with a tail between the two
creatures, a fire field is a ring on the ground under the wild — and an **electric** contact at
21:00, where `environment` drops the bloom threshold to 0.85 and raises the strength to 1.15, is
a clean yellow star rather than the wash the first art produced. Two of them (`encounter/vfx/12`,
`encounter/vfx/21`) join the regress matrix, because the first cut washed out at noon and the
redraw had to be re-checked at night, and without a row neither would be noticed again.

The lesson is the one this project keeps relearning from the other side: *a visual claim needs a
screenshot someone actually looked at* — and a screenshot of the wrong moment is not that.

---

### 80 — 2026-09-10 — The lead rule held when a fight started and not when one turned, and the check that should have caught it was more generous than the game

DECISIONS #76 asked `automation.chooseLead` at **engagement**. `battle.stepper`'s `nextAlly` — the
hook that replaces a member who falls mid-duel — still took **whoever was next in the party**. So
the brief's rule was true at the moment a fight began and false the moment one turned, which on a
bad matchup is how a party loses three Pokémon to one wild. `nextAlly` asks the same rule now, and
because it is handed to the stepper the closed-tab replay swaps by it too.

**Then the rule turned out never to have worked at all.** Wiring the swap up and watching it sent
the **Snivy** at a Grass wild with a Tepig holding Ember on the bench. The cause:

```
a pokemon move slot is  { id, pp, maxPp }      — and carries no type
leadChoice reads         slot.type ?? slot.t    — undefined, so `continue`
```

Every offensive score therefore sat at its floor, the term that is supposed to **dominate**
contributed nothing, and the decision fell through to the health tiebreak. `battle` owns the move
table and `automation` may not import it, so the resolver is injected alongside `effectiveness`.

**The part worth keeping is why the selftest was green.** DECISIONS #76's lead checks build their
party with `moves: [{ id, pp, type }]` — **a shape no `pokemon` instance has**. The stub was more
generous than the game, so the test exercised a code path the game could never reach. That is the
exact failure mode #35 warns about from the other direction: it is not enough to compare against
literals if the *fixture* is fiction.

The new check uses the real slot shape, and it isolates the term under test rather than trusting a
fixture to. Three members of the **same type** — so their defence against the wild is identical —
differing only in what their moves are made of. Resolved, the Fire mover is sent; unresolved, every
offence is the floor and the first in line goes, which is the behaviour that shipped. The first
fixture I wrote could not have told them apart: all three of its members differed in defence too,
so it agreed with the broken code by luck, which is how this survived in the first place.

**Measured in a forest hunt:** two mid-fight swaps, both to Tepig, against a Grass table — where
party order would have sent Oshawott.

### 81 — 2026-09-11 — A wipe always revives, and the lobby is the Pokémon Center

`encounter`'s `wipe()` opened with `if (faintedWarned) return;` above the toll, the `reviveAll()`
and the `party:wiped` emit, and `faintedWarned` was cleared in exactly one place — a `resolve()`
that found somebody still standing. So the second wipe with no surviving encounter between it and
the first did nothing at all: no toll, no revive, no event, no toast.

That is not a cosmetic miss, because a party with no conscious member is a closed loop.
`slotNear` refuses one (`src/encounter/index.js`), so no encounter can start; `wipe()` runs only
from `resolve()`, so no resolve can happen; and `reviveAll()` had exactly one caller, inside
`wipe()`. The party then walked its circuit past living wildlife forever, in silence, and
`offline` wrote that state to the save on `pagehide`. Measured on a real page: wipe #1 charged
₽9,984 and revived; wipe #2 charged nothing, emitted nothing and left the party at 0/21 0/19 0/22
with `firstConscious()` null, and it never recovered.

Three changes, deliberately overlapping, because one net that a future refactor can cut is how
this happened in the first place:

- **The latch guards the nag, not the recovery.** Every wipe pays and revives. The renamed
  `faintedNagged` now only stops `slotNear` repeating itself once per step.
- **A lap of the circuit revives.** `hunts`' lap rest called `pokemon.heal` without `revive`, and
  the guard at `src/pokemon/instance.js:236` is `if (inst.hp <= 0 && !revive) return inst.hp;` —
  so the one case whose header the rest was written for ("a wiped party walks its circuit forever
  meeting nothing") was the one case it declined. `:237` is `inst.hp + hp` clamped to the maximum —
  the adding branch — which lands on exactly the lap fraction here only because the member is at 0.
  The revive branch also clears status, and only that branch: a faint cures nothing (the engine
  never nulls `status` on a KO and writeBack copies it back), so a member revived by a lap would
  otherwise return poisoned and take residual chip on turn one. This amends #67, which described
  the lap rest as topping up "everyone's" HP when it could not touch a fainted member at all.
- **`city.enter()` heals.** `travel` already teleports a wiped party to the `pokecenter-door`
  marker and the wipe toast already claims they paid at the Centre; nothing healed them there.
  Free and unconditional, because a heal a broke player cannot afford rebuilds the same trap one
  level up. It mints nothing, so "money is earned by selling" (§0) is untouched — the rule
  constrains income, and this is a service with no price rather than a payment either way. What it
  does cost is the pull of Potions and Revives as purchases; that is the trade #81 accepts. `instance.js` had already
  written the seam down — its header named the Pokemon Center as the caller `revive: true` exists
  for, and that caller did not exist. The same header is corrected here, because this commit adds
  the second and third: it now names all three and says what each one clears.

And the refusal says so out loud now: a fainted party walking past a slot logs `warn` once and
toasts once. `warn`, never `error`, because a handled path may not spend the zero-error budget
every capture is measured against (#15). The nag is the tripwire that says if the state is ever
reached anyway.

An adversary pass found the fourth loop the three nets did **not** cover, and it is closed here
too. `instance.js` `deserialize` clamped hp with `Math.floor(slice.hp ?? maxHp)`, which looks like
a sanitiser and is not: `??` catches only `null`/`undefined`, `Math.floor('x')` is `NaN`, and
`Math.max`/`Math.min` pass `NaN` through. A member at `hp = NaN` is neither conscious (`hp > 0`
false) nor hurt (`hp < maxHp` false) — the one combination all three nets decline, measured in a
browser as a full lap and a round trip to the city with the party still `[NaN, NaN, NaN]`. A save
is a file a player can edit, so every number out of one is a claim: `level`, `exp` and `hp` are now
each read through a finite check, and a non-number reads as absent. Pinned by
`src/pokemon/instance-save.test.js`.

The same pass could not break the rest: the four flow cases hold at seeds 1, 42, 99 and 20260911
(16/16, and the seeds do move the world — first species and loop length both change); fourteen
`?break=` quarantines heal with zero console errors, and the redundancy pays for itself there —
`?break=encounter` costs the lap net and the city still heals, `?break=city` and `?break=hunts`
each lose one and the other covers; twelve showcases leave `pokeidle.save` byte-identical.

Rejected: making `encounter.cancel()` run the wipe. `cancel()`'s caller is `travel.go()` behind
its `busy` flag, and `party:wiped` sends `travel` straight back into `go()` — the re-entrancy the
header at `wipe()` already exists to avoid. The city heal makes that path recoverable without it.

### 82 — 2026-09-11 — A room's side walls are collision, not composition, under this camera

Building the Pokemon Center's interior (slice 013) needed to know why `city`'s own buildings
never show a visible east or west wall either — the same question a future room would ask
again the first time its own side walls came back invisible or paper-thin. It is arithmetic,
not an asset problem, and it does not go away by picking a different model.

`core/render.js`'s camera offset is `(0, sin(pitch) * d, cos(pitch) * d)` — zero in `x` — so
the camera always sits directly above and behind whatever it is focused on in `x`, with real
lateral distance only from a wall that itself runs east-west (the *north* wall, whose face
points along `z`, toward the camera's own large `z` offset). A wall running north-south (an
east or west wall) only ever gets the small angle a room's own half-width provides against
roughly 30 units of camera height and depth combined: for the 13-cell-wide Pokemon Center
room, `cos` of that angle is under 0.2, so even a correctly-facing, unculled panel resolves
to a sliver a few pixels wide. `pt-house-indoor`'s `house_wall_side` family is a single
`THREE.FrontSide` plane per piece, so getting the facing wrong makes it fully invisible
(back-face culled) and getting it right only makes it a thin line — proved by placing the
same model at both `rot:0` and `rot:2`, and at the middle of the room instead of the wall
column, and finding no visible difference in any of the four screenshots.
`docs/progress/city/critic/n12-pokecenter.png` shows the same thing on the authored building
next door: the roof and the front wall (with its windows and awning) read; there is no visible
east or west wall on that building either, and nothing in `city` has ever added one.

**A side wall in a room built for this fixed camera is collision, not composition.** The
room's read has to come from its north (far) wall, its floor plan, and whatever stands inside
it — a counter, a bench, a rug — the way `city`'s hedges and fences already stand in for a
site boundary no flat wall panel could show from this angle either. A future slice should not
spend time trying to make an east- or west-facing wall panel read as solid geometry from this
camera; short of geometry with its own silhouette visible from above (a roofline, a raised
sill, a row of props along the edge), it structurally cannot. `src/pokecenter/map.js`'s
`sideWall()` cites this entry.

### 83 — 2026-09-11 — Nurse Joy is the cure now, gated on a minute and a generic interact key

**Revises #81's third net.** #81 gave `city.enter()` an unconditional, free heal on every
arrival — deliberately redundant with the wipe's own `reviveAll()` and the hunt lap's rest, so
a party with no conscious member was never a closed loop. That net is deleted here, replaced
by a manual cure inside the Pokemon Center: facing the counter (3 cells tagged `'counter'`,
`src/pokecenter/map.js`) and pressing a new generic key opens a dialogue with Nurse Joy, who
heals the whole party — HP, status **and PP**, once every `HEAL_COOLDOWN_MS` (60 real seconds,
`src/pokecenter/heal.js`) — free. Nets #1 (`encounter.wipe()`) and #2 (the hunt lap) are
untouched; a wiped party still arrives already healed, just inside the room now
(`src/travel/index.js`'s `party:wiped` listener repoints from the outside door marker to
`pokecenter` itself), and that path never arms the cooldown.

**PP is restored for the first time anywhere in the game.** Every other recovery path —
`pokemon.reviveAll()` (the wipe), the hunt lap's partial heal — calls `instance.js`'s `heal()`,
which never touches `moves[].pp`; `restorePp()` existed only for Auto-Ether. The manual cure
calls both `reviveAll()` (the `revive: true` allowlist's existing caller #1, reused, not
duplicated — `pokemon/instance.js:230-266`) and `restorePp(instanceId, { moveId, amount: 'full'
})` on every party member's every move slot. This is the actual functional difference between
visiting Nurse Joy and every other recovery in the game, and it is why a Potion, a Revive and
an Ether all still have a job: none of the free nets fills a PP bar.

**`player:interact` is generic, not `pokecenter:heal`.** The key (`Z`/`Space`, `ui/input.js`)
emits the faced cell's tags — `{ cx, cz, dir, facing: {cx, cz}, tags }`, read through
`terrain.tagsAt()` the same way `simulation`'s own `player:enteredTile` is built — regardless
of which scene is loaded or what, if anything, is standing there. `pokecenter`'s listener is
the only one that exists yet and it just checks `tags.includes('counter')`; a future NPC
anywhere else in the game (a shopkeeper, a sign, a second counter) reacts to the same event
without a second key being invented for it.

**Why:** the alternative — keeping the free lobby heal alongside a Nurse Joy that also heals —
was rejected because it makes the counter interaction pointless (the player is already healed
by the time they could walk to it) and keeps Potions/Revives exactly as useless as #81 made
them, which is what this slice exists to undo. A `pokecenter:heal` event scoped to this one
counter was rejected in favour of the generic `player:interact`: the counter is not special,
the tag on it is, and the next tagged cell in the next room should not need a new key added to
`ui/input.js` to be reachable.

**Cost:** a player who never walks to the Center and never fights past a wipe has no free
recovery at all now — Potions, Revives and a trip to the counter are the only ways back to full
health outside a fainted party's own two safety nets. `docs/STATUS.json`'s
`travel-mid-encounter-silent` entry is reworded (not closed): the underlying gap — `travel.go()`
calling `encounter.cancel()` with no prompt — is unchanged, and a mid-encounter travel now costs
a walk to the Center rather than costing nothing. No visible cooldown countdown exists yet
(`remainingCooldownMs`'s return value is available for one); out of scope here.

### 84 — 2026-09-12 — The wild is met, not revealed: no burst, no bubble, no banner

The user asked for a Tibia-style hunt: the wild Pokémon already walks the map, the party walks
up to it, and the fight happens where the two are standing — not a cutscene that pops one out of
the grass with a ring of leaves, a "!" balloon and an `A wild X appeared!` toast. That entire
vocabulary (`T.APPEAR`/`T.RUSTLE`, `ball.js`'s `LEAF_*`/`ALERT_*` meshes, `alertPhase`, the toast
in `begin()`) is deleted rather than shortened — a reveal that is merely faster is still a reveal.

**The handover, not a second spawn.** `hunts.spawnNpc` already made the wild a wandering NPC
(`tether: {radius:1}, solid:true`) and `hunts.index.js`'s own `player:enteredTile` listener
already walks the party off the circuit to stand next to it. What changed is `takeSlot(k)`: it
used to delete that NPC and hand `encounter` only its species/shiny/anchor cell, so `encounter`
spawned a **second**, brand-new sprite that burst out of the grass — the cutscene was, literally,
one Pokémon vanishing and a different one appearing in its place. `takeSlot` now returns the
live `npcId` and the creature's **current** cell (read off `simulation.npcs()`, not the slot's
authored anchor — a tether drifts ±1 tile, and the fight has to happen where the body actually
is). `encounter` spawns its own actor on that same cell and retires the map NPC only once its own
actor is drawn, so there is never a frame with neither.

**The level moved to the slot.** A plate over a wandering creature's head (the next slice) has to
show the level it will actually fight at, and until now that level was rolled fresh at the
moment of engagement (`rollIndex`, seeded by the encounter index). It is now rolled once, when
the creature spawns onto its slot, from its own stream (`hunts/level/<biome>/<k>/<gen>`) against
`encounter.band()` — a sibling stream, so no species, shiny or IV roll anywhere else moves
(ARCHITECTURE §2.5). `engage()` takes species, level and cell from the slot and everything else
(shiny, IVs, catch rate) from the index, as before.

**What replaces the "!" and the toast is nothing, on purpose.** The plate the next slice adds and
that plate's HP bar are what says "this is an encounter, and it is waiting on you" — a banner
announcing an arrival is describing something that, in this flow, never happens. `shimmer()` (the
shiny's ring) is kept: it is identity, not a transition, and a green Azurill is still unreadable
in green grass without it.

**Showcase renamed, not repointed.** `?showcase=encounter`'s default mode was `reveal`, staged at
the apex of the hop with the bubble popped. There is no apex any more, so the mode is `meet` —
the moment of contact, wild and lead standing on their own cells — and the two regress rows this
touches (`encounter/12`, `encounter/vfx/12`, `encounter/vfx/21`) were re-accepted in this commit;
only the two `vfx/*` rows moved outside tolerance (`p99`, from the wild's breathing phase no
longer offsetting by the deleted `T.APPEAR`), looked at frame by frame, both correct.

### 85 — 2026-09-12 — Nameplates read the world; nothing new was published to give them one

MMORPG-style plates — name, level, HP — over the trainer, the party's lead and every wild in a
hunt, name-only over everything else, was asked for as new UI. It shipped as almost entirely a
**read**, not a new contract: `ui/plates.js` gathers what it draws from APIs every one of those
modules already published — `simulation.lineup()`, `hunts.slots()`, `encounter.active()`/
`scene()`, `pokemon.lead()` — the same pull discipline `hud.js` and `panels/battle.js` already
use (a quarantined module costs this file a category of plate, never a crash). The one live-HP
computation a plate needs mid-duel is copied from `panels/battle.js`'s own `read()` rather than
re-derived, because that file already solved "read the live fight, not the party record" for the
exact same reason (DECISIONS #72: HP writes back to an instance only when a duel ends).

**Two small widenings, both additive.** `simulation.npcs()` gained `x,y,z` (posed exactly as the
renderer would, `poseWalker` at `sub: 0` — not a fresh formula, the one `renderPose` already
uses) plus `species`/`shiny`/`trainer`/`display`, and `spawnNpc(spec)` gained an optional
`display` — a human label for the three city person-NPCs and Nurse Joy, none of which a slug
title-cases into anything a player should read. Nothing else moved: no new `plates()` method on
`simulation`, `hunts` or `encounter` — the data was already there, or one field short of it.

**`hpInk` moved from `panels/battle.js` to `theme.js`.** A plate's bar and the battle card's own
bar have to agree, and the alternative was a second copy drifting the moment one of them tuned a
threshold.

**Composition, not perf, is why a plate is capped, clamped and sometimes dropped.** A wide hunt
framing can put most of a lap's nine slots on screen; a plate for every one of them crowded into
the same few rows near the horizon and read as a smear, not nine labels — measured on
`?scene=hunt-meadow`, screenshot, looked at, twice: first with no cutoff (`docs/progress`
equivalent: `shots/out/plates-hunt.png`), then again once `MAX_PLATE_TILES` (14, Chebyshev) and
the party-bar/button-strip/battle-card clamps were in and one collision pair (`Bunnelby`,
`Cottonee`, standing one tile apart) still printed as one smeared label. The fix for *that* is
the rule the collision pass follows: a plate pushed against the floor with nowhere left to go is
**skipped**, never snapped back onto the plate it was trying to clear — the first cut did the
snap and produced exactly the two-names-stitched-together bug a screenshot caught immediately.

**Painted in `lateFrame`, and this marks the screen dirty far more than `ui` used to.** A plate
tracks a sprite that can move every *rendered* frame, and painting it against the previous
frame's camera (the `frame` hook ran before `rig.update()`) trailed a moving sprite by one frame
of motion — the same bug `pokemon/field.js`'s own `lateFrame` placement exists to avoid. The
honest cost is that `screen.dirty`'s tick-driven model, built to save a redraw while nothing was
happening, no longer saves much of anything while any plate is on screen — which is most of a
hunt or a city.

**Measured against the actual frame-timing budget, not against `regress`.** The first draft of
this entry cited `regress`'s `p99`/`over200Pct` moving on `boot/12` as the evidence — those are
pixel-*brightness* histogram statistics (`tools/shots/shoot.js`'s `sceneStats`), not timing, and
a reviewer caught the mix-up. Worse, `regress`'s own matrix (`tools/shots/regress.js`) shoots a
module's own showcase for every row but `boot/12`, and a showcase is exactly where plates are
suppressed (`minimal`, above) — so it structurally cannot see this cost at all. The number that
actually matters is `fps`/`p95ms` (`tools/shots/shoot.js`'s own `fps.mean`/`fps.p95ms`, budgeted
in `checkBudgets` at ≥50 / ≤20ms) against a **real scene**, plates on: `hunt-meadow`, `hunt-forest`,
`hunt-cave`, `hunt-coast` and `demo-city` all measured 60 fps mean, 16.7–16.8 ms p95 — comfortably
inside budget, and `npm run gate`'s own `boot` stage (which shoots every real scene, not the
showcases) is what would fail first if that ever stopped being true.

### 86 — 2026-09-12 — A turn's strikes are drained one beat at a time, never emitted as a block

The brief asks that a trainer's Pokémon and the wild never attack at the same time, with a real
delay between actions. They already didn't decide at the same time — `battle/engine.js`'s
`turn()` has always resolved priority, then speed, then a coin, and returned both sides' events
in that order — but `encounter`'s own stepping put both sides' `battle:strike` in the **same
tick**: `stepDuel` called `run.step()` once every `T.TURN` (24 sim steps) and looped over every
strike the whole turn produced, emitting all of them before the loop returned. Two blows in one
tick is two balloons popping together and one visual effect overwriting the other before it had
finished, which is exactly the "attacks at the same time" the brief names.

**`src/encounter/beats.js`'s `planBeats(strikes, beats)` turns the engine's ordered output into
a timeline**, not a reordering — it does not touch who acts first, only when each of the
engine's own outputs is allowed to reach the bus. One `config.actionSteps` (18, replacing the
unread `turnSteps`) apart for an ordinary strike, `T.ITEM`/`reviveSteps()` for an item or a
revive — the same beats a turn already held for, just now assigned to the strike that earns
them instead of summed into one number for the whole turn. Pure and index-free like every other
roll in this module, and pinned in `encounter/selftest.js` #24 against literals, not a second
call to itself (DECISIONS #35).

**`encounter/index.js`'s `tickDuel` replaces `stepDuel`.** It asks the engine for a new turn
only once the previous one's plan is fully drained (`scene.turnPlan === null`), and drains at
most the beats that are due on the current tick — in practice one, since two beats landing on
the same tick would need `actionSteps` to be smaller than a single sim step. `emitStrike` is the
per-strike body the old per-turn loop used to run for every strike at once: it arms `scene.vfx`
**only** for a strike that carries a move (a residual tick, an item or a swap gets no effect,
and explicitly clears whatever the previous strike armed rather than letting it linger into a
beat with nothing to show), and it is where `battle:strike` gains two fields it never had:
`type` and `shape` — the move's element and delivery shape, read once here via `battle.move(id)`
and handed to `ui` on the event, because a balloon that colours itself by type (the next slice)
may not import `encounter`'s own element table across the module boundary.

**One consequence, taken deliberately: a turn where both sides act now takes `2 ×
actionSteps` (36 steps) instead of the old fixed 24.** A fight is slower to watch by about a
half, in exchange for every blow actually being legible on its own. Nothing about the *fold*
(the `idle`/`offline` path through `encounter.pure()` → `battle.resolve()`) changes — it never
read `T` or `ACTION_STEPS` in the first place, and stays exactly as fast as it always was, which
is the whole point of DECISIONS #72's "presentation, never a rule" for every beat in this file.

**Cost.** `tests/flows/action-pacing.spec.js` proves the property end to end — two strikes of
the same turn land at least an `actionSteps`-sized gap of real sim ticks apart, measured by
stepping in small counted chunks rather than trusting the bus log's own array index (which is
not a tick count, and a first draft of this test trusted it and passed for the wrong reason: a
broken de-duplication re-recorded the same already-seen strike on every later poll, which
happened to produce a small, wrong, but plausible-looking gap). `hunt.spec.js`'s existing tick
budgets did not need raising — the common case (one side already fainted, or a one-strike turn)
is unaffected, and the slower two-strike case still lands well inside the existing ceilings.
