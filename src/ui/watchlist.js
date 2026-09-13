/**
 * The "notify me when X appears" species watch-list (Stage 4) — the one real feature behind
 * the source design's Settings mockup, alongside the settings that bind straight to
 * `core/config.js`.
 *
 * Pure and DOM-free, like `window.js`/`gesture.js`, so `src/ui/selftest.js` can pin its
 * round-trip under plain Node — a plain `Set`, module-scope so `src/ui/screens/settings.js`
 * (writes it) and `src/ui/index.js` (reads it for the `encounter:started` listener, and
 * saves/restores it) agree on one copy without passing it through `app` by hand.
 *
 * Player state, not a tunable — `core/config.js`'s own `localStorage['pokeidle.config']` is a
 * per-browser settings store a URL param can override for one session; a watch-list belongs
 * in the save (`ui`'s own slice, `index.js`'s `saveState`/`loadState`, bumped to v2 for it).
 */

const watched = new Set();

/** Every species currently watched, alphabetised so a rendered list doesn't reorder itself
 *  under the player's cursor as entries come and go. */
export function list() {
  return [...watched].sort();
}

export function has(name) {
  return watched.has(String(name ?? '').toLowerCase());
}

/** @returns {boolean} whether it was actually added (false for an empty/duplicate name) */
export function add(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key || watched.has(key)) return false;
  watched.add(key);
  return true;
}

/** @returns {boolean} whether it was actually present to remove */
export function remove(name) {
  return watched.delete(String(name ?? '').toLowerCase());
}

/** `index.js`'s own `loadState` — clears first, so a save with a shorter list than the
 *  current session actually shrinks it, the same discipline `restoreWindows` uses. */
export function restore(names) {
  watched.clear();
  if (!Array.isArray(names)) return;
  for (const name of names) {
    const key = String(name ?? '').trim().toLowerCase();
    if (key) watched.add(key);
  }
}

/** For a test, or a full reset — nothing in the shipped UI calls this today. */
export function clear() {
  watched.clear();
}
