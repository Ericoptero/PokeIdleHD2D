/**
 * encounter — spawn tables, catching, resolved battles (src/encounter/index.js).
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
 *   showcase.js   the staged capture (src/main.js)
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
 * **`collection` pairs `encounter:started` with `catch:succeeded`.** src/core/bus.js fixes both payloads;
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
 * `idle/encounter/N` streams — this module cannot make it delegate without a
 * core change, and that is filed rather than pretended. What it *can* do is make
 * `tablesFor()` return a table `idle`'s uniform pick samples correctly from; see `tables.js`.
 *
 * **The registry's null object answers `typeof api.foo === 'function'` with true even for a
 * dead module** (src/core/registry.js), so nothing here tests a sibling with `typeof`. `isLive()` reads the
 * `__missing` marker, the way `src/collection/index.js` does.
 */

import { makeBallSprite } from './ball.js';
import { makeStrikeVfx, shapeOf } from './vfx/play.js';
import { planBeats } from './beats.js';
import {
  SHINY_RATE, SHINY_RATE_CHARM,
  catchRateFor, levelBand, rollAt, catchRoll,
  shakesFor, rewardsFor,
} from './rolls.js';
import { dropsFor, tableFor as dropTableFor } from './drops.js';
import {
  todBand, rowsFor, expand, bumpsFor, validate, authoredCatchRate, summary,
} from './tables.js';
import { runSelfTest, summarise } from './selftest.js';
import { reportSelfTest } from '../core/log.js';
import { dirTo } from '../core/dir.js';

/**
 * How many balls may be thrown at one defeated wild.
 *
 * **One, and it is a rule rather than a setting**. The pity ledger is what
 * closes a grind out — spend 125% of a species' price and the next throw is certain — and that
 * only means anything if a throw costs a *victory*. A configurable number here would let a full
 * bag substitute for the fight, and the ladder `economy/pricing.js` is anchored to would stop
 * measuring anything.
 */
export const THROWS_PER_FAINT = 1;

/**
 * What a total party wipe costs, as a fraction of the wallet.
 *
 * A tenth, and it is the only way money leaves the game other than the shop — so it is the one
 * thing that makes a hunt a risk rather than a slower clock. Taken from the balance at the
 * moment of the wipe, which is exact: nothing accrues currency, so there is never an amount in
 * flight to disagree with.
 */
export const WIPE_PENALTY = 0.10;

/** Save slice version. `loadState` migrates forward and refuses a newer one (src/offline/slices.js). */
const SAVE_VERSION = 1;

/** The registry's null object answers every property with a function — this is the tell. */
const isLive = (api) => !!api && api.__missing === undefined;

/**
 * The scene's timeline, in fixed sim steps (1/20 s each, `core/clock.js`).
 *
 * Sim steps and not seconds, and certainly not `performance.now()`: the harness freezes the
 * clock for every screenshot and a showcase has to be able to stop the
 * animation on an exact frame and get the same pixels twice. Every number below is a count
 * of `tick()` calls.
 */
