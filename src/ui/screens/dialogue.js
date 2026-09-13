/**
 * The message box (Stage 9) — replaces `panels/dialogue.js` under the same panel contract,
 * including its one load-bearing flag: **`hidesHud: true`**, the only panel in the app that
 * still uses it (`../index.js`'s `bars = !state.panel?.hidesHud` stands the wallet/dock/party
 * bar down while a message is up, matching the mainline's own "a message is not a menu, but it
 * does own the whole bottom of the screen" rule). Nothing about that mechanism changes moving
 * to DOM — the flag lives on the descriptor object either way.
 *
 * Still nobody's caller — `ctx.get('ui').say(text, {speaker})` is a seam nothing in `src/`
 * publishes NPC lines through yet (`panels/dialogue.js`'s own header). This screen is honest
 * to that: it is not docked to any HUD chrome dependency, has no scrim (the mainline shows the
 * scene behind a message box), and needs no live subscription — `open()` is handed the whole
 * page set at once.
 */
import { h, setText } from '../dom/el.js';
import { icon } from '../dom/icons.js';

export function makeDialogueDomScreen(app, domLayer) {
  let root = null;
  let pages = [];
  let index = 0;
  let speaker = null;
  let onDone = null;
  let speakerEl = null;
  let textEl = null;
  let countEl = null;

  function advance() {
    index += 1;
    if (index < pages.length) { render(); return; }
    const done = onDone;
    app.close();
    if (typeof done === 'function') { try { done(); } catch { /* the caller's problem */ } }
  }

  function render() {
    if (speaker) { speakerEl.hidden = false; setText(speakerEl, speaker); } else { speakerEl.hidden = true; }
    setText(textEl, pages[index] ?? '');
    if (pages.length > 1) { countEl.hidden = false; setText(countEl, `${index + 1}/${pages.length}`); } else { countEl.hidden = true; }
  }

  return {
    id: 'dialogue',
    hidesHud: true,
    open(opts = {}) {
      const text = opts.text ?? opts.pages ?? '';
      pages = (Array.isArray(text) ? text : [text]).map((t) => String(t ?? '')).filter(Boolean);
      if (!pages.length) pages = ['…'];
      index = 0;
      speaker = opts.speaker ? String(opts.speaker) : null;
      onDone = opts.onDone ?? null;

      speakerEl = h('span', { class: 'ci-dialogue-speaker' }, '');
      textEl = h('p', { class: 'ci-dialogue-text' }, '');
      countEl = h('span', { class: 'ci-dialogue-count' }, '');
      root = h('div', { class: 'ci-dialogue', 'data-ui': 'dialogue-box' }, [
        h('button', {
          type: 'button', class: 'ci-dialogue-surface', 'data-ui': 'dialogue-advance', onClick: () => advance(),
        }, [
          speakerEl,
          textEl,
          h('div', { class: 'ci-dialogue-footer' }, [countEl, icon('chevron-down', { size: 16 })]),
        ]),
      ]);
      domLayer.host.appendChild(root);
      render();
    },
    close() {
      pages = []; index = 0; speaker = null; onDone = null;
      root?.remove(); root = null;
    },
    remaining: () => Math.max(0, pages.length - index),
    key(ev) {
      if (ev.code === 'Enter' || ev.code === 'KeyZ' || ev.code === 'Space') { advance(); return true; }
      return false;
    },
    draw() { return null; },
  };
}
