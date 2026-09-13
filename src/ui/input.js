/**
 * The input seam. Nothing else in the game maps a device to the world.
 *
 * Movement goes through `simulation.moveIntent(dir)` and nowhere else, which is what keeps
 * the walk tile-locked and deterministic: `moveIntent` queues **one** step, taken on the next
 * fixed tick where the queue is standing still, so holding a key is expressed
 * as re-issuing the intent every frame rather than as a velocity. Releasing calls `stop()`,
 * and the walker finishes the tile it is on instead of stopping between two.
 *
 * **Whether the keyboard drives the walker at all is the scene's call.** A hunt is watched,
 * not steered: `simulation.formation().input` is false there, so a direction key does not
 * queue a step and does not draw the pad. It is not a silent dead key — the first one raises
 * a toast saying who is leading and how to leave.
 *
 * Keys, in the Black & White idiom:
 *
 * ```
 *   ← ↑ → ↓  /  W A S D     walk (walkable maps only)
 *   Z / Space                interact — the faced cell's tags, `player:interact` (src/core/bus.js)
 *   Enter                    confirm / menu   X / Escape     back, or open the menu
 *   T travel  P party   B shop   C boxes   I bag   4 dex   R trainer   M menu   `  debug overlay
 * ```
 *
 * `Z`/`Space` swap meaning the instant a panel is open: `onKeyDown`'s panel branch routes them
 * to that panel's own `key(ev)` first (a dialogue's advance, a battle card's throw) — interact
 * only ever fires with no panel open, so the two never race for the same press.
 *
 * The event is generic — the faced cell's tags, not a fixed list of "things you can talk to" —
 * on purpose: the input bus lets `pokecenter` gets to react to it without this file knowing
 * the Pokemon Center exists, and why a future NPC anywhere else needs no new key of its own.
 *
 * A touch device gets an on-screen pad instead, drawn on the same canvas — but only on a
 * touch device, because every other module's showcase boots `ui` too (`src/main.js`) and a
 * d-pad in the corner of a critic's screenshot of the *city* would be this module vandalising
 * someone else's frame.
 */

import {
  SOUTH, WEST, NORTH, EAST, DIR_DX, DIR_DZ,
} from '../core/dir.js';
import { C } from './theme.js';

/** Physical keys → direction. `code` rather than `key`, so a non-QWERTY layout still walks. */
export const MOVE_KEYS = new Map([
  ['ArrowDown', SOUTH], ['KeyS', SOUTH],
  ['ArrowLeft', WEST], ['KeyA', WEST],
  ['ArrowUp', NORTH], ['KeyW', NORTH],
  ['ArrowRight', EAST], ['KeyD', EAST],
]);

/** Panel shortcuts. `KeyD` walks east, so the dex has no letter of its own — it is `4`. */
/**
 * Every panel `ui` ships, in strip order.
 *
 * It lives here rather than in `index.js` because `index.js` is not importable under Node — it
 * reaches a canvas at init — and `selftest.js` has to be able to check that no shortcut names a
 * panel that does not exist. `ui.selfTest()` asserts the live `PANELS` map matches this list, so
 * the two cannot drift; before sharing this reducer the Node check carried its own hand-written copy
 * and adding a panel failed it.
 */
export const PANEL_IDS = Object.freeze([
  'menu', 'travel', 'offline', 'shop', 'boxes', 'dex', 'automation', 'party', 'inventory',
  'trainer', 'battle', 'dialogue',
]);

export const PANEL_KEYS = new Map([
  ['KeyT', 'travel'], ['KeyP', 'party'], ['KeyB', 'shop'], ['KeyC', 'boxes'], ['KeyM', 'menu'],
  ['KeyU', 'automation'], ['KeyI', 'inventory'], ['KeyR', 'trainer'],
  ['Digit1', 'party'], ['Digit2', 'shop'], ['Digit3', 'boxes'], ['Digit4', 'dex'],
  ['Digit5', 'travel'], ['Digit6', 'automation'], ['Digit7', 'inventory'], ['Digit8', 'trainer'],
]);

const isLive = (api) => !!api && api.__missing === undefined;

