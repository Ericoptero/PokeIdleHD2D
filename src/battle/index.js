// @ts-check
/**
 * battle — the turn engine (ARCHITECTURE §5.17).
 *
 * Everything about a fight that is arithmetic. It holds no `pokemon` instance, touches no
 * `three`, reads no clock and has no DOM: it takes two plain **combatant records** and returns
 * a transcript. That is what lets `idle` and `offline` replay a battle headlessly, and what
 * lets `selftest.js` run the whole thing under plain Node.
 *
 * **Why this is not part of `encounter`.** `encounter/index.js` is already a thousand lines and
 * owns a five-stage animation; the engine has to run where there is no animation at all. And
 * the split is the one DECISIONS #61 records: `encounter` supplies the capture rate, the HP
 * left and the coin, `economy` owns the ball and the pity, and combat is here.
 *
 * **Why this fetches its own data.** `pokemon` already awaits `species.json` on the boot
 * critical path against §7's 6-second cold budget. Loading 330 KB more there would delay
 * `__READY__` for everyone, and a move table that 404'd would cost the overworld its sprites.
 * Here, a failure quarantines `battle` alone and the registry's null-object keeps the rest of
 * the game running (§2.1).
 */

import * as MOVES from './moves.js';
import { TYPES, effectiveness, effectivenessText, STAB, typeColour } from './types.js';
import { statsOf, stageMultiplier, expAtLevel, expToNextLevel, levelForExp, expYield } from './stats.js';
import {
  makeCombatant, begin, turn, resolve, stepper, applyAction,
  damageOf, streamFor, STREAM_ROOT, MAX_BETWEEN,
} from './engine.js';
import { strikesOf, describeStrike } from './strike.js';
import { reportSelfTest } from '../core/log.js';

/** Save slice version. `loadState` migrates forward and refuses a newer one (§5). */
const SAVE_VERSION = 1;

