/**
 * `economy.bag()`/`stash()` (`economy/index.js:534-535`) already hand back exactly the rows a
 * grid needs, tier-ascending then value-descending — `filterRows` only filters by tab and,
 * optionally, by category. Moved here unchanged from `panels/inventory.test.js` when the view
 * built on it converted to a DOM screen (`screens/inventory.js`, Stage 5) — the model this pins
 * did not change, only the thing rendering it.
 */
import { describe, it, expect } from 'vitest';
import { filterRows, CATEGORY_LABEL } from './inventory.js';

const BAG_ROWS = [
  { id: 'pokeball', name: 'Poké Ball', category: 'ball', tier: 1, n: 20, cap: 999, unitSell: 100, totalSell: 2000, locked: false, desc: 'x' },
  { id: 'potion', name: 'Potion', category: 'medicine', tier: 1, n: 10, cap: 999, unitSell: 100, totalSell: 1000, locked: false, desc: 'x' },
  { id: 'superpotion', name: 'Super Potion', category: 'medicine', tier: 2, n: 3, cap: 999, unitSell: 350, totalSell: 1050, locked: true, desc: 'x' },
];
const STASH_ROWS = [
  { id: 'nugget', name: 'Nugget', category: 'treasure', tier: 2, n: 5, cap: 999, unitSell: 5000, totalSell: 25000, locked: false, desc: 'x' },
];

/** Just enough of `app` for `filterRows()`: an `economy` off `ctx.get`. */
function fakeApp({ bag = [], stash = [] } = {}) {
  return {
    ctx: {
      get: (id) => (id === 'economy'
        ? { bag: () => bag, stash: () => stash }
        : { __missing: true }),
    },
    markDirty() {},
    toast() {},
  };
}

describe('the inventory row filter', () => {
  it('reads the bag tab from economy.bag(), untouched, when no category is set', () => {
    const app = fakeApp({ bag: BAG_ROWS, stash: STASH_ROWS });
    expect(filterRows(app, 'bag', null)).toEqual(BAG_ROWS);
  });

  it('reads the stash tab from economy.stash(), not the bag', () => {
    const app = fakeApp({ bag: BAG_ROWS, stash: STASH_ROWS });
    expect(filterRows(app, 'stash', null)).toEqual(STASH_ROWS);
  });

  it('filters by category within the active tab, in the same order economy provided', () => {
    const app = fakeApp({ bag: BAG_ROWS, stash: STASH_ROWS });
    const meds = filterRows(app, 'bag', 'medicine');
    expect(meds.map((r) => r.id)).toEqual(['potion', 'superpotion']);
    // Not re-sorted: `economy.bag()`'s own tier-ascending order survives the filter untouched.
    expect(meds).toEqual(BAG_ROWS.filter((r) => r.category === 'medicine'));
  });

  it('a category with nothing in the active tab filters to empty, not to the other tab\'s rows', () => {
    const app = fakeApp({ bag: BAG_ROWS, stash: STASH_ROWS });
    expect(filterRows(app, 'bag', 'treasure')).toEqual([]);
  });

  it('an economy that is quarantined answers with no rows rather than throwing', () => {
    const app = { ctx: { get: () => ({ __missing: true }) } };
    expect(filterRows(app, 'bag', null)).toEqual([]);
    expect(filterRows(app, 'stash', null)).toEqual([]);
  });

  it('every category the catalogue ships has a readable label', () => {
    for (const cat of ['ball', 'medicine', 'candy', 'evolution', 'lure', 'held', 'treasure']) {
      expect(CATEGORY_LABEL[cat]).toBeTruthy();
    }
  });
});
