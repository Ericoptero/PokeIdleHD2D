/**
 * offline — closed-tab catch-up and the save format (ARCHITECTURE §5.8, §10).
 *
 * Three jobs, in this order at boot:
 *
 *   1. **Load.** `pokeidle.save` is parsed, checksum-verified, migrated forward one
 *      version at a time and field-repaired. Anything that cannot survive that is moved to
 *      `pokeidle.save.broken` and the game starts fresh — the one thing this module must
 *      never do is white-screen the boot it sits in.
 *   2. **Hydrate.** Saved slices are pushed back into the modules that own them, through
 *      their published APIs only (`src/offline/slices.js`).
 *   3. **Catch up.** Time between the save's `lastSeenMs` and now is clamped to
 *      `config.offlineCapS`, discounted along an efficiency curve, and handed to
 *      `idle.simulate` **once, verbatim**. What comes back is granted where a module can
 *      accept it and reported as pending where none can yet, and the whole thing is
 *      published as a "while you were away" payload for `ui` to render.
 *
 * Afterwards it keeps the save honest: debounced writes (2 s), writes on
 * `visibilitychange` and `pagehide`, and a slow heartbeat so a browser that is killed
 * without warning cannot be reopened for offline credit covering hours the tab was
 * actually open and already accruing.
 *
 * Showcase mode is strictly read-only: `?showcase=…` runs against an in-memory copy of the
 * real save and never writes, never hydrates and never grants, because a showcase must be
 * deterministic (§6) and must not spend a player's actual absence on a screenshot.
 */

import { makeSaveStore, makeStorage, makeMemoryStorage, KEY, BROKEN_KEY, FUTURE_KEY } from './save.js';
import { CURRENT_VERSION, MIGRATION_CHAIN } from './migrations.js';
import { computeCatchUp, makeSummary, CURVE_DEFAULTS, formatDuration, efficiencyAt, effectiveSeconds } from './catchup.js';
import { discoverProviders } from './slices.js';

/** How often the save is refreshed while nothing in particular is happening. */
const DEFAULT_HEARTBEAT_MS = 60000;

