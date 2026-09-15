/**
 * stamps.js — named, reusable clipboard clips ("prefabs"), Slice 9d. A flat client-side library,
 * completely independent of any one map: like `session.js`'s own plain copy/paste `clipboard`
 * field already documents ("nothing here is map-id-scoped"), a saved stamp is just a named
 * `copyRect`-shaped `{w,h,cells,objects}` clip an author can drop into ANY map's grid later,
 * through the exact same `pasteClip` (`tools.js`) a plain Ctrl+V already uses.
 *
 * Deliberately scoped down from the original plan's "prefab" language (the slice brief's own
 * words): no new file format, no server endpoint, no prefab-instance/linked-copy concept that
 * would need a data model `mapfile.js` has no place for. A stamp is authoring sugar around the
 * clipboard, never serialized into a map — placing one just commits an ordinary `pasteClip` undo
 * entry, no different from a manual copy-paste. No `doc`/`history` ever passes through this file.
 *
 * Backed by `localStorage['pokeidle.studio.stamps']`, one JSON object keyed by name
 * (`{[name]: clip}`) — a flat map, not an array, so a save-with-existing-name overwrites in place
 * with no separate "find by name" pass, and `getStamp`/`deleteStamp` are both a single property
 * access. Wrapped in try/catch throughout, matching `library.js`'s own favorites precedent: a
 * private window, cleared/blocked site data, or a full quota degrades to "nothing saved" rather
 * than breaking the tool.
 */

const KEY = 'pokeidle.studio.stamps';

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch { return {}; }
}

function writeAll(map) {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* private mode / full quota — this session's stamp still works, it just won't persist */ }
}

/** Every saved stamp's name, alphabetical — `panels.js`'s stamp-picker `<select>` options. */
export function listStamps() {
  return Object.keys(readAll()).sort();
}

/** One saved stamp's clip (`copyRect`'s own `{w,h,cells,objects}` shape), or `null` if `name`
 *  is not saved — a stale picker selection (deleted from another tab/session) or a name that
 *  never existed both read the same way. */
export function getStamp(name) {
  if (!name) return null;
  return readAll()[name] ?? null;
}

/** Saves `clip` under `name`, overwriting any existing stamp of the same name. `clip` is stored
 *  exactly as `copyRect`/`session.getClipboard()` hand it over — no re-shaping — so a saved
 *  stamp reads back byte-identical to the clipboard it was made from. A no-op for an empty name
 *  or a clip with nothing in it (the same "nothing to commit" tolerance `pasteClip` itself uses). */
export function saveStamp(name, clip) {
  if (!name || !clip || (!clip.cells.length && !clip.objects.length)) return;
  const all = readAll();
  all[name] = clip;
  writeAll(all);
}

/** Removes one saved stamp by name — a no-op if it is already gone. */
export function deleteStamp(name) {
  const all = readAll();
  if (!(name in all)) return;
  delete all[name];
  writeAll(all);
}
