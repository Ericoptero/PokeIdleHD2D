/**
 * encounter — spawn tables, catching, resolved battles (ARCHITECTURE §5.6).
 *
 * This is the module that turns walking into a Pokemon game. The lead Pokemon steps into
 * tall grass, something comes out of it, the party beats it down, a ball goes in, and
 * `collection` writes it into the dex while `economy` charges for the ball. Everything
 * about *what* comes out lives in `tables.js`; everything about *which* number decides it
 * lives in `rolls.js`; this file is the wiring, the on-screen moment and the seams.
 *
 *   rolls.js      every roll, as a pure function of (seed, index). No ctx, no clock.
 *   tables.js     five biomes x three time bands, with mainline capture rates
 *   ball.js       the thrown ball, as authored 16px pixel art
 *   showcase.js   the staged capture (ARCHITECTURE §6)
 *   selftest.js   35 checks, run by tools/seams/run.js with no browser
 *
 * ### The four seams, and what each one owes the other side
 *
 * **`economy` owns the ball; this module owns the roll.** `economy.throwBall()` spends the
 * ball out of the bag and reports the odds — it deliberately does not roll them, because a
 * module that both spent the ball and decided the outcome would make a catch depend on shop
 * state and determinism would be gone (`economy/items.js` says so in as many words). So the
 * eighteen-ball line, the Gen 3/4 capture formula and every conditional multiplier (Dusk 3x
 * at night or in a cave, Quick 5x on turn one, Level 8x/4x/2x, Nest by level, Heavy by
 * weight) are asked for, never re-derived. What this module supplies is the half `economy`
 * cannot know: the species' capture rate, the HP left after the battle, and the coin.
 *
 * **`collection` pairs `encounter:started` with `catch:succeeded`.** §4 fixes both payloads;
 * a bare catch with no encounter before it is legal but loses the level and the biome, so
 * both are always emitted, in order, for every catch. The catch payload also carries the
 * `ivs` this module rolled — `collection` uses them when they are there and rolls its own
 * from its own stream when they are not, and a Pokemon whose IVs changed depending on which
 * module happened to look at it first would be the kind of bug nobody ever finds.
 *
 * **`idle` resolves encounters BY INDEX while the tab is closed.** Everything in `rolls.js`
 * is addressed by `(seed, index)` for exactly that reason, and this module's entire
 * persistent state is two integers: how many cells of grass have been walked, and how many
 * encounters have been started. `idle` still rolls its own encounters from its own
 * `idle/encounter/N` streams (DECISIONS #19) — this module cannot make it delegate without a
 * core change, and that is filed rather than pretended. What it *can* do is make
 * `tablesFor()` return a table `idle`'s uniform pick samples correctly from; see `tables.js`.
 *
 * **The registry's null object answers `typeof api.foo === 'function'` with true even for a
 * dead module** (§2.1), so nothing here tests a sibling with `typeof`. `isLive()` reads the
 * `__missing` marker, the way `src/collection/index.js` does.
 */

import { makeBallSprite } from './ball.js';
import {
  SHINY_RATE, SHINY_RATE_CHARM,
  streamFor, catchRateFor, levelBand, stepRoll, stepValue, rollAt, catchRoll,
  shakesFor, rewardsFor,
} from './rolls.js';
import {
  BIOMES, STEP_RATE, todBand, rowsFor, expand, bumpsFor, validate, authoredCatchRate, summary,
} from './tables.js';
import { runSelfTest, summarise } from './selftest.js';

/** Save slice version. `loadState` migrates forward and refuses a newer one (§5). */
const SAVE_VERSION = 1;

/** The registry's null object answers every property with a function — this is the tell. */
const isLive = (api) => !!api && api.__missing === undefined;

/**
 * The scene's timeline, in fixed sim steps (1/20 s each, `core/clock.js`).
 *
 * Sim steps and not seconds, and certainly not `performance.now()`: the harness freezes the
 * clock for every screenshot (DECISIONS #14) and a showcase has to be able to stop the
 * animation on an exact frame and get the same pixels twice. Every number below is a count
 * of `tick()` calls.
 */
const T = {
  APPEAR: 20,      // the grass moves, then the wild comes out of it and settles
  /**
   * How much of `APPEAR` is the **grass alone**, as a fraction.
   *
   * The brief for this round is that a player should see the beat rather than read it: "the
   * grass reacts, the wild Pokemon appears". Those are two pictures, and the first one only
   * exists if there is a window in which the disturbance is on screen and the Pokemon is not.
   * Eight of the twenty steps, so `mode=approach` (frozen at 0.3 of the beat) is unambiguously
   * inside it and `mode=reveal` (0.62) is unambiguously past it.
   */
  RUSTLE: 0.4,
  READY: 8,        // a beat, during which a player (or `automation`) may throw
  /**
   * How long the wild waits after that before the party settles it and it leaves.
   *
   * Not decoration — without it the live game deadlocks. Nothing throws a ball at `/`:
   * `automation` is off by default (§5.11 — "none are on by default") and `ui` has no
   * throw bound yet, so an encounter with `throwAt = Infinity` sat in the `ready` stage
   * forever with `active` never clearing, which meant the first Pokemon a player ever met
   * was also the last. Measured by walking the lobby's own grass: 6 steps, 1 encounter, and
   * then nothing for another 894 sim steps.
   *
   * What happens instead is the thing §5.6 already says: **battles are resolved, not
   * turn-by-turn.** `begin()` has already run the exchange, so the unattended encounter pays
   * out that battle and the wild leaves. Walking through grass therefore earns; *catching*
   * still costs a ball and still needs somebody to decide to throw it.
   */
  LEAVE: 26,
  THROW: 12,       // the ball's arc
  SUCK: 5,         // the wild is drawn in; the ball drops
  SHAKE: 14,       // one wobble
  RESULT: 26,      // the click and its sparkles, or the break-out
  LINGER: 16,      // the wild flees / the frame holds on the outcome
};