const isLive = (api) => !!api && api.__missing === undefined;
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export default {
  id: 'offline',
  needs: ['idle'],
  /** Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6). */
  showcaseNeeds: ['city', 'terrain'],

  init(ctx) {
    const { config, bus, log } = ctx;
    const readOnly = !!config.showcase;

    /* ------------------------------------------------------------- the store */

    const realStorage = makeStorage();
    // A showcase reads the real save so the panel can report on it, but works on a copy so
    // it cannot write, quarantine or spend anything belonging to the player.
    const storage = readOnly
      ? makeMemoryStorage(Object.fromEntries(
        [KEY, BROKEN_KEY, FUTURE_KEY]
          .map((k) => [k, realStorage.getItem(k)])
          .filter(([, v]) => v != null)))
      : realStorage;

    const store = makeSaveStore({
      storage,
      log,
      seed: num(config.seed, 0),
      debounceMs: num(config.saveDebounceMs, 2000),
      // Anti-starvation ceiling: a change every second must not postpone the write forever.
      maxDebounceMs: num(config.saveMaxDebounceMs, 15000),
    });

    store.load();
    store.beginSession();

    /* ------------------------------------------------- offline's own slice */

    /**
     * State this module owns. `progress` is the cumulative encounter counter that
     * `idle/accrual.js` indexes its per-encounter RNG streams from — without persisting it
     * every session would replay encounter #1 onwards and meet the same shiny forever.
     * `carry` keeps the sub-unit remainder that flooring the payout would otherwise eat.
     */
    const self = {
      progress: { encounters: 0, seconds: 0 },
      carry: { money: 0, tokens: 0 },
      lifetime: { offlineSessions: 0, offlineSeconds: 0, offlineMoney: 0 },
      player: null,
    };

    store.register('offline', {
      source: 'native', order: 0,
      // `player` is deliberately not in here: the cell belongs to the `simulation` slice
      // and storing it twice would let the two copies disagree.
      capture: () => ({
        progress: { ...self.progress },
        carry: { ...self.carry },
        lifetime: { ...self.lifetime },
      }),
      restore: (v) => {
        if (!v || typeof v !== 'object') return;
        if (v.progress) self.progress = { encounters: num(v.progress.encounters), seconds: num(v.progress.seconds) };
        if (v.carry) self.carry = { money: num(v.carry.money), tokens: num(v.carry.tokens) };
        if (v.lifetime) self.lifetime = { ...self.lifetime, ...v.lifetime };
      },
    });

    // Every module the registry knows about, not just the ones with an adapter written for
    // them. ARCHITECTURE §5 promises a module opts into saving "simply by having"
    // `saveState`/`loadState` and needs no entry anywhere — with the default id list that was
    // never true, and `encounter` has shipped a save seam nothing ever called since it was
    // written. `discoverProviders` already skips an id with neither a seam nor an adapter.
    const providers = discoverProviders(ctx, ctx.registry.status().map((m) => m.id));
    for (const p of providers) {
      store.register(p.id, { capture: p.capture, restore: p.restore ?? (() => {}), source: p.source, order: p.order });
    }
    const unrestored = providers.filter((p) => !p.restore).map((p) => ({ id: p.id, why: p.unrestoredWhy }));

    let restored = [];
    if (!readOnly) restored = store.hydrate();

    // `idle` may publish its own progress; if it does, its value wins over our mirror.
    const idleSlice = store.get('idle');
    if (idleSlice?.progress) {
      self.progress = { encounters: num(idleSlice.progress.encounters), seconds: num(idleSlice.progress.seconds) };
    }

    /* ------------------------------------------------------------- the curve */

    // Read from config where the integrator has defined the key, otherwise from the
    // module's own defaults. Written this way so these become live tunables (§2.6) the
    // moment `core/config.js` grows them, with no change here — see the coreRequest.
    const curve = () => ({
      graceS: num(config.offlineGraceS, CURVE_DEFAULTS.graceS),
      halfLifeS: num(config.offlineHalfLifeS, CURVE_DEFAULTS.halfLifeS),
      floor: num(config.offlineEfficiency, CURVE_DEFAULTS.floor),
      minS: num(config.offlineMinS, CURVE_DEFAULTS.minS),
      maxPlausibleS: num(config.offlineMaxPlausibleS, CURVE_DEFAULTS.maxPlausibleS),
    });

    /**
     * The state `idle.simulate` wants. Preferring `idle.state()` when it exists keeps the
     * online and offline pictures identical by construction rather than by coincidence.
     */
    function idleState() {
      const idle = ctx.get('idle');
      const live = isLive(idle) && typeof idle.state === 'function' ? idle.state() : null;
      const biome = live?.biome ?? ctx.get('terrain').handle?.()?.biome ?? 'meadow';
      const base = live ?? {
        party: ctx.get('pokemon').party?.() ?? [],
        biome,
        luck: 1,
      };
      const state = { ...base, biome };
      if (state.tables === undefined) {
        const tables = ctx.get('encounter').tablesFor?.(biome, num(config.tod, 12));
        if (Array.isArray(tables)) state.tables = tables;
      }
      if (state.balls === undefined) {
        const balls = ctx.get('economy').count?.('pokeball');
        if (Number.isFinite(balls)) state.balls = balls;
      }
      if (state.tod === undefined) state.tod = num(config.tod, 12);
      // The discount lives in the time axis (see below), so the rate multiplier stays 1.
      state.efficiency = 1;
      state.progress = { ...self.progress };
      return state;
    }

    /**
     * One catch-up decision. `simulate` is `idle`'s, unmodified, called exactly once with
     * the *discounted* number of seconds.
     *
     * Discounting in the time axis rather than through `state.efficiency` is deliberate:
     * the curve is not a constant, so no single scalar could express it, and a time-axis
     * discount holds exactly whatever `idle` decides a second is worth — including for
     * the discrete, index-addressed encounters, which a rate multiplier would renumber.
     */
    function decide(nowMs, { lastSeenMs = store.lastSeenMs(), firstLaunch = store.info().firstLaunch } = {}) {
      const idle = ctx.get('idle');
      const simulate = isLive(idle) && typeof idle.simulate === 'function'
        ? idle.simulate
        // `idle` is quarantined. Reporting a zero absence is the honest answer; inventing
        // an accrual model here would be exactly the duplicate `idle` forbids.
        : () => ({ money: 0, exp: 0, research: 0, encounters: 0, wholeEncounters: 0 });
      try {
        return computeCatchUp({
          nowMs, lastSeenMs, firstLaunch,
          capS: num(config.offlineCapS, 12 * 3600),
          curve: curve(),
          state: idleState(),
          seed: num(config.seed, 0),
          simulate,
        });
      } catch (err) {
        // `simulate` and the state assembly reach into four sibling modules that are being
        // rewritten around us. A throw here would fail this module's init, the registry
        // would quarantine it, and the write path would never install — losing the save is
        // a far worse outcome than losing one catch-up.
        log.warn('offline: catch-up could not be computed; granting nothing this session', err);
        return {
          reason: 'error', ok: false, nowMs, lastSeenMs: lastSeenMs ?? null,
          rawAwayS: 0, awayS: 0, clockSkewS: 0, capS: num(config.offlineCapS, 12 * 3600),
          capped: false, cappedS: 0, effectiveS: 0, efficiencyAvg: 0, bands: [],
          gains: null, repairAnchor: false, curve: curve(),
          error: String(err?.message ?? err),
        };
      }
    }

    /* ------------------------------------------------------------ the payout */

    const notes = [];
    const info = store.info();
    if (info.firstLaunch) notes.push('first launch — a new save was created');
    if (info.quarantined) notes.push(`the previous save was unreadable (${info.quarantined.reason}) and is kept at ${BROKEN_KEY}`);
    if (info.futureVersion) notes.push(`a save from a newer build (v${info.futureVersion}) is kept at ${FUTURE_KEY}`);
    if (info.migratedFrom != null) notes.push(`save migrated v${info.migratedFrom} → v${CURRENT_VERSION}`);
    if (info.repairs.length) notes.push(`repaired ${info.repairs.join(', ')}`);
    if (info.storage === 'memory') notes.push('browser storage is unavailable — this session will not be saved');

    let decision = decide(Date.now());
    let summary = null;

    if (!readOnly) {
      const applied = {};
      const pending = {};

      if (decision.repairAnchor) store.setLastSeen(Date.now());

      if (decision.ok) {
        const g = decision.gains ?? {};
        const economy = ctx.get('economy');
        const canBank = isLive(economy) && typeof economy.add === 'function' && typeof economy.balance === 'function';

        try {
          // Currencies, with the flooring remainder carried to the next session rather than
          // quietly discarded. What lands in `applied` is measured from the balance, not
          // assumed: `economy` multiplies income by the player's own upgrades on the way in,
          // so the number on the card has to be the number that actually arrived.
          for (const currency of ['money', 'tokens']) {
            const raw = num(g[currency]);
            if (raw <= 0) continue;
            const total = raw + num(self.carry[currency]);
            const whole = Math.floor(total);
            self.carry[currency] = total - whole;
            if (whole <= 0) continue;
            if (canBank) {
              const before = num(economy.balance(currency));
              economy.add(currency, whole, 'offline');
              const credited = num(economy.balance(currency)) - before;
              applied[currency] = Math.round(credited > 0 ? credited : whole);
            } else pending[currency] = whole;
          }

          // Items an auto-battle run found or an auto-catch run spent.
          for (const [id, n] of Object.entries(g.items ?? {})) {
            const delta = Math.trunc(num(n));
            if (!delta) continue;
            if (isLive(economy) && typeof economy.give === 'function' && typeof economy.take === 'function') {
              if (delta > 0) economy.give(id, delta); else economy.take(id, -delta);
              applied[id] = (applied[id] ?? 0) + delta;
            } else pending[id] = (pending[id] ?? 0) + delta;
          }
        } catch (err) {
          log.warn('offline: economy refused the catch-up payout', err);
          notes.push('the payout could not be banked this session');
        }

        // Nothing accepts experience or a caught Pokemon from a background run yet. They
        // are reported as pending rather than folded into the money number, so the card
        // never claims the player got something they did not.
        if (num(g.exp) >= 1) pending.exp = Math.floor(num(g.exp));
        if (num(g.wholeEncounters) > 0) pending.encounters = g.wholeEncounters;
        if (num(g.catches) > 0) pending.catches = g.catches;
        if (num(g.shinies) > 0) pending.shinies = g.shinies;

        // Hand the consumed encounter indices back to `idle`. Without this its live counter
        // still points at index 0, so the first online encounters would re-roll the exact
        // ones the catch-up just paid for — same species, same shinies — and the next
        // capture would write that stale counter back over ours.
        if (g.progress) {
          self.progress = { encounters: num(g.progress.encounters), seconds: num(g.progress.seconds) };
          const idle = ctx.get('idle');
          try {
            if (isLive(idle) && typeof idle.restore === 'function') idle.restore({ progress: { ...self.progress } });
            else if (isLive(idle) && typeof idle.setProgress === 'function') idle.setProgress({ ...self.progress });
          } catch (err) { log.warn('offline: could not hand the encounter counter back to idle', err); }
        }
        if (g.truncated) notes.push('the absence was long enough that the tail of the encounter list was estimated');

        self.lifetime.offlineSessions += 1;
        self.lifetime.offlineSeconds += decision.cappedS;
        self.lifetime.offlineMoney += num(applied.money);
      }
      if (decision.reason === 'error') {
        notes.push('the catch-up model was unavailable this session; nothing was granted');
      }

      if (decision.reason === 'clock-rewound') {
        notes.push(`the system clock moved back ${formatDuration(decision.clockSkewS)} — nothing was granted for time we cannot account for`);
      }
      if (decision.reason === 'implausible') {
        notes.push('the save\'s last-seen time is not plausible; the clock anchor was reset');
      }
      if (decision.capped) {
        notes.push(`offline progress is capped at ${formatDuration(decision.capS)}`);
      }

      summary = makeSummary(decision, {
        applied, pending, notes,
        save: {
          version: CURRENT_VERSION, storage: info.storage, firstLaunch: info.firstLaunch,
          quarantined: info.quarantined?.reason ?? null, futureVersion: info.futureVersion,
          migratedFrom: info.migratedFrom, sessions: info.sessions + 1,
          lifetime: { ...self.lifetime },
        },
      });

      const toast = (text, kind) => { try { ctx.get('ui').toast?.(text, kind); } catch { /* ui is someone else's */ } };
      if (decision.ok) {
        // Exactly the payload ARCHITECTURE §4 documents. `ui` pulls the full card with
        // `ctx.get('offline').summary()`.
        bus.emit('offline:applied', { awayS: decision.awayS, gains: decision.gains, capped: decision.capped });
        toast(`Welcome back — ${summary.awayText} away, ₽${(applied.money ?? 0).toLocaleString()}`, 'offline');
      }
      if (info.quarantined) toast('A damaged save was set aside; starting a new game', 'warn');
      if (info.futureVersion) toast(`Save is from a newer version (v${info.futureVersion}); it has been kept safe`, 'warn');
    } else {
      summary = makeSummary(decision, { notes: [...notes, 'showcase mode: read-only, nothing granted or written'] });
    }

    /* ------------------------------------------------------------- write path */

    const listeners = [];
    let heartbeat = null;

    if (!readOnly) {
      // The first write anchors `createdMs` and the session counter immediately, so a tab
      // closed ten seconds after a first launch still has a save.
      store.flush('boot');

      const dirtyOn = ['economy:changed', 'collection:added', 'catch:succeeded', 'party:leadChanged',
        'encounter:resolved', 'automation:changed', 'world:loaded'];
      for (const type of dirtyOn) listeners.push(bus.on(type, () => store.markDirty(type)));

      const onVisibility = () => { if (document.visibilityState === 'hidden') store.flush('visibilitychange'); };
      const onPageHide = () => store.flush('pagehide');
      // `freeze` is a Page Lifecycle event on the document: the last moment before a tab
      // is frozen for bfcache, and on mobile often the last code that runs at all.
      const onFreeze = () => store.flush('freeze');
      document.addEventListener('visibilitychange', onVisibility);
      document.addEventListener('freeze', onFreeze);
      addEventListener('pagehide', onPageHide);
      listeners.push(
        () => document.removeEventListener('visibilitychange', onVisibility),
        () => document.removeEventListener('freeze', onFreeze),
        () => removeEventListener('pagehide', onPageHide),
      );

      // Keeps `lastSeenMs` fresh while the tab is open and nothing is changing. Without it,
      // a browser killed after twelve idle hours would be reopened for twelve hours of
      // offline credit covering time the tab was open and already accruing.
      heartbeat = setInterval(() => store.flush('heartbeat'), num(config.offlineHeartbeatMs, DEFAULT_HEARTBEAT_MS));

      /**
       * The player's cell, put back once there is a map to stand on.
       *
       * This used to listen for `world:loaded` and it has never once worked. `terrain.load()`
       * emits that event from inside itself, and the scene then calls `placePlayer(spawn)` a
       * few lines later — so the restore landed and was overwritten microseconds afterwards,
       * every boot. `scene:entered` fires after `enter()` has resolved, which makes this the
       * last word instead of the first.
       *
       * Once per session, too: travelling city → forest → city must not yank the player back
       * to wherever they happened to be standing when the save was written.
       */
      let playerRestored = false;
      const restorePlayer = ({ mapId }) => {
        if (playerRestored) return;
        const want = self.player;
        if (!want || want.mapId !== mapId) return;
        playerRestored = true;
        const sim = ctx.get('simulation');
        const terrain = ctx.get('terrain');
        if (!isLive(sim) || typeof sim.teleport !== 'function') return;
        if (isLive(terrain) && typeof terrain.passable === 'function' && !terrain.passable(want.cx, want.cz, want.dir)) return;
        sim.teleport(want.cx, want.cz, want.dir);
      };
      listeners.push(bus.on('scene:entered', restorePlayer));
      // The cell itself is captured by the `simulation` adapter in slices.js; all that is
      // needed here is somewhere to put it back once a map exists.
      const savedPlayer = store.get('simulation');
      if (savedPlayer) self.player = savedPlayer;
    }

    /* ------------------------------------------------------------------ API */

    return {
      // --- save (§10) -------------------------------------------------------
      /** A deep snapshot of the save document. */
      save: () => store.snapshot(),
      /** Writes immediately, bypassing the debounce. Never throws. */
      persist: (reason = 'manual') => store.flush(reason),
      /** The store itself: register(), get/set/patch, import/export, clear(), info(). */
      store,
      version: CURRENT_VERSION,
      migrations: () => [...MIGRATION_CHAIN],
      /** Diagnostics for the debug overlay: storage kind, quarantine, migrations, writes. */
      info: () => ({
        ...store.info(),
        readOnly,
        providers: store.providers(),
        restored,
        unrestored,
        lifetime: { ...self.lifetime },
        progress: { ...self.progress },
      }),
      keys: { save: KEY, broken: BROKEN_KEY, future: FUTURE_KEY },

      // --- catch-up (§5.8) --------------------------------------------------
      /** The "while you were away" payload, for `ui` to render. Null once dismissed. */
      summary: () => summary,
      dismissSummary() { const s = summary; summary = null; return s; },
      /** The raw decision, including the reason a payout did not happen. */
      decision: () => decision,
      awayS: () => decision.awayS,
      lastSeenMs: () => store.lastSeenMs(),
      curve,
      /** Efficiency at `t` seconds into an absence, and its exact integral. */
      efficiencyAt: (t) => efficiencyAt(t, curve()),
      effectiveSeconds: (t) => effectiveSeconds(t, curve()),
      /** What an absence of `awayS` would be worth right now. Pure: grants nothing. */
      preview(awayS, nowMs = Date.now()) {
        return decide(nowMs, { lastSeenMs: nowMs - awayS * 1000, firstLaunch: false });
      },
      /** Recomputes the catch-up decision — used by the showcase and by tests. */
      _decide: decide,

      dispose() {
        if (heartbeat) clearInterval(heartbeat);
        for (const off of listeners) { try { off(); } catch { /* already gone */ } }
        if (!readOnly) store.flush('dispose');
        store.dispose();
      },
    };
  },

  async showcase(mode, ctx) {
    const { showcaseOffline } = await import('./showcase.js');
    return showcaseOffline(mode, ctx);
  },
};
