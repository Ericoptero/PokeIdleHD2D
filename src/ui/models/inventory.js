/**
 * The inventory model — pure, DOM-free, lifted unchanged from `panels/inventory.js` (Stage 5's
 * Códice conversion, `screens/inventory.js`) so the view could swap under it with no change to
 * the one thing worth pinning a test to.
 *
 * `economy.bag()`/`stash()` (`economy/index.js`) already hand back exactly the rows a grid
 * needs: category, tier, count, unit/total sell value and lock state, sorted tier-ascending
 * then value-descending. This adds nothing to that ordering — it only filters by tab
 * (Bag / Stash) and, optionally, by category.
 */

const isLive = (api) => !!api && api.__missing === undefined;

/** The seven live categories `economy/items.js`'s `ITEMS` populates today (`key` appears in
 *  the typedef but nothing ships in it) — used only to give a filter tab a readable label; the
 *  filter itself works on whatever category a row actually carries. */
export const CATEGORY_LABEL = {
  ball: 'BALL', medicine: 'MEDICINE', candy: 'CANDY', evolution: 'EVOLUTION',
  lure: 'LURE', held: 'HELD', treasure: 'TREASURE',
};

/**
 * `tab` picks `economy.bag()` or `economy.stash()`, `category` (falsy = every category) filters
 * what comes back — no re-sorting on top of either, since both already sort tier-ascending then
 * value-descending. A free function, not a closure method, so a test can call it with a fake
 * `economy` with no `app` at all beyond `ctx.get`.
 */
export function filterRows(app, tab, category) {
  const eco = app.ctx.get('economy');
  if (!isLive(eco)) return [];
  const source = tab === 'stash'
    ? (typeof eco.stash === 'function' ? eco.stash() ?? [] : [])
    : (typeof eco.bag === 'function' ? eco.bag() ?? [] : []);
  return category ? source.filter((r) => r.category === category) : source;
}