const T = {
  /**
   * The breath before the first blow, in sim steps.
   *
   * **There is no reveal any more**. The creature was already walking the map,
   * the party walked up to it, and the fight starts where it is standing — so what used to be
   * `APPEAR` (20 steps of leaves, a hop, a scale pop and a "!" balloon) is half a second in
   * which two animals are looking at each other. It is not zero, because the plate over the
   * wild's head and the first move's balloon have to be legible before the screen fills with
   * an effect, and it is not longer, because a hunt that stops for a second per creature stops
   * feeling like a hunt.
   */
  OPEN: 10,
  /**
   * The duel's own beats, in sim steps. How long the engine is asked to hold **one action's**
   * beat for is `config.actionSteps`, read in `init` as `ACTION_STEPS` — not
   * a literal here, because it is the one beat a player might reasonably want to tune from a
   * URL, and this table is built before `init` has a `config` to read.
   *
   * A fight is no longer a number computed before the animation starts: the
   * scene drains `battle.stepper`'s turns one strike at a time and these are how long each
   * beat holds. `VICTORY` is the pause on the last blow before the throw window opens, which is
   * what makes the faint read as an ending rather than as a cut.
   */
  ITEM: 16,        // a potion or an ether, mid-duel
  STRIKE: 10,      // how long one blow's effect plays — always shorter than ACTION_STEPS
  VICTORY: 12,
  READY: 8,        // a beat, during which a player (or `automation`) may throw
  /**
   * How long the wild waits after that before the party settles it and it leaves.
   *
   * Not decoration — without it the live game deadlocks. Nothing throws a ball at `/`:
   * `automation` is off by default (src/automation/index.js — "none are on by default") and `ui` has no
   * throw bound yet, so an encounter with `throwAt = Infinity` sat in the `ready` stage
   * forever with `active` never clearing, which meant the first Pokemon a player ever met
   * was also the last. Measured by walking the lobby's own grass: 6 steps, 1 encounter, and
   * then nothing for another 894 sim steps.
   *
   * What happens instead is the thing src/encounter/index.js already says: **battles are resolved, not
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
   * Extra modules the showcase scene needs on top of `needs` (src/main.js).
   *
   * `simulation` walks the party into the grass and `collection` records what comes out of
   * it — both are the point of the shot. **`battle` is also needed**: the fight is
   * stepped on screen now, and without the engine this scene photographed the degraded path and
   * printed "0 turns (no engine)" beside a picture of a duel that never happened. It is in
   * `showcaseNeeds` and still not in `needs`, which is the whole distinction — a quarantined
   * engine must cost the game its combat and not its encounters (src/encounter/index.js).
   *
   * `idle` and `automation` are deliberately absent: `idle`'s heartbeat would bank money into
   * the readout between the settle and the shutter, and `automation` would throw its own ball
   * at the encounter this scene is staging.
   */
  showcaseNeeds: ['simulation', 'collection', 'battle'],

  init(ctx) {
    const { bus, config, log } = ctx;
    const seed = config.seed;
    /** One action's beat, in sim steps. Read once; a mid-fight config change
     *  finishes the fight it started in, which is the harness's own `?actionSteps=` contract. */
    const ACTION_STEPS = Math.max(1, Math.round(config.actionSteps ?? 18));

    // --- the tables ---------------------------------------------------------
    // Checked once, out loud. A typo in a species name is invisible at runtime — the
    // encounter is simply dropped and the grass quietly stops working — and this is a
    // handled path, so it is a `warn`: tools/shots/shoot.js counts console errors and behaving correctly must
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
    /** What a move looks like when it lands. */
    const strikeVfx = makeStrikeVfx(ctx.THREE, ctx, { pitch: config.cameraPitch ?? 45 });
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
     * wall-clock luck. Showcases are read-only.
     */
    const armed = !config.showcase || config.showcase === 'encounter';

    // --- helpers ------------------------------------------------------------

    /**
     * The active map's own gameplay-profile id (P5) — `terrain.handle().encounterTable`,
     * which is the loaded map's own `encounters.table` when it has one, or whatever a
     * proc-gen builder defaulted it to before returning (`src/hunts/index.js`'s `biome.id`,
     * `src/city/index.js`'s/`src/pokecenter/index.js`'s `'city'`). **No membership check
     * against a fixed list any more** — that used to live here (`BIOMES.includes(b) ? b :
     * 'meadow'`), which is exactly the "fixed 5-entry enum" this phase removes. An id this
     * module has never heard of is not an error: `tableFor`, below, and `rowsFor`
     * (`tables.js`) already fall back to `TABLES.meadow` for one, so a map that has not been
     * authored a table yet degrades to the same safety net a typo used to.
     */
    const biomeNow = () => ctx.get('terrain').handle?.()?.encounterTable ?? 'meadow';
    /** The active map's category tags (`'cave'`, `'coastal'`, …) — see `terrain.handle()`'s
     *  own doc. Read by `ballContext()`, below, for the two balls that key off a category
     *  rather than an id (`economy/items.js`'s Dive/Dusk Ball). */
    const tagsNow = () => {
      const t = ctx.get('terrain').handle?.()?.tags;
      return Array.isArray(t) ? t : [];
    };
    /** The active map's own id (`'hunt-forest'`, `'demo-city'`, …) — a strict superset of
     *  `biomeNow()`'s table id, kept as its own field because two maps could someday share a
     *  table without being the same place. `collection` stores this on a caught Pokemon's
     *  save row (P5 item 9) instead of the table id, so its provenance survives a table
     *  being renamed or shared. */
    const mapIdNow = () => ctx.get('terrain').handle?.()?.id ?? null;
    const todNow = () => {
      const env = ctx.get('environment');
      // Liveness on the *value*, never on `typeof` (src/core/registry.js).
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

    /**
     * The weight-expanded table for a table id and hour, memoised per (id, band).
     *
     * No membership check against a fixed list — `rowsFor` (`tables.js`) already falls back
     * to `TABLES.meadow` for an id it does not recognise, so trusting whatever `biome` names
     * (an authored id from the map file, or `biomeNow()`'s own default) is enough: an unknown
     * id still resolves to a real table, it just is not this file's job to decide which ones
     * are "real" any more (P5).
     */
    const tableCache = new Map();
    function tableFor(biome, tod) {
      const b = String(biome ?? 'meadow');
      const key = `${b}/${todBand(tod)}`;
      if (!tableCache.has(key)) {
        const rows = rowsFor(b, tod);
        tableCache.set(key, { table: expand(rows, { slots: 120, biome: b, tod }), bumps: bumpsFor(rows) });
      }
      return tableCache.get(key);
    }

    /** A species record from a name, a record, or nothing. Null is a legal answer. */
    function speciesRecord(v) {
      if (!v) return null;
      if (typeof v === 'object') return v;
      const pokemon = ctx.get('pokemon');
      return isLive(pokemon) && typeof pokemon.species === 'function' ? pokemon.species(v) ?? null : null;
    }

    // ---------------------------------------------------------------- rolling

    /**
     * Encounter number `index`, as a pure function of the seed and that index.
     *
     * Exposed because it is the whole determinism story: hand it an index and it gives the
     * species, level, shiny flag and six IVs, with no reference to when or whether the
     * encounter actually happened. `idle` should be resolving its closed-tab encounters
     * through this rather than through its own copy in `accrual.js`; that needs a core
     * change.
     */
    function rollIndex(index, {
      biome = biomeNow(), tod = todNow(), band = null, rate = null,
      tags = tagsNow(), mapId = mapIdNow(),
    } = {}) {
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
        biome, tod, tags, mapId,
        sheet,
        display: sheet?.display ?? rolled.species,
        catchRate: catchRateOf(rolled.species, sheet),
        instanceId: sheet ? String(sheet.id) : rolled.species,
      };
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
    function stageCell(slotCell = null) {
      const sim = ctx.get('simulation');
      const cell = isLive(sim) ? sim.followerCell?.() : null;
      const terrain = ctx.get('terrain');
      const DX = [0, -1, 0, 1], DZ = [1, 0, -1, 0];      // core/dir.js order
      const dir = (cell?.dir ?? 0) & 3;
      // **The wild fights where it was standing.** The party walked off its circuit to reach
      // this creature, so staging it two cells in front of the head — which is
      // what a tall-grass encounter wanted — would move it away from the spot the player just
      // walked to. A slot encounter stages on the slot's own cell; everything else keeps the
      // old framing.
      const cx = slotCell ? slotCell.cx : (cell?.cx ?? 0) + DX[dir] * 2;
      const cz = slotCell ? slotCell.cz : (cell?.cz ?? 0) + DZ[dir] * 2;
      // `simulation.surfaceAt` measures the top of the cell off the loaded map's placements;
      // `terrain.height()` reports the authored heightfield, which the demo maps never set
      //. Prefer the measured one and fall back to the authored one.
      const y = isLive(sim) && Number.isFinite(sim.surfaceAt?.(cx, cz))
        ? sim.surfaceAt(cx, cz) : (terrain.height?.(cx, cz) ?? 0);
      // **The wild faces the lead** — computed from the true geometry (`dirTo`, core/dir.js)
      // rather than assumed to be the exact reverse of the lead's own facing. The two only
      // agree when the lead is looking straight at the staged cell; a slot encounter (the
      // common case now, `hunts`'s aggro trigger) stages the wild on its own drifted tile,
      // which is not always dead ahead of whichever way the lead happens to be facing when it
      // arrives.
      const faceDir = cell ? dirTo(cx, cz, cell.cx, cell.cz) : (dir + 2) & 3;
      return { cx, cz, y, dir: faceDir, x: cx + 0.5, z: cz + 0.5 };
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
     * How high above a wild Pokemon's feet its "!" balloon — and its plate, and the capture
     * tooltip — hang.
     *
     * Measured off the actor rather than guessed: `pokemon.sprites.get()` now reports
     * `headLift` straight from `pokemon/sprites.js`'s `headLiftOf()` (the quad's own stretched
     * height, less the same foot pad `field.js` drops the sprite by), the one true head height
     * every caller used to guess at with its own fudge factor. `1.62` survives only as the
     * fallback for a sprite that has not spawned yet.
     */
    function headLiftOf(actorId) {
      const pokemon = ctx.get('pokemon');
      const a = isLive(pokemon) ? pokemon.sprites.get?.(actorId) : null;
      return Number.isFinite(a?.headLift) ? a.headLift : 1.62;
    }

    function clearWild() {
      const pokemon = ctx.get('pokemon');
      if (scene?.wildActor && isLive(pokemon)) pokemon.sprites.remove(scene.wildActor);
      if (scene) scene.wildActor = 0;
    }

    /**
     * Takes the map's own creature out of the walker's cast. Idempotent.
     *
     * Called twice on purpose: once from `scene.ready`, the moment this module's actor stands
     * where the NPC was standing, and again from `endScene()` — because an encounter can be
     * cancelled or travelled out of before that promise ever resolves, and a wild that stayed
     * in the cast would still be `solid` on a cell the slot has already scheduled a refill for.
     */
    function retireNpc() {
      if (!scene?.npcId) return false;
      const sim = ctx.get('simulation');
      const id = scene.npcId;
      scene.npcId = 0;
      if (isLive(sim) && typeof sim.removeNpc === 'function') return sim.removeNpc(id);
      return false;
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
    /**
     * How long the manual throw window stays open before the wild leaves unattended, in sim
     * steps. Only a WON fight can throw a ball at all (`attempt()` refuses on anything but
     * `active.battle.win === true`), so only that case is worth extending — `T.LEAVE` (0.8s)
     * covers a loss/flee either way. On a win: `T.LEAVE` when Auto-Catch is on — automation
     * throws well inside that, from its own `battle:ended` handler
     * (`src/automation/index.js`) — or `config.manualThrowSeconds` (5s) when it is off, so a
     * human player actually has time to read the capture tooltip (`dom/capture.js`) and choose
     * before the wild is gone.
     */
    function leaveSteps() {
      if (active?.battle?.win !== true) return T.LEAVE;
      const auto = ctx.get('automation');
      const autoCatch = isLive(auto) && typeof auto.isActive === 'function' && auto.isActive('catch');
      if (autoCatch) return T.LEAVE;
      return Math.max(T.LEAVE, Math.round((config.manualThrowSeconds ?? 5) * 20));
    }

    function marks(s) {
      // **The throw window opens when the fight ends, and not before.** `fightEndsAt` is
      // `Infinity` while turns are still being stepped, which makes every mark below infinite
      // too — so a queued throw simply waits, exactly as it already waited out the reveal.
      const ready = s.fightEndsAt + T.READY;
      const throwAt = Math.max(ready, s.throwAt ?? Infinity);
      // Finite only while no throw has been queued: an order to throw cancels the exit by
      // construction, rather than by a flag that could fall out of step with it.
      const leaveAt = Number.isFinite(throwAt) ? Infinity : ready + leaveSteps();
      const land = throwAt + T.THROW;
      const suck = land + T.SUCK;
      const shakeEnd = suck + Math.max(0, s.shakes) * T.SHAKE;
      const resultEnd = shakeEnd + T.RESULT;
      return { throwAt, leaveAt, land, suck, shakeEnd, resultEnd, end: resultEnd + T.LINGER };
    }

    /** `config.reviveSeconds` in sim steps. Zero seconds is an instant revive, for the harness. */
    const reviveSteps = () => Math.max(0, Math.round((config.reviveSeconds ?? 5) * 20));

    /**
     * Emits one strike's `battle:strike` and arms its VFX — never two strikes in the same
     * tick. A strike with no `move` (a residual tick, an item, a swap) gets no visual effect
     * and clears whatever the previous strike armed, so a beat with nothing to show is a beat
     * that shows nothing rather than a stale effect still finishing.
     *
     * `type`/`shape` ride along on the emitted event — the element and the
     * delivery shape the move resolves to — so `ui` can colour a balloon by type
     * without importing `encounter`'s own tables, which the module boundary forbids.
     */
    function emitStrike(strike, step) {
      const bt = ctx.get('battle');
      const moveRec = strike.move && isLive(bt) && typeof bt.move === 'function' ? bt.move(strike.move) : null;
      scene.vfx = strike.move
        ? {
          at: step, shape: shapeOf(moveRec), type: moveRec?.t ?? 'normal', toWild: strike.target === 'b',
          // Threaded through so `play.js` can add a super-effective hit's second ring and a
          // crit's white flash without `ui`'s own copy of the same fields.
          crit: !!strike.crit, effectiveness: strike.effectiveness ?? 1,
        }
        : null;
      if (config.showcase) return;
      bus.emit('battle:strike', {
        index: active.index, turn: strike.turn,
        attacker: strike.attacker, attackerSpecies: strike.attackerSpecies,
        target: strike.target, targetSpecies: strike.targetSpecies,
        move: strike.move, name: strike.name, struggle: strike.struggle,
        damage: strike.damage, hits: strike.hits, effectiveness: strike.effectiveness,
        crit: strike.crit, miss: strike.miss, immune: strike.immune,
        targetHp: strike.targetHp, targetMaxHp: strike.targetMaxHp,
        status: strike.status, fainted: strike.fainted, cause: strike.cause,
        // What was used, when the strike is an item rather than a blow.
        item: strike.item ?? null, use: strike.use ?? null,
        // The element and the shape a balloon/VFX would use — null for a strike with no move.
        type: moveRec?.t ?? null, shape: strike.move ? shapeOf(moveRec) : null,
      });
    }

    /**
     * One sim step of the live duel — at most one `run.step()` per turn, and at most one
     * `battle:strike` per tick, drained off a plan rather than fired in a block.
     *
     * **The sequencing this exists for**: `run.step()` resolves a whole turn —
     * both sides, in the engine's own priority/speed order — synchronously, in one call, the
     * instant it is asked. Emitting straight out of that call's result is what put both sides'
     * `battle:strike` in the same tick, which is the "attacks at the same time" bug the brief
     * is about: two balloons popping together, one effect overwriting the other. `planBeats`
     * turns the same ordered `strikes[]` into a timeline — `ACTION_STEPS` apart, an item or a
     * revive holding longer — and this drains exactly one due entry per call. The engine's own
     * order is never touched; only when each of its outputs is allowed to reach the bus moves.
     */
    function tickDuel(step) {
      const s = scene;
      const enc = active;
      if (!s) return;

      if (!s.turnPlan) {
        if (step < s.nextTurnAt) return;
        if (!enc?.duel?.engine) { endFight(step); return; }
        const { run } = enc.duel;
        if (run.over) { endFight(step); return; }

        const out = run.step();
        const bt = ctx.get('battle');
        const names = { a: enc.duel.ally.display ?? enc.duel.ally.species, b: enc.display ?? enc.species };
        const strikes = (isLive(bt) && typeof bt.strikesOf === 'function')
          ? bt.strikesOf(out.events, names) : [];

        enc.battle.turns = run.state.turn;
        enc.battle.transcript.push(...out.events);
        s.strikes = strikes;
        s.turnsSeen++;

        s.turnPlan = planBeats(strikes, { actionSteps: ACTION_STEPS, itemSteps: T.ITEM, reviveSteps: reviveSteps() });
        s.turnPlanAt = step;
        s.turnCursor = 0;
        s.turnOver = run.over;
        // A turn that produced no strikes at all (both sides already fainted and swapped, say)
        // has nothing to drain — settle it on the same tick rather than stall on an empty plan.
        if (!s.turnPlan.length) {
          s.turnPlan = null;
          s.nextTurnAt = step + 1;
          if (s.turnOver) endFight(step);
          return;
        }
      }

      while (s.turnCursor < s.turnPlan.length && step >= s.turnPlanAt + s.turnPlan[s.turnCursor].at) {
        emitStrike(s.turnPlan[s.turnCursor].strike, step);
        s.turnCursor++;
      }

      if (s.turnCursor >= s.turnPlan.length) {
        const over = s.turnOver;
        s.turnPlan = null;
        s.turnCursor = 0;
        s.nextTurnAt = step;
        if (over) endFight(step);
      }
    }

    /**
     * The fight is over: settle it, pay what it cost, and open the throw window.
     *
     * The writeback and the `battle:ended` emit both live here rather than in `resolve()`,
     * because a player may spend several seconds deciding whether to throw and the party bar
     * must already show what the fight did to it.
     */
    function endFight(at) {
      const s = scene;
      const enc = active;
      if (!s || Number.isFinite(s.fightEndsAt)) return;
      s.fightEndsAt = at + T.VICTORY;
      if (!enc) return;

      const duel = enc.duel;
      if (duel?.engine) {
        const st = duel.run.state;
        const won = st.over ? st.winner === 'a' : st.a.hp / st.a.maxHp >= st.b.hp / st.b.maxHp;
        enc.battle.win = won;
        enc.battle.turns = st.turn;
        enc.battle.stalled = !st.over;
        enc.battle.allyHp = st.a.hp;
        enc.battle.allyMaxHp = st.a.maxHp;
        enc.battle.sent = duel.run.sent;
        // The wild's HP as a fraction, which is what `economy.catchOdds` wants. A won fight
        // leaves it at 0, which the formula clamps to 0.01 — the maximum HP bonus.
        enc.hpFraction = st.b.maxHp > 0 ? st.b.hp / st.b.maxHp : 1;
        enc.battle.hpFraction = enc.hpFraction;
        // **The status the fight actually inflicted**, which `attempt()` used to throw away by
        // hard-coding `'none'` — so the 2.5x sleep and 1.5x paralysis bonuses in `catchOdds`
        // were unreachable from the one place a ball is ever thrown.
        enc.wildStatus = st.b.status ?? 'none';
        // **The last word on whoever is left in the `a` slot.** `nextAlly` (`openDuel`) already
        // snapshots anyone who fainted and was swapped out; this is the other half — the
        // member still standing when the fight ends (a win, a loss, or a stall) never triggers
        // `nextAlly` at all, so nothing would otherwise record its true final hp/status/PP.
        if (st.a?.instanceId) duel.snapshots?.set(st.a.instanceId, st.a);
        writeBack(duel);
      } else {
        enc.battle.win = duel?.win ?? false;
        enc.hpFraction = enc.battle.hpFraction;
      }
      last = { ...last, ...enc, battle: enc.battle, hpFraction: enc.hpFraction };

      bus.emit('battle:ended', {
        index: enc.index, won: !!enc.battle.win, turns: enc.battle.turns,
        hpFraction: enc.hpFraction, allyHp: enc.battle.allyHp ?? null,
        allyMaxHp: enc.battle.allyMaxHp ?? null, stalled: !!enc.battle.stalled,
      });
    }

    /** One sim step of the on-screen moment. Pure function of `scene.step`. */
    function advanceScene() {
      if (!scene) return;
      const s = scene;
      const m = marks(s);
      const at = s.at;
      const step = s.step;

      // 1. **the fight, from step 0.** There is no reveal to wait out.
      //
      // The creature was walking this map and the party walked up to it, so the first thing
      // this loop ever draws is two animals standing on their own cells. What
      // used to be here — `T.RUSTLE` of leaves with the wild undrawn, then a hop and a scale
      // pop out of the grass — is gone, and with it the one reason the first exchange could
      // not start until step 44.
      if (!Number.isFinite(s.fightEndsAt)) {
        // one strike drained per due beat, `ACTION_STEPS` apart.
        //
        // Resolve only the current turn at this beat. `begin()` used to resolve the
        // battle before the wild had finished coming out of the grass, and the card that
        // followed was a readout of something already over. Now the stepper is driven from
        // here, one exchange at a time, and every blow it produces goes out on the bus as a
        // `battle:strike`, one per beat and never two in the same tick, so the
        // VFX, the callout and the card all read one seam.
        tickDuel(step);
        moveWild({ y: at.y, visible: true, scale: 1 });
        if (s.shiny) sprite.shimmer(at, step); else sprite.hide();
        /**
         * **The blow, drawn between the two creatures that are standing there.**
         *
         * The endpoints are read at draw time rather than stored with the strike, because the
         * party is paused but not frozen — it finishes the tile it was on — and an effect
         * anchored to where somebody *was* a beat ago lands in the grass beside them.
         */
        if (s.vfx && step - s.vfx.at < T.STRIKE) {
          const lead = isLive(ctx.get('simulation')) ? ctx.get('simulation').followerCell?.() : null;
          const mine = lead
            ? { x: lead.cx + 0.5, y: surfaceAt(lead.cx, lead.cz), z: lead.cz + 0.5 }
            : { x: at.x, y: at.y, z: at.z + 2 };
          const theirs = { x: at.x, y: at.y, z: at.z };
          strikeVfx.play({
            shape: s.vfx.shape, type: s.vfx.type,
            from: s.vfx.toWild ? mine : theirs,
            to: s.vfx.toWild ? theirs : mine,
            crit: s.vfx.crit, effectiveness: s.vfx.effectiveness,
          });
          strikeVfx.phase((step - s.vfx.at) / T.STRIKE);
        } else {
          strikeVfx.hide();
        }
        s.stage = 'fight';
      } else if (step < m.throwAt) {
        // 1c. the beat in which a ball may be thrown — and, if none is, the exit.
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
          // **No "!" balloon.** What says "you may throw now" is the beaten wild's own plate,
          // whose bar is on the floor, and the capture tooltip's own prompt.
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

    /** The drawn top of a cell, measured where it can be and authored where it cannot. */
    function surfaceAt(cx, cz) {
      const sim = ctx.get('simulation');
      const terrain = ctx.get('terrain');
      if (isLive(sim) && Number.isFinite(sim.surfaceAt?.(cx, cz))) return sim.surfaceAt(cx, cz);
      return terrain.height?.(cx, cz) ?? 0;
    }

    function endScene() {
      retireNpc();
      clearWild();
      sprite.hide();
      strikeVfx.hide();
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
     * Chebyshev, and the reach is the distance a slot is authored at — 2 (src/hunts/index.js). The
     * tether's ±1 drift is what makes the meeting read as a creature noticing the party; it is
     * not extra reach, and treating it as such left the trigger silent.
     */
    /**
     * One nag per streak, for a party that has nothing left to fight with.
     *
     * This is **not** a guard on `wipe()`. It used to be: `wipe()` opened with
     * `if (faintedWarned) return;` above the revive, and the reset below only ran on a resolve
     * where somebody was still standing. So the second wipe with no surviving encounter between
     * paid nothing, revived nobody and emitted nothing, and the party then sat at 0 hp forever —
     * `slotNear` refuses a party with no conscious member, so no encounter could start, so no
     * resolve could clear the latch, so `reviveAll()` could never run. A save written in that
     * state was silent and battle-free for good. A wipe now always pays and always revives; what
     * is latched is only the nag below.
     *
     * One of three deliberately overlapping nets — this, `hunts`' lap rest and
     * `city.enter()`. Do not drop one as redundant: the redundancy is the decision.
     */
    let faintedNagged = false;

    /**
     * The most sim steps one `advance()` call may run.
     *
     * The whole animation is `OPEN + n*TURN + VICTORY + READY + THROW + SUCK + 5*SHAKE + RESULT
     * + LINGER`, well under two hundred for any fight this game's level curve produces; a
     * thousand is room for a long duel and still a number a wedged page cannot hide behind.
     */
    const MAX_ADVANCE = 1000;

    function slotNear(cx, cz) {
      const hunts = ctx.get('hunts');
      if (!isLive(hunts) || typeof hunts.slots !== 'function') return null;
      // Nothing to fight with: a party that is entirely fainted walks past its wildlife
      // rather than losing to it twenty-three times in a row, which is what it did before
      // this guard existed.
      const pokemon = ctx.get('pokemon');
      const canFight = !isLive(pokemon) || typeof pokemon.firstConscious !== 'function'
        || !!pokemon.firstConscious();
      // Cleared here and not only in `resolve()`, because the two routes that revive without
      // resolving anything — a lap of the circuit and arriving in the city — would otherwise
      // leave the nag latched and swallow the next streak's warning.
      if (canFight) faintedNagged = false;
      else {
        /**
         * **Say so.** This refusal used to be silent, and a party that had somehow reached 0 hp
         * across the board walked its circuit past living wildlife forever with nothing in the
         * console and nothing on screen — which is precisely how long that bug lived. A lap rest
         * and the city both revive now, so this should be unreachable; the nag is the tripwire
         * that says out loud if it ever is not. `warn`, never `error`: a handled path must not
         * spend the zero-error budget every capture is measured against.
         */
        if (!faintedNagged) {
          faintedNagged = true;
          log.warn('encounter: the whole party is fainted — walking past the wildlife until something revives it');
          if (!config.showcase) {
            bus.emit('ui:toast', { text: 'Your party is out cold. Head back to the city to heal.', kind: 'warn' });
          }
        }
        return null;
      }
      const reach = Math.max(0, Number(config.slotEngageTiles ?? 2));
      // **Against the wild's own live position, not the slot's authored one.** It drifts a
      // tile around its tether (`hunts/index.js`'s own `tether: {radius: 1}`), and "the
      // trainer's Pokemon physically reaches a living wild" (the brief's own words) means the
      // creature standing there right now — the same live lookup `ui/plates.js`'s
      // `wanderingPlates()` and the aggro walk (`hunts/index.js`'s own `bfsPath` trigger)
      // already use, so all three agree on where contact actually happens.
      const sim = ctx.get('simulation');
      const npcs = isLive(sim) && typeof sim.npcs === 'function' ? sim.npcs() : [];
      for (const s2 of hunts.slots()) {
        if (!s2.occupied) continue;
        const live = npcs.find((n) => n.id === s2.npcId) ?? s2;
        if (Math.max(Math.abs(live.cx - cx), Math.abs(live.cz - cz)) <= reach) return s2;
      }
      return null;
    }

    /**
     * Starts the fight with whatever is standing on a slot.
     *
     * `hunts.takeSlot` hands the creature over **without taking its sprite off the map**: the
     * body standing there becomes the body that fights, and this module retires it only once
     * its own actor is drawn on the same cell. The slot is then scheduled to
     * refill, which is what makes it a respawn point.
     *
     * The **species, the level and the cell** are the slot's — they are what a plate over the
     * creature's head was already advertising before anybody touched it. The shiny roll and the
     * IVs still come from `rollAt(index)`, so a hunt replayed offline meets the same creature
     * it met live.
     */
    function engage(slot) {
      const hunts = ctx.get('hunts');
      const taken = isLive(hunts) && typeof hunts.takeSlot === 'function' ? hunts.takeSlot(slot.k) : null;
      if (!taken) return null;
      const index = encounters++;
      const enc = rollIndex(index);
      if (!enc) return null;
      // **The species and the level are the slot's; everything else is the index's.** The level
      // owned by the field actor: it is a property of the creature that walked onto the
      // slot, printed over its head before anybody touched it, so rolling a different one at
      // the moment of contact would make that plate a lie.
      const species = taken.species;
      const merged = {
        ...enc,
        species: species.name,
        display: species.display ?? species.name,
        sheet: species,
        level: Number.isFinite(taken.level) ? taken.level : enc.level,
        shiny: enc.shiny || !!taken.shiny,
        catchRate: authoredCatchRate(species.name) ?? catchRateFor(species.bst) ?? enc.catchRate,
        slot: slot.k,
        // Where the creature **is**, not where the slot was authored: it drifts a tile around
        // its tether, and the fight happens on the cell it is standing on.
        slotCell: { cx: taken.cx, cz: taken.cz, dir: taken.dir ?? slot.dir ?? 0 },
        // The body to inherit, retired once this module's own actor replaces it.
        npcId: Number.isFinite(taken.npcId) ? taken.npcId : 0,
      };
      /**
       * **Auto-Lead is asked here, before the duel opens**, because that is the only moment the
       * answer means anything: once `begin()` has built its combatant the member is out.
       *
       * It is asked at engagement rather than on a cadence for the same reason heal and ether
       * are not in `PASSES` — there is nothing to decide when there is no wild in front of you
       *.
       */
      const auto = ctx.get('automation');
      const pokemon = ctx.get('pokemon');
      if (isLive(auto) && typeof auto.duel === 'function' && isLive(pokemon)) {
        const bt = ctx.get('battle');
        const roster = typeof pokemon.party === 'function' ? pokemon.party() : [];
        const wild = merged.sheet ?? pokemon.species?.(merged.species);
        const want = auto.duel({
          effectiveness: isLive(bt) && typeof bt.effectiveness === 'function' ? bt.effectiveness : null,
          moveOf: isLive(bt) && typeof bt.move === 'function' ? bt.move : null,
        }).chooseLead(roster, wild ? { ...wild, species: wild.name } : null);
        const at = want ? roster.findIndex((m) => m.instanceId === want) : -1;
        if (at > 0) pokemon.setLead(at);
      }
      return begin(merged);
    }

    /**
     * Opens a fight and hands back the stepper that runs it, one turn at a time.
     *
     * This replaced a synchronous `battle.resolve()`. The whole exchange used
     * to be decided inside `begin()`, before a single frame was drawn, and the battle card was
     * a readout of something that had already happened — which is why nothing in the game ever
     * called `battle.turn()`, published and pure though it was. Now the scene steps it on a sim
     * cadence, so the player watches the fight the offline replay would have run.
     *
     * `between` and `nextAlly` are the two hooks that make an ally faint non-terminal: the
     * first is where Auto-Heal, Auto-Ether and Auto-Revive land (Phase D fills it in), and the
     * second sends out the next party member. Neither may draw randomness — see the header of
     * `battle/engine.js`.
     *
     * Degrades rather than throws. A quarantined `battle` costs the game its combat, not its
     * encounters: the wild appears, the exchange is a walkover for whoever has the higher
     * level, and this module's animation and catch flow are untouched.
     */
    function openDuel(lead, enc) {
      const bt = ctx.get('battle');
      const pokemon = ctx.get('pokemon');
      const walkover = (win) => ({
        engine: false, run: null, ally: null, wild: null,
        win, turns: 0, transcript: [], hpFraction: win ? 0 : 1, snapshots: new Map(),
      });
      if (!isLive(bt) || typeof bt.stepper !== 'function' || !isLive(pokemon)) {
        return walkover((lead?.level ?? topLevel()) >= (enc.level ?? 5));
      }
      const wildSpecies = enc.sheet ?? pokemon.species(enc.species);
      if (!lead || !wildSpecies) return walkover(false);

      const combatantOf = (m) => bt.makeCombatant({
        species: m.species, level: m.level, ivs: m.ivs, shiny: m.shiny,
        // The party's REAL moves, PP and current HP — a fight that started from full health
        // every time would make attrition, and the items that answer it, meaningless.
        moves: m.moves?.length ? m.moves.map((x) => ({ ...x })) : undefined,
        hp: m.hp, status: m.status, instanceId: m.instanceId,
      });

      const ally = combatantOf(lead);
      const wild = bt.makeCombatant({
        species: wildSpecies, level: enc.level, ivs: enc.ivs, shiny: enc.shiny,
      });

      /**
       * The live HP/PP/status **every** party member actually ended the fight with, keyed by
       * `instanceId` — the one field on an instance that is minted once and never recomputed
       * (src/pokemon/index.js). `writeBack` reads this instead of the combatant objects handed
       * to `bt.stepper()`: those are the *starting* snapshots (`combatantOf()`'s own return
       * value) and `battle/engine.js` never mutates them — every turn clones a fresh `state.a`/
       * `state.b` (`cloneSide`) and reassigns, so a plain `[ally, ...swapped-in]` array frozen
       * at each member's OWN entry would forever read as that member's HP when it stepped in,
       * never what the fight actually did to it. Two moments give the true final value for
       * everyone who was ever `state.a`: the instant before a fainted one is swapped out
       * (`nextAlly(state)` below — the engine calls it with `state.a` still the fainted
       * member, hp and all) and the instant the whole fight ends (`endFight()`, `state.a` is
       * whoever is left standing, or the last one tried against a stall/loss).
       */
      const snapshots = new Map();
      const sent = new Set([lead.instanceId]);
      /**
       * The duel object `openDuel` is about to return, made visible to `nextAlly` before it
       * exists as a return value. `nextAlly` is a closure defined here, inside `openDuel`, but
       * it only ever RUNS later — once `bt.stepper()` has been handed it below and a turn
       * actually faints somebody — which is after `openDuel` has already returned its result to
       * `begin()`/`resolveFight()`. So there is nothing for `nextAlly` to call `writeBackOne`
       * against unless this module keeps its own handle on the object it is building, set once,
       * right before `return`.
       */
      let duelHandle = null;

      /**
       * The next party member that can still fight. Party order for now; the API puts
       * the matchup rule behind the same hook, so Auto-Lead replaces this function and nothing
       * else moves.
       */
      function nextAlly(state) {
        // The member `state.a` names here is the one that just fainted — record its true
        // final state (hp 0, whatever status/PP it ended with) before it is discarded. This is
        // the ONLY place that HP is ever observed, so a swap that never checked in here would
        // leave that member's write-back reading its starting HP, undoing its own faint.
        if (state?.a?.instanceId) {
          snapshots.set(state.a.instanceId, state.a);
          // **Landed on `pokemon.party()` the instant the swap happens, not at `endFight()`.**
          // `writeBack(duel)` used to run exactly once, at the very end of the whole battle, so
          // a member that fainted and was swapped out here sat in `duel.snapshots` — correct,
          // and completely unread — until the fight finished. Meanwhile `ui/hud.js`'s `read()`
          // only overlays live-combatant hp onto whichever member is `state.a` *right now*, so
          // the fainted member's HUD row kept showing its last-written (pre-fight, full) hp for
          // the rest of the fight. `writeBackOne` against the outgoing member's own instanceId
          // closes that gap the moment it opens.
          writeBackOne(duelHandle, state.a.instanceId);
        }
        if (typeof pokemon.conscious !== 'function') return null;
        // Only members that can still fight AND have not already been out. The second half is
        // what stops a duel cycling one Pokemon back in after it faints.
        const bench = pokemon.conscious().filter((m) => !sent.has(m.instanceId));
        if (!bench.length) return null;
        /**
         * **The matchup decides the swap, not the party order.**
         *
         * `automation.chooseLead` is asked at engagement, which made the
         * brief's lead rule true when a fight *started* and false the moment one *turned*: a
         * member that fainted mid-duel was replaced by whoever happened to be next in line,
         * which on a bad matchup is how a party loses three Pokemon to one wild.
         *
         * It is asked here rather than in `tickDuel` because `nextAlly` is handed to
         * `battle.stepper` and the stepper is drained by `idle` and `offline` too — so the
         * closed-tab replay swaps by the same rule as the watched fight, which is the whole of
         * src/idle/index.js's one-implementation claim applied to a decision instead of to a turn.
         */
        const auto = ctx.get('automation');
        let who = bench[0];
        if (isLive(auto) && typeof auto.duel === 'function') {
          const bt2 = ctx.get('battle');
          const want = auto.duel({
            effectiveness: isLive(bt2) && typeof bt2.effectiveness === 'function' ? bt2.effectiveness : null,
            moveOf: isLive(bt2) && typeof bt2.move === 'function' ? bt2.move : null,
          }).chooseLead(bench, wildSpecies ? { ...wildSpecies, species: wildSpecies.name } : null);
          who = bench.find((m) => m.instanceId === want) ?? bench[0];
        }
        sent.add(who.instanceId);
        // **The party record follows the swap the instant it happens, not after the whole
        // encounter resolves.** Until this call, `pokemon.lead()` — and everything keyed off
        // it: the field sprite (`simulation.rebuildMembers()`), the nameplate name/shiny star
        // (`ui/plates.js`), the balloon speaker — kept showing the fainted leader for the rest
        // of the fight while the engine was already acting on (and choosing moves for) whoever
        // just stepped in. `resolve()`'s own end-of-encounter re-pick (further down this file)
        // is a safety net for the case nothing here already fixed, not the primary path any
        // more.
        const party = typeof pokemon.party === 'function' ? pokemon.party() : [];
        const idx = party.findIndex((m) => m.instanceId === who.instanceId);
        if (idx > 0 && typeof pokemon.setLead === 'function') pokemon.setLead(idx);
        return combatantOf(who);
      }

      /**
       * **The item decisions, injected — and this module is what debits the bag.**
       *
       * `automation` decides *what* to use from pure rules; `battle.applyAction` changes the
       * combatant; neither of them may touch an inventory (src/battle/index.js). So the Action
       * comes back naming an item, and the take happens here, against a `stock` snapshot the
       * hook reads so it can never propose what is no longer there.
       *
       * A quarantined `automation` costs the fight its items and nothing else — `duel()` is
       * reached through `ctx.get` and is not in `needs`, for the same reason `battle` is not.
       */
      const auto = ctx.get('automation');
      const economy = ctx.get('economy');
      const stock = {};
      const restock = () => {
        if (!isLive(economy) || typeof economy.inventory !== 'function') return;
        for (const k of Object.keys(stock)) delete stock[k];
        Object.assign(stock, economy.inventory());
      };
      restock();
      const plan = isLive(auto) && typeof auto.duel === 'function'
        ? auto.duel({ stock, itemOf: (id) => (isLive(economy) ? economy.item?.(id) : null),
          effectiveness: typeof bt.effectiveness === 'function' ? bt.effectiveness : null })
        : null;

      const between = plan?.between
        ? (state) => {
          const acts = plan.between(state) ?? [];
          const paid = [];
          for (const act of acts) {
            // Spend it before it is applied. A `take` that fails means the snapshot was stale,
            // and dropping the action is the right answer — better a turn without a potion than
            // a potion drunk twice.
            if (isLive(economy) && typeof economy.take === 'function'
              && !economy.take(act.item, 1, 'battle')) continue;
            stock[act.item] = Math.max(0, (stock[act.item] ?? 0) - 1);
            paid.push(act);
          }
          return paid;
        }
        : null;

      const run = bt.stepper(ally, wild, seed, enc.index, { nextAlly, between });
      duelHandle = { engine: true, run, ally, wild, snapshots, win: null, turns: 0, transcript: [], hpFraction: 1 };
      return duelHandle;
    }

    /**
     * Writes back what one member's own snapshot says the fight cost it, through `pokemon`'s
     * published API — the ledger of HP and PP belongs to the creature's owner, not to the
     * module that staged the encounter.
     *
     * Reads `duel.snapshots.get(instanceId)` — the live per-`instanceId` state `openDuel`'s
     * `nextAlly` and `endFight` (below) record as the fight actually happens — rather than the
     * combatant objects `bt.stepper()` was originally handed. Those never change: `battle/
     * engine.js` clones a fresh `state.a`/`state.b` every turn (`cloneSide`) and never mutates
     * its input, so a snapshot frozen at "what this member looked like when it stepped in"
     * reads as that member's STARTING hp forever — which is exactly why the party used to come
     * out of every hunt fight undamaged, no matter what happened inside it.
     *
     * Split out of `writeBack(duel)` below so `nextAlly` can call it on ONE instance — the
     * member it is swapping out — the instant that swap happens, rather than wait for
     * `writeBack`'s own once-per-fight call at `endFight()`. Waiting until then is what left a
     * fainted, swapped-out member's `pokemon.party()` record (and therefore its HUD row,
     * `ui/hud.js`'s `read()` only overlays live-combatant hp onto whoever is `state.a` right
     * now) reading its pre-fight, full hp for the rest of the fight it had already lost.
     */
    function writeBackOne(duel, instanceId) {
      const pokemon = ctx.get('pokemon');
      if (!duel?.engine || !isLive(pokemon)) return;
      const c = duel.snapshots?.get(instanceId);
      if (!c) return;
      const party = typeof pokemon.party === 'function' ? pokemon.party() : [];
      const inst = party.find((m) => m.instanceId === c.instanceId);
      if (!inst) return;
      const lost = Math.max(0, inst.hp - c.hp);
      if (lost > 0 && typeof pokemon.damage === 'function') pokemon.damage(inst.instanceId, lost);
      else if (c.hp > inst.hp && typeof pokemon.heal === 'function') {
        // An item was used mid-fight. Heal by the difference rather than setting HP, so the
        // instance stays the authority on its own maximum.
        pokemon.heal(inst.instanceId, { hp: c.hp - inst.hp, status: false, revive: c.hp > 0 && inst.hp <= 0 });
      }
      if (Array.isArray(inst.moves)) {
        for (const slot of inst.moves) {
          const spent = c.moves.find((m) => m.id === slot.id);
          if (spent) slot.pp = Math.max(0, Math.min(slot.maxPp ?? spent.maxPp, spent.pp));
        }
      }
      if (c.status !== undefined) inst.status = c.status;
    }

    /**
     * Writes back what the fight cost **every** member it sent out, through `pokemon`'s
     * published API — a thin loop over `writeBackOne` above, kept as its own entry point
     * because `endFight()` (below) still wants "every snapshot, in one call" for whoever is
     * left standing when the fight resolves, which is the one snapshot `nextAlly` never took
     * because nothing swapped it out.
     */
    function writeBack(duel) {
      if (!duel?.engine) return;
      for (const c of duel.snapshots?.values() ?? []) writeBackOne(duel, c.instanceId);
    }

    /**
     * Runs a whole fight in one call, for the callers that cannot watch one.
     *
     * `autoResolve` uses it as a **pure probe** — `encounter/showcase.js findIndex` runs it up
     * to four hundred times to search the index space for an encounter worth photographing, and
     * a probe reads the world without changing it. So this never writes back and never emits.
     */
    function resolveFight(lead, enc) {
      const duel = openDuel(lead, enc);
      if (!duel.engine) return duel;
      while (!duel.run.over) duel.run.step();
      const st = duel.run.state;
      const over = st.over;
      return {
        ...duel,
        win: over ? st.winner === 'a' : st.a.hp / st.a.maxHp >= st.b.hp / st.b.maxHp,
        turns: st.turn,
        hpFraction: st.b.maxHp > 0 ? st.b.hp / st.b.maxHp : 1,
        transcript: [],
      };
    }

    function begin(enc) {
      if (!enc) return null;
      // **Nothing to fight with, nothing to fight.** The slot trigger already checks this, but
      // the tall-grass path did not — and a wiped party kept starting encounters and losing
      // them, thirty-six in a row, one turn each.
      const roster = ctx.get('pokemon');
      if (isLive(roster) && typeof roster.firstConscious === 'function' && !roster.firstConscious()) return null;
      if (active) flee();
      endScene();

      const lead = leadOf();
      // **The fight is opened, not run.** `battle.stepper` is stepped one turn at a time by
      // `advanceScene` below, so the player watches the exchange rather than reading its
      // result. `win` is `null` until somebody faints, and every reader has to
      // treat that as "not decided yet" — `attempt()` in particular refuses on anything that
      // is not `true`.
      const duel = openDuel(lead, enc);
      active = {
        ...enc,
        duel,
        battle: {
          engine: duel.engine, win: duel.engine ? null : duel.win,
          turns: 0, transcript: [], hpFraction: duel.hpFraction,
          ally: duel.ally?.species ?? lead?.species?.name ?? null,
        },
        hpFraction: duel.hpFraction,
        turn: 0,
        startedAt: Number(ctx.clock?.simTime ?? 0),
      };
      last = { ...active, outcome: null, ball: null, odds: null, roll: null };

      if (duel.engine) {
        bus.emit('battle:started', {
          index: enc.index, ally: duel.ally.species, wild: duel.wild.species, level: enc.level,
          moves: duel.ally.moves.map((m) => m.id),
        });
      }

      const at = stageCell(enc.slotCell ?? null);
      const sim = ctx.get('simulation');
      const trainer = isLive(sim) ? sim.player?.() : null;
      // **Mutual facing, once, at the moment the fight is staged.** The wild already turned to
      // face the lead inside `stageCell()`; this is the other half — the party's own lead
      // turns to face the wild's staged cell, so the fight opens with both sides looking at
      // each other instead of the lead still facing whichever way the walk happened to leave
      // it. A stationary turn (`line.turn`, `simulation.face`), not a step — the battle is
      // staged where everyone already stands.
      if (isLive(sim) && typeof sim.face === 'function' && typeof sim.followerCell === 'function') {
        const lead = sim.followerCell();
        if (lead) sim.face(dirTo(lead.cx, lead.cz, at.cx, at.cz));
      }
      scene = {
        step: 0, stage: 'meet', at, wildActor: 0, coverY: coverHeightAt(at.cx, at.cz),
        /**
         * The map NPC this fight inherited, still standing on `at` — `0` for an encounter with
         * no slot behind it.
         *
         * It is **not** retired here. `hunts.takeSlot` hands the body over rather than deleting
         * it and this module removes it only once `showWild` has landed its own
         * actor on the same cell, so the creature never blinks out and back in.
         */
        npcId: Number.isFinite(enc.npcId) ? enc.npcId : 0,
        // The duel's clock. `nextTurnAt` is when the next turn may be drawn from the
        // engine; `fightEndsAt` stays `Infinity` until somebody faints, which is what `marks()`
        // reads to know whether the throw window has opened yet. `turnPlan` is the current
        // turn's strikes timed out by `planBeats` — `null` between turns, and
        // while it holds entries `tickDuel` drains one per due tick rather than asking the
        // engine for a new turn.
        nextTurnAt: T.OPEN, fightEndsAt: Infinity, strikes: [], turnsSeen: 0,
        turnPlan: null, turnPlanAt: 0, turnCursor: 0, turnOver: false,
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
      // `if (scene)`: a `cancel()` racing this promise (a travel out mid-fetch) already leaves
      // whatever `showWild` spawns unclaimed — pre-existing, not touched here; a leaked actor
      // costs a sprite slot, not correctness; the asynchronous spawn can still race cancellation.
      scene.ready = showWild(active, at).then((id) => {
        if (scene) { scene.wildActor = id; scene.headLift = headLiftOf(id); }
        // The handover, in this order and not the other one: the map's creature leaves the
        // walker's cast only now that this module's actor is drawn on the cell it was standing
        // on. Unconditional even when `showWild` failed (it answers 0 at `warn`) or `scene` is
        // already gone: a wild left in the cast would be refilled over 26 s later and stand
        // inside its own replacement, and a failed spawn is a wild with no visible body either
        // way — the pre-existing gap `showWild` already had, not a new one.
        retireNpc();
        return id;
      });

      // The party stops to fight. It keeps its place in the loop, so the lap continues from
      // where it was interrupted rather than starting again.
      const walker = ctx.get('simulation');
      if (isLive(walker) && typeof walker.pause === 'function' && !config.showcase) walker.pause(true);

      bus.emit('encounter:started', {
        species: active.species, level: active.level, shiny: active.shiny, biome: active.biome,
        // Extras beyond src/core/bus.js's fixed four. `collection` reads none of them and everything
        // ignores what it does not know, but the bus spy is the screenshot log's only record
        // of what happened and an index it cannot see is an index nobody can replay.
        index: active.index, tod: active.tod, ivs: active.ivs, catchRate: active.catchRate,
        slot: Number.isFinite(active.slot) ? active.slot : null,
        // The map this was met on (P5 item 9) — a strict superset of `biome`'s table id, and
        // what `collection` now stores as a caught Pokemon's origin instead of the table id,
        // so its provenance survives a table being renamed or shared between maps.
        mapId: active.mapId ?? null,
      });

      // **No "A wild X appeared!" line.** It was the caption on a cutscene that no longer
      // happens: the creature was on the map, the party walked to it, and a banner announcing
      // an arrival would be describing something the player just watched not happen. What names
      // it now is the plate over its head.
      return active;
    }

    /**
     * Throws a ball. **Returns a boolean** — `automation` does
     * `const ok = encounter.attempt(pick.ball)` and reports `ok ? 'caught' : 'missed'`, so
     * anything object-shaped here would read as a catch every single time. The detail goes
     * on `last()`.
     */
    function attempt(ball = null) {
      // **A ball is illegal until the wild is beaten** (src/encounter/index.js). It used to be
      // legal on turn one because a battle was a coin flip resolved before the animation
      // started; now the exchange is a real fight and a Pokemon that just won it is the one
      // you get to throw at. `automation` moved onto `battle:ended` for this reason — a
      // subscription still firing on `encounter:started` would get `false` forever and its
      // auto-catch would die with no console error at all.
      // **A ball is illegal until the wild is beaten** (src/encounter/index.js). `win` is `null`
      // while the duel is still being stepped, so the test is `!== true` and
      // not `=== false`: a fight in progress is not a fight that was won.
      if (!active) return false;
      if (!active.battle || active.battle.win !== true) return false;
      // **`THROWS_PER_FAINT` is a rule, not a setting.** One ball per defeated wild, so the
      // pity ledger is what closes a grind out and a full bag is not. It used to be true only
      // by accident — `resolve()` cleared `active` at the end of the first throw — and an
      // accident is not something a reader can rely on.
      if ((active.throws ?? 0) >= THROWS_PER_FAINT) return false;
      const economy = ctx.get('economy');
      if (!isLive(economy)) { log.warn('encounter: economy is down, so no ball can be thrown'); return false; }

      const enc = active;
      const id = ball ?? ballId;
      const turn = enc.turn + 1;

      // `economy` spends the ball and reports the odds; it never rolls them.
      const thrown = economy.throwBall(id, ballContext(enc, turn), {
        // The status the fight actually left it in. This was hard-coded to `'none'` until
        // the turn engine, which makes the 2.5x sleep and 1.5x paralysis bonuses in `catchOdds`
        // unreachable from the only place in the game that throws a ball.
        catchRate: enc.catchRate, hpFraction: enc.hpFraction, status: enc.wildStatus ?? 'none',
      });
      if (!thrown?.thrown) {
        bus.emit('ui:toast', { text: `No ${economy.item?.(id)?.name ?? id} left`, kind: 'warn' });
        return false;
      }
      enc.turn = turn;
      enc.throws = (enc.throws ?? 0) + 1;

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
        scene.throwAt = Math.max(scene.step, T.OPEN + T.READY);
      }

      if (caught) {
        // src/core/bus.js's payload plus the level, the ball and the IVs this module rolled. `collection`
        // pairs this with the `encounter:started` above and takes the IVs rather than
        // inventing its own.
        bus.emit('catch:succeeded', {
          instanceId: enc.instanceId, species: enc.species, shiny: enc.shiny,
          level: enc.level, ivs: enc.ivs, ball: id, biome: enc.biome, index: enc.index,
        });
      } else {
        // NOT in src/core/bus.js's table. Emitted anyway because a failed catch is half of what this
        // module does and `ui`, `automation` and a future ball-counter all want it; filed in
        // src/core/bus.js so the table can catch up. Nothing subscribes today, so nothing breaks.
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
     * This is src/encounter/index.js's "battles are **resolved**, not turn-by-turn" doing the
     * work: `begin()` already ran the exchange against the lead's level, so the outcome is
     * decided, paid and reported here — the same numbers `autoResolve` would have given the
     * idle layer for the same index. It is *not* auto-catch: no ball is spent and nothing
     * enters the dex, because src/automation/index.js puts auto-catch in `automation` and says none of its
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
      // as **win**: the readout printed
      // `outcome (decided at the throw): win` directly under `roll 0.865422 >= 0.388403` and
      // `shakes 0`. A ball was thrown and it broke out, so the word is `escaped`; only an
      // encounter nobody threw at reports the battle's verdict, which is all it has.
      last = { ...(last ?? enc), outcome: caught ? 'caught' : (ball ? 'escaped' : outcome), ball, rewards, battleOutcome: outcome };

      const economy = ctx.get('economy');
      if (isLive(economy) && rewards.money > 0) economy.add?.('money', rewards.money, 'battle');

      // **The experience a won fight is worth, finally paid to the Pokemon that won it.**
      // `source: 'hunt'` is what lets the evolution it may unlock be taken at all — the rule
      // lives at one point, in `pokemon.grantExp`. Kept outside the `if` (defaulting to 0) so
      // `encounter:resolved`'s own payload can carry the REAL amount granted — a different,
      // smaller number than `rewards.exp` (`rewardsFor()`'s own generic scaled figure, used
      // for the money/XP chip today) — for the drop tooltip's Pokémon-XP line to read
      // (`ui/dom/feed.js`).
      const pokemon = ctx.get('pokemon');
      const bt = ctx.get('battle');
      let pokemonExp = 0;
      if (win && isLive(pokemon) && typeof pokemon.grantPartyExp === 'function') {
        const wild = enc.sheet ?? pokemon.species?.(enc.species);
        pokemonExp = isLive(bt) && typeof bt.expYield === 'function' && wild
          ? bt.expYield(wild.baseExp, enc.level)
          : Math.max(1, Math.round((enc.level ?? 5) * 6));
        pokemon.grantPartyExp(pokemonExp, { source: 'hunt' });
      }

      // **A fainted lead steps aside, and a fainted party loses the hunt.**
      //
      // The duel itself already swapped: `battle.stepper`'s `nextAlly` sends the next conscious
      // member out mid-fight, so by the time this runs the party is either usable or wiped
      //. What is left here is the bookkeeping — put a conscious member at the
      // front for the next engagement — and the consequence, which until now was a single
      // `log.warn` and a toast suggesting a Pokemon Center the game would never take you to.
      if (isLive(pokemon) && typeof pokemon.party === 'function') {
        const party = pokemon.party();
        const next = party.findIndex((m) => m.hp > 0);
        if (next > 0) pokemon.setLead(next);
        if (next < 0) wipe(enc); else faintedNagged = false;
      }

      // **The loot.** Pure and index-addressed, so a hunt replayed by `offline` produces the
      // same haul as the one that was watched. It is the only way the twelve `treasure` items
      // enter the bag — they have shipped with sell prices and no source since `economy` was
      // written — and it is what an evolution is paid for with.
      if (win) {
        const loot = dropsFor(seed, enc.index, {
          // The species' own record, so its table is its own. `sheet` is what
          // `rollIndex` already resolved, so this costs no lookup and no new plumbing.
          species: enc.sheet ?? null,
          biome: enc.biome, catchRate: enc.catchRate, level: enc.level, shiny: enc.shiny,
        });
        if (loot.length && isLive(economy) && typeof economy.give === 'function') {
          for (const drop of loot) economy.give(drop.id, drop.n, 'drop');
          // The one drop summary is the encounter feed card (`ui/dom/feed.js`, listening for
          // this same event) — a second, item-only "Found …" toast duplicated it and was the
          // one the user asked removed; the feed card is index-correlated and richer (XP,
          // gold, pity), so it is the summary kept.
          bus.emit('drop:collected', { items: loot, index: enc.index });
        }
      }

      // The walk resumes wherever it stopped. `pause` and not `halt`, so a scripted loop keeps
      // its place in the circuit rather than restarting it (src/simulation/index.js).
      const sim = ctx.get('simulation');
      if (isLive(sim) && typeof sim.pause === 'function') sim.pause(false);

      bus.emit('encounter:resolved', {
        outcome, species: enc.species, rewards, pokemonExp,
        caught: !!caught, ball, level: enc.level, shiny: enc.shiny,
        biome: enc.biome, index: enc.index, turns: enc.turn,
      });
    }

    /**
     * The party is out cold: pay the toll and go home.
     *
     * **The hop is not done from here.** This runs inside `resolve()`, which runs inside
     * `advanceScene()`, which runs inside `tick()` — and `travel.go()` is asynchronous,
     * serialised behind a `busy` flag, and itself calls `encounter.cancel()` and
     * `simulation.halt()`. Re-entering it from inside the encounter it is cancelling is how a
     * deadlock gets written. So this pays, heals, and emits: `travel` listens for
     * `party:wiped` and does the hop on the next frame (src/core/bus.js).
     *
     * The money is spent before the heal so the toast can name both, and the ten per cent is of
     * the balance **now** — which is exact rather than approximate, because a closed tab mints
     * no currency and there is nothing in flight to disagree with.
     */
    function wipe(enc) {
      faintedNagged = false;
      const economy = ctx.get('economy');
      const pokemon = ctx.get('pokemon');
      let lost = 0;
      if (isLive(economy) && typeof economy.balance === 'function') {
        lost = Math.floor((economy.balance('money') ?? 0) * WIPE_PENALTY);
        if (lost > 0) economy.spend?.('money', lost, 'wipe');
      }
      if (isLive(pokemon) && typeof pokemon.reviveAll === 'function') pokemon.reviveAll();
      bus.emit('party:wiped', {
        biome: enc?.biome ?? biomeNow(), index: enc?.index ?? null, moneyLost: lost,
      });
      if (!config.showcase) {
        bus.emit('ui:toast', {
          text: lost > 0
            ? `Your party was wiped out. You paid ₽${lost.toLocaleString('en-GB')} at the Pokémon Center.`
            : 'Your party was wiped out. The Pokémon Center patched everyone up.',
          kind: 'warn',
        });
      }
    }

    /**
     * What `economy` needs to evaluate a conditional ball. Every field here is read by at
     * least one of the eighteen: `species` by Net (types), Fast (base Speed) and Heavy
     * (weight), `level` by Nest, `partyLevel` by Level, `tod` by Dusk, `tags` by Dusk and
     * Dive (P5: these used to read `biome` as an identity string against a fixed 5-entry
     * enum — `economy/items.js` now checks a category tag instead, since two differently
     * named maps could both be caves), `turn` by Quick and Timer, `caught` by Repeat.
     */
    function ballContext(enc = active, turn = (active?.turn ?? 0) + 1) {
      const collection = ctx.get('collection');
      const caughtBefore = isLive(collection) ? !!collection.caught?.(enc?.species) : false;
      return {
        species: enc?.sheet ?? null,
        level: enc?.level ?? 1,
        biome: enc?.biome ?? biomeNow(),
        tags: enc?.tags ?? tagsNow(),
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
     * — the Pokemon walks in front, so it is what meets the grass first.
     * That is the entire reason the event exists, and this is its only consumer.
     */
    const off = [
      bus.on('player:enteredTile', ({ cx, cz }) => {
        if (!armed || frozen || active || scene) return;

        // **The only way a wild Pokemon is met.** A hunt walks a closed loop past fixed spawn
        // slots, steps off it to reach an occupied one, and fights the creature standing there
        // (src/hunts/index.js). There is no second path: the tall-grass step roll that used
        // to spawn a Pokemon out of nowhere on any cell tagged `tallgrass` is gone, everywhere,
        // and with it the city's own spawn table. Nothing in this game appears from nothing.
        const slot = slotNear(cx, cz);
        if (slot) engage(slot);
      }),
      // A new map is a new biome and a new table; the memo is keyed on both, but the level
      // band moves with the party and the cached expansion does not carry it, so this is
      // just hygiene: drop everything and let it rebuild on the next roll.
      bus.on('world:loaded', () => tableCache.clear()),
    ];

    // ---------------------------------------------------------------- api

    const api = {
      // --- src/encounter/index.js -------------------------------------------------------------
      /**
       * The weighted species table, **weight-expanded into a plain `string[]`** so a uniform
       * pick from it is the weighted pick. `idle`, `offline` and `automation` all index it
       * directly; see the header of `tables.js` for why that shape and not `{name, weight}`.
       */
      tablesFor(biome = biomeNow(), tod = todNow()) { return tableFor(biome, tod).table; },
      begin,
      attempt,
      flee,
      /**
       * The idle path: a resolved battle with no UI, as a pure function of state and seed
       * (src/encounter/index.js). Keyed to the **lead's level** and not to summed party power — the encounter table
       * measured that a full bench made every encounter a foregone win at 97 %.
       */
      autoResolve(enc, lead = null) {
        if (!enc) return { outcome: 'flee', species: null, rewards: { money: 0, exp: 0 } };
        const index = Number.isFinite(enc.index) ? enc.index : encounters;
        // The SAME engine the visible fight runs, so a battle resolved with nobody watching is
        // the battle that would have been watched. `fight` degrades to a level
        // comparison when `battle` is quarantined, which is the only place the old
        // `resolveBattle` shape survives — and it survives as a fallback, not as a second
        // model of combat.
        const who = Number.isFinite(lead) ? { level: lead } : (lead ?? leadOf());
        const battle = resolveFight(who, { ...enc, index, level: enc.level ?? 5 });
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
       * `{ steps, encounters }`.
       *
       * `steps` no longer moves: it counted cells of tall grass the lead had walked, and
       * indexed the "is there one?" roll that the spawn-slot model removed. It is kept in the shape,
       * and in the save slice, so an existing document still loads — reading a number nobody
       * writes is harmless, and a slice key that vanished would need a migration for nothing.
       */
      progress: () => ({ steps, encounters }),
      seed: () => seed,

      // --- state ------------------------------------------------------------
      active: () => active,
      last: () => last,
      scene: () => (scene ? {
        stage: scene.stage, step: scene.step, shake: scene.shake,
        // The duel's own clock, so a card or a showcase can say how far into the fight it is
        // without reaching into the stepper.
        turns: scene.turnsSeen, fighting: !Number.isFinite(scene.fightEndsAt),
        // Where the wild is standing, so `ui` can hang a callout over it without reaching in.
        at: { cx: scene.at.cx, cz: scene.at.cz, y: scene.at.y },
        // How far above its feet its head is, **measured off the actor** rather than guessed
        // (`headLiftOf`): `ui` hangs a plate and a balloon off this and must not re-derive a
        // sprite's world height from a texel count of its own.
        headLift: scene.headLift,
      } : null),
      /**
       * Stages one strike at an exact phase and holds it — the showcase tool for the VFX.
       *
       * `advanceToStage` can freeze the *encounter's* beats because they are a function of
       * `scene.step`; a strike's effect is a function of which move happened to be chosen on
       * which turn, which is not something a screenshot can ask for. So this asks directly: a
       * shape, a type and a phase in `[0,1]`, played between whoever is standing there.
       *
       * A showcase tool and nothing else — it draws an effect without a fight behind it, which
       * is exactly what makes the eighteen palettes and three deliveries photographable at
       * three times of day rather than only reachable by waiting for the right move
       *.
       */
      stageStrike({ shape = 'contact', type = 'normal', phase = 0.25, crit = false, effectiveness = 1 } = {}) {
        const sim = ctx.get('simulation');
        const head = isLive(sim) ? sim.followerCell?.() : null;
        const target = scene?.at ?? (head ? { cx: head.cx, cz: head.cz - 2, y: 0 } : { cx: 0, cz: 0, y: 0 });
        const mine = head
          ? { x: head.cx + 0.5, y: surfaceAt(head.cx, head.cz), z: head.cz + 0.5 }
          : { x: target.cx + 0.5, y: target.y ?? 0, z: (target.cz ?? 0) + 2.5 };
        const theirs = { x: (target.cx ?? 0) + 0.5, y: target.y ?? 0, z: (target.cz ?? 0) + 0.5 };
        strikeVfx.play({ shape, type, from: mine, to: theirs, crit, effectiveness });
        strikeVfx.phase(phase);
        frozen = true;
        return { shape, type, phase, from: mine, to: theirs };
      },

      /** The blows of the exchange being drawn right now — what `battle:strike` just carried. */
      strikes: () => (scene?.strikes ?? []).map((x) => ({ ...x })),
      /** One ball per defeated wild, and the wipe's toll. Rules, not settings. */
      THROWS_PER_FAINT,
      WIPE_PENALTY,
      /**
       * Whether the "!" bubble is on screen right now.
       *
       * Published because a claim about a picture has to be checkable from the shot's own
       * JSON log, not from reading the source: the showcase prints it into `ctx.log.info`,
       * which the harness captures alongside the PNG.
       */
      /**
       * Re-fits the airborne ball to the camera. Driven by the module's `lateFrame` hook; see
       * `ball.js` `refit()` for why it cannot be done once at placement time. `strikeVfx` has
       * no equivalent method any more: its meshes billboard by construction,
       * adding their local offset in view space rather than copying a camera quaternion, so
       * there is nothing here left for a per-frame call to do.
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
      /**
       * The odds a given ball would have right now, without spending one.
       *
       * **Through `oddsWithPity`, not `catchOdds`.** What `attempt()` actually rolls against
       * is the pity-floored number (`economy.throwBall` credits the ledger and then floors),
       * so a panel reading the raw formula would print one percentage and the ball would obey
       * another. The floor is taken at the *current* sum — the ball about to be thrown has not
       * been credited yet, which is exactly what "without spending one" means.
       */
      oddsFor(id, enc = active, turn = (active?.turn ?? 0) + 1) {
        const economy = ctx.get('economy');
        if (!isLive(economy) || !enc) return 0;
        const opts = {
          ball: id, catchRate: enc.catchRate, hpFraction: enc.hpFraction,
          status: 'none', context: ballContext(enc, turn),
        };
        if (typeof economy.oddsWithPity === 'function') {
          return economy.oddsWithPity(opts, enc.species)?.odds ?? 0;
        }
        return economy.catchOdds?.(opts) ?? 0;
      },

      // --- reporting --------------------------------------------------------
      tables: () => summary(),
      rows: (biome = biomeNow(), tod = todNow()) => tableFor(biome, tod).table.rows,
      band: () => levelBand(topLevel()),
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
       * the queued-attempt implementation and unreachable in practice, because `attempt()` always queued; now that
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
       *
       * `'ready'` targets `scene.fightEndsAt + f * T.READY` and not a fixed offset from the
       * scene's start, because a duel's length is not fixed (a revive or a
       * bench swap can run it well past its first turn) — a constant baseline here was already
       * wrong before this file had a `'meet'` stage, it simply had nothing exercising it to say
       * so: no `STOP` mode and no test calls `advanceToStage('ready', …)` today, and the
       * `Number.isFinite(target)` guard below is what would have caught a mistake here.
       */
      advanceToStage(stage, frac = 0.5) {
        if (!scene) return null;
        const m = marks(scene);
        const f = Math.max(0, Math.min(1, frac));
        const shakeSpan = Math.max(0, scene.shakes) * T.SHAKE;
        const target = Math.round(
          stage === 'meet' ? f * T.OPEN
            : stage === 'ready' ? scene.fightEndsAt + f * T.READY
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
      /**
       * The three pure functions `idle` and `offline` need, handed over as a bundle.
       *
       * **Injected through `state`, never deep-imported** (seam rule 2 bans reaching past a
       * module's index). This is what closes the core request filed at the head of this file:
       * src/encounter/index.js and src/idle/index.js promise a seed and an index give the same encounter live or offline, and
       * before this they did not — `accrual.js` rolled its own species from its own stream with
       * its own level band, so index 400 was a different Pokemon in the two paths.
       *
       * `resolve` runs `resolveFight()`: the same turn engine the visible fight
       * uses, with the HP writeback and the bus emits off, because a closed-tab replay must not
       * hospitalise a party that is not there.
       */
      pure: () => ({
        rollAt: (index, opts = {}) => rollIndex(index, opts),
        resolve: (enc, index) => {
          const out = resolveFight(leadOf(), { ...enc, index: index ?? enc.index });
          return { win: out.win, turns: out.turns, hpFraction: out.hpFraction };
        },
        /**
         * The fold's loot. It is handed a species **name** — `accrual.js` holds what
         * `rollAt` returned and cannot reach `pokemon` (seam rule 2) — so the record is
         * resolved here, where there is a `ctx`, and the pure function stays pure.
         */
        dropAt: (index, opts = {}) => dropsFor(seed, index, {
          species: speciesRecord(opts.species),
          biome: opts.biome ?? biomeNow(), catchRate: opts.catchRate ?? 45,
          level: opts.level ?? 5, shiny: !!opts.shiny,
        }),
      }),

      /** What encounter `index` drops. Pure and index-addressed; `idle` replays it verbatim. */
      dropsFor: (index, opts = {}) => dropsFor(seed, index, {
        species: speciesRecord(opts.species),
        biome: opts.biome ?? biomeNow(), catchRate: opts.catchRate ?? 45,
        level: opts.level ?? 5, shiny: !!opts.shiny,
      }),
      /** The table a species drops from, for a readout that wants the rows and not a roll. */
      dropTableFor: (species, biome = biomeNow(), opts = {}) =>
        dropTableFor(speciesRecord(species), biome, opts),

      /** The last fight's turn-by-turn transcript, for a battle panel to replay. */
      transcript: () => (last?.battle?.transcript ?? []).map((e) => ({ ...e })),

      // --- persistence (src/offline/slices.js, the native seam) --------------------------------
      saveState: () => ({ v: SAVE_VERSION, steps, encounters, ball: ballId }),
      loadState(value) {
        if (!value || typeof value !== 'object') return false;
        // Refuse a newer slice rather than guess at it, and say so at `warn` — a handled
        // path must not spend tools/shots/shoot.js's zero-error budget.
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
        reportSelfTest('encounter', results);
        return { ...summarise(results), results };
      },

      dispose() {
        strikeVfx.dispose?.();
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
   * `lateFrame`, not `frame`: the ball's sprite billboard reads the camera to
   * face it, and the camera does not move until `rig.update()` has run between `frame` and
   * `lateFrame` (`src/main.js`) — `pokemon/index.js`'s own sprites move here for the same
   * reason. Deliberately not an animation hook either way — the moment is driven by `tick` on
   * the fixed step so a frozen scene is a frozen picture.
   */
  lateFrame(dt, alpha, ctx) {
    ctx.get('encounter').refit?.();
  },

  async showcase(mode, ctx) {
    const { showcaseEncounter } = await import('./showcase.js');
    return showcaseEncounter(mode, ctx);
  },

  dispose() {},
};
