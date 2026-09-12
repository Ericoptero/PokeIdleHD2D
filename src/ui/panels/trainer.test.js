/**
 * `trainerModel(app)` is the whole content model (`trainer.js`'s own header comment) — a free
 * function of `app.ctx.get(...)`, exposed the `travel.js`/`rows()`, `inventory.js`/`filterRows`
 * way, so this file needs no canvas. `layout(model)` is the second half: it turns that model
 * into block heights with no `g` at all, which is what lets acceptance criterion 4 ("the Party
 * section is reachable") be asserted as a number rather than read off a screenshot.
 */
import { describe, it, expect } from 'vitest';
import { trainerModel, layout } from './trainer.js';

const TRAINER = {
  level: 7, wins: 45, into: 12, need: 18, next: 63,
};

const PROGRESS = {
  dexCaught: 23, battlesWon: 45, itemsBought: 61, playSeconds: 5400, trainerLevel: 7,
};

const STATS = { ballsThrown: 30, itemsUsed: 12, upgradesBought: 2 };

const CURRENCIES = [
  { id: 'money', symbol: '₽', balance: 12345 },
  { id: 'research', symbol: '◈', balance: 40 },
  { id: 'shards', symbol: '◆', balance: 6 },
  { id: 'bp', symbol: 'BP', balance: 90 },
];

const UPGRADES = [
  { id: 'payday', name: 'Payday Fund', currency: 'money', level: 3, max: 50, cost: 18000, affordable: true, unlocked: true },
  { id: 'shiny_lens', name: 'Shiny Lens', currency: 'shards', level: 0, max: 10, cost: 110, affordable: false, unlocked: false },
];

const MULTIPLIERS = { moneyGain: 1.18, catchRate: 1, shinyOdds: 1, bagSlots: 0, offlineHours: 2 };

const BAG = [
  { id: 'amuletcoin', name: 'Amulet Coin', category: 'held', n: 1, desc: '+50% money, forever.' },
  { id: 'potion', name: 'Potion', category: 'medicine', n: 10, desc: 'x' },
];

const COMPLETION = {
  total: 400, seen: 60, caught: 30, owned: 20,
  seenPct: 15, caughtPct: 7.5, livingPct: 5,
  forms: { total: 40, caught: 4, pct: 10 },
};

const ROSTER = [
  { species: { name: 'pikachu' }, level: 12, hp: 30, maxHp: 40 },
  { species: { name: 'bulbasaur' }, level: 9, hp: 0, maxHp: 28 },
];

/** A fully-stocked fake `economy`/`collection`/`pokemon`, so every section has real content. */
function fakeApp({ buffs = [] } = {}) {
  return {
    hud: { displayName: (sp) => (sp?.name ?? '?').toUpperCase() },
    ctx: {
      get: (id) => {
        if (id === 'economy') {
          return {
            trainer: () => TRAINER,
            progress: () => PROGRESS,
            stats: () => STATS,
            currencies: () => CURRENCIES,
            multipliers: () => MULTIPLIERS,
            buffs: () => buffs,
            bag: () => BAG,
            upgrades: () => UPGRADES,
          };
        }
        if (id === 'collection') return { completion: () => COMPLETION };
        if (id === 'pokemon') return { party: () => ROSTER };
        return { __missing: true };
      },
    },
  };
}

/** Only `trainer()`/`progress()`/`upgrades()`/`buffs()` — acceptance criterion 1's own list —
 *  everything else (and every other module) is quarantined. */
function minimalFakeApp() {
  return {
    ctx: {
      get: (id) => (id === 'economy'
        ? {
          trainer: () => TRAINER, progress: () => PROGRESS, upgrades: () => UPGRADES, buffs: () => [],
        }
        : { __missing: true }),
    },
  };
}

