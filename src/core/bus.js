/**
 * Synchronous, ordered, isolated event bus (ARCHITECTURE §2.3).
 *
 * Isolation matters more than speed here: a listener that throws must not stop the other
 * listeners, and must not take down the frame it was called from. A listener that keeps
 * throwing is removed, because a broken listener firing 60 times a second turns the
 * console into noise and hides the real failure.
 */

const SPY_CAPACITY = 256;
const THROW_LIMIT = 3;

export function makeBus({ onError } = {}) {
  /** @type {Map<string, Set<{fn:Function, throws:number, once:boolean}>>} */
  const listeners = new Map();
  const ring = new Array(SPY_CAPACITY);
  let ringAt = 0, ringLen = 0;
  let depth = 0;

  function record(type, payload) {
    ring[ringAt] = { type, payload, t: performance.now() };
    ringAt = (ringAt + 1) % SPY_CAPACITY;
    if (ringLen < SPY_CAPACITY) ringLen++;
  }

  function on(type, fn, { once = false } = {}) {
    if (typeof fn !== 'function') throw new TypeError(`bus.on(${type}): handler is not a function`);
    let set = listeners.get(type);
    if (!set) listeners.set(type, (set = new Set()));
    const entry = { fn, throws: 0, once };
    set.add(entry);
    return () => set.delete(entry);
  }

  function emit(type, payload) {
    record(type, payload);
    const set = listeners.get(type);
    if (!set || set.size === 0) return;
    if (depth > 32) {
      onError?.(new Error(`bus: recursion depth exceeded emitting "${type}"`), { type });
      return;
    }
    depth++;
    // Snapshot: a listener may add or remove listeners while we iterate.
    for (const entry of [...set]) {
      if (!set.has(entry)) continue;
      try {
        entry.fn(payload);
        if (entry.once) set.delete(entry);
      } catch (err) {
        entry.throws++;
        onError?.(err, { type, throws: entry.throws });
        if (entry.throws >= THROW_LIMIT) {
          set.delete(entry);
          onError?.(new Error(`bus: listener for "${type}" removed after ${THROW_LIMIT} throws`), { type });
        }
      }
    }
    depth--;
  }

  return {
    on,
    once: (type, fn) => on(type, fn, { once: true }),
    off: (type, fn) => {
      const set = listeners.get(type);
      if (set) for (const e of set) if (e.fn === fn) set.delete(e);
    },
    emit,
    /** The last 256 events, oldest first — dumped into every failing screenshot log. */
    spy() {
      const out = [];
      for (let i = 0; i < ringLen; i++) out.push(ring[(ringAt - ringLen + i + SPY_CAPACITY) % SPY_CAPACITY]);
      return out;
    },
    types: () => [...listeners.keys()].sort(),
    clear: () => listeners.clear(),
  };
}
