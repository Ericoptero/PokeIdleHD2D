/**
 * The national dex list — pure, DOM-free, lifted out of `panels/dex.js` when its view
 * converted to a DOM screen (`screens/dex.js`, Stage 9), the `models/inventory.js`/
 * `models/travel.js`/`models/trainer.js` precedent.
 *
 * Every base-form species `pokemon` knows about, in dex order, carrying whatever record
 * `collection` holds for it. Species with no record read as locked slots, which is what makes
 * this a dex rather than an inventory — a screen of "1025 rows of not seen" tells the player
 * nothing, so the summary (`screens/dex.js`) is the point and this list is the detail under it.
 */

const isLive = (api) => !!api && api.__missing === undefined;

export function nationalList(app, records) {
  const byKey = new Map(records.map((r) => [r.key, r]));
  const pokemon = app.ctx.get('pokemon');
  const table = isLive(pokemon) && typeof pokemon.baseForms === 'function' ? pokemon.baseForms() : [];
  if (!table.length) return records.filter((r) => r.id !== null).sort((a, b) => a.id - b.id);
  const out = [];
  for (const sp of table) {
    if (!Number.isFinite(sp.id)) continue;
    const r = byKey.get(sp.name);
    out.push(r ?? {
      key: sp.name, id: sp.id, display: sp.display ?? sp.name,
      seen: 0, caught: 0, owned: 0, shinyCaught: 0,
    });
  }
  return out.sort((a, b) => a.id - b.id);
}
