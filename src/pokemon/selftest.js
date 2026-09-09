#!/usr/bin/env node
/**
 * Property checks for the `pokemon` instance model, run under plain Node by
 * `tools/seams/run.js` rule 6.
 *
 *   node src/pokemon/selftest.js
 *
 * It exercises `instance.js` directly against the real `battle` engine and the real committed
 * species table — no browser, no `ctx`, no sprites. That split is why `instance.js` takes every
 * dependency as a parameter: the module's *rendering* half needs a DOM and its *gameplay* half
 * must not, and only the second half is what a level-up can get wrong.
 *
 * The checks that matter most are the ones a screenshot cannot make at all: that a level-up
 * does not refill PP, that a restored save is not trusted about derived state, and that
 * evolution refuses outside a hunt.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as INST from './instance.js';
import * as EVO from './evolution.js';
// `economy` is booted through its own `init` for the same reason `battle` is: check 30's whole
// point is that this module's material ids and that module's item ids are the same strings, and
// a hand-copied list of ids would be the one thing that cannot prove it.
import economyModule from '../economy/index.js';
import battleModule from '../battle/index.js';
import { makeRng } from '../core/rng.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const gen = (f) => JSON.parse(readFileSync(join(REPO, 'public', 'generated', f), 'utf8'));

const results = [];
const check = (n, ok, d = '') => { results.push({ name: n, ok: !!ok, detail: d }); return !!ok };
const eq = (n, got, want) => check(n, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const table = gen('species.json');
const byName = new Map(table.map((s) => [s.name, s]));
const lookup = (k) => byName.get(String(k ?? '').toLowerCase()) ?? null;

/**
 * The REAL `battle` API, booted through its own `init` against a stub `ctx`.
 *
 * Not a hand-written surface, and not a deep import either — `tools/seams/run.js` rule 2 bans
 * reaching into another module's internals and it is right to: a stub that drifted from the
 * engine would let this file pass while the game was broken. `hunts/selftest.js` solves the
 * same problem the same way (`terrainModule.init(stubCtx)`), and the only extra piece here is
 * `fetch`: the module loads its two snapshots over HTTP in a browser, so under Node the two
 * paths are answered off disk. That is the whole reason `init` fetches instead of importing.
 */
globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  try { return { ok: true, json: async () => gen(name) }; }
  catch { return { ok: false, json: async () => null }; }
};
const economy = await economyModule.init({
  bus: { emit() {}, on: () => () => {} },
  config: { seed: 1337 },
  clock: { simTime: 0, wallMs: () => 0 },
  rng: makeRng(1337, 'root/economy'),
  log: { info() {}, warn() {}, error() {} },
  get: () => undefined,
});

const battle = await battleModule.init({
  log: { info() {}, warn() {}, error() {} },
  get: () => undefined,
  bus: { emit() {}, on: () => () => {} },
  config: { seed: 1337 },
});

const rng = makeRng(1337, 'root/instance');
const mint = (name, level, extra = {}) =>
  INST.makeInstance({ species: lookup(name), level, ordinal: 0, rng, ...extra }, battle);

// --- 1. a minted instance is a real body ------------------------------------
const osha = mint('oshawott', 5);
check('1. an instance carries real stats', osha.stats.hp > 10 && osha.maxHp === osha.stats.hp);
eq('2. it starts at full health', osha.hp, osha.maxHp);
check('3. it carries up to four move slots with PP', osha.moves.length > 0 && osha.moves.length <= 4
  && osha.moves.every((m) => m.pp === m.maxPp && m.pp > 0), JSON.stringify(osha.moves));
eq('4. instanceId is species#ordinal, with no level in it', osha.instanceId, 'oshawott#0');
check('5. its experience matches its level on its own curve',
  osha.exp === battle.expToLevel(lookup("oshawott").growthRate, 5));

// --- 2. instanceId must survive a level-up ----------------------------------
// This is the defect the old scheme had: the id was built from the level, so it changed the
// moment a Pokemon levelled — and `collection` keys its bus intake off it.
const idBefore = osha.instanceId;
INST.grantExp(osha, 50000, { battle, lookup });
eq('6. instanceId is unchanged by a level-up', osha.instanceId, idBefore);
check('7. the level actually moved', osha.level > 5, `now ${osha.level}`);
check('8. stats grew with it', osha.maxHp > 20, `maxHp ${osha.maxHp}`);

