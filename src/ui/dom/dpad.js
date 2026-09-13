/**
 * The touch d-pad (Stage 8) — replaces `input.js`'s canvas-drawn `drawPad`/`PAD`, deleted in
 * this same stage. The canvas version drew a d-pad because a touch device has no keyboard;
 * `#ui-dom` sits above the canvas already, so the same control is a real DOM element now
 * rather than a second hit-testing system for four buttons.
 *
 * **Hold, not tap.** The canvas pad used `pulse()` — press, then auto-release two frames
 * later, one discrete step per tap — because a canvas `g.hit()` region only ever reports a
 * single "this was hit", with no separate down/up of its own to hold. A DOM button gets real
 * `pointerdown`/`pointerup` for free, so this reads `input.press(dir)`/`input.release(dir)`
 * directly — the same primitives a held keyboard key already drives — and holding a finger on
 * a direction walks continuously, matching the keyboard instead of asking a thumb to tap once
 * per tile.
 */
import { h } from './el.js';
import { SOUTH, WEST, NORTH, EAST } from '../../core/dir.js';

const DIRS = [
  { key: 'n', dir: NORTH, glyph: '↑' },
  { key: 'w', dir: WEST, glyph: '←' },
  { key: 'e', dir: EAST, glyph: '→' },
  { key: 's', dir: SOUTH, glyph: '↓' },
];

export function makeDomPad(domLayer, input) {
  const buttons = new Map();
  const root = h('div', { class: 'ci-dpad', 'data-ui': 'dpad', hidden: true }, [
    ...DIRS.map(({ key, dir, glyph }) => {
      const btn = h('button', {
        type: 'button',
        class: `ci-dpad__btn ci-dpad__${key}`,
        'data-ui': `dpad-${key}`,
        onPointerdown: (ev) => { ev.preventDefault(); btn.dataset.active = 'true'; input.press(dir); },
      }, glyph);
      const up = () => { btn.dataset.active = 'false'; input.release(dir); };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointerleave', up);
      btn.addEventListener('pointercancel', up);
      buttons.set(key, btn);
      return btn;
    }),
    h('div', { class: 'ci-dpad__hub' }),
  ]);
  domLayer.host.appendChild(root);

  // Whether anything else on screen makes walking make sense right now — a full-screen DOM
  // modal already covers the pad by z-index alone (`screens.css`'s modals sit at `4`, this
  // pad at `3`), but a still-canvas panel (`menu`/`party`/`boxes`/…, Stage 9 territory) has no
  // DOM scrim to cover it with, so `../index.js` folds `!state.panel` into this explicitly —
  // the same "don't walk blind behind a panel" rule the hint text already follows.
  let contextOk = true;

  function update() {
    root.hidden = !contextOk || !input.touch() || !input.canWalk();
  }
  update();

  return {
    update,
    setContext(ok) { contextOk = !!ok; update(); },
    dispose() {
      for (const btn of buttons.values()) btn.dataset.active = 'false';
      root.remove();
    },
  };
}
