/**
 * The trainer model — pure, DOM-free, lifted out of `panels/trainer.js` when its view
 * converted to a DOM screen (`screens/trainer.js`, Stage 6). `layout(model)` — the second half
 * `panels/trainer.js` used to turn this into canvas block heights for `scrollArea` — did not
 * move with it: a DOM screen scrolls natively, so there is nothing left to compute a pixel
 * total for. What is worth pinning is unchanged: five sections, in this fixed order, plus the
 * header fields (portrait, level, wins-into-next, the four currencies).
 *
 * Every economy read degrades to an empty/default value when `economy` (or `collection`,
 * `pokemon`) is not live, the same "a quarantined module costs a blank chip, not a dead panel"
 * rule every other screen in this app follows.
 */

import { duration } from '../format.js';

const isLive = (api) => !!api && api.__missing === undefined;

/**
 * Every multiplier key `economy.multipliers()` can report, this model's label for it, and
 * what "no bonus" looks like for that key (`economy/upgrades.js`'s own `EFFECT_BASE`,
 * duplicated here rather than imported: `tools/seams/run.js` rule 2 forbids a deep import
 * into `economy/`, and `hud.js`'s `WALLET` / `models/inventory.js`'s `CATEGORY_LABEL` already
 * keep this exact kind of UI-owned label table for an economy id). A row is only worth a line
 * once its value has moved off `base` — a fresh save's Bonuses section is otherwise eleven
 * rows of "no change yet".
 */
const EFFECTS = [
  ['moneyGain', 'Money', 1], ['expGain', 'EXP', 1], ['encounterRate', 'Encounter rate', 1],
  ['catchRate', 'Catch rate', 1], ['shinyOdds', 'Shiny odds', 1], ['sellValue', 'Sell value', 1],
  ['ballDiscount', 'Ball discount', 1], ['bpGain', 'Battle Points', 1], ['shardFind', 'Shard find', 1],
  ['bagSlots', 'Bag capacity', 0], ['offlineHours', 'Offline hours', 0],
];
const EFFECT_LABEL = Object.fromEntries(EFFECTS.map(([key, label]) => [key, label]));

