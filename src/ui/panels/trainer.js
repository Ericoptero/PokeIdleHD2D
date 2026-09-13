/**
 * The trainer panel — the rest of what `economy` already computes about the trainer, which
 * until now the HUD reduced to one `TRAINER n` chip and a 1px bar (`hud.js`'s `drawClock`).
 * Level, wins-into-next, lifetime totals, active buffs, the eleven upgrade tracks, the dex
 * summary and a compact party readout, in one scrolling window — the first panel actually
 * built on `scrollArea` (`panels/common.js`), because it is the one most likely to
 * overflow a single screen: five sections, one of which (Upgrades) is eleven rows long by
 * itself and never gets shorter.
 *
 * `trainerModel(app)` is the whole content model, exported standalone the way `inventory.js`'s
 * `filterRows(app, tab, category)` is (the precedent for a panel whose row-building is
 * worth testing with no canvas) — a fake `economy` (plus, optionally, `collection`/`pokemon`)
 * off `ctx.get` is all a test needs. `layout(model)` turns that model into block heights with
 * no `g` at all, so the scrollable content's total height is a pure number a test can assert
 * on directly (`trainer.test.js`'s own "the Party section is reachable" case) rather than a
 * pixel a screenshot has to be read to confirm.
 */

import {
  C, windowFrame, section, scrollArea, fit,
} from './common.js';
import {
  meter, hpRamp, CURRENCY_COLOUR,
} from '../theme.js';
import { fmt, duration } from '../format.js';

const isLive = (api) => !!api && api.__missing === undefined;

/**
 * Every multiplier key `economy.multipliers()` can report, this panel's label for it, and
 * what "no bonus" looks like for that key (`economy/upgrades.js`'s own `EFFECT_BASE`,
 * duplicated here rather than imported: `tools/seams/run.js` rule 2 forbids a deep import
 * into `economy/`, and `hud.js`'s `WALLET` / `models/inventory.js`'s `CATEGORY_LABEL` already keep
 * this exact kind of UI-owned label table for an economy id). A row is only worth a line once
 * its value has moved off `base` — a fresh save's Bonuses section is otherwise eleven rows of
 * "no change yet".
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
 * dependency this panel needs to draw its own portrait.
 */
const TRAINER_PORTRAIT_URL = '/assets/trainer/hero.png';

/**
 * `src/pokemon/sprites.js`'s `TRAINER_SHEET`: 32×768, 24 frames of 32×32 in one column; the
 * south row is `[11, 12, 13, 21, 22, 23]` and 11 is the first walk frame (feet together).
 * Duplicated here rather than imported — `pokemon/sprites.js` is under `pokemon/`, and rule 2
 * forbids a deep import into it — `drawIcon` (`hud.js`) assumes a 2×4 Pokemon layout and does
 * not fit a single-column 24-frame trainer sheet, so this is its own small crop.
 */
const TRAINER_FRAME = 32;
const TRAINER_SOUTH_FRAME = 11;

function drawPortrait(g, x, y, size) {
  const img = g.image(TRAINER_PORTRAIT_URL);
  if (!img) { g.fill(x, y, size, size, C.deepShade); return; }
  const k = Math.max(1, Math.floor(size / TRAINER_FRAME));
  const d = TRAINER_FRAME * k;
  g.sprite(img, 0, TRAINER_SOUTH_FRAME * TRAINER_FRAME, TRAINER_FRAME, TRAINER_FRAME, x, y, d, d);
}

