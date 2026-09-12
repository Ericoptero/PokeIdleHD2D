/**
 * The save store (src/offline/save.js).
 *
 * `localStorage['pokeidle.save']` holds **one** JSON object shaped `{ v: <int>, … }`.
 * Writes are debounced 2 s and also fired on `visibilitychange`, `pagehide` and a slow
 * heartbeat; migrations run forward one version at a time and are never skipped; a save
 * that cannot be parsed, verified or migrated is moved aside to `pokeidle.save.broken`
 * rather than being repaired in place — and never, ever thrown as an exception into boot.
 *
 * This file is deliberately free of DOM and of three.js so it can be exercised from node
 * (`src/offline/selftest.js`) with an injected storage and clock. Everything that touches
 * `window` lives in `index.js`.
 */

import { CURRENT_VERSION, MIGRATIONS, freshSave } from './migrations.js';

export const KEY = 'pokeidle.save';
export const BROKEN_KEY = 'pokeidle.save.broken';
export const FUTURE_KEY = 'pokeidle.save.future';

const NOOP_LOG = { debug() {}, info() {}, warn() {}, error() {} };

/* ------------------------------------------------------------------ storage */

/**
 * localStorage, wrapped so that Safari private mode, a disabled-storage policy or a full
 * quota degrade to an in-memory store instead of throwing through the boot path.
 * @returns {{getItem(k:string):string|null, setItem(k:string,v:string):void,
 *            removeItem(k:string):void, keys():string[], kind:'local'|'memory'}}
 */
export function makeStorage(preferred = typeof localStorage !== 'undefined' ? localStorage : null) {
  const probe = '__pokeidle_probe__';
  let ok = false;
  try {
    if (preferred) { preferred.setItem(probe, '1'); preferred.removeItem(probe); ok = true; }
  } catch { ok = false; }

  if (ok) {
    return {
      kind: 'local',
      getItem: (k) => { try { return preferred.getItem(k); } catch { return null; } },
      setItem: (k, v) => preferred.setItem(k, v),          // throws on quota — the caller handles it
      removeItem: (k) => { try { preferred.removeItem(k); } catch { /* nothing to undo */ } },
      keys: () => { try { return Object.keys(preferred); } catch { return []; } },
    };
  }
  const mem = new Map();
  return {
    kind: 'memory',
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    keys: () => [...mem.keys()],
  };
}

/** An in-memory storage, for tests and for the showcase's staged scenarios. */
export function makeMemoryStorage(seed = {}) {
  const mem = new Map(Object.entries(seed));
  return {
    kind: 'memory',
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    keys: () => [...mem.keys()],
    _map: mem,
  };
}

/* ------------------------------------------------------------------ integrity */

/**
 * Key-order-independent JSON, so a checksum survives a round trip through an engine that
 * reorders object keys (V8 reorders integer-like keys, which slice ids can be).
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined || typeof v === 'function') continue;
    parts.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * FNV-1a, 32 bit. Not a security primitive and not pretending to be one: it exists to
 * catch a truncated or hand-mangled save before the migrations run on nonsense.
 */
export function checksum(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const withoutHash = (obj) => { const { h, ...rest } = obj; return rest; };
export const hashOf = (obj) => checksum(stableStringify(withoutHash(obj)));

/** Returned by `safeClone` for a value that cannot survive JSON — `undefined` cannot be
 *  used as that signal, because a default parameter would swallow it. */
const UNCLONEABLE = Symbol('uncloneable');

/** JSON round trip that can never throw; returns `fallback` for anything unserialisable. */
function safeClone(value, fallback = null) {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? fallback : JSON.parse(s);
  } catch { return fallback; }
}

const isPlainObject = (o) => typeof o === 'object' && o !== null && !Array.isArray(o);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/* ------------------------------------------------------------------ the store */

/**
 * @param {object} [opts]
 * @param {ReturnType<makeStorage>} [opts.storage]
 * @param {() => number} [opts.now]          wall clock, ms
 * @param {object} [opts.log]
 * @param {number} [opts.debounceMs]         trailing debounce for dirty writes
 * @param {number} [opts.maxDebounceMs]      hard ceiling, so a steady drip still lands
 * @param {(fn:Function, ms:number) => any} [opts.setTimer]
 * @param {(id:any) => void} [opts.clearTimer]
 */