export default {
  id: 'battle',
  needs: [],
  /** The showcase names real species, so it wants the species table beside it (§6). */
  showcaseNeeds: ['pokemon'],

  async init(ctx) {
    const { log } = ctx;

    /** Per-Pokemon move preference, `instanceId -> moveId[]`. The only state this module has. */
    const priority = new Map();

    let moves = null;
    let learnsets = null;
    try {
      const [m, l] = await Promise.all([
        fetch('/generated/moves.json').then((r) => (r.ok ? r.json() : null)),
        fetch('/generated/learnsets.json').then((r) => (r.ok ? r.json() : null)),
      ]);
      moves = m; learnsets = l;
    } catch { /* handled below, at warn — a handled path must not cost §7's error budget */ }

    if (!moves || !learnsets) {
      // `log.warn`, never `log.error`: §7 budgets zero console errors and DECISIONS #15 is
      // explicit that a handled path must not spend that budget.
      log.warn('battle: /generated/{moves,learnsets}.json missing — no battle can be fought. '
        + 'Run `node src/pokemon/tools/build-battle-data.js`.');
    } else {
      MOVES.load({ moves, learnsets });
      log.info(`battle: ${MOVES.moveCount()} moves, ${Object.keys(learnsets).length} learnsets`);
    }

    const api = {
      // --- data ------------------------------------------------------------
      ready: () => MOVES.ready(),
      move: (id) => MOVES.resolveMove(id),
      moveIds: () => MOVES.moveIds(),
      moveCount: () => MOVES.moveCount(),
      learnset: (species) => MOVES.learnset(species),
      types: () => [...TYPES],
      effectiveness,
      effectivenessText,
      /** `{ core, edge, ink }` for a type — `ink` is what a balloon or a floater prints on
       *  paper; `core`/`edge` are the strike's own effect colours. Falls back to `normal`. */
      typeColour,
      STAB,

      /** The four slots a species carries at a level, honouring its owner's preference list. */
      movesFor: (species, level, opts = {}) => MOVES.movesFor(species, level, {
        priority: opts.priority ?? priority.get(opts.instanceId) ?? [],
      }),

      // --- stats and experience --------------------------------------------
      stats: statsOf,
      stageMultiplier,
      expToLevel: expAtLevel,
      expToNextLevel,
      levelForExp,
      expYield,

      // --- the engine -------------------------------------------------------
      makeCombatant,
      begin,
      /** One turn, pure. */
      turn,
      /**
       * A fight, one turn at a time — **the implementation**, of which `resolve` is a drain.
       *
       * The visible fight steps this on a sim cadence so it can be watched and screenshotted;
       * `idle` and `offline` drain it. `between` lands heals, ethers and revives between two
       * turns and `nextAlly` sends out the next party member when one falls, so an ally faint
       * is not the end of a duel. Neither hook may draw randomness (DECISIONS #72).
       */
      stepper,
      applyAction,
      MAX_BETWEEN,
      resolve,
      /** One record per blow, folded out of a turn's events — what `battle:strike` carries. */
      strikesOf,
      describeStrike,
      damageOf,
      choose: (self, foe) => MOVES.choose(self, foe),
      streamFor,
      STREAM_ROOT,

      // --- the player's preference list ------------------------------------
      priority: (instanceId) => [...(priority.get(instanceId) ?? [])],
      setPriority(instanceId, moveIds) {
        if (!instanceId) return false;
        const list = (moveIds ?? []).filter((id) => MOVES.move(id));
        if (list.length) priority.set(instanceId, list.slice(0, MOVES.MOVE_SLOTS));
        else priority.delete(instanceId);
        return true;
      },

      selfTest() {
        // The browser-side echo of `selftest.js`, so a showcase can print a score beside the
        // frame the way `encounter.selfTest()` already does.
        const results = [];
        const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
        check('data loaded', MOVES.ready(), `${MOVES.moveCount()} moves`);
        check('type chart: water on fire is 2x', effectiveness('water', ['fire']) === 2);
        check('type chart: electric on ground is 0', effectiveness('electric', ['ground']) === 0);
        check('type chart: ice on dragon/flying is 4x', effectiveness('ice', ['dragon', 'flying']) === 4);
        check('stream identity', streamFor(1337, 7, 1).label === `${STREAM_ROOT}/7/1`);
        // The claim the whole visible fight rests on: stepping and draining are one code path.
        {
          const a = makeCombatant({ species: 'pikachu', level: 10 });
          const b = makeCombatant({ species: 'rattata', level: 10 });
          const drained = resolve(a, b, 1337, 3);
          const run = stepper(a, b, 1337, 3);
          const stepped = [];
          while (!run.over) stepped.push(...run.step().events);
          check('stepping a fight equals draining it',
            JSON.stringify(stepped) === JSON.stringify(drained.transcript),
            `${stepped.length} vs ${drained.transcript.length} events`);
          check('a strike is derived per blow', strikesOf(drained.transcript, { a: 'a', b: 'b' }).length > 0);
        }
        reportSelfTest('battle', results);
        return { ok: results.every((r) => r.ok), results };
      },

      // --- the save seam (§5) ----------------------------------------------
      saveState: () => ({ v: SAVE_VERSION, priority: Object.fromEntries(priority) }),
      loadState(value) {
        if (!value || typeof value !== 'object') return false;
        if (Number(value.v) > SAVE_VERSION) {
          log.warn(`battle: save slice v${value.v} is newer than v${SAVE_VERSION} — not loaded`);
          return false;
        }
        priority.clear();
        for (const [id, list] of Object.entries(value.priority ?? {})) {
          if (Array.isArray(list)) priority.set(id, list.filter((m) => typeof m === 'string'));
        }
        return true;
      },
    };

    return api;
  },

  async showcase(mode, ctx) {
    const { showcaseBattle } = await import('./showcase.js');
    return showcaseBattle(mode, ctx);
  },
};
