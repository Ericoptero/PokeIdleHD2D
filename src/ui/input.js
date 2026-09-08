/**
 * The input seam. Nothing else in the game maps a device to the world.
 *
 * Movement goes through `simulation.moveIntent(dir, running)` and nowhere else, which is
 * what keeps the walk tile-locked and deterministic: `moveIntent` queues **one** step, taken
 * on the next fixed tick where the queue is standing still (DECISIONS #27), so holding a key
 * is expressed as re-issuing the intent every frame rather than as a velocity. Releasing
 * calls `stop()`, and the walker finishes the tile it is on instead of stopping between two.
 *
 * Keys, in the Black & White idiom:
 *
 * ```
 *   ← ↑ → ↓  /  W A S D     walk            Shift (held)   run
 *   Z / Enter                confirm         X / Escape     back, or open the menu
 *   P party   B bag   C boxes   D dex   M menu   `  debug overlay
 * ```
 *
 * A touch device gets an on-screen pad instead, drawn on the same canvas — but only on a
 * touch device, because every other module's showcase boots `ui` too (`src/main.js`) and a
 * d-pad in the corner of a critic's screenshot of the *city* would be this module vandalising
 * someone else's frame.
 */

import { SOUTH, WEST, NORTH, EAST } from '../core/dir.js';
import { C, panel } from './theme.js';

/** Physical keys → direction. `code` rather than `key`, so a non-QWERTY layout still walks. */
export const MOVE_KEYS = new Map([
  ['ArrowDown', SOUTH], ['KeyS', SOUTH],
  ['ArrowLeft', WEST], ['KeyA', WEST],
  ['ArrowUp', NORTH], ['KeyW', NORTH],
  ['ArrowRight', EAST], ['KeyD', EAST],
]);

/** Panel shortcuts. `KeyD` walks east, so the dex has no letter of its own — it is `4`. */
export const PANEL_KEYS = new Map([
  ['KeyP', 'party'], ['KeyB', 'shop'], ['KeyC', 'boxes'], ['KeyM', 'menu'],
  ['Digit1', 'party'], ['Digit2', 'shop'], ['Digit3', 'boxes'], ['Digit4', 'dex'],
]);

const isLive = (api) => !!api && api.__missing === undefined;

