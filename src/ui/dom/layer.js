/**
 * `#ui-dom` — the Códice screens' home, mounted beside the pixel-canvas UI rather than
 * instead of it (see `../index.js`'s own top-of-file comment for why the canvas exists and
 * what stays on it — plates, callouts, floaters — for good).
 *
 * Stacking inside `#ui` (`index.html`): the world canvas (`screen.js`, `z-index: 1` today,
 * split into `#ui-world` once the canvas panel stack retires) sits under this, and the
 * evolution cutscene (`../evolution.js`) sits over it at `z-index: 3`.
 *
 * The CSS is authored as real `.css` files and pulled in with Vite's `?inline` so it lands in
 * one synchronous `<style>` tag — the same shape `../evolution.js`, `battle/showcase.js`,
 * `economy/showcase.js` and `idle/panel.js` already inject, just as a static import instead of
 * a template literal. A plain `import './x.css'` would give an async `<link>` in the built
 * game, and `__READY__` (`main.js`) can flip before it resolves — a flash of unstyled HUD a
 * capture could catch.
 */
import tokens from '../css/tokens.css?inline';
import base from '../css/base.css?inline';
import hud from '../css/hud.css?inline';
import screens from '../css/screens.css?inline';

let styleInjected = false;
function ensureStyle() {
  if (styleInjected) return;
  const style = document.createElement('style');
  style.id = 'ui-codex-style';
  style.textContent = `${tokens}\n${base}\n${hud}\n${screens}`;
  document.head.appendChild(style);
  styleInjected = true;
}

/**
 * @param {{root: HTMLElement, config: object}} opts `root` is `#ui` (`index.js`'s own
 *   `document.getElementById('ui')`); `config` is `core/config.js`'s instance.
 */
export function makeDomLayer({ root, config }) {
  ensureStyle();

  const host = document.createElement('div');
  host.id = 'ui-dom';
  root.appendChild(host);

  /**
   * Coalesces same-frame invalidations into one `requestAnimationFrame`, mirroring the
   * canvas's own `screen.markDirty()` → `lateFrame()` → `paint()` shape. Nothing calls this
   * yet in Stage 1 (the offline card's collapsible sections are plain DOM/CSS state, not a
   * re-render) — it exists now so a later screen with real cross-cutting state (config
   * changes, a bus-driven feed) has the seam ready rather than inventing its own.
   */
  let raf = null;
  const listeners = new Set();
  function invalidate() {
    if (raf != null) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      for (const fn of listeners) fn();
    });
  }

  /** The determinism switch (`base.css`'s `[data-frozen]` rules) — on whenever a capture's
   *  URL demands the same pixels twice (`tools/shots/parity.js`), exactly the condition
   *  `toasts.js` already freezes ageing on. */
  function setFrozen(on) { host.toggleAttribute('data-frozen', !!on); }
  const readFrozen = () => !!(config?.get ? config.get('showcase') : config?.showcase) ||
    !!(config?.get ? config.get('timeFrozen') : config?.timeFrozen);
  setFrozen(readFrozen());
  const offConfig = config?.onChange?.(() => setFrozen(readFrozen()));

  /**
   * `--ui-scale` mirrors `config.uiScale`, clamped to the same {1, 2} ladder `screen.js`
   * clamps its own backing store to — both layers must agree while the canvas HUD still
   * exists (Stage 9 relaxes this once it doesn't).
   */
  function applyUiScale() {
    const raw = Number(config?.get ? config.get('uiScale') : config?.uiScale);
    host.style.setProperty('--ui-scale', raw >= 2 ? '2' : '1');
  }
  applyUiScale();
  const offScale = config?.onChange?.(applyUiScale);

  /**
   * `document.fonts.ready`, exposed the same way `screen.js`'s `imagesSettled()` exposes
   * sprite-sheet loads: a showcase awaits it before the shutter
   * (`tools/shots/shoot.js`/`parity.js`), so a self-hosted-but-not-yet-decoded face never
   * shows up as a fallback system font in one capture and the real one in the next.
   */
  function fontsReady() {
    return (typeof document !== 'undefined' && document.fonts?.ready) || Promise.resolve();
  }

  /**
   * The DOM successor to `screen.regions()` — "a button painted under another panel looks
   * identical in a screenshot to one that works" (`screen.js`) is exactly as true here.
   * Anything a flow test needs to find gets a `data-ui="<tag>"` attribute; this walks them.
   */
  function probe() {
    return [...host.querySelectorAll('[data-ui]')].map((el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        tag: el.getAttribute('data-ui'),
        box: { x: r.x, y: r.y, w: r.width, h: r.height },
        visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
        disabled: !!el.disabled,
      };
    });
  }

  return {
    host,
    invalidate,
    /** @returns {Function} unsubscribe */
    onInvalidate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setFrozen,
    fontsReady,
    probe,
    dispose() {
      offConfig?.();
      offScale?.();
      if (raf != null) cancelAnimationFrame(raf);
      listeners.clear();
      host.remove();
    },
  };
}
