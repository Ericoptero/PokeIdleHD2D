/**
 * The trainer screen (Stage 6; Slice 5 — anchored popup) — replaces `panels/trainer.js` under
 * the same DOM screen contract (`{id, open, close, key, draw}`). The content model is untouched
 * (`../models/trainer.js`'s `trainerModel`); what changes is that this scrolls natively
 * instead of through `panels/common.js`'s `scrollArea`, so there is no pixel-height layout
 * pass left to run — the browser already knows how tall its own content is.
 *
 * **Slice 5: no scrim, anchored to the HUD trainer card.** Every other screen this migration
 * built is an opaque `.ci-offline-scrim` card in the middle of the frame; this one instead
 * drops out of `dom/hud.js`'s own trainer button (`data-ui="hud-trainer"`) as a small popup,
 * with the world left fully visible and walkable behind it — the user-approved brief's own
 * call, and why `modal: false` is on the returned panel object below (`../index.js`'s
 * `drawWorld()` and `input.js`'s panel-open branch both read that field to decide whether the
 * world keeps rendering/taking input underneath). `draw()` repositions the popup off the
 * button's own live rect (`app.hudTrainerRect()`) every frame rather than once on open, so it
 * survives a window resize with no listener of its own to maintain.
 */
import { h, setText } from '../dom/el.js';
import { icon } from '../dom/icons.js';
import { fmt } from '../format.js';
import {
  trainerModel, TRAINER_PORTRAIT_URL, TRAINER_FRAME_COUNT, TRAINER_SOUTH_FRAME,
} from '../models/trainer.js';

const CURRENCY_ICON = { money: 'coin', research: 'trending-up', shards: 'gem', bp: 'dot' };

/** Crops the trainer sheet (one column, `TRAINER_FRAME_COUNT` stacked 32×32 frames) to the
 *  south-facing walk frame, the same `background-size`/`background-position` percentage
 *  technique `dom/hud.js`'s party row uses for the 2×4 Pokemon sheet — proportional to the
 *  sheet's own layout, not to any one rendered pixel size. */
function trainerPortrait() {
  const box = h('div', { class: 'ci-trainer-portrait' });
  box.style.backgroundImage = `url(${TRAINER_PORTRAIT_URL})`;
  box.style.backgroundSize = `100% ${TRAINER_FRAME_COUNT * 100}%`;
  box.style.backgroundPosition = `0% ${(TRAINER_SOUTH_FRAME / (TRAINER_FRAME_COUNT - 1)) * 100}%`;
  return box;
}

function row(label, value, { dim = false, frac = null } = {}) {
  const children = [
    h('span', { class: 'ci-trainer-row__label' }, label),
    h('span', { class: 'ci-trainer-row__value' }, value),
  ];
  if (!Number.isFinite(frac)) return h('div', { class: `ci-trainer-row${dim ? ' ci-trainer-row--dim' : ''}` }, children);
  const fill = h('div', { class: 'ci-hp-meter__fill' });
  fill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  fill.dataset.band = frac <= 0.2 ? 'low' : frac <= 0.5 ? 'mid' : 'high';
  return h('div', { class: 'ci-trainer-party-row' }, [
    h('div', { class: `ci-trainer-row${dim ? ' ci-trainer-row--dim' : ''}` }, children),
    h('div', { class: 'ci-hp-meter' }, fill),
  ]);
}

function section(sec) {
  const body = sec.rows.length
    ? sec.rows.map((r) => row(r.label, r.value, { dim: !!r.dim, frac: r.frac }))
    : [h('div', { class: 'ci-shelf-empty' }, sec.empty ?? 'Nothing yet.')];
  return h('div', { class: 'ci-trainer-section' }, [
    h('h3', { class: 'ci-settings-section__title' }, sec.label),
    ...body,
  ]);
}