export function makeInput({ ctx, app }) {
  const held = [];              // direction stack, most recently pressed first
  let touch = false;
  /**
   * True once the player has engaged with the controls at all — driven the walker, been told
   * why they cannot, or opened a panel. It is not "has moved": in a hunt the player can never
   * move, and a flag that only a step could clear would leave the control hint sitting over
   * the near ground in every hunt frame a critic ever takes.
   */
  let engaged = false;
  /** The scene we have already explained ourselves in, so a held key raises one toast, not sixty. */
  let refusedFor = null;
  const listeners = [];
  const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); listeners.push(() => el.removeEventListener(type, fn, opts)); };

  // A coarse pointer means a phone or a tablet: show the pad from the first frame there,
  // and on anything else only once a real touch has happened.
  try { touch = matchMedia('(pointer: coarse)').matches; } catch { touch = false; }

  const sim = () => ctx.get('simulation');
  /** No formation at all — simulation down, or another module's showcase — behaves as before. */
  function canWalk() {
    const s = sim();
    if (!isLive(s) || typeof s.formation !== 'function') return true;
    return s.formation().input !== false;
  }
  function engage() { if (!engaged) { engaged = true; app.markDirty(); } }
  /** Says once per scene why the keys do nothing here, instead of eating them in silence. */
  function refuse() {
    engage();
    const t = ctx.get('travel');
    const id = isLive(t) && typeof t.current === 'function' ? (t.current()?.id ?? '?') : '?';
    if (refusedFor === id) return;
    refusedFor = id;
    app.toast('Your Pokémon hunts on its own — press T to travel', 'info');
  }

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

  /**
   * `player:interact` (src/core/bus.js): a generic "the player faced a cell and pressed the
   * button" event, not a Center-specific one — any tagged cell in any scene can react to it
   * without a new key of its own. `terrain.tagsAt` is the same accessor `simulation`'s own
   * `announce()` uses to build `player:enteredTile`'s payload (src/simulation/index.js), so this reuses an
   * existing, cheap read rather than inventing a second way to ask the question.
   */
  function interact() {
    if (!canWalk()) return;
    const s = sim();
    if (!isLive(s) || typeof s.player !== 'function') return;
    const { cx, cz, dir } = s.player();
    const fx = cx + DIR_DX[dir], fz = cz + DIR_DZ[dir];
    const terrain = ctx.get('terrain');
    const tags = isLive(terrain) && typeof terrain.tagsAt === 'function' ? terrain.tagsAt(fx, fz) : [];
    ctx.bus.emit('player:interact', { cx, cz, dir, facing: { cx: fx, cz: fz }, tags });
  }

  function onKeyDown(ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const code = ev.code;

    // A focused text field (the chat mockup's own input, `dom/chat.js`) owns its own keys —
    // without this, typing "travel" into it would fire T/R/A/V/E/L as panel shortcuts on the
    // way past. Escape still blurs it, matching every other escape hatch in this file; the
    // field's own `keydown` listener handles Enter (send/close) before this ever runs, so
    // there is nothing else to do here for it.
    const editing = !!document.activeElement
      && (document.activeElement.isContentEditable
        || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName));
    if (editing) {
      if (code === 'Escape') document.activeElement.blur();
      return;
    }

    if (code === 'Backquote') { app.toggleDebug(); ev.preventDefault(); return; }

    // A panel swallows movement: walking blind behind a full-frame shop is the classic bug.
    if (app.panelOpen()) {
      clear();
      if (app.panelKey(ev)) { ev.preventDefault(); return; }
      if (code === 'Escape' || code === 'KeyX') { app.close(); ev.preventDefault(); return; }
      return;
    }

    if (MOVE_KEYS.has(code)) {
      // preventDefault even when the key does nothing here: a page that scrolls out from
      // under the game is worse than a key that politely explains itself.
      if (code.startsWith('Arrow')) ev.preventDefault();
      if (!canWalk()) { refuse(); return; }
      press(MOVE_KEYS.get(code));
      return;
    }
    if (code === 'KeyZ' || code === 'Space') {
      // Always prevented, even when nothing reacts: Space scrolls the page by default.
      if (code === 'Space') ev.preventDefault();
      interact();
      return;
    }
    if (code === 'Escape' || code === 'KeyX') { app.open('menu'); ev.preventDefault(); return; }
    // Enter used to open the menu too; it now opens/closes the chat mockup instead
    // (`dom/chat.js`, Stage 3c) — Escape/X are still the menu's own keys.
    if (code === 'Enter') { app.toggleChat(); ev.preventDefault(); return; }
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
  }

  on(window, 'keydown', onKeyDown);
  on(window, 'keyup', onKeyUp);
  // A tab-out with a key down would otherwise leave the walker jogging into a wall forever.
  on(window, 'blur', () => { clear(); });
  on(window, 'touchstart', () => { if (!touch) { touch = true; app.markDirty(); } }, { passive: true });

  /**
   * Re-issues the held direction every frame; `moveIntent` overrides the autopilot for one
   * step only.
   *
   * There used to be a "the first real input halts the autopilot for good" seam here, because
   * `city.enter()` left the player on a wander. A walkable map no longer
   * installs one, and a hunt's wander is the whole point of a hunt, so the seam could only
   * ever do the wrong thing now and is gone.
   */
  function frame() {
    if (!held.length) return;
    const s = sim();
    if (!isLive(s) || typeof s.moveIntent !== 'function') return;
    if (s.moveIntent(held[0]) !== false) engage();
  }

  // ------------------------------------------------------------- the touch pad
  const PAD = { size: 21 };

  /**
   * The d-pad, drawn as **one body** rather than as five detached rectangles.
   *
   * Round 1 drew four separate 21 px panels in a plus with a bare tan square in the middle,
   * and a rectangular RUN chip beside it — which is what a d-pad looks like before anyone has
   * drawn it. The silhouette here is a single cross with the corner pixels knocked out the
   * same way `theme.panel` knocks them out, the four keys are plates inset into it and the
   * middle is a recessed hub rather than a hole. (The RUN latch went with run itself.)
   */
  function drawPad(g) {
    // Not drawn where the player cannot walk. `screen.paint()` clears the hit regions every
    // repaint, so not drawing the pad *is* unregistering it — there are no orphaned taps.
    if (!touch || !canWalk()) return;
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
    /** True once the player has engaged with the controls — the hint hides itself then. */
    hasMoved: () => engaged,
    /** Whether this scene lets the keyboard drive the walker; the hint copy reads it. */
    canWalk,
    touch: () => touch,
    held: () => held.slice(),
    /** For the showcase: stage the pad without a touch device. */
    setTouch(on2) { touch = !!on2; },
    press,
    release,
    dispose() { for (const off of listeners) off(); },
  };
}
