/**
 * automation — the idle layer's agency (src/automation/index.js).
 *
 * `idle` decides what a second of play produces. This module decides what the player would
 * have *done* with that second: which encounters are worth fighting, which are worth a
 * ball, which ball, what happens to the eleventh Zubat, and when to go back to the Mart.
 * Six automations, none of them on by default, every one of them driven by rules the
 * player can read, reorder and rewrite.
 *
 *   ops.js           the operator table — the grammar of a rule
 *   fields.js        the fact schema — everything a rule is allowed to ask about
 *   rules.js         validate, compile, evaluate, explain
 *   automations.js   the six automations, as data: prices, actions, settings, defaults
 *   ball.js          the ball optimiser: cost per Pokémon actually caught
 *   engine.js        unlock/enable state, rule storage, cadence, the audit log
 *   selftest.js      the invariants, runnable in Node
 *
 * ## The rule engine is the product
 *
 * A hard-coded list of checkboxes is a day's work and a dead end: every new thing a player
 * wants to express costs a new checkbox, a new save field and a new line in `ui`. So the
 * rules are **data** — `{ field, op, value } → action` trees — and `schema()` publishes
 * every field with its type, unit, range, enum values and the operators legal on it.
 * `ui` renders a field picker, an operator picker filtered by type, and the right value
 * control. It never learns what a Pokémon is.
 *
 * First match wins, top to bottom, so the list order *is* the priority and every decision
 * has exactly one rule to blame. That is what makes the audit log readable and a
 * destructive automation trustworthy.
 *
 * ## Three seams worth understanding
 *
 * **`idle` produces; this module permits.** `idle/accrual.js` resolves wild encounters
 * only when its `auto-battler` flag is set and catches only when `auto-catch` is. Nothing
 * else in the tree ever grants those. So enabling Auto-Hunt here is literally what turns
 * the idle loop from passive income into a hunt, and disabling it turns it back off —
 * including on restore, where this module re-asserts its flags *after* `idle` has loaded
 * its own save slice.
 *
 * **A catch made inside `idle` has to be given a body.** `idle`'s model is pure and
 * chunk-invariant: it reports `gains.catches` as a count and up to eight sample events,
 * and it never creates a Pokémon or emits `catch:succeeded` (that event is emitted by
 * `encounter`). This module is the bridge: it materialises those catches through
 * `collection.deposit()`, which is the same intake path a wild catch takes, so the dex,
 * the boxes and the toasts all behave identically. Catches beyond the sampled events are
 * synthesised from `ctx.rng.fork('automation/catch/<n>')` against the biome's encounter
 * table, with `n` persisted in the save so a reload does not renumber the stream.
 *
 * **The ball policy is advisory on the idle path, and honest about it.** `rollEncounter`
 * decides `caught` from a fixed chance that does not read the bag, so a better ball cannot
 * change the outcome of a catch that has already been resolved. This module therefore
 * *chooses* the ball (and records it on the box entry as provenance) but never spends one
 * for an idle catch — `idle` already debited a capsule. On the foreground path, where a
 * throw is a real event, `encounter.attempt(ballId)` gets the chosen ball. Closing that
 * gap needs one field in `IdleState`; it is written up as a cross-module request rather
 * than faked here.
 */

import {
  AUTOMATIONS, AUTOMATION_IDS, automation, requirementMet, requirementText, KEEP_ORDERS,
} from './automations.js';
import { makeEngine } from './engine.js';
import {
  schemaFor, worldFacts, wildFacts, storedFacts, itemFacts, catchRateFor,
  BIOMES, TYPES, ITEM_CATEGORIES, KINDS,
} from './fields.js';
import { OPERATORS } from './ops.js';
import { chooseBall, rankBalls, evaluatorFrom, DEFAULT_SETTINGS as BALL_DEFAULTS } from './ball.js';
import { betweenFor, leadChoice } from './duel.js';
import { validateRule, kindSchema, describeCondition, MAX_RULES, MAX_LEAVES } from './rules.js';
import { reportSelfTest } from '../core/log.js';

/** Save slice version; `loadState` migrates forward and never backwards. */
const SAVE_VERSION = 1;

/** World facts are rebuilt at most this often, in simulated seconds. */
const WORLD_TTL_S = 0.5;

/**
 * Legacy toggle names the seed API published. Kept because `rules()`/`set()` are a
 * published contract and something may still be calling them.
 */
const LEGACY = Object.freeze({
  autoHunt: 'hunt', autoCatch: 'catch', autoBall: 'ball',
  autoRelease: 'release', releaseDuplicates: 'release', autoSell: 'sell', autoRestock: 'restock',
});

/** The registry's null object answers every property with a function — this is the tell. */
const isLive = (api) => !!api && api.__missing === undefined;

/** Live handle so `tick` and `dispose` do not have to go back through the registry. */
let live = null;

