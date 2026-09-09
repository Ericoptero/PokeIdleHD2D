/**
 * travel — where the player is, and how they get somewhere else (ARCHITECTURE §5.16).
 *
 * Before this module the game had two scenes and no way between them: `src/main.js` called
 * `city.enter()` once at boot and `hunts.enter(id)` was reachable only from the screenshot
 * harness, so four finished biomes sat behind a URL nobody types. This is the seam that
 * connects them, and the one place that knows the whole map of the world.
 *
 * **Not in `src/core/`.** Core is the only thing every module may import, and a scene manager
 * needs `city`, `hunts`, `simulation`, `encounter` — none of which belongs there. Not in `ui`
 * either: the destination table, the teardown order and the save slice are game state, and a
 * lobby you can only reach by opening a panel is not reachable from the boot path at all.
 * So it is an ordinary module reaching its neighbours through `ctx.get` + `isLive`, and a
 * quarantined `travel` costs the game travel rather than its lobby (`src/main.js` falls back).
 *
 * What a destination *is* stays with the scene that owns it: `city.formation()` and
 * `hunts.list()` each declare how their own map is played, and this module only carries them.
 *
 * Order matters in `src/main.js`: registered after `simulation` and **before `offline`**, or
 * `offline` builds its provider list without this module in it and the scene is never saved.
 */

/** The registry's null object answers every property with a function — this is the tell. */
const isLive = (api) => !!api && api.__missing === undefined;

/** Save slice version. `loadState` migrates forward and refuses a newer one (§5). */
const SAVE_VERSION = 1;

