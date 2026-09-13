/**
 * The trainer screen (Stage 6) — replaces `panels/trainer.js` under the same DOM screen
 * contract (`{id, open, close, key, draw}`). The content model is untouched
 * (`../models/trainer.js`'s `trainerModel`); what changes is that this scrolls natively
 * instead of through `panels/common.js`'s `scrollArea`, so there is no pixel-height layout
 * pass left to run — the browser already knows how tall its own content is.
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

    return h('div', { class: 'ci-offline-scrim', 'data-ui': 'trainer-scrim' }, [
      h('div', { class: 'ci-trainer-card' }, [
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
      ]),
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

  return {
    id: 'trainer',
    /** Not part of the panel contract `../index.js` drives — the `models/inventory.js`/
     *  `filterRows` precedent for exposing the content model a test can read with no DOM. */
    model: () => trainerModel(app),
    open() {
      root = renderStatic();
      domLayer.host.appendChild(root);
      update();
    },
    close() {
      root?.remove();
      root = null;
    },
    key(ev) {
      if (ev.code === 'Escape') { app.close(); return true; }
      return false;
    },
    draw() {
      if (root) update();
      return null;
    },
  };
}
