/**
 * The post-battle capture control — a small, world-anchored tooltip over a beaten wild,
 * replacing the old docked battle card's Throw/Run buttons (`ui/screens/battle.js`, removed).
 *
 * **Only shown when a human has to decide.** Auto-Catch, when it is on, already throws from
 * its own `battle:ended` handler (`src/automation/index.js`) well inside the ordinary short
 * throw window — this tooltip would only ever flash and vanish in that case, so it never
 * mounts while Auto-Catch is active. When it is off, `encounter/index.js`'s `leaveSteps()`
 * holds the window open for `config.manualThrowSeconds` (5s) specifically so this has time to
 * be read and clicked, and the wild keeps floating (`FLOAT_AMPLITUDE`, `encounter/index.js`)
 * the whole time it is up.
 *
 * Reuses the same ball choice the old card did — `encounter.bestBall()` (the strongest ball
 * actually in the bag, `economy.recommendBall()`) — and the same call,
 * `encounter.attempt(id)`/`encounter.flee()`. If the window times out with nothing clicked,
 * `resolveUnattended()` lets the wild go exactly as it always has; this tooltip changes
 * nothing about that outcome, only how long a player has to act before it happens.
 */
import { h, setText } from './el.js';
import { POKEMON_LIFT } from '../plates.js';

const isLive = (api) => !!api && api.__missing === undefined;

export function makeCaptureTooltip(ctx) {
  const ballName = h('span', { class: 'ci-capture__ball' });
  const throwBtn = h('button', { type: 'button', class: 'ci-btn', 'data-ui': 'capture-throw' }, ballName);
  const runBtn = h('button', { type: 'button', class: 'ci-shelf-btn', 'data-ui': 'capture-run' }, 'Run');
  const anchor = h('div', { class: 'ci-balloon-anchor', hidden: true },
    h('div', { class: 'ci-capture' }, [throwBtn, runBtn]));

  /**
   * The window's own eligibility, computed straight from the live modules — never from
   * `anchor.hidden` or any other DOM side-effect of the last `update()`. `key()` needs this
   * independent of render cadence: a real player can press `Z` the instant the tooltip
   * appears, before the next `requestAnimationFrame`'s `lateFrame()` has synced the DOM (and a
   * scripted `key()` press, `tests/flows/vfx-real-fight.spec.js`, can arrive with NO
   * `lateFrame` in between at all under the paused test harness — `window.__HOOKS__.step()`
   * only drives `registry.tick`). Consulting the modules directly is what makes the keybind
   * correct in both.
   */
  function eligible() {
    const enc = ctx.get('encounter');
    const auto = ctx.get('automation');
    const active = isLive(enc) && typeof enc.active === 'function' ? enc.active() : null;
    const scene = isLive(enc) && typeof enc.scene === 'function' ? enc.scene() : null;
    const autoCatch = isLive(auto) && typeof auto.isActive === 'function' && auto.isActive('catch');
    if (!active?.battle || active.battle.win !== true || scene?.stage !== 'ready' || autoCatch) return null;
    return { enc, scene };
  }

  function attempt() {
    const enc = ctx.get('encounter');
    if (!isLive(enc) || typeof enc.attempt !== 'function') return;
    const id = typeof enc.ball === 'function' ? enc.ball() : undefined;
    const eco = ctx.get('economy');
    const owned = isLive(eco) && typeof eco.count === 'function' && id ? eco.count(id) > 0 : false;
    enc.attempt(owned ? id : (enc.bestBall?.()?.id ?? id));
  }
  function flee() {
    const enc = ctx.get('encounter');
    if (isLive(enc) && typeof enc.flee === 'function') enc.flee();
  }
  throwBtn.addEventListener('click', attempt);
  runBtn.addEventListener('click', flee);

  return {
    el: anchor,
    /** @returns {boolean} whether the tooltip is visible this frame. */
    update(projectClient) {
      const on = eligible();
      if (!on) { anchor.hidden = true; return false; }
      const { enc, scene } = on;

      const at = typeof projectClient === 'function'
        ? projectClient(scene.at.cx + 0.5, scene.at.y + (scene.headLift ?? POKEMON_LIFT), scene.at.cz + 0.5)
        : null;
      if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) { anchor.hidden = true; return false; }
      anchor.hidden = false;
      anchor.style.left = `${at.x}px`;
      anchor.style.top = `${at.y}px`;

      const eco = ctx.get('economy');
      const id = (typeof enc.ball === 'function' ? enc.ball() : null);
      const owned = isLive(eco) && typeof eco.count === 'function' && id ? eco.count(id) > 0 : false;
      const ballId = owned ? id : (enc.bestBall?.()?.id ?? id);
      const left = isLive(eco) && typeof eco.count === 'function' && ballId ? (Number(eco.count(ballId)) || 0) : 0;
      const name = (isLive(eco) ? eco.item?.(ballId)?.name : null) ?? 'Ball';
      setText(ballName, left > 0 ? `Throw ${name} ×${left}` : 'No balls');
      throwBtn.disabled = left <= 0;
      return true;
    },
    /** `Z`/`Space` throws, matching the old battle card's own keybind — `R` is deliberately
     *  NOT bound here (click-only for Run): it is already the global "open Trainer" shortcut
     *  (`ui/input.js`'s `PANEL_KEYS`) outside a panel, which is exactly the context this
     *  tooltip shows in. @returns {boolean} whether the key was consumed. */
    key(ev) {
      if (!eligible()) return false;
      if (ev.code === 'KeyZ' || ev.code === 'Space') { attempt(); return true; }
      return false;
    },
    dispose() { anchor.remove(); },
  };
}