export default {
  id: 'travel',
  needs: ['terrain'],
  /** The showcase travels for real, so it needs both scenes and the walker that stages them. */
  showcaseNeeds: ['tiles', 'terrain', 'environment', 'pokemon', 'simulation', 'city', 'hunts'],

  init(ctx) {
    const { bus, config, log } = ctx;

    /** @type {{id:string, name:string, kind:string, module:string, arg:string|null}|null} */
    let current = null;
    let busy = false;
    /** A scene id recovered from the save, waiting for `boot()` to be asked for it. */
    let pending = null;

    const cityApi = () => ctx.get('city');
    const huntsApi = () => ctx.get('hunts');

    /**
     * Every place the player can stand, city first.
     *
     * Built fresh each call rather than cached: `hunts.list()` is the authority on which
     * biomes exist, and a table copied at init would go stale the moment one is added.
     */
    /**
     * The trainer's level, or `null` when `economy` is not live.
     *
     * `null` and not 0: a quarantined ledger must **fail open** (§5.16). A gate that defaulted
     * to level 1 would lock the player out of every hunt because a module they cannot see is
     * broken, which is the opposite of what §2.1's isolation is for.
     */
    function trainerLevel() {
      const eco = ctx.get('economy');
      if (!isLive(eco) || typeof eco.trainer !== 'function') return null;
      const t = eco.trainer();
      return Number.isFinite(t?.level) ? t.level : null;
    }

    function destinations() {
      const out = [];
      const city = cityApi();
      if (isLive(city) && typeof city.enter === 'function') {
        out.push({
          id: 'demo-city', name: 'Lumen City', kind: 'Town', module: 'city', arg: null,
          formation: typeof city.formation === 'function' ? city.formation() : null,
        });
      }
      const hunts = huntsApi();
      if (isLive(hunts) && typeof hunts.list === 'function') {
        const level = trainerLevel();
        for (const b of hunts.list()) {
          const need = Number(b.requiredLevel) || 0;
          // `locked` is false when the level is unknown — the fail-open rule above.
          const locked = level !== null && level < need;
          out.push({
            id: `hunt-${b.id}`, name: b.name, kind: 'Hunt', module: 'hunts', arg: b.id,
            formation: b.formation ?? null,
            requiredLevel: need,
            locked,
            why: locked ? `Trainer Lv${need} — you are Lv${level}` : null,
          });
        }
      }
      return out;
    }

    const find = (id) => destinations().find((d) => d.id === id) ?? null;

    /**
     * Goes somewhere. Serialised: a click and a keypress can land in the same frame, and two
     * overlapping `enter()` calls would dispose a map the other one is still building.
     *
     * @param {string} id  a destination id, e.g. `'demo-city'` or `'hunt-forest'`
     * @returns {Promise<boolean>} whether the travel happened
     */
    async function go(id) {
      if (busy) { log.info(`travel: already travelling — "${id}" ignored`); return false; }
      const dest = find(id);
      if (!dest) { log.warn(`travel: no destination "${id}"`); return false; }
      // **The gate is a rule of progression, not a property of the scene**, so it does not
      // apply to the two diagnostic knobs that ask for a scene by name: `?showcase=` and
      // `?scene=`. Every hunt biome is gated above trainer level 1 and the harness boots a
      // fresh save, so a gate that applied to them would frame an empty blue void instead of a
      // map. Measured, not reasoned about, and twice: `?showcase=travel&mode=hunt-cave` came
      // back at 9 draw calls, and after that was fixed `?scene=hunt-cave` — which is how
      // `tools/shots` frames a hunt at `/` — did exactly the same thing (DECISIONS #70). The
      // row is still drawn locked, because `destinations()` is untouched; it is only the
      // *refusal* that stands down.
      if (dest.locked && !config.showcase && id !== config.scene) {
        // Refused, not thrown: the caller gets `false` the same way it does for an unknown
        // destination, and the player gets a sentence rather than a dead button.
        log.info(`travel: "${id}" needs trainer level ${dest.requiredLevel}`);
        bus.emit('ui:toast', { text: dest.why, kind: 'warn' });
        return false;
      }

      busy = true;
      try {
        // A wild Pokemon staged on a map that is about to be disposed outlives it: `encounter`
        // listens for `world:loaded` but never for `world:unloaded`, so it has no idea the
        // ground went away. Both of these are its own published API.
        const encounter = ctx.get('encounter');
        if (isLive(encounter) && typeof encounter.active === 'function'
          && encounter.active() && typeof encounter.cancel === 'function') encounter.cancel();

        // Stop the outgoing scene's autopilot before the collision it is walking against is
        // torn out from under it. `enter()` installs the destination's own.
        const sim = ctx.get('simulation');
        if (isLive(sim) && typeof sim.halt === 'function') sim.halt();

        // The scene does the rest: its environment preset and weather, its dressing, its
        // formation and its spawn. `terrain.load` unloads the old map first, and both scenes
        // listen for `world:unloaded` to take themselves down.
        const owner = ctx.get(dest.module);
        if (!isLive(owner) || typeof owner.enter !== 'function') {
          log.warn(`travel: "${dest.module}" cannot enter "${id}"`);
          return false;
        }
        await owner.enter(dest.arg ?? undefined);

        current = dest;
        bus.emit('scene:entered', {
          sceneId: dest.id,
          mapId: dest.id,
          biome: dest.arg ?? 'city',
          formation: dest.formation ? { ...dest.formation } : null,
        });
        // One owner for arrival, so a hop cannot toast twice. Never in a showcase: sim time
        // is frozen for a capture, so a toast never expires and sits in every frame.
        if (!config.showcase) bus.emit('ui:toast', { text: `Arrived: ${dest.name}`, kind: 'info' });
        log.info(`travel: entered ${dest.name} (${dest.id})`);
        return true;
      } catch (err) {
        log.error(`travel: entering "${id}" failed`, err);
        return false;
      } finally {
        // In `finally`, so a scene that throws mid-build costs one failed hop rather than
        // wedging travel for the rest of the session.
        busy = false;
      }
    }

    const api = {
      destinations,
      current: () => (current ? { ...current } : null),
      busy: () => busy,
      go,

      /**
       * Where a boot should go: the URL first so the harness can frame a hunt at `/`, then
       * the save, then the lobby.
       */
      boot() {
        const asked = config.scene;
        if (asked && find(asked)) return asked;
        if (asked) log.warn(`travel: ?scene=${asked} is not a destination — booting the lobby`);
        // **A saved scene the trainer can no longer enter must not boot the game into
        // nothing.** A save written before the gate existed — or restored onto an `economy`
        // that has been reset — can name `hunt-cave` with the wins for level 3, and `go()`
        // would refuse it with `main.js` holding an empty map. The lobby is always enterable,
        // so that is where a refused save lands. `info`, not `warn`: it is a correct outcome.
        if (pending && find(pending)) {
          const saved = find(pending);
          if (!saved.locked) return pending;
          log.info(`travel: the saved scene "${pending}" needs trainer level ${saved.requiredLevel} — booting the lobby`);
        }
        return 'demo-city';
      },

      // --- the save seam (§5) ------------------------------------------------
      saveState: () => ({ v: SAVE_VERSION, sceneId: current?.id ?? null }),
      /**
       * Records an intent and nothing else. Restoring at hydrate time is impossible — there
       * is no map yet, and no scene has been entered — so `boot()` is what acts on it.
       */
      loadState(value) {
        if (!value || typeof value !== 'object') return false;
        if (Number(value.v) > SAVE_VERSION) {
          log.warn(`travel: save slice v${value.v} is newer than v${SAVE_VERSION} — not loaded`);
          return false;
        }
        pending = typeof value.sceneId === 'string' ? value.sceneId : null;
        return true;
      },
    };

    /**
     * Hand the save seam to `offline` directly if it is already up.
     *
     * `offline` discovers its providers once, during its own `init`, so which modules get a
     * slice is decided by the registry's topological order — and `travel` lands on the wrong
     * side of it (`offline` needs only `idle`, and the sort is alphabetical among modules
     * whose dependencies are already satisfied). Registering here covers that case, and
     * pulls the slice `hydrate()` had already read off disk before this module existed.
     *
     * If `offline` is *not* up yet, none of this runs and the ordinary `saveState`/`loadState`
     * discovery catches us instead. Both orders work, which is the point.
     */
    const offline = ctx.get('offline');
    if (isLive(offline) && typeof offline.store?.register === 'function') {
      offline.store.register('travel', {
        capture: () => api.saveState(),
        restore: (v) => api.loadState(v),
        source: 'native',
        order: 45,                       // after `simulation` (40), before the default 50
      });
      const saved = offline.store.get?.('travel');
      if (saved !== undefined) api.loadState(saved);
    }

    return api;
  },

  /**
   * `?showcase=travel[&mode=<destination id>]` — travel for real, then open the panel over
   * whatever we arrived in. `mode=default` is the lobby; `mode=hunt-forest` frames the panel
   * against a biome, which is the pair a critic needs to see the HERE row move.
   */
  async showcase(mode, ctx) {
    const travel = ctx.get('travel');
    const wanted = travel.destinations().some((d) => d.id === mode) ? mode : 'demo-city';
    await travel.go(wanted);
    const ui = ctx.get('ui');
    if (ui && ui.__missing === undefined && typeof ui.open === 'function') ui.open('travel');
  },
};