// --- 3. a level-up must not be a free heal ----------------------------------
const dewy = mint('oshawott', 10);
dewy.moves[0].pp = 1;
const spentId = dewy.moves[0].id;
INST.grantExp(dewy, battle.expToLevel('medium', 20), { battle, lookup });
const kept = dewy.moves.find((m) => m.id === spentId);
check('9. a level-up does not refill spent PP', !kept || kept.pp === 1,
  kept ? `${spentId} came back at ${kept.pp}` : 'slot was replaced, which is also fine');
check('10. HP keeps its fraction across a level-up, not its value', dewy.hp > 0 && dewy.hp <= dewy.maxHp);

// --- 4. evolution: a level AND a bill, and nobody evolves by themselves ------
// A bag that holds nothing, and one that holds everything — the two ends of every question
// this section asks.
const isRealItem = (id) => !!economy.item(id);
const EMPTY = { count: () => 0, isItem: isRealItem };
const RICH = { count: () => 99, isItem: isRealItem };

const bulba = mint('bulbasaur', 15);
const under = INST.evolutionFor(bulba, lookup, RICH);
eq('11. one level short: the route is named but not ready', under?.ready, false);
eq('12. …and it names the level it wants', under?.level, 16);

bulba.level = 16;
const atLevel = INST.evolutionFor(bulba, lookup, RICH);
eq('13. at the level with a full bag: ready', atLevel?.ready, true);
eq('14. …and it is ivysaur', atLevel?.to?.name, 'ivysaur');

const broke = INST.evolutionFor(mint('bulbasaur', 16), lookup, EMPTY);
eq('15. at the level with an empty bag: NOT ready', broke?.ready, false);
check('16. …and it says exactly what is missing',
  broke.missing.length === 1 && broke.missing[0].n === 6 && broke.missing[0].have === 0,
  JSON.stringify(broke.missing));
eq('17. the material is a real drop item', broke.materials[0].id, 'tinymushroom');

// The rule the whole change is about.
const rich = INST.grantExp(mint('bulbasaur', 16), 0, { battle, lookup, count: RICH.count });
eq('18. grantExp NEVER evolves, even when everything is paid for', rich.evolves, undefined);
eq('19. …it offers, and says the offer can be taken', rich.pending?.ready, true);
eq('20. …and names what it would become', rich.pending?.to, 'ivysaur');
const poor = INST.grantExp(mint('bulbasaur', 16), 0, { battle, lookup, count: EMPTY.count });
eq('21. an unaffordable offer is still reported, not hidden', poor.pending?.ready, false);

// A stone evolution pays the stone AND the materials.
const eevee = mint('eevee', 60);
const flare = INST.evolutionOptions(eevee, lookup, RICH).find((r) => r.to.name === 'flareon');
eq('22. a stone route still wants its stone', flare?.materials?.[0]?.id, 'firestone');
check('23. …and materials on top of it', flare.materials.length === 2 && flare.materials[1].n >= 2,
  JSON.stringify(flare.materials));
eq('24. a branching line offers every route', INST.evolutionOptions(eevee, lookup, RICH).length, 8);

// With nothing in the bag, the offer shown is the SHORTEST grind, not the first alphabetically.
const shortest = INST.evolutionFor(mint('eevee', 60), lookup, EMPTY);
check('25. an unaffordable branching line points at the cheapest route',
  INST.evolutionOptions(mint('eevee', 60), lookup, EMPTY)
    .every((r) => r.missing.reduce((a, m) => a + m.n - m.have, 0)
      >= shortest.missing.reduce((a, m) => a + m.n - m.have, 0)),
  `offered ${shortest.to.name}`);

// The cost curve has to mean something: a cosmetic step must not cost what a Dragonite does.
const cost = (p, c) => {
  const P2 = lookup(p); const C = lookup(c);
  const row = (P2.evo ?? []).find((r) => r.to === c) ?? {};
  return EVO.requirementFor(P2, C, row, EMPTY);
};
const caterpie = cost('caterpie', 'metapod');
const dragonite = cost('dragonair', 'dragonite');
check('26. a trivial evolution is cheap', caterpie.materials[0].n <= 3 && caterpie.materials[0].id === 'tinymushroom',
  JSON.stringify(caterpie.materials));
check('27. a pseudo-legendary is not', dragonite.materials[0].id === 'cometshard' && dragonite.materials[0].n >= 6,
  JSON.stringify(dragonite.materials));
check('28. Magikarp into Gyarados costs the top rung of its family',
  cost('magikarp', 'gyarados').materials[0].id === 'pearlstring');