export default {
  id: 'encounter',
  needs: ['pokemon', 'terrain', 'economy'],
  /**
   * Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6).
   *
   * `simulation` walks the party into the grass and `collection` records what comes out of
   * it — both are the point of the shot. `idle` and `automation` are deliberately absent:
   * `idle`'s heartbeat would bank money into the readout between the settle and the shutter,
   * and `automation` would throw its own ball at the encounter this scene is staging.
   */
  showcaseNeeds: ['simulation', 'collection'],

  init(ctx) {
    const { bus, config, log } = ctx;
    const seed = config.seed;

    // --- the tables ---------------------------------------------------------
    // Checked once, out loud. A typo in a species name is invisible at runtime — the
    // encounter is simply dropped and the grass quietly stops working — and this is a
    // handled path, so it is a `warn`: §7 counts console errors and behaving correctly must
    // not cost the budget.
    {
      const pokemon = ctx.get('pokemon');
      const lookup = isLive(pokemon) && typeof pokemon.species === 'function' ? pokemon.species : null;
      if (lookup) {
        const bad = validate(lookup);
        if (bad.length) log.warn(`encounter: ${bad.length} bad table rows — ${bad.slice(0, 4).join('; ')}`);
      } else {
        log.warn('encounter: pokemon is not live, so the spawn tables could not be validated');
      }
    }

    // --- persistent state (the whole of it) ---------------------------------
    /** How many cells of tall grass the lead has walked. Indexes the "is there one?" roll. */
    let steps = 0;
    /** How many encounters have been started. Indexes species / level / shiny / IVs. */
    let encounters = 0;
    /** The ball the next throw uses when the caller does not name one. */
    let ballId = 'pokeball';

    /** @type {object|null} the encounter that is live and has not been resolved */
    let active = null;
    /** The last encounter to reach an outcome — what the showcase panel and `ui` read. */
    let last = null;

    // --- the on-screen moment -----------------------------------------------
    const sprite = makeBallSprite(ctx.THREE, ctx);
    /** @type {{stage:string, step:number, wildActor:number, ...}|null} */
    let scene = null;
    let frozen = false;

    /**
     * Passive encounters are armed at `/` (the real game) and in this module's own
     * showcase, and nowhere else.
     *
     * Every other module's proof shots are taken through `?showcase=<id>`, several of them
     * on maps that carry tall grass — `city` scatters two patches of it and `simulation`
     * plants two more. A wild Pokemon rearing up in the middle of somebody else's hero frame
     * would be this module vandalising another module's evidence, and it would do it
     * non-reproducibly, because how many sim steps have run by the time the shutter opens is
     * wall-clock luck. Same reasoning as DECISIONS #15's "?showcase=... is read-only".
     */
    const armed = !config.showcase || config.showcase === 'encounter';

    // --- helpers ------------------------------------------------------------

    const biomeNow = () => {
      const handle = ctx.get('terrain').handle?.();
      const b = handle?.biome;
      return BIOMES.includes(b) ? b : 'meadow';
    };
    const todNow = () => {
      const env = ctx.get('environment');
      // Liveness on the *value*, never on `typeof` (§2.1).
      const t = isLive(env) ? env.getTimeOfDay?.() : undefined;
      return Number.isFinite(t) ? t : config.tod;
    };
    const leadOf = () => {
      const pokemon = ctx.get('pokemon');
      return isLive(pokemon) ? (pokemon.lead?.() ?? null) : null;
    };
    const topLevel = () => {
      const pokemon = ctx.get('pokemon');
      const party = isLive(pokemon) ? (pokemon.party?.() ?? []) : [];
      let top = 0;
      for (const m of party) top = Math.max(top, Number(m?.level) || 0);
      return top || 5;
    };
    const speciesOf = (name) => {
      const pokemon = ctx.get('pokemon');
      return isLive(pokemon) ? (pokemon.species?.(name) ?? null) : null;
    };
    /** The mainline rate if a table lists it, the BST proxy otherwise (`rolls.js`). */
    const catchRateOf = (name, sheet) => authoredCatchRate(name) ?? catchRateFor(sheet?.bst);

    function multipliers() {
      const economy = ctx.get('economy');
      const m = isLive(economy) ? economy.multipliers?.() : null;
      return {
        encounterRate: Number.isFinite(m?.encounterRate) ? m.encounterRate : 1,
        shinyOdds: Number.isFinite(m?.shinyOdds) ? m.shinyOdds : 1,
      };
    }

    /**
     * The shiny threshold. The *roll* is fixed by the index; only the line it is compared
     * against moves with the save, which is what lets a Shiny Charm mean anything without
     * making encounter #431 a different Pokemon than it was yesterday.
     */
    function shinyRate() {
      const economy = ctx.get('economy');
      const charm = isLive(economy) && economy.count?.('shiny-charm') > 0;
      return (charm ? SHINY_RATE_CHARM : SHINY_RATE) * multipliers().shinyOdds;
    }

    /** The weight-expanded table for a biome and hour, memoised per (biome, band). */
    const tableCache = new Map();
    function tableFor(biome, tod) {
      const b = BIOMES.includes(biome) ? biome : 'meadow';
      const key = `${b}/${todBand(tod)}`;
      if (!tableCache.has(key)) {
        const rows = rowsFor(b, tod);
        tableCache.set(key, { table: expand(rows, { slots: 120, biome: b, tod }), bumps: bumpsFor(rows) });
      }
      return tableCache.get(key);
    }

    // ---------------------------------------------------------------- rolling

    /**
     * Encounter number `index`, as a pure function of the seed and that index.
     *
     * Exposed because it is the whole determinism story: hand it an index and it gives the
     * species, level, shiny flag and six IVs, with no reference to when or whether the
     * encounter actually happened. `idle` should be resolving its closed-tab encounters
     * through this rather than through its own copy in `accrual.js`; that needs a core
     * change and is filed in `coreRequests`.
     */
    function rollIndex(index, { biome = biomeNow(), tod = todNow(), band = null, rate = null } = {}) {
      const { table, bumps } = tableFor(biome, tod);
      const rolled = rollAt(seed, index, {
        table, bumps,
        band: band ?? levelBand(topLevel()),
        shinyRate: rate ?? shinyRate(),
      });
      if (!rolled) return null;
      const sheet = speciesOf(rolled.species);
      return {
        ...rolled,
        biome, tod,
        sheet,
        display: sheet?.display ?? rolled.species,
        catchRate: catchRateOf(rolled.species, sheet),
        instanceId: sheet ? String(sheet.id) : rolled.species,
      };
    }

    /**
     * §5.6's `roll(biome, tod, luck)`. **This one consumes indices** — it rolls the next
     * grass step and, if that fires, the next encounter — which is what makes it the live
     * path rather than a probe. `rollAt(index)` above is the pure form.
     */
    function roll(biome = biomeNow(), tod = todNow(), luck = 1) {
      const rate = (STEP_RATE[biome] ?? STEP_RATE.meadow) * multipliers().encounterRate * (Number(luck) || 1);
      const index = steps++;
      if (!stepRoll(seed, index, rate)) return null;
      return rollIndex(encounters++, { biome, tod });
    }

    // ---------------------------------------------------------------- the moment

    /**
     * How far the cover on a cell stands above its own soil.
     *
     * The ball's contact blob is the single cue that sells "in the air" in a still frame, and
     * a blob laid on the soil under a cell of tall grass is *inside* the blades: measured off
     * the pack, `tall_grass` spans y 0.125..0.625 and `tall_grass_light` 0.125..0.5, against a
     * blob laid at +0.02. Round 1 therefore had no visible shadow anywhere under the ball in
     * the frame whose whole job is to be that frame. 0.66 clears the *taller* model's tips
     * (0.625) with 0.035 to spare, which is what it takes: at 0.52 the blob is drawn — an A/B
     * against `blob.visible = false` moves 996 pixels — but half of it is eaten by the blades
     * of its own cell and the visible half is 23 levels on a surface that dark, which is not a
     * cue anybody reads. A shadow on the *tops* of the grass is where a real one lands anyway.
     */
    function coverHeightAt(cx, cz) {
      const terrain = ctx.get('terrain');
      const tags = terrain.tagsAt?.(cx, cz);
      return Array.isArray(tags) && tags.includes('tallgrass') ? 0.66 : 0;
    }

    /** Where the wild Pokemon stands: two cells in front of the lead, on the ground. */
    function stageCell() {
      const sim = ctx.get('simulation');
      const cell = isLive(sim) ? sim.followerCell?.() : null;
      const terrain = ctx.get('terrain');
      const DX = [0, -1, 0, 1], DZ = [1, 0, -1, 0];      // core/dir.js order
      const dir = (cell?.dir ?? 0) & 3;
      const cx = (cell?.cx ?? 0) + DX[dir] * 2;
      const cz = (cell?.cz ?? 0) + DZ[dir] * 2;
      // `simulation.surfaceAt` measures the top of the cell off the loaded map's placements;
      // `terrain.height()` reports the authored heightfield, which the demo maps never set
      // (DECISIONS #27). Prefer the measured one and fall back to the authored one.
      const y = isLive(sim) && Number.isFinite(sim.surfaceAt?.(cx, cz))
        ? sim.surfaceAt(cx, cz) : (terrain.height?.(cx, cz) ?? 0);
      // The wild faces the lead, which is the reverse of the lead's own facing.
      return { cx, cz, y, dir: (dir + 2) & 3, x: cx + 0.5, z: cz + 0.5 };
    }

    async function showWild(enc, at) {
      const pokemon = ctx.get('pokemon');
      if (!isLive(pokemon) || !enc.sheet) return 0;
      try {
        return await pokemon.sprites.spawn({
          species: enc.sheet, shiny: enc.shiny,
          x: at.x, y: at.y, z: at.z, dir: at.dir, gait: 'idle', phase: 0,
        });
      } catch (err) {
        log.warn(`encounter: could not spawn ${enc.species} — ${err?.message ?? err}`);
        return 0;
      }
    }

    function moveWild(patch) {
      const pokemon = ctx.get('pokemon');
      if (scene?.wildActor && isLive(pokemon)) pokemon.sprites.set(scene.wildActor, patch);
    }

    /**
     * How high above a wild Pokemon's feet its "!" balloon hangs.
     *
     * Measured off the actor rather than guessed: `pokemon.sprites.get()` reports the quad's
     * world height, which is the 32-texel frame over 16 texels per unit and then stretched by
     * `1/cos(pitch)` (pokemon/sprites.js `frameWorldSize`). The art sits low in its own frame
     * — the top rows are the clearance a sprite sheet leaves — so the balloon hangs at 0.58 of
     * the quad rather than on top of it, which is where the reference puts it: overlapping the
     * head's own airspace, not floating a body-length above it.
     */
    function headLiftOf(actorId) {
      const pokemon = ctx.get('pokemon');
      const a = isLive(pokemon) ? pokemon.sprites.get?.(actorId) : null;
      return Number.isFinite(a?.h) ? a.h * 0.58 : 1.62;
    }

    /**
     * The bubble's own 0..1, spanning the moment the wild pops to the end of the throw window.
     *
     * One phase across both stages, not one per stage: the balloon pops once and then holds,
     * and a phase that restarted at the stage boundary would pop it a second time in the
     * middle of the beat a player is deciding in.
     */
    function alertPhase(s, step) {
      const pop = T.APPEAR * T.RUSTLE;
      const span = Math.max(1, T.APPEAR + T.READY - pop);
      return Math.min(1, Math.max(0, (step - pop) / span));
    }

    function clearWild() {
      const pokemon = ctx.get('pokemon');
      if (scene?.wildActor && isLive(pokemon)) pokemon.sprites.remove(scene.wildActor);
      if (scene) scene.wildActor = 0;
    }

    /**
     * The stage boundaries, derived from what has already been decided.
     *
     * `throwAt` is not a constant: `automation` calls `attempt()` synchronously from inside
     * this module's own `encounter:started` emit, and jumping straight to the throw would
     * skip the reveal entirely. So an order to throw is *queued* at the earliest step the
     * animation can honour it, and the outcome — already decided and already on the bus —
     * simply plays out.
     */
    function marks(s) {
      const throwAt = Math.max(T.APPEAR + T.READY, s.throwAt ?? Infinity);
      // Finite only while no throw has been queued: an order to throw cancels the exit by
      // construction, rather than by a flag that could fall out of step with it.
      const leaveAt = Number.isFinite(throwAt) ? Infinity : T.APPEAR + T.READY + T.LEAVE;
      const land = throwAt + T.THROW;
      const suck = land + T.SUCK;
      const shakeEnd = suck + Math.max(0, s.shakes) * T.SHAKE;
      const resultEnd = shakeEnd + T.RESULT;
      return { throwAt, leaveAt, land, suck, shakeEnd, resultEnd, end: resultEnd + T.LINGER };
    }

    /** One sim step of the on-screen moment. Pure function of `scene.step`. */
    function advanceScene() {
      if (!scene) return;
      const s = scene;
      const m = marks(s);
      const at = s.at;
      const step = s.step;

      // 1. the grass moves, and then the wild comes out of it
      //
      // Two beats inside one, and the split is the whole point. Round 2's appear had the
      // Pokemon on screen from step 0 and merely rising, which in the frozen frame a critic
      // actually looks at is a Pokemon standing in grass — the reveal that the whole-game
      // critic could not find. `T.RUSTLE` of the beat is the grass alone: the wild is not
      // drawn at all, only the disturbance is, so the frame before the reveal is a *cause*.
      // Then it bursts out over the rest of the beat, and `mode=approach` freezes in the
      // first half while `mode=reveal` freezes in the second.
      if (step <= T.APPEAR) {
        const k = step / T.APPEAR;
        const out = k <= T.RUSTLE ? 0 : (k - T.RUSTLE) / (1 - T.RUSTLE);
        const hop = Math.sin(out * Math.PI) * 0.5;
        /**
         * It grows as it comes out — **in two discrete steps, on thirds**, and the
         * quantisation is the whole point rather than a simplification of a nicer curve.
         *
         * The first cut ran a continuous squash-and-stretch (`0.62 + 0.38·min(1, out/0.55) +
         * 0.20·sin(out·pi)`), which freezes `mode=reveal` at about 1.10. That is critic issue
         * [12] moved from the ball onto the headline sprite: at the framing every picture mode
         * now uses one sprite texel is exactly three internal pixels, and 1.10 of that is 3.3,
         * so texels come out three internal pixels wide in some runs and four in others.
         * Measured on the same species in the same cell, one frame with the ramp and one
         * without — histogram of horizontal texel-edge spacings across the whole sprite:
         *
         *   scale 1     (mode=escaped)  gap 9 px x408, gap 12 px x223   48.9 % on whole texels
         *   scale ~1.10 (mode=reveal)   gap 9 px x246, gap 12 px x441   27.1 % on whole texels
         *
         * A scale that is a multiple of 1/3 keeps every texel a whole number of internal
         * pixels, so the pop goes 2/3 -> 1 and nothing in between. Two sizes read as a pop
         * *better* than a ramp does at twenty steps a second — it is what the era's own
         * sprites do — and the frame `mode=reveal` freezes on is the settled 1, on the grid,
         * the same size as every other Pokemon in the picture. The burst is carried by the
         * hop, the leaves and the bubble, which cost the grid nothing.
         *
         * `pokemon.sprites.set` takes `scale` and re-derives the quad from it (field.js:207).
         */
        moveWild(out <= 0
          ? { visible: false }
          : { y: at.y + hop, visible: true, scale: out < 0.34 ? 2 / 3 : 1 });
        // A shiny announces itself, the way the mainline does — and it is the only thing
        // that makes one legible: a shiny Azurill is green in green grass. Everything else
        // gets the grass parting under it, which is what makes a 24-pixel hop read as a
        // *reveal* in a still frame rather than as a Pokemon sitting in a field.
        if (s.shiny && out > 0) sprite.shimmer(at, step); else sprite.rustle(at, k);
        if (out > 0) sprite.alert(at, alertPhase(s, step), at.y + hop + s.headLift);
        s.stage = 'appear';
      } else if (step < m.throwAt) {
        // 1b. the beat in which a ball may be thrown — and, if none is, the exit.
        //
        // `m.leaveAt` is finite only while `throwAt` is not, so a queued throw cancels the
        // exit by construction rather than by a flag that could get out of step with it.
        if (step >= m.leaveAt) {
          if (active) resolveUnattended();
          const k = (step - m.leaveAt) / T.LINGER;
          if (k >= 1) { endScene(); return; }
          // Two quick hops away and gone, which reads as leaving rather than as vanishing.
          moveWild({ y: at.y + Math.abs(Math.sin(k * Math.PI * 2)) * 0.45, visible: k < 0.75, scale: 1 });
          sprite.hide();
          s.stage = 'left';
        } else {
          moveWild({ y: at.y, visible: true, scale: 1 });
          if (s.shiny) sprite.shimmer(at, step); else sprite.hide();
          // The bubble stays up for the whole beat in which a ball may be thrown, because
          // that is exactly what it means: this is an encounter, and it is waiting on you.
          sprite.alert(at, alertPhase(s, step), at.y + s.headLift);
          s.stage = 'ready';
        }
      } else if (step < m.land) {
        // 2. the ball is in the air
        const k = (step - m.throwAt) / T.THROW;
        sprite.setBall(s.ball);
        sprite.arc(s.from, { x: at.x, y: at.y + 0.45, z: at.z }, k, at.y, at.y + (s.coverY ?? 0));
        s.stage = 'throw';
      } else if (step < m.suck) {
        // 3. the wild is drawn in
        //
        // **On the cover, not on the soil**, and the arc's shadow already knew it: `arc()` is
        // passed `shadowY = at.y + coverY` because a cell of `tall_grass` stands 0.625 units
        // proud and a blob under that is inside the blades (see `shadow()` in ball.js). The
        // ball itself was still being rested at `at.y`, so it was drawn *below its own
        // shadow* and the blades took the bottom third of it: measured on `f-shake.png`, the
        // ball is 116 px tall and the grass in front of it covers 40 of them, which is the
        // whole lower shell, the button and the band. A ball that has fallen into deep grass
        // sits on the grass — the same surface its shadow lands on.
        const rest = { x: at.x, y: at.y + (s.coverY ?? 0), z: at.z };
        const k = (step - m.land) / T.SUCK;
        moveWild({ visible: false });
        sprite.rest(rest, -1, 0);
        sprite.burst(rest, 1 - k * 0.6, { keepBall: true });
        s.stage = 'capture';
      } else if (step < m.shakeEnd) {
        // 4. the wobbles
        const into = step - m.suck;
        const shake = Math.floor(into / T.SHAKE);
        sprite.rest({ x: at.x, y: at.y + (s.coverY ?? 0), z: at.z }, shake, (into % T.SHAKE) / T.SHAKE);
        s.stage = 'shake';
        s.shake = shake + 1;
      } else if (step < m.resultEnd) {
        // 5. the click, or the break-out
        const k = (step - m.shakeEnd) / T.RESULT;
        if (s.caught) {
          sprite.burst({ x: at.x, y: at.y + (s.coverY ?? 0), z: at.z }, k, { keepBall: true });
        } else {
          const hop = Math.sin(Math.min(1, k * 2) * Math.PI) * 0.7;
          moveWild({ y: at.y + hop, visible: true, scale: 1 });
          sprite.hide();
        }
        s.stage = s.caught ? 'caught' : 'escaped';
      } else if (step < m.end) {
        // 6. the wild leaves
        if (!s.caught) moveWild({ visible: step - m.resultEnd < T.LINGER / 2 });
        sprite.hide();
        s.stage = 'done';
      } else {
        endScene();
        return;
      }
      s.step++;
    }

    function endScene() {
      clearWild();
      sprite.hide();
      scene = null;
    }

    // ---------------------------------------------------------------- the API

    /**
     * Starts an encounter: sets it live, then announces it.
     *
     * The order matters. `automation` subscribes to `encounter:started` and calls
     * `attempt()` from inside the emit, so `active` has to be set *before* the bus sees the
     * event or the automation's throw would find nothing to throw at.
     */
    /**
     * The occupied slot the head has just walked up to, or `null`.
     *
     * Chebyshev, and the reach is the distance a slot is authored at — 2 (§5.14). The
     * tether's ±1 drift is what makes the meeting read as a creature noticing the party; it is
     * not extra reach, and treating it as such left the trigger silent.
     */
    /** One warning per wipe, not one per step. */
    let faintedWarned = false;

    /**
     * The most sim steps one `advance()` call may run.
     *
     * The whole animation is `APPEAR + READY + THROW + SUCK + 5*SHAKE + RESULT + LINGER`, well
     * under two hundred; a thousand is room for any future beat and still a number a wedged
     * page cannot hide behind.
     */
    const MAX_ADVANCE = 1000;

    function slotNear(cx, cz) {
      const hunts = ctx.get('hunts');
      if (!isLive(hunts) || typeof hunts.slots !== 'function') return null;
      // Nothing to fight with: a party that is entirely fainted walks past its wildlife
      // rather than losing to it twenty-three times in a row, which is what it did before
      // this guard existed (DECISIONS #67).
      const pokemon = ctx.get('pokemon');
      if (isLive(pokemon) && typeof pokemon.firstConscious === 'function' && !pokemon.firstConscious()) return null;
      const reach = Math.max(0, Number(config.slotEngageTiles ?? 2));
      for (const s2 of hunts.slots()) {
        if (!s2.occupied) continue;
        if (Math.max(Math.abs(s2.cx - cx), Math.abs(s2.cz - cz)) <= reach) return s2;
      }
      return null;
    }

    /**
     * Starts the fight with whatever is standing on a slot.
     *
     * `hunts.takeSlot` hands the creature over **and takes its sprite off the map**, so the
     * wild that walks out is the one that was standing there rather than a second copy beside
     * it — and the slot is then scheduled to refill, which is what makes it a respawn point.
     *
     * The level, the shiny roll and the IVs still come from `rollAt(index)`: the slot decides
     * *which species* and *where*, and the index space decides everything else, so a hunt
     * replayed offline meets the same creature it met live (DECISIONS #35(a)).
     */
    function engage(slot) {
      const hunts = ctx.get('hunts');
      const taken = isLive(hunts) && typeof hunts.takeSlot === 'function' ? hunts.takeSlot(slot.k) : null;
      if (!taken) return null;
      const index = encounters++;
      const enc = rollIndex(index);
      if (!enc) return null;
      // The species is the slot's; everything else is the index's.
      const species = taken.species;
      const merged = {
        ...enc,
        species: species.name,
        display: species.display ?? species.name,
        sheet: species,
        shiny: enc.shiny || !!taken.shiny,
        catchRate: authoredCatchRate(species.name) ?? catchRateFor(species.bst) ?? enc.catchRate,
        slot: slot.k,
      };
      return begin(merged);
    }

    /**
     * The fight itself, run by `battle` (§5.17).
     *
     * This replaces `rolls.resolveBattle` — eleven lines that compared two levels and rolled a
     * coin — with a real turn engine: four moves with PP, the type chart, criticals, statuses
     * and stat stages (DECISIONS #67). The engine is pure and index-addressed, so the same
     * `(seed, index)` gives the same fight live, backgrounded and on a closed-tab replay.
     *
     * Degrades rather than throws. A quarantined `battle` costs the game its combat, not its
     * encounters: the wild appears, the exchange is a walkover for whoever has the higher
     * level, and the module's own animation and catch flow are untouched.
     */
    function fight(lead, enc, { apply = true } = {}) {
      const bt = ctx.get('battle');
      const pokemon = ctx.get('pokemon');
      if (!isLive(bt) || typeof bt.resolve !== 'function' || !isLive(pokemon)) {
        const win = (lead?.level ?? topLevel()) >= (enc.level ?? 5);
        return { win, hpFraction: win ? 0 : 1, turns: 0, transcript: [], engine: false };
      }
      const wildSpecies = enc.sheet ?? pokemon.species(enc.species);
      if (!lead || !wildSpecies) {
        return { win: false, hpFraction: 1, turns: 0, transcript: [], engine: false };
      }

      const ally = bt.makeCombatant({
        species: lead.species, level: lead.level, ivs: lead.ivs, shiny: lead.shiny,
        // The party's REAL moves, PP and current HP — a fight that started from full health
        // every time would make the per-lap heal (§5.7) and the whole idea of attrition
        // meaningless.
        moves: lead.moves?.length ? lead.moves.map((m) => ({ ...m })) : undefined,
        hp: lead.hp, status: lead.status, instanceId: lead.instanceId,
      });
      const wild = bt.makeCombatant({
        species: wildSpecies, level: enc.level, ivs: enc.ivs, shiny: enc.shiny,
      });

      // **`apply` is what keeps `autoResolve` a pure probe** (§5.6 has always called it "a
      // pure function of state and seed"). `encounter/showcase.js findIndex` runs it up to
      // four hundred times to search the index space for an encounter worth photographing;
      // with the writeback and the bus emits on, that scan hospitalised the party and flooded
      // the spy ring, and the showcase then hung waiting for a `begin()` that refused because
      // nothing was conscious. A probe reads the world; it does not change it.
      if (apply) {
        bus.emit('battle:started', {
          index: enc.index, ally: ally.species, wild: wild.species, level: enc.level,
          moves: ally.moves.map((m) => m.id),
        });
      }

      const out = bt.resolve(ally, wild, seed, enc.index);
      const win = out.winner === 'a';

      // What the fight cost, applied through `pokemon`'s published API. The ledger of HP and
      // PP belongs to the creature's owner, not to the module that staged the encounter.
      if (apply && typeof pokemon.damage === 'function' && lead.instanceId) {
        const lost = Math.max(0, ally.maxHp - out.a.hp) - Math.max(0, ally.maxHp - (lead.hp ?? ally.maxHp));
        if (lost > 0) pokemon.damage(lead.instanceId, lost);
      }
      if (apply && Array.isArray(lead.moves)) {
        for (const slot of lead.moves) {
          const spent = out.a.moves.find((m) => m.id === slot.id);
          if (spent) slot.pp = Math.max(0, Math.min(slot.pp, spent.pp));
        }
      }

      if (apply) {
        bus.emit('battle:ended', {
          index: enc.index, won: win, turns: out.turns, hpFraction: out.hpFraction,
          allyHp: out.a.hp, allyMaxHp: out.a.maxHp, stalled: out.stalled,
        });
      }

      return {
        win, hpFraction: out.hpFraction, turns: out.turns,
        transcript: out.transcript, engine: true, allyHp: out.a.hp,
      };
    }

    function begin(enc) {
      if (!enc) return null;
      // **Nothing to fight with, nothing to fight.** The slot trigger already checks this, but
      // the tall-grass path did not — and a wiped party kept starting encounters and losing
      // them, thirty-six in a row, one turn each (DECISIONS #67).
      const roster = ctx.get('pokemon');
      if (isLive(roster) && typeof roster.firstConscious === 'function' && !roster.firstConscious()) return null;
      if (active) flee();
      endScene();

      const lead = leadOf();
      const battle = fight(lead, enc);
      active = {
        ...enc,
        battle,
        hpFraction: battle.hpFraction,
        turn: 0,
        startedAt: Number(ctx.clock?.simTime ?? 0),
      };
      last = { ...active, outcome: null, ball: null, odds: null, roll: null };

      const at = stageCell();
      const sim = ctx.get('simulation');
      const trainer = isLive(sim) ? sim.player?.() : null;
      scene = {
        step: 0, stage: 'appear', at, wildActor: 0, coverY: coverHeightAt(at.cx, at.cz),
        from: {
          x: (trainer?.cx ?? at.cx) + 0.5,
          y: at.y + 1.1,
          z: (trainer?.cz ?? at.cz + 4) + 0.5,
        },
        ball: ballId, shakes: 0, caught: false, throwAt: Infinity, shake: 0,
        shiny: !!active.shiny,
        // Overwritten once the actor exists and its real frame size is known.
        headLift: 1.62,
      };
      // The sprite sheet may not be in the atlas yet, so the actor arrives a microtask (or
      // a fetch) later. The promise is kept so a showcase can await it before it freezes the
      // timeline — a scene frozen before the wild exists is a screenshot of empty grass.
      scene.ready = showWild(active, at).then((id) => {
        if (scene) { scene.wildActor = id; scene.headLift = headLiftOf(id); }
        return id;
      });

      // The party stops to fight. It keeps its place in the loop, so the lap continues from
      // where it was interrupted rather than starting again.
      const walker = ctx.get('simulation');
      if (isLive(walker) && typeof walker.pause === 'function' && !config.showcase) walker.pause(true);

      bus.emit('encounter:started', {
        species: active.species, level: active.level, shiny: active.shiny, biome: active.biome,
        // Extras beyond §4's fixed four. `collection` reads none of them and everything
        // ignores what it does not know, but the bus spy is the screenshot log's only record
        // of what happened and an index it cannot see is an index nobody can replay.
        index: active.index, tod: active.tod, ivs: active.ivs, catchRate: active.catchRate,
        slot: Number.isFinite(active.slot) ? active.slot : null,
      });

      /**
       * The line the games print, in the live game only.
       *
       * A toast and never `ui.say()`: the message box waits for a keypress before it closes
       * (ui/panels/dialogue.js `advance`), and an idle game that opens one every time the
       * lead walks through grass would stack a modal in front of a player who is not there.
       * A toast says the same sentence and stands itself down.
       *
       * `!config.showcase` because a toast fades on a wall-clock timer, and the one thing a
       * screenshot may not contain is something that is a different colour every capture
       * (DECISIONS #14). Another module's showcase gets the bubble and the animation, which
       * are both functions of the sim step, and none of the text.
       */
      if (!config.showcase) {
        bus.emit('ui:toast', {
          text: `A wild ${active.display ?? active.species}${active.shiny ? ' ★' : ''} appeared!`,
          kind: active.shiny ? 'good' : 'info',
        });
      }
      return active;
    }

    /**
     * Throws a ball. **Returns a boolean** — `automation` does
     * `const ok = encounter.attempt(pick.ball)` and reports `ok ? 'caught' : 'missed'`, so
     * anything object-shaped here would read as a catch every single time. The detail goes
     * on `last()`.
     */
    function attempt(ball = null) {
      // **A ball is illegal until the wild is beaten** (§5.6, DECISIONS #67). It used to be
      // legal on turn one because a battle was a coin flip resolved before the animation
      // started; now the exchange is a real fight and a Pokemon that just won it is the one
      // you get to throw at. `automation` moved onto `battle:ended` for this reason — a
      // subscription still firing on `encounter:started` would get `false` forever and its
      // auto-catch would die with no console error at all.
      if (active && active.battle && active.battle.win === false) return false;
      if (!active) return false;
      const economy = ctx.get('economy');
      if (!isLive(economy)) { log.warn('encounter: economy is down, so no ball can be thrown'); return false; }

      const enc = active;
      const id = ball ?? ballId;
      const turn = enc.turn + 1;

      // `economy` spends the ball and reports the odds; it never rolls them.
      const thrown = economy.throwBall(id, ballContext(enc, turn), {
        catchRate: enc.catchRate, hpFraction: enc.hpFraction, status: 'none',
      });
      if (!thrown?.thrown) {
        bus.emit('ui:toast', { text: `No ${economy.item?.(id)?.name ?? id} left`, kind: 'warn' });
        return false;
      }
      enc.turn = turn;

      const rolled = catchRoll(seed, enc.index, turn);
      const caught = rolled < thrown.odds;
      const shakes = shakesFor(rolled, thrown.odds, caught);

      last = {
        ...enc, ball: id, ballName: economy.item?.(id)?.name ?? id,
        multiplier: thrown.multiplier, odds: thrown.odds, roll: rolled,
        shakes, caught, turn, outcome: caught ? 'caught' : 'escaped',
      };

      if (scene) {
        scene.ball = id;
        scene.shakes = shakes;
        scene.caught = caught;
        // Queued, not jumped to: `marks()` will not honour it before the reveal is over.
        scene.throwAt = Math.max(scene.step, T.APPEAR + T.READY);
      }

      if (caught) {
        // §4's payload plus the level, the ball and the IVs this module rolled. `collection`
        // pairs this with the `encounter:started` above and takes the IVs rather than
        // inventing its own.
        bus.emit('catch:succeeded', {
          instanceId: enc.instanceId, species: enc.species, shiny: enc.shiny,
          level: enc.level, ivs: enc.ivs, ball: id, biome: enc.biome, index: enc.index,
        });
      } else {
        // NOT in §4's table. Emitted anyway because a failed catch is half of what this
        // module does and `ui`, `automation` and a future ball-counter all want it; filed in
        // coreRequests so the table can catch up. Nothing subscribes today, so nothing breaks.
        bus.emit('catch:failed', {
          species: enc.species, shiny: enc.shiny, ball: id, odds: thrown.odds,
          shakes, turn, index: enc.index,
        });
      }

      resolve(caught ? 'win' : (enc.battle.win ? 'win' : 'flee'), { caught, ball: id });
      return caught;
    }

    /** The player (or the idle layer) walks away. */
    function flee() {
      if (!active) return false;
      resolve('fled', { caught: false, ball: null });
      return true;
    }

    /**
     * Nobody threw. The party settles the exchange and the wild leaves.
     *
     * This is ARCHITECTURE §5.6's "battles are **resolved**, not turn-by-turn" doing the
     * work: `begin()` already ran the exchange against the lead's level, so the outcome is
     * decided, paid and reported here — the same numbers `autoResolve` would have given the
     * idle layer for the same index. It is *not* auto-catch: no ball is spent and nothing
     * enters the dex, because §5.11 puts auto-catch in `automation` and says none of its
     * rules are on by default.
     */
    function resolveUnattended() {
      if (!active) return;
      resolve(active.battle.win ? 'win' : 'flee', { caught: false, ball: null });
    }

    /**
     * Ends the encounter and pays for it.
     *
     * **This module is the only thing that credits a live encounter.** `economy` mints BP on
     * `encounter:resolved` and shards on `catch:succeeded`, and it deliberately refuses to
     * credit `rewards.money` because `idle` banks its own accrual through `economy.add()`
     * and paying both would pay for the same battle twice (`economy/index.js` says so).
     * `idle`'s encounters never reach this function, so crediting money here is the one
     * payment and not a second one.
     */
    function resolve(outcome, { caught, ball }) {
      const enc = active;
      active = null;
      if (!enc) return;

      const win = outcome === 'win';
      const rewards = rewardsFor(enc.level, { win, caught, shiny: enc.shiny });
      // Two different verdicts, and round 1 printed one under the other's label.
      //
      // `outcome` here is the *battle* — 'win' when the party won the exchange, 'flee' when
      // it did not — and that is what `encounter:resolved` carries, because `economy` mints
      // BP off exactly that word. But `last` is what a UI reads to say what happened to the
      // *ball*, and `caught ? 'caught' : outcome` captioned a failed catch on a won exchange
      // as **win**: `docs/progress/encounter/critic/c04-night-2130.png` prints
      // `outcome (decided at the throw): win` directly under `roll 0.865422 >= 0.388403` and
      // `shakes 0`. A ball was thrown and it broke out, so the word is `escaped`; only an
      // encounter nobody threw at reports the battle's verdict, which is all it has.
      last = { ...(last ?? enc), outcome: caught ? 'caught' : (ball ? 'escaped' : outcome), ball, rewards, battleOutcome: outcome };

      const economy = ctx.get('economy');
      if (isLive(economy) && rewards.money > 0) economy.add?.('money', rewards.money, 'battle');

      // **The experience a won fight is worth, finally paid to the Pokemon that won it.**
      // `source: 'hunt'` is what lets the evolution it may unlock be taken at all — the rule
      // lives at one point, in `pokemon.grantExp` (§0, DECISIONS #62).
      const pokemon = ctx.get('pokemon');
      const bt = ctx.get('battle');
      if (win && isLive(pokemon) && typeof pokemon.grantPartyExp === 'function') {
        const wild = enc.sheet ?? pokemon.species?.(enc.species);
        const gained = isLive(bt) && typeof bt.expYield === 'function' && wild
          ? bt.expYield(wild.baseExp, enc.level)
          : Math.max(1, Math.round((enc.level ?? 5) * 6));
        pokemon.grantPartyExp(gained, { source: 'hunt' });
      }

      // **A fainted lead steps aside.** Without this the party kept sending a 0 HP Oshawott
      // out and lost twenty-three fights in a row, each in one turn. The full heal rule — a
      // potion below a threshold, and a partial heal per completed lap — is phase 6; this is
      // the floor that keeps the loop from degenerating in the meantime.
      if (isLive(pokemon) && typeof pokemon.party === 'function') {
        const party = pokemon.party();
        if (party[0] && party[0].hp <= 0) {
          const next = party.findIndex((m) => m.hp > 0);
          if (next > 0) pokemon.setLead(next);
          else if (!faintedWarned) {
            faintedWarned = true;
            log.warn('encounter: the whole party is fainted — no more slots will be engaged');
            bus.emit('ui:toast', { text: 'Your party is out cold — visit the Pokémon Center', kind: 'warn' });
          }
        } else faintedWarned = false;
      }

      // The walk resumes wherever it stopped. `pause` and not `halt`, so a scripted loop keeps
      // its place in the circuit rather than restarting it (§5.4).
      const sim = ctx.get('simulation');
      if (isLive(sim) && typeof sim.pause === 'function') sim.pause(false);

      bus.emit('encounter:resolved', {
        outcome, species: enc.species, rewards,
        caught: !!caught, ball, level: enc.level, shiny: enc.shiny,
        biome: enc.biome, index: enc.index, turns: enc.turn,
      });
    }

    /**
     * What `economy` needs to evaluate a conditional ball. Every field here is read by at
     * least one of the eighteen: `species` by Net (types), Fast (base Speed) and Heavy
     * (weight), `level` by Nest, `partyLevel` by Level, `tod`/`biome` by Dusk and Dive,
     * `turn` by Quick and Timer, `caught` by Repeat.
     */
    function ballContext(enc = active, turn = (active?.turn ?? 0) + 1) {
      const collection = ctx.get('collection');
      const caughtBefore = isLive(collection) ? !!collection.caught?.(enc?.species) : false;
      return {
        species: enc?.sheet ?? null,
        level: enc?.level ?? 1,
        biome: enc?.biome ?? biomeNow(),
        tod: enc?.tod ?? todNow(),
        turn,
        caught: caughtBefore,
        partyLevel: leadOf()?.level ?? topLevel(),
        fishing: false,
      };
    }

    // ---------------------------------------------------------------- the grass

    /**
     * `player:enteredTile` carries the **lead Pokemon's** cell, not the trainer's
     * (DECISIONS #27) — the Pokemon walks in front, so it is what meets the grass first.
     * That is the entire reason the event exists, and this is its only consumer.
     */
    const off = [
      bus.on('player:enteredTile', ({ cx, cz, tags }) => {
        if (!armed || frozen || active || scene) return;

        // **A hunt meets its wildlife where the wildlife is standing.** A scene walking a
        // closed loop has fixed spawn slots two cells off the path (§5.14), and coming within
        // `slotEngageTiles` of an occupied one is the encounter — no roll, no grass, and the
        // same creature every lap until it is beaten. A walkable map the player drives keeps
        // the tall-grass step roll it has always had (DECISIONS #67).
        const slot = slotNear(cx, cz);
        if (slot) { engage(slot); return; }

        if (!Array.isArray(tags)) return;
        if (!tags.includes('tallgrass') && !tags.includes('encounter')) return;
        const enc = roll();
        if (enc) begin(enc);
      }),
      // A new map is a new biome and a new table; the memo is keyed on both, but the level
      // band moves with the party and the cached expansion does not carry it, so this is
      // just hygiene: drop everything and let it rebuild on the next roll.
      bus.on('world:loaded', () => tableCache.clear()),
    ];

    // ---------------------------------------------------------------- api

    const api = {
      // --- §5.6 -------------------------------------------------------------
      /**
       * The weighted species table, **weight-expanded into a plain `string[]`** so a uniform
       * pick from it is the weighted pick. `idle`, `offline` and `automation` all index it
       * directly; see the header of `tables.js` for why that shape and not `{name, weight}`.
       */
      tablesFor(biome = biomeNow(), tod = todNow()) { return tableFor(biome, tod).table; },
      roll,
      begin,
      attempt,
      flee,
      /**
       * The idle path: a resolved battle with no UI, as a pure function of state and seed
       * (§5.6). Keyed to the **lead's level** and not to summed party power — DECISIONS #21
       * measured that a full bench made every encounter a foregone win at 97 %.
       */
      autoResolve(enc, lead = null) {
        if (!enc) return { outcome: 'flee', species: null, rewards: { money: 0, exp: 0 } };
        const index = Number.isFinite(enc.index) ? enc.index : encounters;
        // The SAME engine the visible fight runs, so a battle resolved with nobody watching is
        // the battle that would have been watched (DECISIONS #67). `fight` degrades to a level
        // comparison when `battle` is quarantined, which is the only place the old
        // `resolveBattle` shape survives — and it survives as a fallback, not as a second
        // model of combat.
        const who = Number.isFinite(lead) ? { level: lead } : (lead ?? leadOf());
        const battle = fight(who, { ...enc, index, level: enc.level ?? 5 }, { apply: false });
        return {
          outcome: battle.win ? 'win' : 'flee',
          species: enc.species ?? null,
          rewards: rewardsFor(enc.level ?? 5, { win: battle.win, caught: false, shiny: !!enc.shiny }),
          hpFraction: battle.hpFraction,
          turns: battle.turns,
          index,
        };
      },

      // --- determinism ------------------------------------------------------
      /** Encounter number `index`, pure. The whole contract, in one call. */
      rollAt: rollIndex,
      /** The catch coin for `index`/`turn`, without spending a ball. Used to stage a shot. */
      catchRollAt: (index, turn = 1) => catchRoll(seed, index, turn),
      /**
       * The coin behind grass step `index`, and the line it was compared against.
       *
       * The trigger is the half of this module a screenshot has the hardest time showing —
       * a cell of grass either did or did not produce a Pokemon, and a frame of nothing
       * happening looks the same as a frame of it not being wired up. Handing back the roll
       * lets the showcase print the last dozen steps with their verdicts, which is the only
       * way that mechanic is visible at all.
       */
      stepRollAt(index, biome = biomeNow()) {
        const rate = (STEP_RATE[biome] ?? STEP_RATE.meadow) * multipliers().encounterRate;
        const roll = stepValue(seed, index);
        return { index, roll, rate, hit: roll < rate };
      },
      /** `{ steps, encounters }` — the only two numbers this module remembers. */
      progress: () => ({ steps, encounters }),
      seed: () => seed,

      // --- state ------------------------------------------------------------
      active: () => active,
      last: () => last,
      scene: () => (scene ? { stage: scene.stage, step: scene.step, shake: scene.shake } : null),
      /**
       * Whether the "!" bubble is on screen right now.
       *
       * Published because a claim about a picture has to be checkable from the shot's own
       * JSON log, not from reading the source: the showcase prints it into `ctx.log.info`,
       * which the harness captures alongside the PNG.
       */
      alerting: () => !!sprite.alerting?.(),
      /**
       * Re-fits the airborne ball to the camera. Driven by the module's `frame` hook; see
       * `ball.js` `refit()` for why it cannot be done once at placement time.
       */
      refit() { sprite.refit(); },

      /** Resolves once the wild Pokemon's sprite is actually in the field. */
      ready: () => scene?.ready ?? Promise.resolve(0),
      ballContext,
      /** The ball a bare `attempt()` throws. */
      setBall(id) { if (id) ballId = String(id); return ballId; },
      ball: () => ballId,
      /** `economy`'s pick for the encounter that is live, or for a hypothetical one. */
      bestBall(enc = active) {
        const economy = ctx.get('economy');
        return isLive(economy) ? economy.recommendBall?.(ballContext(enc, (enc?.turn ?? 0) + 1)) ?? null : null;
      },
      /** The odds a given ball would have right now, without spending one. */
      oddsFor(id, enc = active, turn = (active?.turn ?? 0) + 1) {
        const economy = ctx.get('economy');
        if (!isLive(economy) || !enc) return 0;
        return economy.catchOdds?.({
          ball: id, catchRate: enc.catchRate, hpFraction: enc.hpFraction,
          status: 'none', context: ballContext(enc, turn),
        }) ?? 0;
      },

      // --- reporting --------------------------------------------------------
      tables: () => summary(),
      rows: (biome = biomeNow(), tod = todNow()) => tableFor(biome, tod).table.rows,
      band: () => levelBand(topLevel()),
      stepRate: (biome = biomeNow()) =>
        (STEP_RATE[biome] ?? STEP_RATE.meadow) * multipliers().encounterRate,
      shinyRate,
      armed: () => armed,

      // --- showcase tools ---------------------------------------------------
      /** Stops the timeline where it is, so a screenshot of a moving scene is reproducible. */
      freeze(on = true) { frozen = !!on; return api; },
      frozen: () => frozen,
      /** Advances the timeline by `n` sim steps whatever `frozen` says. */
      /**
       * Steps the animation `n` sim steps.
       *
       * **Clamped, and that is not defensive tidiness.** `marks()` returns `Infinity` for a
       * throw that was never queued, so `advanceToStage('capture')` on an encounter nobody
       * threw at computes an infinite target — and this loop then wedged the browser's main
       * thread so completely that even a CDP evaluate timed out. It was reachable before
       * DECISIONS #67 and unreachable in practice, because `attempt()` always queued; now that
       * a ball is illegal until the wild is beaten, a lost battle reaches it every time.
       */
      advance(n = 1) {
        const want = Number(n);
        if (!Number.isFinite(want) || want < 0) {
          log.warn(`encounter: advance(${n}) is not a number of steps — ignored`);
          return api.scene();
        }
        const steps = Math.min(want, MAX_ADVANCE);
        if (steps < want) log.warn(`encounter: advance(${want}) clamped to ${MAX_ADVANCE}`);
        for (let i = 0; i < steps; i++) advanceScene();
        return api.scene();
      },
      /**
       * Advances to a named stage, `frac` of the way through it.
       *
       * A showcase cannot hardcode a step number: the shake window is `shakes x 14` steps
       * long and `shakes` comes out of the catch roll, so "the frame where the ball clicks"
       * is at step 88 for a three-wobble catch and step 46 for a nought-wobble miss. Asking
       * for the stage instead makes every mode's freeze point correct whatever the seed
       * rolled — the first cut of `mode=caught` froze at a hardcoded 78 and caught the third
       * wobble instead of the click.
       */
      advanceToStage(stage, frac = 0.5) {
        if (!scene) return null;
        const m = marks(scene);
        const f = Math.max(0, Math.min(1, frac));
        const shakeSpan = Math.max(0, scene.shakes) * T.SHAKE;
        const target = Math.round(
          stage === 'appear' ? f * T.APPEAR
            : stage === 'ready' ? T.APPEAR + f * T.READY
              : stage === 'throw' ? m.throwAt + f * T.THROW
                : stage === 'capture' ? m.land + f * T.SUCK
                  : stage === 'shake' ? m.suck + f * shakeSpan
                    : stage === 'result' ? m.shakeEnd + f * T.RESULT
                      : m.resultEnd + f * T.LINGER);
        if (!Number.isFinite(target)) {
          // The throw never happened — on a lost battle it cannot — so there is no `capture`,
          // `shake` or `result` beat to advance to. Saying so is better than advancing by
          // infinity, which is what this did.
          log.warn(`encounter: stage "${stage}" has no beat in this scene (nothing was thrown)`);
          return api.scene();
        }
        return api.advance(Math.max(0, target - scene.step));
      },
      /** Rewinds the counters, so a showcase can stage index N without walking to it. */
      setProgress({ steps: s, encounters: e } = {}) {
        if (Number.isFinite(s)) steps = Math.max(0, Math.floor(s));
        if (Number.isFinite(e)) encounters = Math.max(0, Math.floor(e));
        return api.progress();
      },
      cancel() {
        active = null;
        endScene();
        const sim = ctx.get('simulation');
        if (isLive(sim) && typeof sim.pause === 'function') sim.pause(false);
      },

      /** The occupied slot the head is next to, or null. The panel and the selftest read it. */
      slotsNear: (cx, cz) => slotNear(cx, cz),
      /** Starts a fight with whatever is on a slot. Returns the encounter, or null. */
      engage: (slot) => (slot ? engage(slot) : null),
      /** The last fight's turn-by-turn transcript, for a battle panel to replay. */
      transcript: () => (last?.battle?.transcript ?? []).map((e) => ({ ...e })),

      // --- persistence (§5, the native seam) --------------------------------
      saveState: () => ({ v: SAVE_VERSION, steps, encounters, ball: ballId }),
      loadState(value) {
        if (!value || typeof value !== 'object') return false;
        // Refuse a newer slice rather than guess at it, and say so at `warn` — a handled
        // path must not spend §7's zero-error budget (DECISIONS #15).
        if (Number(value.v) > SAVE_VERSION) {
          log.warn(`encounter: save slice v${value.v} is newer than v${SAVE_VERSION} — not loaded`);
          return false;
        }
        steps = Number.isFinite(value.steps) ? Math.max(0, Math.floor(value.steps)) : 0;
        encounters = Number.isFinite(value.encounters) ? Math.max(0, Math.floor(value.encounters)) : 0;
        if (typeof value.ball === 'string') ballId = value.ball;
        return true;
      },

      /**
       * The 35 invariants, run in the browser against the live species snapshot. The seam
       * suite runs the same function under Node (`node src/encounter/selftest.js`); this is
       * here so the showcase panel can print the score next to the frame it is claiming.
       */
      selfTest() {
        const pokemon = ctx.get('pokemon');
        const species = isLive(pokemon) ? pokemon.all?.() ?? null : null;
        const results = runSelfTest({ species });
        return { ...summarise(results), results };
      },

      dispose() {
        for (const unhook of off) unhook?.();
        endScene();
        sprite.dispose();
      },
    };

    log.info(`encounter: ${summary().map((s) => `${s.biome}:${s.rows}`).join(' ')} rows, ` +
      `seed ${seed}, passive encounters ${armed ? 'armed' : 'held (another module\'s showcase)'}`);

    return api;
  },

  tick(dt, ctx) {
    const api = ctx.get('encounter');
    if (api.frozen?.()) return;
    api.advance?.(1);
  },

  /**
   * Render-rate, and it does exactly one thing: keep the thrown ball's sprite on the pixel
   * grid as the camera moves. Deliberately not an animation hook — the moment is driven by
   * `tick` on the fixed step so a frozen scene is a frozen picture (DECISIONS #14).
   */
  frame(dt, alpha, ctx) {
    ctx.get('encounter').refit?.();
  },

  async showcase(mode, ctx) {
    const { showcaseEncounter } = await import('./showcase.js');
    return showcaseEncounter(mode, ctx);
  },

  dispose() {},
};