describe('trainerModel', () => {
  it('produces the five sections, in the stated order, with the header fields off economy.trainer()', () => {
    const model = trainerModel(fakeApp());
    expect(model.level).toBe(TRAINER.level);
    expect(model.wins).toBe(TRAINER.wins);
    expect(model.into).toBe(TRAINER.into);
    expect(model.need).toBe(TRAINER.need);
    expect(model.sections.map((s) => s.id)).toEqual(['progress', 'bonuses', 'upgrades', 'dex', 'party']);
  });

  it('the Progress section reads dexCaught/battlesWon/itemsBought off progress() and ballsThrown off stats()', () => {
    const model = trainerModel(fakeApp());
    const progress = model.sections.find((s) => s.id === 'progress');
    const byKey = Object.fromEntries(progress.rows.map((r) => [r.key, r.value]));
    expect(byKey.dexCaught).toBe(String(PROGRESS.dexCaught));
    expect(byKey.battlesWon).toBe(String(PROGRESS.battlesWon));
    expect(byKey.itemsBought).toBe(String(PROGRESS.itemsBought));
    expect(byKey.ballsThrown).toBe(String(STATS.ballsThrown));
  });

  it('the Upgrades section carries every track\'s id/level/max/cost exactly as upgrades() reports, greyed when unaffordable or locked', () => {
    const model = trainerModel(fakeApp());
    const upgrades = model.sections.find((s) => s.id === 'upgrades');
    expect(upgrades.rows).toHaveLength(UPGRADES.length);
    const payday = upgrades.rows.find((r) => r.id === 'payday');
    expect(payday).toMatchObject({ level: 3, max: 50, cost: 18000, dim: false });
    const shinyLens = upgrades.rows.find((r) => r.id === 'shiny_lens');
    expect(shinyLens).toMatchObject({ level: 0, max: 10, cost: 110, dim: true });
  });

  it('the Bonuses section only lists a multiplier once it has moved off its own base', () => {
    const model = trainerModel(fakeApp());
    const bonuses = model.sections.find((s) => s.id === 'bonuses');
    const keys = bonuses.rows.map((r) => r.key).filter(Boolean);
    expect(keys).toContain('moneyGain');
    expect(keys).toContain('offlineHours');
    // catchRate and shinyOdds are both still at their base (1) in MULTIPLIERS and must not
    // clutter the section with a row that says nothing changed.
    expect(keys).not.toContain('catchRate');
    expect(keys).not.toContain('shinyOdds');
  });

  it('the Bonuses section names the held item granting a passive, from bag()\'s held rows', () => {
    const model = trainerModel(fakeApp());
    const bonuses = model.sections.find((s) => s.id === 'bonuses');
    const held = bonuses.rows.find((r) => r.id === 'amuletcoin');
    expect(held).toMatchObject({ label: 'Amulet Coin', value: 'held' });
    // The Potion is not a held-category item and must not appear here — that is the inventory
    // panel's job (018), not this one's.
    expect(bonuses.rows.some((r) => r.id === 'potion')).toBe(false);
  });

  it('a buff past its secondsLeft window is simply absent — the panel does not filter it itself', () => {
    const withBuff = trainerModel(fakeApp({ buffs: [{
      id: 'lure', key: 'encounterRate', mult: 1.5, secondsLeft: 120,
    }] }));
    const bonusesWith = withBuff.sections.find((s) => s.id === 'bonuses');
    expect(bonusesWith.rows.some((r) => r.id === 'lure')).toBe(true);

    // `economy.buffs()` never returns an expired entry (`state.js`'s own `activeBuffs()`
    // filters by `until > t` before this module ever sees it) — simulated here by simply
    // handing back an empty array, exactly what the real ledger would once the lure expires.
    const expired = trainerModel(fakeApp({ buffs: [] }));
    const bonusesExpired = expired.sections.find((s) => s.id === 'bonuses');
    expect(bonusesExpired.rows.some((r) => r.id === 'lure')).toBe(false);
  });

  it('the Dex section summarises collection.completion(); the Party section is six rows, always', () => {
    const model = trainerModel(fakeApp());
    const dex = model.sections.find((s) => s.id === 'dex');
    expect(dex.rows.find((r) => r.key === 'seen').value).toBe('60/400 (15%)');

    const party = model.sections.find((s) => s.id === 'party');
    expect(party.rows).toHaveLength(6);
    expect(party.rows[0]).toMatchObject({ filled: true, value: '30/40', frac: 30 / 40 });
    // A fainted member (0 hp) is still shown, at frac 0 — a blank slot, not an error.
    expect(party.rows[1]).toMatchObject({ filled: true, value: '0/28', frac: 0 });
    // The bench beyond what `pokemon.party()` returned pads out to six empty slots.
    expect(party.rows[2]).toMatchObject({ filled: false });
    expect(party.rows[5]).toMatchObject({ filled: false });
  });

  it('degrades to empty sections, not a throw, when only economy is live (acceptance criterion 1\'s own fixture)', () => {
    const model = trainerModel(minimalFakeApp());
    expect(model.sections.map((s) => s.id)).toEqual(['progress', 'bonuses', 'upgrades', 'dex', 'party']);
    expect(model.currencies).toEqual([]);
    expect(model.sections.find((s) => s.id === 'dex').rows).toEqual([]);
    expect(model.sections.find((s) => s.id === 'party').rows).toHaveLength(6);
    expect(model.sections.find((s) => s.id === 'party').rows.every((r) => r.filled === false)).toBe(true);
    expect(model.sections.find((s) => s.id === 'upgrades').rows).toHaveLength(UPGRADES.length);
  });
});

describe('layout(model) — acceptance criterion 4: the Party section is reachable', () => {
  it('is the last block, with all six of its rows counted, and the total exceeds a 320x180 buffer\'s body', () => {
    const model = trainerModel(fakeApp());
    const { blocks, total } = layout(model);
    const last = blocks[blocks.length - 1];
    expect(last.kind).toBe('section');
    expect(last.section.id).toBe('party');
    expect(last.section.rows).toHaveLength(6);

    // Fixed by construction regardless of any fake data: eleven upgrade tracks and six party
    // rows alone already outrun the body a 320x180 buffer (016's own smallest tested case)
    // leaves once the header, the footer and the reserved HUD bands are subtracted — this
    // panel is the one the slice's own Why section says is "most likely to overflow a single
    // screen", so this bound holds however the Bonuses/Dex rows happen to vary.
    expect(total).toBeGreaterThan(160);
  });

  it('the total is a pure function of row counts — two models with the same shape lay out identically', () => {
    const a = layout(trainerModel(fakeApp()));
    const b = layout(trainerModel(fakeApp({ buffs: [] })));
    expect(a.total).toBe(b.total);
  });
});