export function makeTrainerDomScreen(app, domLayer) {
  let root = null;
  let levelText = null;
  let winsText = null;
  let xpFill = null;
  let xpText = null;
  let walletHost = null;
  let body = null;

  function renderStatic() {
    levelText = h('span', {}, '');
    winsText = h('span', { class: 'ci-trainer-head__wins' }, '');
    xpFill = h('div', { class: 'ci-meter__fill' });
    xpText = h('span', { class: 'ci-trainer-head__xp-text' }, '');
    walletHost = h('div', { class: 'ci-trainer-wallet' });
    body = h('div', { class: 'ci-trainer-body', 'data-ui': 'trainer-body' });

    return h('div', { class: 'ci-trainer-pop', 'data-ui': 'trainer-pop' }, [
      h('div', { class: 'ci-trainer-head' }, [
        trainerPortrait(),
        h('div', { class: 'ci-trainer-head__body' }, [
          h('span', { class: 'ci-trainer-head__title' }, [levelText]),
          winsText,
          h('div', { class: 'ci-trainer-head__xp' }, [
            h('div', { class: 'ci-meter' }, xpFill),
            xpText,
          ]),
        ]),
        h('button', {
          type: 'button', class: 'ci-icon-btn ci-trainer-close', 'data-ui': 'trainer-close', onClick: () => app.close(),
        }, icon('close', { size: 18 })),
      ]),
      walletHost,
      body,
    ]);
  }

  function update() {
    const model = trainerModel(app);
    setText(levelText, `Trainer ${model.level}`);
    setText(winsText, `${fmt(model.wins)} wins`);
    const frac = model.need > 0 ? Math.max(0, Math.min(1, model.into / model.need)) : 0;
    xpFill.style.width = `${frac * 100}%`;
    setText(xpText, `${fmt(model.into)} / ${fmt(model.need)} to Lv ${model.level + 1}`);

    walletHost.replaceChildren(...model.currencies.map((c) => h('div', {
      class: 'ci-chip', 'data-currency': c.id, 'data-ui': `trainer-wallet-${c.id}`,
    }, [icon(CURRENCY_ICON[c.id] ?? 'dot', { size: 15 }), h('span', {}, fmt(c.balance))])));

    body.replaceChildren(...model.sections.map(section));
  }

  /**
   * Dismiss-on-outside-click: closes the popup unless the pointer landed inside it, or on the
   * HUD trainer button itself (`data-ui="hud-trainer"`, `dom/hud.js`) — without that second
   * exception, the same press that opens the popup (button `click`) would also be seen here as
   * an "outside" `pointerdown` firing first and closing it before it ever showed. Captured on
   * `document` (`true` for the capture phase, matching this codebase's other document-level
   * listeners, e.g. `dom/dnd.js`'s own pointer listeners) rather than a narrower ancestor, since
   * the whole point is to catch a click anywhere else in the game.
   */
  function onOutsidePointerDown(ev) {
    if (root?.contains(ev.target)) return;
    if (ev.target?.closest?.('[data-ui="hud-trainer"]')) return;
    app.close();
  }

  return {
    id: 'trainer',
    /** Not part of the panel contract `../index.js` drives — the `models/inventory.js`/
     *  `filterRows` precedent for exposing the content model a test can read with no DOM. */
    model: () => trainerModel(app),
    // Slice 5: the one screen in this migration that does not cover the world — see this
    // file's own header. `../index.js`'s `drawWorld()` and `input.js`'s panel-open branch
    // both key off this field rather than a special-cased `id === 'trainer'` check, so a
    // future non-modal popup needs only to set this, not to touch either of those files again.
    modal: false,
    open() {
      root = renderStatic();
      domLayer.host.appendChild(root);
      update();
      document.addEventListener('pointerdown', onOutsidePointerDown, true);
    },
    close() {
      document.removeEventListener('pointerdown', onOutsidePointerDown, true);
      root?.remove();
      root = null;
    },
    key(ev) {
      if (ev.code === 'Escape') { app.close(); return true; }
      return false;
    },
    draw() {
      if (!root) return null;
      update();
      // Anchored off the HUD trainer button's own live rect, recomputed every frame (no
      // resize listener needed — see this file's own header) rather than once on open.
      const rect = app.hudTrainerRect?.();
      if (rect) {
        root.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - root.offsetWidth - 8))}px`;
        root.style.top = `${rect.bottom + 8}px`;
        root.style.maxHeight = `${Math.max(120, window.innerHeight - rect.bottom - 16)}px`;
      }
      return null;
    },
  };
}