/**
 * The whole content model: five sections, in this fixed order, plus the header fields drawn
 * above them (portrait, level, wins-into-next, the four currencies). A free function of
 * `app` alone — no panel-local state — so a test builds it with nothing but a fake `ctx.get`.
 *
 * Every economy read degrades to an empty/default value when `economy` (or `collection`,
 * `pokemon`) is not live, the same "a quarantined module costs a blank chip, not a dead panel"
 * rule every other panel in this file follows.
 */
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
  // Three sources, concatenated into one flat list rather than three mini-sections: the
  // multiplier snapshot (already folds upgrades *and* held-item passives together, per
  // `economy/state.js`'s own `multipliers()`), the timed buffs (already self-expiring —
  // `buffs()` never returns one past its own `secondsLeft` window, so nothing here re-filters
  // it), and which held items are granting a passive at all.
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
      value: `×${Number(b.mult).toFixed(2)} · ${duration(b.secondsLeft)} left`,
      secondsLeft: b.secondsLeft,
    });
  }
  for (const row of bag) {
    if (row.category !== 'held' || !(row.n > 0)) continue;
    bonusRows.push({ id: row.id, label: row.name, value: 'held', desc: row.desc });
  }

  // --- Upgrades ----------------------------------------------------------------------------
  // Exactly as `upgrades()` already reports — level/max/cost, greyed when unaffordable, not
  // unlocked, or maxed. `id`/`level`/`cost`/`max` carried alongside the display fields so a
  // test can assert the numbers directly rather than parse a label.
  const upgradeRows = upgrades.map((u) => ({
    id: u.id,
    label: `${u.name} Lv ${u.level}/${u.max}`,
    level: u.level,
    max: u.max,
    cost: u.cost,
    affordable: u.affordable,
    unlocked: u.unlocked,
    value: u.level >= u.max ? 'MAXED' : `${symbolFor(u.currency)}${fmt(u.cost)}`,
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
  // Six rows, always — a compact summary (species, level, HP fraction), distinct from the party bar's
  // always-on bar: this sits inside a scrollable detail view, not a fixed overlay, and it never
  // needs a sprite (the bar already has one).
  const mon = app.ctx.get('pokemon');
  const roster = isLive(mon) && typeof mon.party === 'function' ? mon.party() : [];
  const partyRows = [];
  for (let i = 0; i < 6; i++) {
    const inst = roster[i];
    if (!inst) { partyRows.push({ filled: false, label: 'empty slot', value: '', dim: true }); continue; }
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
      { id: 'progress', label: 'PROGRESS', rows: progressRows, rowH: ROWH },
      { id: 'bonuses', label: 'BONUSES', rows: bonusRows, rowH: ROWH, empty: 'no active bonuses' },
      { id: 'upgrades', label: 'UPGRADES', rows: upgradeRows, rowH: ROWH },
      { id: 'dex', label: 'DEX', rows: dexRows, rowH: ROWH, empty: 'dex data unavailable' },
      { id: 'party', label: 'PARTY', rows: partyRows, rowH: ROWH_METER },
    ],
  };
}

// ---------------------------------------------------------------------------- layout (no `g`)

const ROWH = 9;
const ROWH_METER = 13;
const TITLE_H = 9;
const SECTION_PAD = 3;
const PORTRAIT_SIZE = 40;
const HEADER_H = PORTRAIT_SIZE + 6;
const WALLET_H = 13;
const GAP = 4;

/** A section's own drawn height: its title bar, a row of padding above and below, and at
 *  least one row (the "nothing yet" placeholder line when it is empty). */
function sectionHeight(sec) {
  const rows = Math.max(1, sec.rows.length);
  return TITLE_H + SECTION_PAD * 2 + rows * (sec.rowH ?? ROWH);
}

/**
 * The vertical stack `draw()` paints, and the one place its total height is computed — the
 * same function feeds `scrollArea`'s `contentH` and the draw loop below, so the two can never
 * disagree about how tall the content is. Pure: takes no `g`, so `trainer.test.js` can assert
 * on it directly (acceptance criterion 4 — "the Party section is reachable" is "it is the last
 * block in this list, and the list's own total is taller than the smallest tested buffer can
 * show at once", not a pixel read).
 */
export function layout(model) {
  const blocks = [
    { kind: 'header', h: HEADER_H },
    { kind: 'wallet', h: WALLET_H },
    ...model.sections.map((sec) => ({ kind: 'section', section: sec, h: sectionHeight(sec) })),
  ];
  let total = 0;
  blocks.forEach((b, i) => { total += b.h + (i < blocks.length - 1 ? GAP : 0); });
  return { blocks, total };
}

// --------------------------------------------------------------------------------- painting

/** One row: a label left, a value right, and — only when `frac` is a number (the Party
 *  section's HP fraction) — a small meter underneath. */
function drawRow(g, x, y, w, row) {
  const ink = row.dim ? C.stoneShadow : C.ink;
  const valueW = row.value ? g.measure(row.value) : 0;
  g.text(x, y, row.label, ink, { max: Math.max(10, w - valueW - 6) });
  if (row.value) g.textRight(x + w, y, row.value, ink);
  if (Number.isFinite(row.frac)) {
    meter(g, { x, y: y + 8, w, h: 3 }, row.frac, { ...hpRamp(row.frac), back: C.wallDeep });
  }
}

function drawSection(g, x, y, w, sec) {
  const h = sectionHeight(sec);
  const box = section(g, {
    x, y, w, h,
  }, sec.label, { bar: C.stoneShadow, light: C.stoneBase });
  const rowH = sec.rowH ?? ROWH;
  if (!sec.rows.length) {
    g.text(box.x + 2, box.y + 2, sec.empty ?? 'nothing yet', C.stoneShadow);
  } else {
    sec.rows.forEach((row, i) => drawRow(g, box.x + 2, box.y + 2 + i * rowH, box.w - 4, row));
  }
  return h;
}

export function makeTrainer(app) {
  let top = 0;

  return {
    id: 'trainer',
    // No `full: true` here — that flag is only a record of the six panels that used to stand
    // the whole HUD down before `full` became inert; this is a new panel and never did.
    open() { top = 0; },
    close() {},
    key() { return false; },

    /** Not part of the panel contract `ui/index.js` drives — `travel.js`'s `rows()`/
     *  `inventory.js`'s `filterRows` precedent for exposing the content model a test (or a
     *  flow, through `ui._state.panel.model()`) needs with no canvas. */
    model: () => trainerModel(app),

    draw(g) {
      const model = trainerModel(app);
      const { blocks, total } = layout(model);

      const win = windowFrame(g, {
        windowId: 'trainer', reserved: app.hudReserved(),
        title: 'TRAINER', bar: C.roofBase, edge: C.roofDeep, light: C.roofLight,
        footer: 'scroll for more    X close',
        onClose: () => app.close(), ...fit(g, 280, 300),
      });

      const out = scrollArea(g, win, {
        contentH: total,
        top,
        tag: 'trainer-scroll',
        draw(gg, box, scrolledTop) {
          let y = box.y - scrolledTop;
          for (const b of blocks) {
            if (b.kind === 'header') {
              drawPortrait(gg, box.x, y, PORTRAIT_SIZE);
              const hx = box.x + PORTRAIT_SIZE + 6;
              const hw = box.w - PORTRAIT_SIZE - 6;
              gg.text(hx, y + 1, `TRAINER ${model.level}`, C.ink);
              gg.text(hx, y + 11, `${fmt(model.wins)} wins`, C.shadowInk);
              const frac = model.need > 0 ? Math.max(0, Math.min(1, model.into / model.need)) : 0;
              meter(gg, {
                x: hx, y: y + 21, w: hw, h: 5,
              }, frac, { fill: C.martBase, light: C.martLight, back: C.wallDeep });
              gg.text(hx, y + 28, `${fmt(model.into)} / ${fmt(model.need)} to Lv ${model.level + 1}`, C.stoneShadow, { max: hw });
            } else if (b.kind === 'wallet') {
              let cx = box.x;
              for (const c of model.currencies) {
                const text = `${c.symbol}${fmt(c.balance)}`;
                gg.text(cx, y + 2, text, CURRENCY_COLOUR[c.id] ?? C.ink);
                cx += gg.measure(text) + 14;
              }
            } else {
              drawSection(gg, box.x, y, box.w, b.section);
            }
            y += b.h + GAP;
          }
        },
      });
      top = out.top;
    },
  };
}