export function makeInput({ ctx, app }) {
  const held = [];              // direction stack, most recently pressed first
  let running = false;
  let touch = false;
  let tookOver = false;
  let moved = false;
  const listeners = [];
  const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); listeners.push(() => el.removeEventListener(type, fn, opts)); };

  // A coarse pointer means a phone or a tablet: show the pad from the first frame there,
  // and on anything else only once a real touch has happened.
  try { touch = matchMedia('(pointer: coarse)').matches; } catch { touch = false; }

  const sim = () => ctx.get('simulation');

  function press(dir) {
    const i = held.indexOf(dir);
    if (i >= 0) held.splice(i, 1);
    held.unshift(dir);
  }
  function release(dir) {
    const i = held.indexOf(dir);
    if (i >= 0) held.splice(i, 1);
  }
  function clear() {
    if (!held.length) return;
    held.length = 0;
    const s = sim();
    if (isLive(s) && typeof s.stop === 'function') s.stop();
  }

  function onKeyDown(ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const code = ev.code;

    if (code === 'Backquote') { app.toggleDebug(); ev.preventDefault(); return; }

    // A panel swallows movement: walking blind behind a full-frame shop is the classic bug.
    if (app.panelOpen()) {
      clear();
      if (app.panelKey(ev)) { ev.preventDefault(); return; }
      if (code === 'Escape' || code === 'KeyX') { app.close(); ev.preventDefault(); return; }
      return;
    }

    if (MOVE_KEYS.has(code)) {
      press(MOVE_KEYS.get(code));
      if (code.startsWith('Arrow')) ev.preventDefault();
      return;
    }
    if (code === 'ShiftLeft' || code === 'ShiftRight') { running = true; return; }
    if (code === 'Escape' || code === 'KeyX' || code === 'Enter') { app.open('menu'); ev.preventDefault(); return; }
    const panelId = PANEL_KEYS.get(code);
    if (panelId) { app.open(panelId); ev.preventDefault(); }
  }

  function onKeyUp(ev) {
    const code = ev.code;
    if (MOVE_KEYS.has(code)) {
      release(MOVE_KEYS.get(code));
      if (!held.length) {
        const s = sim();
        if (isLive(s) && typeof s.stop === 'function') s.stop();
      }
      return;
    }
    if (code === 'ShiftLeft' || code === 'ShiftRight') running = false;
  }

  on(window, 'keydown', onKeyDown);
  on(window, 'keyup', onKeyUp);
  // A tab-out with a key down would otherwise leave the walker jogging into a wall forever.
  on(window, 'blur', () => { clear(); running = false; });
  on(window, 'touchstart', () => { if (!touch) { touch = true; app.markDirty(); } }, { passive: true });

  /**
   * Re-issues the held direction every frame. `moveIntent` overrides the autopilot for one
   * step only, so this is also what takes the player off a scripted route: the first real
   * input halts it for good, rather than fighting it for the rest of the session.
   */
  function frame() {
    if (!held.length) return;
    const s = sim();
    if (!isLive(s) || typeof s.moveIntent !== 'function') return;
    if (!tookOver) {
      tookOver = true;
      if (typeof s.autopilot === 'function' && s.autopilot() !== 'still' && typeof s.halt === 'function') s.halt();
    }
    s.moveIntent(held[0], running);
    if (!moved) { moved = true; app.markDirty(); }
  }

  // ------------------------------------------------------------- the touch pad
  const PAD = { size: 21 };

  /**
   * The d-pad, drawn as **one body** rather than as five detached rectangles.
   *
   * Round 1 drew four separate 21 px panels in a plus with a bare tan square in the middle,
   * and a rectangular RUN chip beside it — which is what a d-pad looks like before anyone has
   * drawn it. The silhouette here is a single cross with the corner pixels knocked out the
   * same way `theme.panel` knocks them out, the four keys are plates inset into it, the
   * middle is a recessed hub rather than a hole, and RUN is a latch that says so.
   */
  function drawPad(g) {
    if (!touch) return;
    const s = PAD.size;
    const ox = 8;
    const oy = g.height - s * 3 - 8;

    // The cross, outlined by the two-rect trick so all eight outer corners are knocked out.
    const ink = C.ink;
    g.fill(ox + s, oy - 1, s, s * 3 + 2, ink);
    g.fill(ox + s - 1, oy, s + 2, s * 3, ink);
    g.fill(ox - 1, oy + s, s * 3 + 2, s, ink);
    g.fill(ox, oy + s - 1, s * 3, s + 2, ink);
    g.fill(ox + s, oy, s, s * 3, C.wallBase);
    g.fill(ox, oy + s, s * 3, s, C.wallBase);
    // the light coming from the top-left, as everywhere else in this UI
    g.fill(ox + s + 1, oy + 1, s - 2, 1, C.wallHi);
    g.fill(ox + 1, oy + s + 1, s, 1, C.wallHi);
    g.fill(ox + 1, oy + s + 1, 1, s - 2, C.wallHi);
    g.fill(ox + s + 1, oy + 1, 1, s, C.wallHi);
    g.fill(ox + s + 1, oy + s * 3 - 2, s - 2, 1, C.wallDeep);
    g.fill(ox + s * 3 - 2, oy + s + 1, 1, s - 2, C.wallDeep);

    const cells = [
      { dir: NORTH, gx: 1, gy: 0, glyph: '↑' },
      { dir: WEST, gx: 0, gy: 1, glyph: '←' },
      { dir: EAST, gx: 2, gy: 1, glyph: '→' },
      { dir: SOUTH, gx: 1, gy: 2, glyph: '↓' },
    ];
    for (const cell of cells) {
      const box = { x: ox + cell.gx * s + 3, y: oy + cell.gy * s + 3, w: s - 6, h: s - 6 };
      const down = held[0] === cell.dir;
      g.fill(box.x - 1, box.y - 1, box.w + 2, box.h + 2, C.wallDeep);
      g.fill(box.x, box.y, box.w, box.h, down ? C.martBase : C.wallLight);
      g.fill(box.x, box.y, box.w, 1, down ? C.martDeep : C.wallHi);
      g.fill(box.x, box.y + box.h - 1, box.w, 1, down ? C.martLight : C.wallDeep);
      g.textCentre(box.x + box.w / 2, box.y + Math.round((box.h - 7) / 2), cell.glyph, down ? C.white : C.ink);
      // the whole arm is the target, not just the plate: a thumb is wider than 15 px
      g.hit({ x: ox + cell.gx * s, y: oy + cell.gy * s, w: s, h: s },
        () => { press(cell.dir); pulse(cell.dir); }, `pad-${cell.dir}`);
    }

    // The hub: recessed, so the middle reads as the pad's pivot instead of as a gap.
    const hx = ox + s + Math.round((s - 9) / 2);
    const hy = oy + s + Math.round((s - 9) / 2);
    g.fill(hx, hy, 9, 9, C.wallDeep);
    g.fill(hx + 1, hy + 1, 7, 7, C.wallShadow);
    g.fill(hx + 1, hy + 1, 7, 1, C.wallDeep);
    g.fill(hx + 1, hy + 7, 7, 1, C.wallLight);

    // Run is a latch on touch — there is no Shift to hold — so it says LATCHED when it is on
    // and carries a lamp that lights, rather than being a chip that changes colour silently.
    const runBox = { x: ox + s * 3 + 8, y: oy + s, w: 40, h: s };
    panel(g, runBox, { paper: running ? C.roofBase : C.wallLight, drop: false,
      bevel: running ? C.roofLight : C.wallHi, shade: running ? C.roofDeep : C.wallDeep });
    g.textCentre(runBox.x + runBox.w / 2 + 3, runBox.y + 3, 'RUN', running ? C.white : C.ink);
    g.fill(runBox.x + 4, runBox.y + 5, 4, 4, running ? C.glowLight : C.wallDeep);
    g.fill(runBox.x + 4, runBox.y + 5, 4, 1, running ? C.glowHi : C.stoneShadow);
    g.textCentre(runBox.x + runBox.w / 2, runBox.y + 12, running ? 'LATCHED' : 'hold',
      running ? C.roofHi : C.stoneShadow);
    g.hit(runBox, () => { running = !running; }, 'pad-run');
  }

  /** A tap is one step: press, and release on the next frame boundary. */
  let pulses = [];
  function pulse(dir) { pulses.push({ dir, frames: 2 }); }
  function drainPulses() {
    if (!pulses.length) return;
    pulses = pulses.filter((p) => { p.frames -= 1; if (p.frames > 0) return true; release(p.dir); return false; });
  }

  return {
    frame() { frame(); drainPulses(); },
    drawPad,
    /** True once the player has actually driven the walker — the hint hides itself then. */
    hasMoved: () => moved,
    touch: () => touch,
    held: () => held.slice(),
    running: () => running,
    /** For the showcase: stage the pad without a touch device. */
    setTouch(on2) { touch = !!on2; },
    press,
    release,
    dispose() { for (const off of listeners) off(); },
  };
}
