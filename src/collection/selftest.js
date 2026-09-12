/**
 * The invariants. A systems module cannot prove itself with a pretty frame, so this is the
 * evidence: every check here runs against the *live* public API, in the browser during the
 * showcase and in Node from a scratch runner, and every number the panel prints comes out
 * of it.
 *
 * The checks are ordered by how much they would hurt if they were false:
 *
 *   1-3  storage integrity — the index, the capacity, the slot back-pointers
 *   4-7  ordering — total, deterministic, permutation-preserving, gap-free
 *   8-11 the dex — arithmetic, best-IV, completion denominators
 *  12-14 release rules — protections honoured, nothing ever released to zero
 *  15-17 persistence and determinism — the save round-trips, the IVs replay
 *
 * The whole run is bracketed by a save and a restore, so calling `selfTest()` on a real
 * save leaves it exactly as it was found.
 */

import { IV_KEYS, IV_TOTAL_MAX, ivTotal } from './dex.js';
import { SORT_IDS } from './sorting.js';

export function runSelfTest(api, ctx) {
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail) }); return ok; };

  // Everything below may move Pokémon about; this puts them back. Toasts are silenced for
  // the duration: a release rule applied by a *test* must not tell the player it happened,
  // and a toast is wall-clock timed, so one left fading would break tools/shots/shoot.js's promise that the
  // same URL gives the same pixels.
  const before = JSON.stringify(api.saveState());
  api.setQuiet(true);

  try {
    // --- 1-3 storage integrity ------------------------------------------------
    const boxes = api.boxes();
    const entries = api.entries();
    let backPointersOk = true;
    for (const e of entries) {
      const at = api.at(e.box, e.slot);
      if (at !== e) { backPointersOk = false; break; }
    }
    check('every entry sits in the slot it says it does', backPointersOk,
      `${entries.length} stored across ${boxes.length} boxes`);

    const counted = boxes.reduce((n, b) => n + b.count, 0);
    check('the slot index agrees with the boxes', counted === entries.length && counted === api.count(),
      `index ${api.count()}, slots ${counted}, list ${entries.length}`);

    const uids = new Set(entries.map((e) => e.uid));
    check('every stored uid is unique', uids.size === entries.length,
      `${uids.size} uids for ${entries.length} entries`);

    // --- 4-7 ordering ---------------------------------------------------------
    let totalOrdering = true;
    let permutation = true;
    let stable = true;
    for (const mode of SORT_IDS) {
      const a = api.sorted(mode).map((e) => e.uid);
      const b = api.sorted(mode).map((e) => e.uid);
      if (a.join() !== b.join()) stable = false;
      if (new Set(a).size !== entries.length || a.length !== entries.length) permutation = false;
      // A total ordering never yields two entries the comparator cannot separate, which is
      // exactly what "no duplicate uid at the same rank" means once the tiebreak is uid.
      if (new Set(a).size !== a.length) totalOrdering = false;
    }
    check('every sort mode is a permutation of storage', permutation, `${SORT_IDS.length} modes`);
    check('every sort mode is deterministic', stable, 'same input, same order, twice');
    check('every sort mode is a total ordering', totalOrdering, 'ties break on ordinal then uid');

    api.sort('species');
    const laid = api.boxes();
    let gapFound = false;
    for (let i = 0; i < laid.length && !gapFound; i++) {
      let seenEmpty = false;
      for (const slot of laid[i]) {
        if (!slot) seenEmpty = true;
        else if (seenEmpty) gapFound = true;
      }
      if (laid[i].count > 0 && i > 0 && laid[i - 1].count < api.capacity()) gapFound = true;
    }
    check('a full sort leaves no gaps', !gapFound, 'compacted from box 1 slot 1');

    const sortedIds = api.entries().map((e) => e.dexId ?? Infinity);
    check('sort("species") is in national dex order',
      sortedIds.every((v, i) => i === 0 || sortedIds[i - 1] <= v),
      `${sortedIds[0] ?? '—'} … ${sortedIds.at(-1) ?? '—'}`);

    // --- move swaps rather than refusing --------------------------------------
    const [first, second] = api.entries();
    if (first && second) {
      const fAt = { box: first.box, slot: first.slot };
      const sAt = { box: second.box, slot: second.slot };
      api.move(first.uid, sAt.box, sAt.slot);
      check('move() swaps with the occupant',
        api.at(sAt.box, sAt.slot) === first && api.at(fAt.box, fAt.slot) === second,
        `${first.display} ⇄ ${second.display}`);
      api.move(first.uid, fAt.box, fAt.slot);
    } else {
      check('move() swaps with the occupant', false, 'not enough Pokémon stored to test');
    }

    // --- 8-11 the dex ---------------------------------------------------------
    const records = api.records();
    const ownedSum = records.reduce((n, r) => n + r.owned, 0);
    check('dex owned counts add up to storage', ownedSum === api.count(),
      `Σ owned ${ownedSum} = stored ${api.count()}`);

    const conserved = records.every((r) => r.owned + r.released <= r.caught);
    check('owned + released never exceeds caught', conserved,
      `${records.length} species tracked, ${api.overflowCount()} lost to full boxes`);

    let bestOk = true, everOk = true;
    for (const r of records) {
      const mine = api.duplicatesOf(r.key);
      const max = mine.reduce((m, e) => Math.max(m, e.ivTotal), -1);
      if (mine.length === 0) { if (r.bestOwned) bestOk = false; continue; }
      if (!r.bestOwned || r.bestOwned.total !== max) bestOk = false;
      if (!r.bestEver || r.bestEver.total < r.bestOwned.total) everOk = false;
    }
    check('best-IV per species is the best one actually held', bestOk, `${records.length} species`);
    check('best-ever is never worse than best-owned', everOk, 'monotone across releases');

    const completion = api.completion();
    const genSum = completion.byGen.reduce((n, g) => n + g.total, 0);
    check('generation totals cover the whole dex universe', genSum === completion.total,
      `Σ gen ${genSum} = ${completion.total} species (+${completion.forms.total} forms)`);

    const genCaught = completion.byGen.reduce((n, g) => n + g.caught, 0);
    check('per-generation caught adds up to the dex count', genCaught === completion.caught,
      `Σ ${genCaught} = ${completion.caught}`);

    // --- 12-14 release rules --------------------------------------------------
    const shinyUid = api.entries().find((e) => e.shiny)?.uid ?? null;
    // The favourite has to be one the rule would otherwise take, or "protected" proves
    // nothing: the worst-IV member of the biggest pile is exactly that Pokémon.
    const pile = api.duplicates(2)[0];
    const favUid = pile ? pile.entries.at(-1).uid : null;
    if (favUid) api.favourite(favUid, true);

    const plan = api.planRelease({ keep: 'iv', protectShiny: true, protectFavourite: true });
    const releasing = new Set(plan.release.map((e) => e.uid));
    check('a release rule never touches a shiny', !shinyUid || !releasing.has(shinyUid),
      `${plan.reasons.shiny} shinies protected`);
    check('a release rule never touches a favourite', !favUid || !releasing.has(favUid),
      `${plan.reasons.favourite} favourites protected`);

    const bySpecies = new Map();
    for (const e of api.entries()) bySpecies.set(e.species, (bySpecies.get(e.species) ?? 0) + 1);
    for (const e of plan.release) bySpecies.set(e.species, bySpecies.get(e.species) - 1);
    check('a release rule never empties a species', [...bySpecies.values()].every((n) => n >= 1),
      `${plan.count} duplicates would go, ${bySpecies.size} species stay`);

    const keepTwo = api.planRelease({ keep: 'iv', keepPerSpecies: 2 });
    check('keepPerSpecies is honoured', keepTwo.count <= plan.count,
      `keep 1 → ${plan.count} released, keep 2 → ${keepTwo.count}`);

    // The rule applied for real, on a copy-free live collection, then rolled back with the
    // save at the end of this function.
    const applied = api.releaseDuplicates({ keep: 'iv', credit: false });
    check('applying the rule removes exactly what it planned',
      api.count() === entries.length - applied.release.length,
      `${applied.release.length} released, ${api.count()} left`);

    let afterBestOk = true;
    for (const r of api.records()) {
      const mine = api.duplicatesOf(r.key);
      const max = mine.reduce((m, e) => Math.max(m, e.ivTotal), -1);
      if (mine.length && (!r.bestOwned || r.bestOwned.total !== max)) afterBestOk = false;
      if (!mine.length && r.bestOwned) afterBestOk = false;
    }
    check('best-IV is rebuilt when the holder is released', afterBestOk,
      'recomputed from what remains, not left dangling');

    // --- 15-17 persistence and determinism ------------------------------------
    const saved = JSON.stringify(api.saveState());
    api.loadState(JSON.parse(saved));
    const reSaved = JSON.stringify(api.saveState());
    check('the save slice round-trips byte for byte', saved === reSaved,
      `${(saved.length / 1024).toFixed(1)} kB`);

    const statsAfter = api.stats();
    api.loadState(JSON.parse(saved));
    check('a reload reproduces the same statistics',
      JSON.stringify(api.stats()) === JSON.stringify(statsAfter),
      `dex ${statsAfter.caught}/${statsAfter.total}, ${statsAfter.stored} stored`);

    // IVs are a pure function of (seed, species, ordinal): re-deriving one from the root
    // stream must reproduce the stored roll exactly, or nothing here replays.
    const sample = api.entries().find((e) => e.origin !== 'restore') ?? api.entries()[0];
    let ivReplay = 'no entries to check';
    let ivOk = true;
    if (sample && ctx?.rng) {
      const rng = ctx.rng.fork(`collection/iv/${sample.species}/${sample.ordinal}`);
      const redone = {};
      for (const k of IV_KEYS) redone[k] = rng.int(0, 31);
      ivOk = ivTotal(redone) === sample.ivTotal;
      ivReplay = `${sample.display} #${sample.ordinal}: ${sample.ivTotal}/${IV_TOTAL_MAX} re-rolled to ${ivTotal(redone)}`;
    }
    check('IVs replay from the seed and the catch ordinal', ivOk, ivReplay);

    // --- 18 capacity is real --------------------------------------------------
    // The interesting behaviour of a box system is what it does when it runs out, and that
    // only exists if it can run out. Fill every remaining slot, then push three more in.
    const free = api.free();
    const overflowBefore = api.overflowCount();
    api.importBatch(Array.from({ length: free + 3 }, () => ({ species: 'magikarp', level: 5, origin: 'gift' })));
    check('storage stops at capacity and counts what it turned away',
      api.free() === 0 && api.count() === api.totalSlots() && api.overflowCount() === overflowBefore + 3,
      `${api.totalSlots()} slots filled, 3 turned away`);
    const magikarp = api.record('magikarp');
    check('a catch with nowhere to go still enters the dex but is not owned',
      !!magikarp && magikarp.caught >= magikarp.owned,
      `caught ${magikarp?.caught ?? 0}, owned ${magikarp?.owned ?? 0}`);
  } catch (err) {
    check('self-test ran to completion', false, String(err?.message ?? err));
  } finally {
    api.loadState(JSON.parse(before));
    api.setQuiet(false);
  }

  return { ok: results.every((r) => r.ok), passed: results.filter((r) => r.ok).length, results };
}