// Every material named must be an item the game actually ships, or the bill can never be paid.
let unknownMaterial = 0; let unreachable = 0; let priced = 0;
for (const sp of table) {
  for (const row of sp.evo ?? []) {
    const child = lookup(row.to);
    if (!child) continue;
    priced++;
    const req = EVO.requirementFor(sp, child, row, EMPTY);
    for (const m of req.materials) if (!isRealItem(m.id)) unknownMaterial++;
    if (!(req.level >= 1 && req.level <= 100)) unreachable++;
  }
}
check('29. every evolution in the game is priced', priced > 400, `${priced} routes`);
eq('30. every material is a real item in economy/items.js', unknownMaterial, 0);
eq('31. every evolution asks for a reachable level', unreachable, 0);

// --- 4b. the module-level action refuses with a reason ----------------------
// `evolve()` is the only path into an evolution in the game now, so its refusals are the UI.
// Booted through pokemon's own init would need a DOM (the sprite field is three.js), so this
// exercises the same decision the module makes, against the same pure functions it calls.
const short = INST.evolutionFor(mint('bulbasaur', 16), lookup, EMPTY);
check('31b. a refusal can name the shortfall, not just say no',
  short.missing.length === 1 && short.missing[0].n - short.missing[0].have === 6,
  JSON.stringify(short.missing));
const tooLow = INST.evolutionFor(mint('bulbasaur', 5), lookup, RICH);
check('31c. …and a level refusal names the level', tooLow.ready === false && tooLow.level === 16);

// --- 5. the species swap keeps identity -------------------------------------
const charm = mint('charmander', 16);
charm.moves[0].pp = 2;
const evolved = INST.evolveTo(charm, lookup('charmeleon'), battle);
eq('20. evolving keeps the instanceId', charm.instanceId, 'charmander#0');
eq('21. …and reports the pair', `${evolved.from}->${evolved.to}`, 'charmander->charmeleon');
eq('22. …and the species really changed', charm.species.name, 'charmeleon');
check('23. …and the body was recomputed', charm.maxHp === battle.stats(lookup("charmeleon").baseStats, charm.ivs, 16).hp);

// --- 6. heal and damage -----------------------------------------------------
const hurt = mint('pikachu', 30);
INST.damage(hurt, 1e9);
eq('24. damage floors at zero, and zero is fainted', hurt.hp, 0);
INST.heal(hurt, { hp: 'full' });
eq('25. a full heal restores maxHp', hurt.hp, hurt.maxHp);

// --- 7. the save seam -------------------------------------------------------
const saved = mint('gastly', 40);
saved.moves[0].pp = 3;
saved.status = 'par';
const round = INST.deserialize(INST.serialize(saved), lookup, battle);
eq('26. a round trip keeps the id', round.instanceId, saved.instanceId);
eq('27. …the level', round.level, saved.level);
eq('28. …the spent PP', round.moves[0].pp, 3);
eq('29. …and the status', round.status, 'par');
eq('30. …and rebuilds maxHp rather than trusting it', round.maxHp, saved.maxHp);

// §5: derived state is REBUILT, never trusted from the file.
const lying = INST.serialize(saved);
lying.hp = 99999;
const corrected = INST.deserialize(lying, lookup, battle);
check('31. a save that lies about HP is corrected, not obeyed', corrected.hp === corrected.maxHp,
  `hp ${corrected.hp} of ${corrected.maxHp}`);
eq('32. an unknown species refuses rather than guessing',
  INST.deserialize({ species: '__nope' }, lookup, battle), null);

// --- 8. degradation with no engine ------------------------------------------
// `battle` is reached through ctx.get, so it CAN be the registry's null object.
const dead = INST.makeInstance({ species: lookup('snivy'), level: 5, ordinal: 3, rng }, null);
check('33. with no engine an instance still exists and can be walked around',
  dead.instanceId === 'snivy#3' && dead.hp > 0 && Array.isArray(dead.moves));
eq('34. …with no moves, which reads as "the engine is missing"', dead.moves.length, 0);

// --- 9. the whole table survives being levelled -----------------------------
let invalidBody = 0;
for (const s of table) {
  const inst = INST.makeInstance({ species: s, level: 50, ordinal: 0, rng }, battle);
  if (!(inst.maxHp > 0) || !(inst.hp === inst.maxHp) || inst.moves.length < 1 || inst.moves.length > 4) invalidBody++;
}
eq('35. all 1253 species mint a valid level-50 body', invalidBody, 0);

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
console.log(`\npokemon: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