export default {
  id: 'automation',
  needs: ['encounter', 'economy', 'collection'],
  /** Extra modules the showcase scene needs on top of `needs` (src/main.js). */
  showcaseNeeds: ['city', 'terrain', 'idle'],

  init(ctx) {
    const { bus, config, clock, log } = ctx;

    const engine = makeEngine({
      onChange: ({ id, what }) => {
        if (what === 'enabled' || what === 'unlocked' || what === 'restored' || what === 'reset') syncIdle();
        bus.emit('automation:changed', toggleMap());
        if (id) bus.emit('automation:configured', { id, what });
      },
    });

    /** Stream ordinal for synthesised idle catches. Persisted — see the header. */
    let catchOrdinal = 0;
    /** Cheap round-robin so one tick never runs two heavy passes. */
    let cursor = 0;
    /** Lifetime counters this module owns, beyond the per-automation ones. */
    const totals = {
      deposited: 0, synthesised: 0, released: 0, sold: 0, bought: 0,
      releaseValue: 0, sellValue: 0, restockSpend: 0,
      wouldHaveSkipped: 0, ballsChosen: 0,
    };
    /** Rolling record of the last ball decisions, for the panel. */
    const ballLog = [];

    const simTime = () => +(clock?.simTime ?? 0);
    const mod = (id) => ctx.get(id);

    // ---------------------------------------------------------------- world

    let worldCache = null;
    let worldAt = -Infinity;

    /** Everything the shared half of a fact object needs. Rebuilt at most twice a second. */
    function world(force = false) {
      const t = simTime();
      if (!force && worldCache && t - worldAt < WORLD_TTL_S) return worldCache;
      const economy = mod('economy');
      const collection = mod('collection');
      const terrain = mod('terrain');
      const environment = mod('environment');

      const biome = terrain.handle?.()?.biome ?? mod('idle').state?.()?.biome ?? 'meadow';
      const tod = environment.getTimeOfDay?.() ?? config.tod;
      const used = num(collection.count?.(), 0);
      const free = num(collection.free?.(), 0);

      worldCache = worldFacts({
        biome: BIOMES.includes(biome) ? biome : 'meadow',
        tod,
        money: num(economy.balance?.('money')),
        research: num(economy.balance?.('research')),
        bp: num(economy.balance?.('bp')),
        shards: num(economy.balance?.('shards')),
        ballsInBag: ballCount(),
        boxFree: free,
        boxUsed: used,
        boxFull: free <= 0 && used > 0,
        dexCaught: dexCaught(),
      });
      worldAt = t;
      return worldCache;
    }

    const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

    /** Species lookups are hot in a box scan; one map for the session. */
    const speciesCache = new Map();
    function speciesOf(key) {
      const k = String(key ?? '').toLowerCase();
      if (speciesCache.has(k)) return speciesCache.get(k);
      const s = mod('pokemon').species?.(k) ?? null;
      speciesCache.set(k, s);
      return s;
    }

    function ballCount() {
      const economy = mod('economy');
      if (typeof economy.items !== 'function' || typeof economy.count !== 'function') return 0;
      let n = 0;
      for (const def of economy.items((i) => i.category === 'ball')) n += num(economy.count(def.id));
      return n;
    }

    function dexCaught() {
      const c = mod('collection');
      const done = c.completion?.();
      if (done && Number.isFinite(done.caught)) return done.caught;
      const dex = c.dex?.();
      return Array.isArray(dex?.caught) ? dex.caught.length : 0;
    }

    /** Progress snapshot the unlock requirements are checked against. */
    /**
     * The counters an unlock gate is measured against.
     *
     * **It is `economy.progress()` plus this module's own two**, and it was three hand-listed
     * keys before the rule UI was connected. That was fine while every automation gated on `dexCaught` or
     * `stored`; the moment one gated on `battlesWon` it read `undefined || 0` and the gate
     * could **never** open — measured: 21 battles won and `unlock('heal')` still answering
     * *"needs 5 battlesWon (0)"*. Spreading `economy.progress()` means a gate can name any
     * counter the ledger already keeps, and a new one is covered the day it lands.
     *
     * `money` now means **earned**, not the balance. Its own label in `requirementText` has
     * always read "₽ earned", and every money-priced shop gate is measured on `totalEarned` —
     * so a wallet you spent down was quietly re-locking things it had never unlocked. No
     * shipped automation gates on it, so this is a latent mislabel fixed rather than a
     * behaviour change.
     */
    function progress() {
      const economy = mod('economy');
      const p = isLive(economy) && typeof economy.progress === 'function' ? economy.progress() : {};
      return {
        ...p,
        dexCaught: dexCaught(),
        stored: num(mod('collection').count?.(), 0),
        money: num(p.totalEarned, 0),
      };
    }

    // ------------------------------------------------------------ idle sync

    /**
     * Asserts this module's flags on `idle`. Called on every unlock, toggle, restore and
     * `world:loaded` — and deliberately *after* a save restore, because `idle` reloads its
     * own unlock set from the file and whatever it finds there must not outrank the
     * automations the player has switched on now.
     */
    function syncIdle() {
      const idle = mod('idle');
      if (!isLive(idle) || typeof idle.grant !== 'function' || typeof idle.revoke !== 'function') return;
      for (const def of AUTOMATIONS) {
        if (!def.idleUnlock) continue;
        const want = engine.isActive(def.id) && !paused(def.id);
        if (want) idle.grant(def.idleUnlock);
        else idle.revoke(def.idleUnlock);
      }
    }

    /** Settings-level gates that stop an automation without switching it off. */
    function paused(id) {
      const s = engine.settings(id);
      const w = world();
      if (id === 'hunt') return !!s.pauseWhenBoxFull && w.boxFull;
      if (id === 'catch') {
        if (s.stopWhenBoxFull && w.boxFull) return true;
        if (w.ballsInBag <= (s.minBalls ?? 0)) return true;
        return false;
      }
      return false;
    }

    // ------------------------------------------------------------- the ball

    function ballSettings() {
      const s = engine.settings('ball');
      return {
        ...BALL_DEFAULTS,
        oddsFloor: s.oddsFloor, minOdds: s.minOdds, bpWeight: s.bpWeight,
        maxSpend: s.maxSpend, masterFloor: s.masterFloor, hpFraction: s.hpFraction,
        // The player's own ladder, which `decideBall` asks before the optimiser. Listed here
        // rather than spread, because this function is deliberately a whitelist: `ball.js`'s
        // optimiser takes a fixed shape and a stray key from a save would reach it silently.
        mode: s.mode ?? 'simple', ladder: s.ladder ?? [], perSpecies: s.perSpecies ?? {},
        reserve: { masterball: s.reserveMaster ?? 1 },
      };
    }

    /** The context `economy`'s conditional balls (Dusk, Net, Level, Repeat…) read. */
    function ballContext(subject, w) {
      const party = mod('pokemon').party?.() ?? [];
      const partyLevel = party.length ? Math.max(...party.map((p) => p?.level ?? 1)) : 5;
      return {
        species: subject.species ?? null,
        level: subject.level ?? 5,
        partyLevel,
        tod: w.tod,
        biome: w.biome,
        turn: subject.turn ?? 1,
        caught: !subject.newSpecies,
        fishing: false,
      };
    }

    /**
     * Chooses a ball for one wild subject: the rule engine assigns a tier, the optimiser
     * in `ball.js` reads the whole ball line and picks.
     * @returns {Object|null} null when no policy is active
     */
    function decideBall(subject, { force = false } = {}) {
      const economy = mod('economy');
      if (!isLive(economy)) return null;
      if (!engine.isActive('ball') && !force) return null;
      const w = world();
      const facts = wildFacts(subject, w);
      const tier = engine.isActive('ball') ? engine.compiled('ball').evaluate(facts).action : 'value';
      const settings = ballSettings();

      /**
       * **The player's ladder is asked first, and it is a preference rather than an override.**
       *
       * The brief asks for a chosen first, second and third ball, per species in Advanced mode —
       * and for a fallback to "the best available option" when the preferred one is not there.
       * So: walk the ladder, take the first ball actually in the bag, and if none of them is,
       * fall through to the cost-per-catch optimiser that was here before. A ladder therefore
       * never makes the choice *worse* than not having one.
       */
      const ladder = settings.mode === 'advanced'
        ? (settings.perSpecies?.[facts.species] ?? settings.ladder ?? [])
        : (settings.ladder ?? []);
      for (const id of ladder) {
        if (num(economy.count?.(id), 0) <= 0) continue;
        totals.ballsChosen++;
        const odds = num(economy.catchOdds?.({
          ball: id, catchRate: facts.catchRate,
          hpFraction: subject.hpFraction ?? settings.hpFraction,
          status: subject.status ?? 'none', context: ballContext(subject, w),
        }), 0);
        const chosen = { ball: id, odds, expected: null, cost: null, tier, why: 'your ladder', table: [], considered: ladder.length };
        ballLog.push({
          at: simTime(), species: facts.species, level: facts.level, shiny: facts.shiny,
          tier, ball: id, odds, expected: null, why: 'your ladder',
        });
        if (ballLog.length > 60) ballLog.shift();
        return chosen;
      }

      const pick = chooseBall(
        evaluatorFrom(economy),
        {
          catchRate: facts.catchRate,
          hpFraction: subject.hpFraction ?? settings.hpFraction,
          status: subject.status ?? 'none',
          context: ballContext(subject, w),
        },
        tier,
        settings,
      );
      totals.ballsChosen++;
      ballLog.push({
        at: simTime(), species: facts.species, level: facts.level, shiny: facts.shiny,
        tier, ball: pick.ball, odds: pick.odds, expected: pick.expected, why: pick.why,
      });
      if (ballLog.length > 40) ballLog.shift();
      return pick;
    }

    // -------------------------------------------------- wild subject facts

    /** Builds the subject a `wild` rule is evaluated against. */
    function wildSubject({ species, level, shiny, hpFraction, turn }) {
      const collection = mod('collection');
      const economy = mod('economy');
      const s = typeof species === 'object' ? species : speciesOf(species);
      const name = s?.name ?? String(species ?? '').toLowerCase();
      const owned = num(collection.owned?.(name), 0);
      const everCaught = collection.caught?.(name) === true || owned > 0;
      const value = isLive(economy) && typeof economy.appraise === 'function'
        ? (economy.appraise({ level, shiny, species: s ?? { baseStats: {} } })?.money ?? 0) : 0;
      return {
        species: s ?? { name, types: [], baseStats: {} },
        speciesName: name,
        level: level ?? 5,
        shiny: !!shiny,
        hpFraction,
        turn,
        newSpecies: !everCaught,
        ownedCount: owned,
        value,
        catchRate: catchRateFor(s?.bst),
      };
    }

    // ------------------------------------------------ materialising catches

    /**
     * Turns the catches `idle` reported into Pokémon in the boxes.
     *
     * @param {Object} gains  an `idle:tick` or `offline:applied` gains object
     * @param {string} source 'idle' | 'offline'
     */
    function absorb(gains, source) {
      const count = Math.max(0, Math.round(gains?.catches ?? 0));
      if (!count) return 0;
      const collection = mod('collection');
      if (!isLive(collection) || typeof collection.deposit !== 'function') return 0;

      const w = world(true);
      const biome = gains.biome ?? w.biome;
      const sampled = (gains.events ?? []).filter((e) => e && e.caught && e.species).slice(0, count);

      /** @type {{name:string, level:number, shiny:boolean, synth:boolean}[]} */
      const made = sampled.map((e) => ({
        name: String(e.species).toLowerCase(),
        level: Math.max(1, Math.round(e.level ?? 5)),
        shiny: !!e.shiny,
        synth: false,
      }));

      // The sample is capped at eight; a drained gap can carry more. The rest are rolled
      // from their own persisted stream so a reload cannot renumber them.
      if (made.length < count) {
        const tables = mod('encounter').tablesFor?.(biome, w.tod) ?? [];
        const band = levelBand();
        for (let i = made.length; i < count; i++) {
          const rng = ctx.rng.fork(`automation/catch/${catchOrdinal++}`);
          const name = tables.length ? tables[Math.floor(rng.next() * tables.length)] : null;
          if (!name) break;
          made.push({
            name: String(name).toLowerCase(),
            level: band.min + Math.floor(rng.next() * (band.max - band.min + 1)),
            shiny: rng.next() < 1 / 4096,
            synth: true,
          });
          totals.synthesised++;
        }
      }
      if (!made.length) return 0;

      const specs = [];
      for (const m of made) {
        const subject = wildSubject({ species: m.name, level: m.level, shiny: m.shiny });
        // The catch policy's verdict is recorded even though it cannot change an outcome
        // `idle` has already resolved (see the header). It is the number that says how much
        // the missing seam is costing.
        if (engine.isActive('catch')) {
          const verdict = engine.compiled('catch').evaluate(wildFacts(subject, w));
          if (verdict.action !== 'catch') totals.wouldHaveSkipped++;
        }
        const pick = decideBall(subject);
        specs.push({
          species: m.name, level: m.level, shiny: m.shiny, biome,
          ball: pick?.ball ?? 'pokeball', origin: 'wild',
        });
      }

      // A handful arrive one at a time so the player gets the toast and the `collection:added`
      // event; a drained gap arrives as a silent batch, because 400 toasts is not a feature
      // and the bus spy only keeps 256 events (src/core/bus.js).
      let stored = 0;
      if (specs.length <= 6 || typeof collection.importBatch !== 'function') {
        for (const spec of specs) if (collection.deposit(spec)) stored++;
      } else {
        const added = collection.importBatch(specs, { announce: false }) ?? [];
        stored = added.filter((a) => a?.stored).length;
        bus.emit('ui:toast', { text: `${stored} Pokémon caught while you were away`, kind: 'good' });
      }
      totals.deposited += stored;

      engine.log({
        at: simTime(), automation: 'catch', action: 'deposit',
        subject: `${stored}/${specs.length}`,
        detail: `${source}: ${specs.slice(0, 3).map((s) => s.species).join(', ')}${specs.length > 3 ? '…' : ''}`
          + (stored < specs.length ? ` — ${specs.length - stored} had nowhere to go` : ''),
      });
      worldAt = -Infinity;
      return stored;
    }

    /** The wild level band `idle` uses, so a synthesised catch is not out of place. */
    function levelBand() {
      const party = mod('pokemon').party?.() ?? [];
      const lead = party.length ? Math.max(...party.map((p) => p?.level ?? 1)) : 5;
      return { min: Math.max(2, Math.round(lead * 0.6)), max: Math.max(3, Math.round(lead * 1.15) + 1) };
    }

    // ------------------------------------------------------- release policy

    /** Orders one species' pile so that rank 1 is the one the settings say to keep. */
    function rankPile(list, order) {
      const by = {
        iv: (a, b) => b.ivTotal - a.ivTotal || b.level - a.level || a.ordinal - b.ordinal,
        level: (a, b) => b.level - a.level || b.ivTotal - a.ivTotal || a.ordinal - b.ordinal,
        bst: (a, b) => (b.bst ?? 0) - (a.bst ?? 0) || b.ivTotal - a.ivTotal || a.ordinal - b.ordinal,
        first: (a, b) => a.ordinal - b.ordinal,
        last: (a, b) => b.ordinal - a.ordinal,
      };
      return list.slice().sort(by[order] ?? by.iv);
    }

    /**
     * What auto-release would do to the boxes as they stand. Pure: nothing moves.
     * @returns {{release:Object[], keep:number, value:{money:number, shards:number},
     *            reasons:Object, capped:number, blocked:string|null}}
     */
    function planRelease() {
      const collection = mod('collection');
      const economy = mod('economy');
      const s = engine.settings('release');
      const w = world();
      const entries = isLive(collection) && typeof collection.entries === 'function' ? collection.entries() : [];
      const empty = { release: [], keep: entries.length, value: { money: 0, shards: 0 }, reasons: {}, capped: 0, blocked: null };
      if (!entries.length) return empty;

      const fill = w.boxUsed + w.boxFree > 0 ? (100 * w.boxUsed) / (w.boxUsed + w.boxFree) : 0;
      if (s.requireUnlock > 0 && fill < s.requireUnlock) {
        return { ...empty, blocked: `boxes ${fill.toFixed(0)}% full, rule waits for ${s.requireUnlock}%` };
      }

      const partyUids = new Set();
      for (const p of mod('pokemon').party?.() ?? []) {
        if (p?.instanceId) partyUids.add(String(p.instanceId));
        if (p?.uid) partyUids.add(String(p.uid));
      }

      // One pass to group, one to rank, one to evaluate. Nothing is quadratic.
      const piles = new Map();
      for (const e of entries) {
        let pile = piles.get(e.species);
        if (!pile) piles.set(e.species, (pile = []));
        pile.push(e);
      }

      const ruleset = engine.compiled('release');
      const appraise = isLive(economy) && typeof economy.appraise === 'function' ? economy.appraise : null;
      const now = simTime();
      const release = [];
      const reasons = {};
      let kept = 0;

      for (const [species, pile] of piles) {
        const ranked = rankPile(pile, s.keepOrder);
        const sheet = speciesOf(species);
        for (let i = 0; i < ranked.length; i++) {
          const e = ranked[i];
          const value = appraise
            ? appraise({ level: e.level, shiny: e.shiny, species: sheet ?? { baseStats: {} } }) ?? { money: 0, shards: 0 }
            : { money: 0, shards: 0 };
          const facts = storedFacts(e, w, {
            copies: pile.length,
            rank: i + 1,
            inParty: partyUids.has(String(e.instanceId)) || partyUids.has(String(e.uid)),
            value: value.money,
            ageS: Math.max(0, now - (e.simTime ?? 0)),
          });
          const decision = ruleset.evaluate(facts);
          if (decision.action === 'release') {
            release.push({ entry: e, rank: i + 1, copies: pile.length, value, rule: decision.ruleId, ruleName: decision.ruleName });
          } else {
            kept++;
            const key = decision.ruleId ?? 'default';
            reasons[key] = (reasons[key] ?? 0) + 1;
          }
        }
      }

      // Worst first, so a capped pass gives up the least. Ties break on uid, which is
      // unique and stable, so two runs of the same save release the same Pokémon.
      release.sort((a, b) => b.rank - a.rank || a.value.money - b.value.money || String(a.entry.uid).localeCompare(String(b.entry.uid)));
      const cap = Math.max(1, Math.floor(s.maxPerRun));
      const taken = release.slice(0, cap);
      const value = taken.reduce((acc, r) => ({ money: acc.money + r.value.money, shards: acc.shards + r.value.shards }), { money: 0, shards: 0 });
      return { release: taken, keep: kept, value, reasons, capped: Math.max(0, release.length - taken.length), blocked: null };
    }

    function runRelease() {
      const plan = planRelease();
      if (plan.blocked || !plan.release.length) return plan;
      const collection = mod('collection');
      const refs = plan.release.map((r) => r.entry.uid ?? r.entry.instanceId);
      const result = typeof collection.releaseMany === 'function'
        ? collection.releaseMany(refs)
        : { released: 0, value: { money: 0, shards: 0 } };
      totals.released += result.released ?? 0;
      totals.releaseValue += result.value?.money ?? 0;
      engine.bump('release', 'actions', result.released ?? 0);
      engine.bump('release', 'money', result.value?.money ?? 0);
      for (const r of plan.release.slice(0, 12)) {
        engine.log({
          at: simTime(), automation: 'release', action: 'release',
          subject: `${r.entry.display ?? r.entry.species} lv${r.entry.level}`,
          rule: r.ruleName,
          detail: `#${r.rank} of ${r.copies} · ${((r.entry.ivTotal / 186) * 100).toFixed(0)}% IV · ₽${Math.round(r.value.money).toLocaleString('en-US')}`,
        });
      }
      if ((result.released ?? 0) > 12) {
        engine.log({
          at: simTime(), automation: 'release', action: 'release',
          subject: `+${result.released - 12} more`, detail: 'same pass',
        });
      }
      worldAt = -Infinity;
      return { ...plan, applied: result.released ?? 0 };
    }

    // ---------------------------------------------------------- sell policy

    function planSell() {
      const economy = mod('economy');
      if (!isLive(economy) || typeof economy.inventory !== 'function') return { plan: [], money: 0, capped: 0 };
      const w = world();
      const s = engine.settings('sell');
      const ruleset = engine.compiled('sell');
      const inv = economy.inventory() ?? {};
      const rows = [];
      for (const [id, count] of Object.entries(inv)) {
        const def = economy.item?.(id);
        if (!def || count <= 0) continue;
        /**
         * **The Sell-Lock, and it is checked here rather than in `economy.sell()`.**
         *
         * The brief calls it a lock on *automatic* selling: collectibles, rare loot, crafting
         * materials, anything the player marked. A player standing at the shop counter asking
         * to sell a locked item is not what it protects against, and refusing them there would
         * be a trap — so `economy.sell()` ignores it and this pass does not.
         *
         * Checked before the rules run, so no ruleset can outvote it. That is the same
         * discipline auto-release uses, where seven protective rules sit above the one that
         * releases anything — except a lock is the player's own instruction and does not even
         * get to be reordered.
         */
        if (economy.sellLocked?.(id)) continue;
        const unit = num(economy.sellValue?.(id), 0);
        const facts = itemFacts(def, count, w, { unitValue: unit, price: num(economy.source?.(id)?.price, def.price ?? 0) });
        const decision = ruleset.evaluate(facts);
        if (decision.action !== 'sell') continue;
        const keep = Math.max(0, Math.floor(decision.args?.keep ?? 0));
        const qty = count - keep;
        if (qty <= 0 || unit <= 0) continue;
        rows.push({ id, name: def.name ?? id, qty, unit, money: unit * qty, keep, rule: decision.ruleId, ruleName: decision.ruleName });
      }
      rows.sort((a, b) => b.money - a.money || a.id.localeCompare(b.id));
      const cap = Math.max(1, Math.floor(s.maxPerRun));
      const plan = rows.slice(0, cap);
      return { plan, money: plan.reduce((n, r) => n + r.money, 0), capped: Math.max(0, rows.length - plan.length) };
    }

    function runSell() {
      const { plan, capped } = planSell();
      if (!plan.length) return { plan, money: 0, capped };
      const economy = mod('economy');
      let sold = 0;
      let got = 0;
      for (const row of plan) {
        if (economy.sell?.(row.id, row.qty)) {
          sold += row.qty;
          got += row.money;
          engine.log({
            at: simTime(), automation: 'sell', action: 'sell',
            subject: `${row.qty} × ${row.name}`, rule: row.ruleName,
            detail: `₽${Math.round(row.money).toLocaleString('en-US')}${row.keep ? ` · kept ${row.keep}` : ''}`,
          });
        }
      }
      totals.sold += sold;
      totals.sellValue += got;
      engine.bump('sell', 'actions', sold);
      engine.bump('sell', 'money', got);
      return { plan, money: got, capped, applied: sold };
    }

    // ------------------------------------------------------- restock policy

    function planRestock() {
      const economy = mod('economy');
      if (!isLive(economy) || typeof economy.items !== 'function') return { plan: [], spend: 0, budget: 0, short: [] };
      const w = world();
      const s = engine.settings('restock');
      const ruleset = engine.compiled('restock');
      const money = num(economy.balance?.('money'));
      const budget = Math.max(0, Math.min(money - (s.floor ?? 0), money * (s.budgetFraction ?? 0.25)));

      const rows = [];
      const ruleOrder = new Map(engine.compiled('restock').rules.map((r, i) => [r.id, i]));
      for (const def of economy.items()) {
        const source = economy.source?.(def.id);
        if (!source || !Number.isFinite(source.price)) continue;
        // Only money purchases are automated: spending someone's Battle Points without
        // being asked is exactly the kind of surprise an automation must not spring.
        if ((source.currency ?? 'money') !== 'money') continue;
        const count = num(economy.count?.(def.id), 0);
        const facts = itemFacts(def, count, w, { unitValue: num(economy.sellValue?.(def.id), 0), price: source.price });
        const decision = ruleset.evaluate(facts);
        // A target is its own instruction: an item the player has asked to keep ten of is
        // bought whether or not a rule happens to name it.
        const targeted = Number(s.targets?.[def.id]) > 0;
        if (decision.action !== 'buy' && !targeted) continue;
        /**
         * **A per-item target beats the rule's `upTo`.** The brief asks for "10 Potions, 5
         * Ethers, 20 Poké Balls" as a thing a player sets directly, and a target the player
         * typed is a stronger statement than a default a rule shipped with.
         */
        const target = Number(s.targets?.[def.id]);
        const upTo = Number.isFinite(target) && target > 0
          ? Math.floor(target)
          : Math.max(0, Math.floor(decision.args?.upTo ?? 0));
        const cap = num(economy.capacity?.(def.id), Infinity);
        const want = Math.min(upTo, cap) - count;
        if (want <= 0) continue;
        rows.push({
          id: def.id, name: def.name ?? def.id, price: source.price, want,
          cost: source.price * want, rule: decision.ruleId, ruleName: decision.ruleName,
          order: ruleOrder.get(decision.ruleId) ?? 99,
        });
      }
      /**
       * **Category first, then rule order, then price — and never price first.**
       *
       * The brief is explicit that a budget is spent *Healing, Revival, PP restoration, Poké
       * Balls*, and that Auto-Buy "must not simply purchase the cheapest item first". Rule order
       * alone nearly did that job and could not finish it: three of those four classes are
       * `category: 'medicine'`, so a single rule covering medicine ordered them by price and a
       * thin wallet bought twenty Potions instead of the one Max Potion that would have kept the
       * party standing.
       *
       * `purchaseClass` reads what the item *does* rather than what shelf it is on, and the
       * player can reorder the four. Price still breaks ties inside a class,
       * which is the one place cheapest-first is right.
       */
      const order = Array.isArray(s.categoryOrder) && s.categoryOrder.length
        ? s.categoryOrder : (economy.purchaseOrder?.() ?? ['heal', 'revive', 'pp', 'ball']);
      const classOrder = new Map(order.map((c, i) => [c, i]));
      const classOf = (id) => classOrder.get(economy.purchaseClass?.(id) ?? 'other') ?? 99;
      rows.sort((a, b) => classOf(a.id) - classOf(b.id)
        || a.order - b.order || a.price - b.price || a.id.localeCompare(b.id));

      const plan = [];
      const short = [];
      let spend = 0;
      for (const row of rows) {
        const affordable = Math.min(row.want, Math.floor((budget - spend) / Math.max(1, row.price)));
        if (affordable <= 0) { short.push(row); continue; }
        plan.push({ ...row, qty: affordable, cost: affordable * row.price, partial: affordable < row.want });
        spend += affordable * row.price;
      }
      return { plan, spend, budget, short, money };
    }

    function runRestock() {
      const { plan, budget, short } = planRestock();
      if (!plan.length) return { plan, spend: 0, budget, short };
      const economy = mod('economy');
      let bought = 0;
      let paid = 0;
      for (const row of plan) {
        if (economy.buy?.(row.id, row.qty)) {
          bought += row.qty;
          paid += row.cost;
          engine.log({
            at: simTime(), automation: 'restock', action: 'buy',
            subject: `${row.qty} × ${row.name}`, rule: row.ruleName,
            detail: `₽${Math.round(row.cost).toLocaleString('en-US')}${row.partial ? ' (budget-limited)' : ''}`,
          });
        }
      }
      totals.bought += bought;
      totals.restockSpend += paid;
      engine.bump('restock', 'actions', bought);
      worldAt = -Infinity;
      return { plan, spend: paid, budget, short, applied: bought };
    }

    // ------------------------------------------------------------- the tick

    /** id -> the pass that runs it. Automations with `everyS: 0` are event-driven only. */
    const PASSES = { release: runRelease, sell: runSell, restock: runRestock };
    const SCHEDULED = AUTOMATION_IDS.filter((id) => automation(id).everyS > 0 && PASSES[id]);

    /**
     * One automation at most per tick, and only when its cadence is due. The scan itself
     * is the expensive part, so nothing here scans until something is going to act on it.
     */
    function tick() {
      const t = simTime();
      for (let i = 0; i < SCHEDULED.length; i++) {
        const id = SCHEDULED[(cursor + i) % SCHEDULED.length];
        if (!engine.isActive(id) || !engine.due(id, t)) continue;
        cursor = (cursor + i + 1) % SCHEDULED.length;
        engine.mark(id, t);
        try {
          PASSES[id]();
        } catch (err) {
          engine.bump(id, 'errors');
          log.warn(`automation/${id} pass failed`, err);
        }
        return;
      }
    }

    // ----------------------------------------------------------------- bus

    const off = [
      // The idle layer reports what it produced; this is where a catch gets a body.
      bus.on('idle:tick', (p) => { if (p?.gains) absorb(p.gains, 'idle'); }),
      bus.on('offline:applied', (p) => { if (p?.gains) absorb(p.gains, 'offline'); }),

      // The foreground path: a real encounter, where a real ball is really thrown.
      /**
       * **`battle:ended`, not `encounter:started`**.
       *
       * This used to throw from inside the `encounter:started` emit, on turn one, because a
       * battle was a coin flip already resolved before the animation began. It is a real
       * fight now and a ball is illegal until the wild is beaten — so a subscription still
       * listening on `encounter:started` would call `attempt()`, get `false` forever, and
       * auto-catch would die **with no console error and no failing check**: the pure ball
       * optimiser this module's selftest exercises would keep answering perfectly.
       */
      bus.on('battle:ended', (b2) => {
        if (!b2?.won) return;
        if (!engine.isActive('catch') || paused('catch')) return;
        const mod0 = mod('encounter');
        const p = typeof mod0.active === 'function' ? mod0.active() : null;
        if (!p) return;
        const subject = wildSubject({
          species: p?.species, level: p?.level, shiny: p?.shiny,
          // The HP the fight actually left it on, not an assumption.
          hpFraction: Number.isFinite(b2.hpFraction) ? b2.hpFraction : 1,
          turn: 1,
        });
        const decision = engine.compiled('catch').evaluate(wildFacts(subject, world()));
        if (decision.action !== 'catch') {
          engine.bump('catch', 'skipped');
          return;
        }
        const pick = decideBall(subject, { force: true });
        if (!pick?.ball) return;
        const encounter = mod('encounter');
        if (typeof encounter.attempt !== 'function') return;
        // `encounter` owns the roll *and* the spend (src/encounter/index.js / economy's
        // `throwBall`); this module only names the ball. The seed ignores the argument.
        const ok = encounter.attempt(pick.ball);
        engine.bump('catch', 'actions');
        engine.log({
          at: simTime(), automation: 'catch', action: ok ? 'caught' : 'missed',
          subject: `${subject.speciesName} lv${subject.level}`, rule: decision.ruleName,
          detail: `${pick.name ?? pick.ball} · ${(pick.odds * 100).toFixed(1)}% · ${pick.why}`,
        });
      }),

      bus.on('world:loaded', () => { worldAt = -Infinity; syncIdle(); }),
      bus.on('collection:added', () => { worldAt = -Infinity; }),
    ];

    // ------------------------------------------------------------ unlocking

    /**
     * Buys an automation. Spends research through `economy`; the engine only records that
     * it happened, so there is exactly one place money leaves the wallet.
     */
    function unlock(id) {
      const def = automation(id);
      if (!def) return { ok: false, why: `no automation "${id}"` };
      const gate = engine.canUnlock(id, progress());
      if (!gate.ok) {
        return { ok: false, why: gate.why === 'requirement not met'
          ? `needs ${requirementText(def.unlock.requires, progress())}` : gate.why };
      }
      const economy = mod('economy');
      const { currency, cost } = def.unlock;
      if (!isLive(economy) || typeof economy.spend !== 'function') return { ok: false, why: 'economy unavailable' };
      if (!economy.spend(currency, cost, `unlock:automation:${id}`)) {
        return { ok: false, why: `costs ${cost} ${currency}` };
      }
      engine.markUnlocked(id, true);
      engine.log({ at: simTime(), automation: id, action: 'unlock', subject: def.name, detail: `${cost} ${currency}` });
      bus.emit('ui:toast', { text: `${def.name} unlocked`, kind: 'good' });
      return { ok: true, why: null };
    }

    // ----------------------------------------------------------- reporting

    /** The seed's toggle map, still true, still published. */
    function toggleMap() {
      const out = {};
      for (const [legacy, id] of Object.entries(LEGACY)) out[legacy] = engine.isActive(id);
      for (const id of AUTOMATION_IDS) out[id] = engine.isActive(id);
      return out;
    }

    /** Everything a UI needs to draw one automation's row. */
    function describe(id) {
      const def = automation(id);
      const p = progress();
      const compiled = engine.compiled(id);
      return {
        id: def.id,
        name: def.name,
        blurb: def.blurb,
        detail: def.detail ?? null,
        kind: def.kind,
        dangerous: !!def.dangerous,
        unlock: { ...def.unlock, met: requirementMet(def.unlock.requires, p), text: requirementText(def.unlock.requires, p) },
        unlocked: engine.isUnlocked(id),
        enabled: engine.isEnabled(id),
        active: engine.isActive(id),
        paused: engine.isActive(id) ? paused(id) : false,
        idleUnlock: def.idleUnlock,
        everyS: def.everyS,
        actions: def.actions,
        defaultAction: def.defaultAction,
        settings: def.settings.map((s) => ({ ...s, value: engine.settings(id)[s.key] })),
        rules: engine.rules(id),
        errors: compiled.errors,
        leaves: compiled.leaves,
        stats: engine.stats(id),
        lastRunS: engine.lastRunS(id),
      };
    }

    // ---------------------------------------------------------------- api

    const api = {
      // --- the seed contract, unchanged --------------------------------------
      /** Without an id: the legacy toggle map. With one: that automation's rule list. */
      rules: (id) => (id ? engine.rules(id) : toggleMap()),
      /** Legacy toggle setter. Accepts both `{ autoHunt: true }` and `{ hunt: true }`. */
      set(patch = {}) {
        let touched = false;
        for (const [k, v] of Object.entries(patch)) {
          const id = LEGACY[k] ?? (AUTOMATION_IDS.includes(k) ? k : null);
          if (!id) continue;
          if (engine.enable(id, !!v) === !!v) touched = true;
        }
        return touched;
      },
      unlocked: () => AUTOMATION_IDS.filter((id) => engine.isUnlocked(id)),

      // --- the schema `ui` renders from -------------------------------------
      /**
       * Everything needed to draw a rule editor without knowing what a Pokémon is:
       * every automation, every field with its type/unit/range/enum, every operator with
       * its arity and wording, and the actions each automation accepts.
       */
      schema() {
        return {
          version: SAVE_VERSION,
          limits: { maxRules: MAX_RULES, maxConditions: MAX_LEAVES },
          operators: OPERATORS.map((o) => ({ id: o.id, label: o.label, symbol: o.symbol, arity: o.arity, types: o.types })),
          kinds: KINDS.map((k) => kindSchema(k)),
          vocabulary: { biomes: BIOMES, types: TYPES, itemCategories: ITEM_CATEGORIES, keepOrders: KEEP_ORDERS },
          automations: AUTOMATIONS.map((a) => ({
            id: a.id, name: a.name, blurb: a.blurb, kind: a.kind, dangerous: !!a.dangerous,
            actions: a.actions, defaultAction: a.defaultAction, settings: a.settings,
            unlock: a.unlock, idleUnlock: a.idleUnlock, everyS: a.everyS,
          })),
        };
      },
      fields: (kind) => schemaFor(kind),
      operators: () => OPERATORS.map((o) => ({ ...o, make: undefined })),

      // --- automations -------------------------------------------------------
      list: () => AUTOMATION_IDS.map(describe),
      get: describe,
      unlock,
      enable: (id, on = true) => engine.enable(id, on),
      toggle: (id) => engine.enable(id, !engine.isEnabled(id)),
      isActive: (id) => engine.isActive(id),
      configure: (id, patch) => engine.configure(id, patch),
      settings: (id) => engine.settings(id),
      progress,

      // --- rule editing ------------------------------------------------------
      addRule: (id, rule, at) => engine.addRule(id, rule, at),
      updateRule: (id, ruleId, patch) => engine.updateRule(id, ruleId, patch),
      removeRule: (id, ruleId) => engine.removeRule(id, ruleId),
      moveRule: (id, ruleId, to) => engine.moveRule(id, ruleId, to),
      setRules: (id, list) => engine.setRules(id, list),
      resetRules: (id) => engine.resetRules(id),
      /** Problems with one rule, before it is stored. Empty means it is sound. */
      validate: (id, rule) => validateRule(rule, { kind: automation(id)?.kind, actions: automation(id)?.actions ?? [] }),
      /** One line of English for a rule's condition — what `ui` puts on a collapsed row. */
      describeRule: (id, rule) => describeCondition(rule?.when ?? null, automation(id)?.kind ?? 'stored'),
      errors: () => engine.errors(),

      // --- evaluation --------------------------------------------------------
      /**
       * What the rules say about one subject, with the per-leaf trace that says why.
       * `subject` is a wild spec, a storage entry or an item id, depending on the kind.
       */
      explain(id, subject) {
        const def = automation(id);
        if (!def) return null;
        const w = world();
        if (def.kind === 'wild') {
          return engine.compiled(id).explain(wildFacts(wildSubject(subject), w));
        }
        if (def.kind === 'stored') {
          return engine.compiled(id).explain(storedFacts(subject, w, subject.__extra ?? {}));
        }
        const economy = mod('economy');
        const itemDef = typeof subject === 'string' ? economy.item?.(subject) : subject;
        if (!itemDef) return null;
        const count = num(economy.count?.(itemDef.id), 0);
        return engine.compiled(id).explain(itemFacts(itemDef, count, w, { unitValue: num(economy.sellValue?.(itemDef.id), 0) }));
      },
      /** The decision alone, no trace. Cheap enough to call per subject. */
      evaluate(id, subject) {
        const e = api.explain(id, subject);
        return e ? { action: e.action, ruleId: e.ruleId, ruleName: e.ruleName, args: e.args } : null;
      },
      /** Facts as the engine sees them — the debugging seam. */
      facts(id, subject) {
        const def = automation(id);
        const w = world();
        if (def?.kind === 'wild') return wildFacts(wildSubject(subject), w);
        if (def?.kind === 'stored') return storedFacts(subject, w, subject.__extra ?? {});
        return null;
      },
      world: () => ({ ...world() }),

      // --- the ball optimiser -------------------------------------------------
      /** The chosen ball for a target, with the whole comparison table behind it. */
      chooseBall: (subject, tier = null) => {
        const s = wildSubject(subject);
        if (!tier) return decideBall(s, { force: true });
        const w = world();
        return chooseBall(
          evaluatorFrom(mod('economy')),
          { catchRate: catchRateFor(s.species?.bst), hpFraction: s.hpFraction ?? ballSettings().hpFraction, context: ballContext(s, w) },
          tier, ballSettings(),
        );
      },
      /** Every ball scored against one target — the table the showcase prints. */
      ballTable: (subject) => {
        const s = wildSubject(subject);
        const w = world();
        return rankBalls(
          evaluatorFrom(mod('economy')),
          { catchRate: catchRateFor(s.species?.bst), hpFraction: s.hpFraction ?? ballSettings().hpFraction, context: ballContext(s, w) },
          ballSettings(),
        );
      },
      ballLog: () => ballLog.slice(),

      /**
       * **The decisions that happen inside a fight**, handed over as pure functions.
       *
       * `encounter` opens a duel and `battle.stepper` steps it; neither may reach in here for a
       * ruleset, and this module may not reach into `battle` for a type chart. So the seam is a
       * bundle: the caller gets `between(state)` and `chooseLead(party, wild)` closed over this
       * player's configuration, and hands in the two things only it can supply — the stock it
       * is going to debit, and `battle`'s `effectiveness`. One implementation then serves the
       * watched fight and the closed-tab replay, so both resolve the same turn engine.
       *
       * An automation that is locked or switched off simply contributes nothing: `settingsOf`
       * returns `null` for it and every chooser treats that as "not configured".
       */
      duel({ stock = {}, itemOf = null, effectiveness = null, moveOf = null, party = null } = {}) {
        const live = (id) => (engine.isActive(id) && !paused(id) ? engine.settings(id) : null);
        const heal = live('heal');
        const cfg = {
          heal: heal?.ladder ?? null,
          revive: live('revive'),
          ether: live('ether'),
        };
        const economy = mod('economy');
        const look = itemOf ?? ((id) => (isLive(economy) ? economy.item?.(id) : null));
        return {
          /** `null` when nothing is enabled, so the stepper can skip the hook entirely. */
          between: (cfg.heal || cfg.revive || cfg.ether) ? betweenFor(cfg, stock, look) : null,
          chooseLead: (roster, wild) => {
            const s2 = live('lead');
            if (!s2) return null;
            /**
             * **The move slots are resolved to their types here, and that is the whole fix.**
             *
             * A `pokemon` instance carries `{ id, pp, maxPp }` and **no type** — so handing the
             * slots straight to `leadChoice` left every offensive score at its floor and the
             * rule that is supposed to dominate was inert: measured against a Grass wild with a
             * Tepig holding Ember on the bench, it sent the Snivy. `battle` owns the move table
             * and this module may not import it, so the resolver is injected.
             */
            const look = moveOf ?? (() => null);
            return leadChoice(roster ?? party ?? [], wild, {
              effectiveness: effectiveness ?? (() => 1),
              typesOf: (m) => m?.species?.types ?? [],
              movesOf: (m) => (m?.moves ?? []).map((x) => ({ ...x, type: x.type ?? look(x.id)?.t ?? null })),
            }, s2);
          },
          settings: cfg,
        };
      },

      // --- dry runs and manual runs -------------------------------------------
      /** What a pass would do, without doing it. The reason a player dares enable one. */
      preview(id) {
        if (id === 'release') return planRelease();
        if (id === 'sell') return planSell();
        if (id === 'restock') return planRestock();
        return null;
      },
      /** Runs one pass now, cadence or not. Respects unlock and enable. */
      run(id) {
        if (!engine.isActive(id) || !PASSES[id]) return null;
        engine.mark(id, simTime());
        return PASSES[id]();
      },

      // --- reporting -----------------------------------------------------------
      history: (n, id) => engine.history(n, id),
      totals: () => ({ ...totals }),
      stats: (id) => engine.stats(id),
      diagnostics: () => ({
        catchOrdinal,
        world: world(),
        scheduled: SCHEDULED,
        errors: engine.errors(),
        idle: {
          granted: AUTOMATIONS.filter((a) => a.idleUnlock && engine.isActive(a.id)).map((a) => a.idleUnlock),
          has: typeof mod('idle').has === 'function'
            ? AUTOMATIONS.filter((a) => a.idleUnlock).map((a) => ({ id: a.idleUnlock, on: !!mod('idle').has(a.idleUnlock) }))
            : [],
        },
      }),

      // --- persistence (the native seam src/offline/slices.js prefers) ---------
      saveState: () => ({ v: SAVE_VERSION, catchOrdinal, totals: { ...totals }, engine: engine.serialize() }),
      loadState(value) {
        if (!value || typeof value !== 'object') return false;
        if (Number(value.v) > SAVE_VERSION) {
          log.warn(`automation: save slice v${value.v} is newer than v${SAVE_VERSION} — ignored`);
          return false;
        }
        if (Number.isFinite(value.catchOrdinal)) catchOrdinal = Math.max(0, Math.floor(value.catchOrdinal));
        if (value.totals) for (const k in totals) if (Number.isFinite(value.totals[k])) totals[k] = value.totals[k];
        const ok = engine.restore(value.engine ?? value);
        // `idle` restores its own unlock set from the same save; ours must win, so the
        // flags are re-asserted after the restore rather than before it.
        syncIdle();
        return ok;
      },

      // --- diagnostics the gauntlet reads --------------------------------------
      async selfTest() {
        const { runSelfTest } = await import('./selftest.js');
        const result = await runSelfTest({ api, engine, ctx });
        reportSelfTest('automation', result);
        return result;
      },
      /** Factory reset. Used by the showcase so a screenshot is reproducible. */
      reset() { engine.reset(); catchOrdinal = 0; for (const k in totals) totals[k] = 0; ballLog.length = 0; },
      /** Internals the descriptor's hooks and the showcase draw from. Not a contract. */
      _internals: { engine, tick, world, wildSubject, planRelease, planSell, planRestock, absorb, decideBall },
      dispose() { for (const un of off) un(); off.length = 0; live = null; },
    };

    live = api;
    syncIdle();
    return api;
  },

  /**
   * Closes over the live API rather than going back through the registry every frame, so
   * the scheduler stays inside `init`'s scope where the module's state lives. The pass
   * itself is a cadence check over six integers unless something is actually due.
   */
  tick() {
    live?._internals.tick();
  },

  async showcase(mode, ctx) {
    const { showcaseAutomation } = await import('./showcase.js');
    return showcaseAutomation(mode, ctx);
  },

  dispose() { live?.dispose?.(); },
};
