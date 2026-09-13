/**
 * The travel model — pure, DOM-free, lifted out of `panels/travel.js` when its view converted
 * to a DOM screen (`screens/travel.js`, Stage 6), the same "the row-building function is worth
 * testing with no canvas" precedent `models/inventory.js`'s `filterRows` set in Stage 5.
 *
 * `travel.destinations()` is the authority on what a destination is (the city and every
 * biome, each carrying the formation its own scene declared) — this only filters out
 * `hidden` rows (the Pokemon Center's door-only entry) and shapes the rest for a list.
 */

const isLive = (api) => !!api && api.__missing === undefined;

/**
 * @param {object} app
 * @param {{pending?: string|null}} [state] `pending` is the one piece of state a screen holds
 *   locally (the destination a `go()` is in flight for) — passed in rather than read off a
 *   module, since nothing but the screen itself tracks it.
 */
export function travelRows(app, { pending = null } = {}) {
  const t = app.ctx.get('travel');
  if (!isLive(t) || typeof t.destinations !== 'function') return [];
  const here = t.current()?.id ?? null;
  // `hidden` is door-only entry (src/travel/index.js) — the Pokemon Center is reached by
  // walking through it in the city, never by picking it here. `travel.go()` still accepts the
  // id; only the row is gone.
  return t.destinations().filter((d) => !d.hidden).map((d) => ({
    id: d.id,
    label: d.name,
    kind: d.kind,
    // The raw biome id (`hunt-meadow`'s `arg` is `'meadow'`) — `idle.catalog().biomes[arg]`
    // is where a relative yield figure for this route comes from (`screens/travel.js`); `null`
    // for the city/Pokemon Center rows, which are not a biome choice.
    arg: d.arg ?? null,
    here: d.id === here,
    loading: d.id === pending,
    // A hunt the trainer is too low for is SHOWN AND GREYED, never hidden — the same rule
    // `economy/shops.js` uses for a shelf that is not unlocked yet. A destination you cannot
    // see is not a goal; one you can see with its price on it is.
    locked: !!d.locked,
    need: Number(d.requiredLevel) || 0,
    // The place you are already standing in is not a destination, and nothing is pickable
    // while a map is being built. **A locked row is NOT disabled**: pressing it is how the
    // player finds out what it wants, because `go()` refuses it with a sentence.
    disabled: d.id === here || !!pending,
  }));
}
