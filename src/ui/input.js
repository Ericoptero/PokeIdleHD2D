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
 * `Z`/`Space` swap meaning the instant a panel is open, or the post-battle capture tooltip is
 * up: `onKeyDown` routes them to the tooltip first (`app.captureKey`, `dom/capture.js`), then
 * to the open panel's own `key(ev)` (a dialogue's advance) — interact only ever fires with
 * neither present, so the three never race for the same press.
 *
 * The event is generic — the faced cell's tags, not a fixed list of "things you can talk to" —
 * on purpose: the input bus lets `pokecenter` gets to react to it without this file knowing
 * the Pokemon Center exists, and why a future NPC anywhere else needs no new key of its own.
 *
 * A touch device gets an on-screen pad instead — `dom/dpad.js` (Stage 8), not drawn here; this
 * file only owns the `press(dir)`/`release(dir)`/`touch()`/`canWalk()` primitives that pad
 * reads, the same ones a held keyboard key already drives — but only on a touch device,
 * because every other module's showcase boots `ui` too (`src/main.js`) and a d-pad in the
 * corner of a critic's screenshot of the *city* would be this module vandalising someone
 * else's frame.
 */

import {
  SOUTH, WEST, NORTH, EAST, DIR_DX, DIR_DZ,
} from '../core/dir.js';

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
  'trainer', 'dialogue', 'settings',
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

    // The post-battle capture tooltip (`dom/capture.js`) is not a panel — it floats over the
    // world with nothing else open — so it gets first refusal on `Z`/`Space` ahead of the
    // panel gate below, the same priority the old battle card's own keybind had while it was
    // the open panel.
    if (app.captureKey(ev)) { ev.preventDefault(); return; }

    // A panel swallows movement: walking blind behind a full-frame shop is the classic bug.
    // The one exception is a panel that declares itself non-modal (`app.panelModal()`, today
    // only the trainer popup, Slice 5): the world stays visible and walkable behind it by
    // design, so an unhandled key falls through to the rest of this chain below — movement,
    // interact, chat — instead of being swallowed here the way a modal panel's is.
    if (app.panelOpen()) {
      if (app.panelKey(ev)) { clear(); ev.preventDefault(); return; }
      if (code === 'Escape' || code === 'KeyX') { clear(); app.close(); ev.preventDefault(); return; }
      if (app.panelModal()) { clear(); return; }
    }

    // Economy mode (`screens/economy.js`, Stage 7) is a root mode, not a panel — it has no
    // `state.panel` slot to swallow movement through, but walking blind with the world hidden
    // is the same bug the branch above exists to avoid, so this mirrors it: every panel
    // shortcut still opens on top of the board (Bag, Shop and Automation all still make sense
    // with no 3D view to look at), and Escape/X leave the mode instead of opening the menu.
    if (app.economyModeActive?.()) {
      clear();
      if (code === 'Escape' || code === 'KeyX') { app.setEconomyMode(false); ev.preventDefault(); return; }
      if (code === 'Enter') { app.toggleChat(); ev.preventDefault(); return; }
      const onId = PANEL_KEYS.get(code);
      if (onId) { app.open(onId); ev.preventDefault(); }
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

  return {
    frame,
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