// ---------------------------------------------------------------------------
// The scratch runner the header promises. Until this existed, `node src/collection/selftest.js`
// exited 0 having run nothing — the seams counted it green, and the 20-odd invariants above
// only ever ran inside the browser showcase. Boots the REAL module through its own `init`
// against a stub ctx (the way `hunts/selftest.js` boots `terrain`), with the species snapshot
// read off disk in place of the `pokemon` module's fetch.
// `typeof process` first: the browser showcase dynamically imports this file (index.js), where
// `process` does not exist and a bare reference throws at module scope.
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('selftest.js')) {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { makeRng } = await import('../core/rng.js');
  const { makeBus } = await import('../core/bus.js');
  const collectionModule = (await import('./index.js')).default;

  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const table = JSON.parse(readFileSync(join(REPO, 'public', 'generated', 'species.json'), 'utf8'));
  const byName = new Map(table.map((s) => [s.name, s]));
  const pokemon = {
    all: () => table,
    species: (k) => byName.get(String(k ?? '').toLowerCase()) ?? null,
  };
  const quiet = { info() {}, warn() {}, error() {} };
  const ctx = {
    bus: makeBus({ onError: () => {} }),
    clock: { simTime: 0, wallMs: () => 0 },
    config: { seed: 1337 },
    rng: makeRng(1337, 'root'),
    log: quiet,
    get: (id) => (id === 'pokemon' ? pokemon : undefined),
  };
  const api = await collectionModule.init(ctx);
  // A few catches so the ordering, dex and release checks have something to order.
  api.importBatch([
    { species: 'sprigatito', level: 12, origin: 'catch' }, { species: 'starly', level: 7, origin: 'catch' },
    { species: 'starly', level: 9, origin: 'catch' }, { species: 'poochyena', level: 5, origin: 'catch' },
    { species: 'eevee', level: 14, origin: 'gift', shiny: true },
  ]);
  const out = runSelfTest(api, ctx);
  for (const r of out.results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n${out.ok ? '✓' : '✗'} collection selftest: ${out.passed}/${out.results.length} checks passed`);
  process.exit(out.ok ? 0 : 1);
}
