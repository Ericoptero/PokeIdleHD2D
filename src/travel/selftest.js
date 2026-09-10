#!/usr/bin/env node
/**
 * Property checks for `src/travel/`, run under plain Node by `tools/seams/run.js` rule 6.
 *
 *   node src/travel/selftest.js
 *
 * This module decides **which scene the game boots into**, and every way that decision can
 * go wrong looks the same from the outside: an empty blue void at nine draw calls. Three
 * such bugs shipped in one commit (DECISIONS #70) and all three were found by re-reading
 * the code, because nothing here was executable without a browser. It is: `travel` touches
 * no `window`, no `THREE` and no `localStorage`, so `init(ctx)` runs against a stub and the
 * whole boot decision is checkable in milliseconds.
 *
 * The rule under test, in one line: **a diagnostic URL stands the gate down, a save does
 * not, and neither is ever allowed to answer "nowhere".**
 */

import travel from './index.js';

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); return !!ok };
const eq = (name, got, want) => check(name, got === want,
  `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/** The registry's null object: every property is a function, and `__missing` is the tell. */
const nullObject = () => new Proxy({}, {
  get: (_t, p) => (p === '__missing' ? true : () => undefined),
});

const BIOMES = [
  { id: 'meadow', name: 'Verdant Meadow', requiredLevel: 0 },
  { id: 'forest', name: 'Whisper Wood', requiredLevel: 5 },
  { id: 'coast', name: 'Salt Reach', requiredLevel: 12 },
  { id: 'cave', name: 'Deep Hollow', requiredLevel: 20 },
];

/**
 * A world just real enough to answer `travel`'s questions.
 * `entered` records what actually got built, which is what the void bugs broke.
 */
function makeWorld({ trainerLevel = 1, config = {}, economy = true, enterThrows = false } = {}) {
  const entered = [];
  const warnings = [];
  const errors = [];
  const modules = {
    city: {
      enter: async () => { entered.push('demo-city') },
      formation: () => ({ lead: 'trainer' }),
    },
    hunts: {
      list: () => BIOMES.map((b) => ({ ...b })),
      enter: async (id) => {
        if (enterThrows) throw new Error('scene build failed');
        entered.push(`hunt-${id}`);
      },
    },
    economy: economy ? { trainer: () => ({ level: trainerLevel }) } : null,
    encounter: { active: () => false, cancel: () => {} },
    simulation: { halt: () => {} },
    offline: null,
  };
  const ctx = {
    bus: { emit: () => {}, on: () => () => {} },
    config: { ...config, get: (k) => config[k] },
    log: {
      info: () => {},
      warn: (m) => warnings.push(String(m)),
      error: (m) => errors.push(String(m)),
    },
    get: (id) => modules[id] ?? nullObject(),
  };
  return { api: travel.init(ctx), entered, warnings, errors };
}

// --- the destination table --------------------------------------------------
{
  const { api } = makeWorld({ trainerLevel: 1 });
  const ids = api.destinations().map((d) => d.id);
  eq('1. the lobby is always first', ids[0], 'demo-city');
  eq('2. every biome hunts declares becomes a destination', ids.length, 1 + BIOMES.length);
  const locked = api.destinations().filter((d) => d.locked).map((d) => d.id);
  eq('3. a biome above the trainer\'s level is drawn locked', locked.join(','),
    'hunt-forest,hunt-coast,hunt-cave');
  const meadow = api.destinations().find((d) => d.id === 'hunt-meadow');
  eq('4. a biome at or below it is not', meadow.locked, false);
  check('5. a locked row carries a reason a panel can print', /Lv/.test(
    api.destinations().find((d) => d.id === 'hunt-cave').why ?? ''));
}

{
  // The fail-open rule. A quarantined ledger must cost the game its *shop*, not its map: a
  // gate that read a missing level as 0 would lock the player out of everything because of a
  // module they cannot see.
  const { api } = makeWorld({ economy: false });
  const locked = api.destinations().filter((d) => d.locked);
  eq('6. an unavailable economy fails OPEN — nothing is locked', locked.length, 0);
}

{
  const { api } = makeWorld({ trainerLevel: 20 });
  eq('7. a high enough level unlocks the whole map',
    api.destinations().filter((d) => d.locked).length, 0);
}

// --- go(): the gate ---------------------------------------------------------
{
  const { api, entered } = makeWorld({ trainerLevel: 1 });
  eq('8. go() refuses a locked destination', await api.go('hunt-cave'), false);
  eq('9. …and builds nothing when it refuses', entered.length, 0);
  eq('10. go() enters an unlocked one', await api.go('hunt-meadow'), true);
  eq('11. …and the scene it entered is the one asked for', entered.join(','), 'hunt-meadow');
  eq('12. current() reports where the player is', api.current().id, 'hunt-meadow');
}

{
  const { api } = makeWorld();
  eq('13. go() refuses an id that is not a destination', await api.go('atlantis'), false);
}

{
  // Both diagnostic knobs stand the gate down. `?showcase=` frames a module, `?scene=` is how
  // `tools/shots` frames a hunt at `/` — and the harness boots a fresh save, so every biome
  // is above the level. A gate that applied here frames an empty void instead of a map.
  const showcase = makeWorld({ trainerLevel: 1, config: { showcase: 'travel' } });
  eq('14. ?showcase= stands the gate down', await showcase.api.go('hunt-cave'), true);
  eq('15. …and really builds the scene', showcase.entered.join(','), 'hunt-cave');

  const scene = makeWorld({ trainerLevel: 1, config: { scene: 'hunt-cave' } });
  eq('16. ?scene= stands the gate down for the scene it names', await scene.api.go('hunt-cave'), true);
  eq('17. …and really builds that one too', scene.entered.join(','), 'hunt-cave');

  // Narrowly: `?scene=hunt-cave` excuses hunt-cave, not the whole map.
  const narrow = makeWorld({ trainerLevel: 1, config: { scene: 'hunt-cave' } });
  eq('18. ?scene= excuses only the scene it names', await narrow.api.go('hunt-coast'), false);
}

{
  const { api } = makeWorld({ trainerLevel: 20, enterThrows: true });
  eq('19. a scene that throws mid-build costs one failed hop', await api.go('hunt-cave'), false);
  eq('20. …and does not wedge travel for the rest of the session', await api.go('demo-city'), true);
}

// --- boot(): the decision that cannot answer "nowhere" ----------------------
{
  const { api } = makeWorld();
  eq('21. with nothing asked for and nothing saved, boot() is the lobby', api.boot(), 'demo-city');
}

{
  const { api } = makeWorld({ config: { scene: 'hunt-forest' }, trainerLevel: 1 });
  eq('22. ?scene= wins over everything', api.boot(), 'hunt-forest');
}

{
  const { api, warnings } = makeWorld({ config: { scene: 'atlantis' } });
  eq('23. an unknown ?scene= falls back to the lobby, not to nothing', api.boot(), 'demo-city');
  check('24. …and says so', warnings.some((w) => w.includes('atlantis')));
}

{
  const { api } = makeWorld({ trainerLevel: 20 });
  api.loadState({ v: 1, sceneId: 'hunt-cave' });
  eq('25. a saved scene the trainer can enter is where boot() goes', api.boot(), 'hunt-cave');
}

{
  // The bug that would have reached a player: a save written before the gate existed — or
  // restored onto an economy that has been reset — names a biome the trainer can no longer
  // enter. `go()` refuses it, and a boot with no fallback holds an empty map.
  const { api } = makeWorld({ trainerLevel: 1 });
  api.loadState({ v: 1, sceneId: 'hunt-cave' });
  eq('26. a saved scene the trainer can NO LONGER enter boots the lobby', api.boot(), 'demo-city');
}

{
  const { api } = makeWorld({ trainerLevel: 20 });
  api.loadState({ v: 1, sceneId: 'atlantis' });
  eq('27. a saved scene that no longer exists boots the lobby', api.boot(), 'demo-city');
}

{
  // Every shape a corrupt or foreign slice can take still has to answer a destination.
  const { api } = makeWorld();
  for (const [label, value] of [
    ['null', null], ['a string', 'hunt-cave'], ['an empty object', {}],
    ['a missing sceneId', { v: 1 }], ['a numeric sceneId', { v: 1, sceneId: 7 }],
  ]) {
    api.loadState(value);
    check(`28. boot() answers a destination for ${label}`, api.boot() === 'demo-city');
  }
}

{
  const { api, warnings } = makeWorld({ trainerLevel: 20 });
  eq('29. a save slice from a newer build is refused', api.loadState({ v: 99, sceneId: 'hunt-cave' }), false);
  check('30. …at warn, not error — a handled path spends no error budget',
    warnings.some((w) => w.includes('newer')));
  eq('31. …and boot() still answers the lobby', api.boot(), 'demo-city');
}

// --- the save seam ----------------------------------------------------------
{
  const { api } = makeWorld({ trainerLevel: 20 });
  await api.go('hunt-coast');
  const saved = api.saveState();
  eq('32. saveState records where the player is', saved.sceneId, 'hunt-coast');
  eq('33. …with a version on it', saved.v, 1);

  const fresh = makeWorld({ trainerLevel: 20 });
  fresh.api.loadState(saved);
  eq('34. a save round-trips into the next session\'s boot', fresh.api.boot(), 'hunt-coast');
}

{
  const { api } = makeWorld();
  eq('35. saveState before travelling records nothing, not a guess', api.saveState().sceneId, null);
}

// --- report -----------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
console.log(`\ntravel: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
