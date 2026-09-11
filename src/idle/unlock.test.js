/**
 * The fold mints research only when a fold encounter is WON, and a win needs `flags.battle`.
 * That flag comes from the `auto-battler` unlock, which only the `hunt` automation grants
 * (src/automation/pricing.test.js), and `hunt` costs research, which starts at zero
 * (src/economy/currencies.test.js). Three files because the seams forbid a test in one module
 * importing another's internals — the loop is stated one module at a time.
 *
 * The `it.fails` case is this module's half of the deadlock: a fresh save, no unlocks, an hour
 * of folding, and the research it minted. It is red today for the real reason (`accrual.js`
 * sets `win = false` without `flags.battle`; the control case below proves the function
 * itself works), and the STATUS token ties it to the `open` entry that tracks the fix — seams
 * rule 9 refuses either half without the other, so the expected failure cannot outlive the
 * bug and the bug cannot be closed while the test still expects to fail.
 */
import { describe, it, expect } from 'vitest';
import { simulate, production, UNLOCKS } from './accrual.js';

/** What a brand-new save looks like to the fold: one starter, nothing unlocked, a few balls. */
function freshSaveState(patch = {}) {
  return {
    party: [{ instanceId: 'starter', level: 5, shiny: false,
      species: { name: 'sprigatito', types: ['grass'], baseStats: { hp: 40, atk: 61, def: 54, spa: 45, spd: 45, spe: 65 } } }],
    biome: 'meadow',
    luck: 1, efficiency: 1, tod: 12,
    unlocks: [],
    upgrades: {},
    tables: ['sprigatito', 'starly', 'poochyena'],
    balls: 20,
    progress: { encounters: 0, seconds: 0 },
    ...patch,
  };
}

const HOUR = 3600;
const SEED = 1337;

describe('research from the fold', () => {
  it('the auto-battler unlock is what turns fold wins on', () => {
    expect(UNLOCKS['auto-battler']?.battle).toBe(true);
    expect(production(freshSaveState()).flags.battle).toBe(false);
    expect(production(freshSaveState({ unlocks: ['auto-battler'] })).flags.battle).toBe(true);
  });

  it('a fresh save folds encounters but wins none of them', () => {
    const gains = simulate(freshSaveState(), HOUR, SEED);
    expect(gains.wholeEncounters).toBeGreaterThan(0);
    expect(gains.wins).toBe(0);
  });

  // STATUS:research-unmintable
  it.fails('an hour of folding on a fresh save mints some research', () => {
    const gains = simulate(freshSaveState(), HOUR, SEED);
    expect(gains.wholeEncounters).toBeGreaterThan(0);
    expect(gains.research).toBeGreaterThan(0);
  });

  it('with the auto-battler flag the same hour does mint research', () => {
    // The control: the function is not broken, the gate on it is.
    const gains = simulate(freshSaveState({ unlocks: ['auto-battler'] }), HOUR, SEED);
    expect(gains.wins).toBeGreaterThan(0);
    expect(gains.research).toBeGreaterThan(0);
  });
});
