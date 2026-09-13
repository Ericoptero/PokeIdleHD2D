/**
 * Toasts, converted to the Códice DOM layer (Stage 2) — the second screen off the canvas
 * after `screens/offline.js`, and the first piece of the *always-on* HUD chrome rather than a
 * modal.
 *
 * Same public shape as the canvas predecessor it replaces (`push`, `step`, `count`, `clear`,
 * `all`) so `../index.js`'s wiring — the `bus.on('ui:toast', …)` listener, the `frame()` call,
 * `showcase.js`'s `ui._toasts.clear()` — needs no restructuring, only a different
 * constructor. What changes underneath: `draw(g, opts)` is gone (nothing paints these on the
 * canvas any more), and with it the canvas `draw()` function's own collision-avoidance math
 * for where the stack sat in buffer coordinates — DOM toasts sit above the canvas, on their
 * own layer, so a control hint drawn under one is merely covered, not visually corrupted the
 * way two overlapping canvas fills would be.
 *
 * The one collision that *is* still real: the menu column (`panels/menu.js`, canvas, until
 * Stage 9) occupies this same bottom-right corner. `setAside()` is the shim for that —
 * `../index.js` calls it whenever the open panel becomes or stops being `menu`.
 *
 * Ageing is still driven by `step(dt)`, the frame delta, not a CSS animation — `frozen` (set
 * from `config.showcase`, exactly as the canvas version read it) has to stop a toast from
 * visibly expiring *before* the shutter, and a CSS animation frozen by `base.css`'s
 * `[data-frozen]` guard would snap the bar to its *end* state (0% — `animation-duration: 0s`)
 * instead of holding it at whatever fraction it reached, which is backwards from what a
 * showcase capture needs (a stack of full, freshly-pushed toasts, not a stack of expired
 * ones).
 */
import { h } from './el.js';
import { icon } from './icons.js';

/** Mirrors `theme.js`'s `TOAST_COLOUR` mark table — a shape and a colour per kind, so the
 *  kind still reads with no colour vision at all. */
const KIND_ICON = {
  good: 'check-circle', warn: 'alert', bad: 'close', offline: 'bedtime', info: 'dot',
};
const KIND_SET = new Set(Object.keys(KIND_ICON));

/**
 * The design's own "Sistema de avisos" mockup varies the on-screen time by how much the
 * message asks of the player — 2s for "it worked", 5s for "it needs you". The canvas
 * predecessor used one fixed 4.5s for every kind; this is a deliberate, low-risk fidelity
 * gain over it (a pure presentation choice, unlike `screens/offline.js`'s refusal to invent
 * data — nothing here needs a new data source). `info`/`offline` split the difference: the
 * mockup shows no example of either.
 */
const DURATION_S = {
  good: 2, warn: 5, bad: 5, offline: 3.5, info: 3.5,
};

/** Older ones fall off the top rather than growing the stack off the screen — the same rule
 *  the canvas predecessor used. */
const MAX_VISIBLE = 4;

export function makeDomToasts(domLayer, { frozen = false } = {}) {
  const host = h('div', { class: 'ci-toasts', 'data-ui': 'toasts' });
  domLayer.host.appendChild(host);

  let seq = 0;
  /** @type {{id:number, text:string, kind:string, age:number, lifetime:number, el:HTMLElement, barEl:HTMLElement}[]} */
  let queue = [];

  function build(entry) {
    const bar = h('div', { class: 'ci-toast__bar-fill' });
    const el = h('div', { class: 'ci-toast', 'data-kind': entry.kind, 'data-ui': `toast-${entry.id}` }, [
      h('div', { class: 'ci-toast__head' }, [
        h('div', { class: 'ci-toast__mark' }, icon(KIND_ICON[entry.kind], { size: 13, strokeWidth: 2 })),
        h('div', { class: 'ci-toast__text' }, entry.text),
      ]),
      h('div', { class: 'ci-toast__bar' }, bar),
    ]);
    entry.el = el;
    entry.barEl = bar;
    return el;
  }

  function push(text, kind = 'info') {
    const t = String(text ?? '').trim();
    if (!t) return null;
    // An unrecognised kind falls back to `info`, exactly as `theme.js`'s `TOAST_COLOUR[kind]
    // ? kind : 'info'` did — `idle/index.js` emits `kind: 'idle'`, which nothing has ever
    // defined a colour for, and this stays a display fallback rather than a build failure.
    const safeKind = KIND_SET.has(kind) ? kind : 'info';
    const entry = {
      id: ++seq, text: t, kind: safeKind, age: 0, lifetime: DURATION_S[safeKind] ?? 3.5,
    };
    host.appendChild(build(entry));
    queue.push(entry);
    while (queue.length > MAX_VISIBLE) queue.shift().el.remove();
    return entry;
  }

  /** @returns {boolean} whether the stack changed — kept for shape parity with the canvas
   *  predecessor, though `../index.js` no longer needs to `markDirty()` off it. */
  function step(dt) {
    if (frozen || !queue.length) return false;
    for (const t of queue) {
      t.age += dt;
      t.barEl.style.width = `${Math.max(0, 1 - t.age / t.lifetime) * 100}%`;
    }
    const before = queue.length;
    queue = queue.filter((t) => {
      if (t.age < t.lifetime) return true;
      t.el.remove();
      return false;
    });
    return queue.length !== before;
  }

  return {
    push,
    step,
    count: () => queue.length,
    clear() {
      for (const t of queue) t.el.remove();
      queue = [];
    },
    /** For a probe or a test — the canvas predecessor's own `all()`, minus its DOM handles. */
    all: () => queue.map(({ id, text, kind, age, lifetime }) => ({
      id, text, kind, age, lifetime,
    })),
    setAside(on) { host.classList.toggle('ci-toasts--aside', !!on); },
    dispose() { host.remove(); },
  };
}