export function makeSaveStore({
  storage = makeStorage(),
  now = () => Date.now(),
  log = NOOP_LOG,
  debounceMs = 2000,
  maxDebounceMs = 10000,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  seed = 0,
  // Injected so `selftest.js` can drive a chain that throws; production always passes the
  // real chain, and nothing else may substitute one.
  version = CURRENT_VERSION,
  migrations = MIGRATIONS,
} = {}) {
  /** @type {Map<string, {capture:Function, restore:Function, source:string, order:number}>} */
  const providers = new Map();
  const diag = {
    storage: storage.kind,
    firstLaunch: false,
    quarantined: null,        // { reason, at, bytes } when a save was moved aside
    futureVersion: null,      // the version we refused to downgrade from
    migratedFrom: null,
    repairs: [],
    writes: 0,
    writeErrors: 0,
    lastWriteMs: 0,
    lastWriteReason: null,
    bytes: 0,
    loadMs: 0,
  };

  let data = freshSave(now(), seed, version);
  let dirtySince = 0;
  let timer = null;
  let sessionStartMs = now();
  let disposed = false;

  /* --------------------------------------------------------------- loading */

  function quarantine(raw, reason, err) {
    diag.quarantined = { reason, at: now(), bytes: raw ? raw.length : 0 };
    try {
      if (raw != null) storage.setItem(BROKEN_KEY, raw);
    } catch (writeErr) {
      diag.quarantined.copyFailed = String(writeErr?.message ?? writeErr);
    }
    storage.removeItem(KEY);
    // Deliberately a warning, not an error: this is the handled path. The game keeps its
    // zero-console-errors budget, the player still gets told, and the bytes are preserved
    // under `pokeidle.save.broken` for a human to look at.
    log.warn(`offline: save quarantined to ${BROKEN_KEY} (${reason})`, err ?? '');
  }

  /** Applies migrations one version at a time, never skipping (src/offline/save.js). */
  function migrate(save) {
    let out = save;
    const from = out.v;
    let guard = 0;
    while (out.v < version) {
      const step = migrations.find((m) => m.to === out.v + 1);
      if (!step) throw new Error(`no migration from v${out.v} to v${out.v + 1}`);
      out = step.apply(out);
      if (!isPlainObject(out)) throw new Error(`migration to v${step.to} returned ${typeof out}`);
      out.v = step.to;
      if (++guard > 64) throw new Error('migration chain did not converge');
    }
    if (from !== version) diag.migratedFrom = from;
    return out;
  }

  /**
   * Field-level repair for a save that is structurally fine but has a bad value in it —
   * a missing `lastSeenMs`, a `createdMs` of `null` after a hand edit. Losing a whole run
   * because one number went strange would be the wrong trade; only shape errors quarantine.
   */
  function repair(save) {
    const t = now();
    const note = (what) => diag.repairs.push(what);
    if (!isPlainObject(save.meta)) { save.meta = freshSave(t, seed, version).meta; note('meta'); }
    if (!isPlainObject(save.slices)) { save.slices = {}; note('slices'); }
    // A timestamp at or before the epoch is not a date, it is a missing field that an
    // older migration filled with a zero. Repairing it to now is the only answer that
    // leaves the player with a working anchor.
    if (!finite(save.createdMs) || save.createdMs <= 0) { save.createdMs = t; note('createdMs'); }
    if (!finite(save.lastSeenMs) || save.lastSeenMs <= 0) { save.lastSeenMs = t; note('lastSeenMs'); }
    if (!finite(save.savedAtMs) || save.savedAtMs <= 0) { save.savedAtMs = save.lastSeenMs; note('savedAtMs'); }
    if (!finite(save.meta.playSeconds) || save.meta.playSeconds < 0) { save.meta.playSeconds = 0; note('meta.playSeconds'); }
    if (!finite(save.meta.sessions) || save.meta.sessions < 0) { save.meta.sessions = 0; note('meta.sessions'); }
    return save;
  }

  function load() {
    const t0 = now();
    diag.firstLaunch = false;
    diag.quarantined = null;
    diag.futureVersion = null;
    diag.migratedFrom = null;
    diag.repairs = [];

    const raw = storage.getItem(KEY);
    if (raw == null || raw === '') {
      diag.firstLaunch = true;
      data = freshSave(now(), seed, version);
      diag.loadMs = now() - t0;
      return data;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      quarantine(raw, 'unreadable', err);
      data = freshSave(now(), seed, version);
      diag.loadMs = now() - t0;
      return data;
    }

    if (!isPlainObject(parsed)) {
      quarantine(raw, 'not-an-object');
      data = freshSave(now(), seed, version);
      diag.loadMs = now() - t0;
      return data;
    }
    if (!Number.isInteger(parsed.v) || parsed.v < 1) {
      quarantine(raw, 'no-version');
      data = freshSave(now(), seed, version);
      diag.loadMs = now() - t0;
      return data;
    }
    if (typeof parsed.h === 'string' && parsed.h !== hashOf(parsed)) {
      quarantine(raw, 'checksum');
      data = freshSave(now(), seed, version);
      diag.loadMs = now() - t0;
      return data;
    }

    if (parsed.v > version) {
      // A save written by a newer build. We cannot migrate backwards and we must not
      // silently overwrite it, so it is set aside intact under its own key and this
      // session starts fresh. Re-installing the newer build gets the run back.
      diag.futureVersion = parsed.v;
      try { storage.setItem(FUTURE_KEY, raw); } catch { /* best effort */ }
      storage.removeItem(KEY);
      log.warn(`offline: save is v${parsed.v}, this build reads v${version} — kept at ${FUTURE_KEY}, starting fresh`);
      data = freshSave(now(), seed, version);
      diag.loadMs = now() - t0;
      return data;
    }

    let migrated;
    try {
      migrated = migrate(parsed);
    } catch (err) {
      quarantine(raw, 'migration', err);
      data = freshSave(now(), seed, version);
      diag.loadMs = now() - t0;
      return data;
    }

    data = repair(migrated);
    diag.bytes = raw.length;
    diag.loadMs = now() - t0;
    return data;
  }

  /* --------------------------------------------------------------- slices */

  /**
   * Registers a state slice. `capture()` returns a JSON-safe value; `restore(value)` puts
   * it back. Both are wrapped: a provider that throws loses its own slice and nothing else.
   */
  function register(id, { capture, restore, source = 'native', order = 0 } = {}) {
    if (typeof id !== 'string' || !id) throw new TypeError('save.register: id must be a string');
    providers.set(id, {
      capture: typeof capture === 'function' ? capture : () => undefined,
      restore: typeof restore === 'function' ? restore : () => {},
      source, order,
    });
    return () => providers.delete(id);
  }

  const ordered = () => [...providers.entries()].sort((a, b) => a[1].order - b[1].order);

  /** Pushes every stored slice back into whichever module owns it. */
  function hydrate() {
    const restored = [];
    for (const [id, p] of ordered()) {
      const value = data.slices?.[id];
      if (value === undefined) continue;
      try { p.restore(safeClone(value)); restored.push(id); }
      catch (err) { log.warn(`offline: restoring slice "${id}" failed — it is left as saved`, err); }
    }
    return restored;
  }

  /** Pulls every registered slice into `data.slices`. Unknown slices are left untouched. */
  function capture() {
    for (const [id, p] of ordered()) {
      let value;
      try { value = p.capture(); } catch (err) {
        log.warn(`offline: capturing slice "${id}" failed — keeping the previous value`, err);
        continue;
      }
      if (value === undefined) continue;
      const clean = safeClone(value, UNCLONEABLE);
      if (clean === UNCLONEABLE) { log.warn(`offline: slice "${id}" is not JSON-serialisable — skipped`); continue; }
      data.slices[id] = clean;
    }
  }

  /* --------------------------------------------------------------- writing */

  function cancelTimer() { if (timer != null) { clearTimer(timer); timer = null; } }

  /** Writes now. Never throws: a full quota is recorded and the game carries on. */
  function flush(reason = 'manual') {
    if (disposed) return false;
    cancelTimer();
    dirtySince = 0;
    const t = now();
    capture();
    data.v = version;
    data.savedAtMs = t;
    data.lastSeenMs = t;
    data.meta.playSeconds = Math.round(data.meta.playSeconds + Math.max(0, (t - sessionStartMs) / 1000));
    sessionStartMs = t;

    const payload = withoutHash(data);
    payload.h = checksum(stableStringify(payload));
    let text;
    try { text = JSON.stringify(payload); }
    catch (err) { diag.writeErrors++; log.warn('offline: save is not serialisable — not written', err); return false; }

    try {
      storage.setItem(KEY, text);
      data.h = payload.h;
      diag.writes++;
      diag.bytes = text.length;
      diag.lastWriteMs = t;
      diag.lastWriteReason = reason;
      if (text.length > 2_000_000) log.warn(`offline: save is ${(text.length / 1e6).toFixed(1)} MB — close to the localStorage quota`);
      return true;
    } catch (err) {
      diag.writeErrors++;
      // Quota, or storage revoked mid-session. The run continues in memory; saying so once
      // is better than a write attempt per second filling the console.
      if (diag.writeErrors === 1) log.warn('offline: could not write the save (quota or storage disabled)', err);
      return false;
    }
  }

  /** Marks the save dirty; the write lands `debounceMs` later, `maxDebounceMs` at the latest. */
  function markDirty(reason = 'change') {
    if (disposed) return;
    const t = now();
    if (!dirtySince) dirtySince = t;
    const waited = t - dirtySince;
    const wait = Math.max(0, Math.min(debounceMs, maxDebounceMs - waited));
    cancelTimer();
    timer = setTimer(() => { timer = null; flush(reason); }, wait);
  }

  return {
    KEY, BROKEN_KEY, FUTURE_KEY,
    version,

    load, hydrate, register, flush, markDirty, capture,
    /** The live document. Read it; write through `set`/`patch` so the write is scheduled. */
    data: () => data,
    snapshot: () => safeClone(data, {}),
    get: (id) => (data.slices && id in data.slices ? safeClone(data.slices[id]) : undefined),
    set(id, value) { data.slices[id] = safeClone(value, null); markDirty(`set:${id}`); },
    patch(id, obj) { data.slices[id] = { ...(data.slices[id] ?? {}), ...safeClone(obj, {}) }; markDirty(`patch:${id}`); },
    providers: () => ordered().map(([id, p]) => ({ id, source: p.source })),

    lastSeenMs: () => data.lastSeenMs,
    /** Moves the "we were alive at" anchor, e.g. after the wall clock jumped backwards. */
    setLastSeen(ms) { data.lastSeenMs = ms; data.savedAtMs = ms; },

    info: () => ({
      ...diag,
      version: data.v,
      currentVersion: version,
      createdMs: data.createdMs,
      lastSeenMs: data.lastSeenMs,
      sessions: data.meta?.sessions ?? 0,
      playSeconds: data.meta?.playSeconds ?? 0,
      slices: Object.keys(data.slices ?? {}),
      pendingWrite: timer != null,
    }),

    /** Raw text of the last written save, for a debug export. */
    export: () => storage.getItem(KEY),
    /** Replaces the save wholesale from text, then reloads through the normal path. */
    import(text) { try { storage.setItem(KEY, String(text)); } catch { return false; } return !!load(); },
    /** Wipes the save (not the quarantined copies) and starts a fresh document. */
    clear() { storage.removeItem(KEY); data = freshSave(now(), seed, version); diag.firstLaunch = true; return data; },
    broken: () => storage.getItem(BROKEN_KEY),
    future: () => storage.getItem(FUTURE_KEY),

    beginSession() { data.meta.sessions = (data.meta.sessions ?? 0) + 1; sessionStartMs = now(); },
    dispose() { cancelTimer(); disposed = true; },
  };
}