/** `+50%` for a `mult`-mode effect (base 1); `+2`/`+2.5` for a `flat`-mode one (base 0). */
function fmtEffect(value, base) {
  if (base === 0) return Number.isInteger(value) ? `+${value}` : `+${value.toFixed(1)}`;
  const pct = Math.round((value - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

/**
 * `assets/trainer/hero.png`, always. `simulation/index.js`'s own `trainerWho` (the party's
 * on-screen avatar) is a private local that starts at `'hero'` and nothing in the game ever
 * writes to it — `city/layout.js`'s `heroine` entries are NPCs, not the player — so there is
 * no live "which trainer" to read through `ctx.get` at all yet, and no `simulation`/`pokemon`
 * dependency this screen needs to draw its own portrait.
 */
export const TRAINER_PORTRAIT_URL = '/assets/trainer/hero.png';

/**
 * `src/pokemon/sprites.js`'s `TRAINER_SHEET`: 32×768, 24 frames of 32×32 in one column; the
 * south row is `[11, 12, 13, 21, 22, 23]` and 11 is the first walk frame (feet together).
 * Duplicated here rather than imported — `pokemon/sprites.js` is under `pokemon/`, and rule 2
 * forbids a deep import into it.
 */
export const TRAINER_FRAME_COUNT = 24;
export const TRAINER_SOUTH_FRAME = 11;

export function trainerModel(app) {
  const eco = app.ctx.get('economy');
  const live = isLive(eco);

  const trainer = live && typeof eco.trainer === 'function'
    ? eco.trainer() : { level: 1, wins: 0, into: 0, need: 1, next: 1 };
  const progress = live && typeof eco.progress === 'function' ? eco.progress() : {};
  const stats = live && typeof eco.stats === 'function' ? eco.stats() : {};
  const currencies = live && typeof eco.currencies === 'function' ? eco.currencies() : [];
  const mult = live && typeof eco.multipliers === 'function' ? eco.multipliers() : {};
  const buffs = live && typeof eco.buffs === 'function' ? eco.buffs() : [];
  const bag = live && typeof eco.bag === 'function' ? eco.bag() : [];
  const upgrades = live && typeof eco.upgrades === 'function' ? eco.upgrades() : [];

  const symbolFor = (id) => currencies.find((c) => c.id === id)?.symbol ?? '';

  // --- Progress --------------------------------------------------------------------------
  const progressRows = [
    { key: 'dexCaught', label: 'Pokédex caught', value: String(progress.dexCaught ?? 0) },
    { key: 'battlesWon', label: 'Battles won', value: String(progress.battlesWon ?? 0) },
    { key: 'itemsBought', label: 'Items bought', value: String(progress.itemsBought ?? 0) },
    { key: 'ballsThrown', label: 'Balls thrown', value: String(stats.ballsThrown ?? 0) },
    { key: 'playSeconds', label: 'Time played', value: duration(progress.playSeconds ?? 0) },
  ];

  // --- Bonuses -----------------------------------------------------------------------------
  const bonusRows = [];
  for (const [key, label, base] of EFFECTS) {
    const value = mult[key];
    if (!Number.isFinite(value) || Math.abs(value - base) < 1e-9) continue;
    bonusRows.push({ key, label, value: fmtEffect(value, base), raw: value });
  }
  for (const b of buffs) {
    bonusRows.push({
      key: b.key,
      id: b.id,
      label: `${EFFECT_LABEL[b.key] ?? b.key} (timed)`,
      value: `×${Number(b.mult).toFixed(2)}`,
      secondsLeft: b.secondsLeft,
    });
  }
  for (const row of bag) {
    if (row.category !== 'held' || !(row.n > 0)) continue;
    bonusRows.push({ id: row.id, label: row.name, value: 'held', desc: row.desc });
  }

  // --- Upgrades ----------------------------------------------------------------------------
  const upgradeRows = upgrades.map((u) => ({
    id: u.id,
    label: `${u.name} Lv ${u.level}/${u.max}`,
    level: u.level,
    max: u.max,
    cost: u.cost,
    affordable: u.affordable,
    unlocked: u.unlocked,
    value: u.level >= u.max ? 'MAXED' : `${symbolFor(u.currency)}${Math.floor(u.cost).toLocaleString('en-US')}`,
    dim: u.level >= u.max || !u.unlocked || !u.affordable,
  }));

  // --- Dex ---------------------------------------------------------------------------------
  const dexApi = app.ctx.get('collection');
  const completion = isLive(dexApi) && typeof dexApi.completion === 'function' ? dexApi.completion() : null;
  const dexRows = completion ? [
    { key: 'seen', label: 'Seen', value: `${completion.seen}/${completion.total} (${completion.seenPct}%)` },
    { key: 'caught', label: 'Caught', value: `${completion.caught}/${completion.total} (${completion.caughtPct}%)` },
    { key: 'owned', label: 'Owned (living dex)', value: `${completion.owned}/${completion.total} (${completion.livingPct}%)` },
    { key: 'forms', label: 'Forms', value: `${completion.forms.caught}/${completion.forms.total} (${completion.forms.pct}%)` },
  ] : [];

  // --- Party -------------------------------------------------------------------------------
  const mon = app.ctx.get('pokemon');
  const roster = isLive(mon) && typeof mon.party === 'function' ? mon.party() : [];
  const partyRows = [];
  for (let i = 0; i < 6; i++) {
    const inst = roster[i];
    if (!inst) { partyRows.push({ filled: false, label: 'Empty slot', value: '', dim: true }); continue; }
    const hp = Math.max(0, Number(inst.hp) || 0);
    const maxHp = Math.max(1, Number(inst.maxHp) || 1);
    const display = typeof app.hud?.displayName === 'function'
      ? app.hud.displayName(inst.species) : (inst.species?.name ?? '?');
    partyRows.push({
      filled: true,
      label: `${display} Lv${inst.level ?? 1}`,
      value: `${Math.floor(hp)}/${Math.floor(maxHp)}`,
      frac: hp / maxHp,
    });
  }

  return {
    portraitUrl: TRAINER_PORTRAIT_URL,
    level: trainer.level,
    wins: trainer.wins,
    into: trainer.into,
    need: trainer.need,
    next: trainer.next,
    currencies,
    sections: [
      { id: 'progress', label: 'Progress', rows: progressRows },
      { id: 'bonuses', label: 'Bonuses', rows: bonusRows, empty: 'No active bonuses.' },
      { id: 'upgrades', label: 'Upgrades', rows: upgradeRows },
      { id: 'dex', label: 'Dex', rows: dexRows, empty: 'Dex data unavailable.' },
      { id: 'party', label: 'Party', rows: partyRows },
    ],
  };
}
