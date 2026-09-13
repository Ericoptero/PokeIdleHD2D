/**
 * Routes (Stage 6) — replaces `panels/travel.js` under the same DOM screen contract
 * (`{id, open, close, key, draw}`). Deliberately the plainest screen in the Códice layer, the
 * same way the canvas panel it replaces was deliberately the plainest panel: a list of places,
 * the one you are standing in marked, and nothing else to decide. `travel.destinations()` is
 * still the sole authority on what a destination is — `../models/travel.js`'s `travelRows`
 * only filters and shapes it, unchanged in substance from the panel this succeeds.
 *
 * **The one new thing**: a relative yield line on each hunt row — `idle.catalog().biomes[arg]`,
 * per the plan's own note that a route's actual coins/hour has no source today (`idle.rate()`
 * is current-state only, not per-biome), so this shows the real relative multipliers
 * (`accrual.js`'s own `BIOMES` table) rather than inventing an absolute figure the game does
 * not compute.
 */
import { h } from '../dom/el.js';
import { icon } from '../dom/icons.js';
import { travelRows } from '../models/travel.js';

const isLive = (api) => !!api && api.__missing === undefined;

export function makeTravelDomScreen(app, domLayer) {
  let root = null;
  let pending = null;

  const rows = () => travelRows(app, { pending });

  function biomeYield(row) {
    if (row.kind !== 'Hunt' || !row.arg) return null;
    const idle = app.ctx.get('idle');
    const b = isLive(idle) && typeof idle.catalog === 'function' ? idle.catalog().biomes?.[row.arg] : null;
    if (!b) return null;
    const cls = (v) => (v > 1 ? ' ci-routes-row__yield-good' : '');
    return h('div', { class: 'ci-routes-row__yield' }, [
      h('span', { class: `ci-routes-row__yield${cls(b.money)}` }, `₽ ×${Number(b.money).toFixed(2)}`),
      h('span', { class: `ci-routes-row__yield${cls(b.encounters)}` }, `encounters ×${Number(b.encounters).toFixed(2)}`),
    ]);
  }

  function pick(item) {
    if (!item || item.disabled || pending) return;
    const t = app.ctx.get('travel');
    if (!isLive(t) || typeof t.go !== 'function' || t.busy?.()) return;
    if (item.locked) { t.go(item.id); return; }
    pending = item.id;
    renderRoot();
    Promise.resolve(t.go(item.id))
      .then((ok) => { pending = null; if (ok) app.close(); else renderRoot(); })
      .catch(() => { pending = null; renderRoot(); });
  }

  function render() {
    const items = rows();
    const rowsEl = items.length
      ? items.map((item) => h('button', {
        type: 'button',
        class: `ci-routes-row${item.here ? ' ci-routes-row--here' : ''}${item.locked ? ' ci-routes-row--locked' : ''}${item.loading ? ' ci-routes-row--loading' : ''}`,
        'data-ui': `route-${item.id}`,
        onClick: () => pick(item),
      }, [
        h('div', { class: 'ci-routes-row__body' }, [
          h('span', { class: 'ci-routes-row__name' }, item.label),
          biomeYield(item),
        ].filter(Boolean)),
        h('span', {
          class: `ci-routes-row__status${item.here ? ' ci-routes-row__status--here' : item.locked ? ' ci-routes-row__status--locked' : ' ci-routes-row__status--kind'}`,
        }, item.loading ? '…' : item.here ? 'Here' : item.locked ? `Lv ${item.need}` : item.kind),
      ]))
      : [h('div', { class: 'ci-shelf-empty' }, 'Travel is unavailable.')];

    return h('div', { class: 'ci-offline-scrim', 'data-ui': 'routes-scrim' }, [
      h('div', { class: 'ci-routes-card' }, [
        h('div', { class: 'ci-offline-head' }, [
          h('div', { class: 'ci-offline-head__icon' }, icon('map', { size: 22 })),
          h('div', { class: 'ci-offline-head__text' }, [
            h('h2', { class: 'ci-offline-head__title', style: { fontSize: '20px' } }, 'Routes'),
          ]),
          h('button', {
            type: 'button', class: 'ci-icon-btn', 'data-ui': 'routes-close', onClick: () => app.close(),
          }, icon('close', { size: 18 })),
        ]),
        h('div', { class: 'ci-routes-body', 'data-ui': 'routes-body' }, rowsEl),
      ]),
    ]);
  }

  function renderRoot() {
    if (!root) return;
    const next = render();
    root.replaceWith(next);
    root = next;
  }

  return {
    id: 'travel',
    /** Not part of the panel contract `../index.js` drives — the same escape hatch
     *  `travel.test.js`/`travel-realwiring.test.js` used against the canvas panel, now
     *  pointed at `../models/travel.js`'s standalone `travelRows` instead. Kept here only so
     *  a flow test can read the live row list with no DOM traversal. */
    rows,
    open() { pending = null; root = render(); domLayer.host.appendChild(root); },
    close() { pending = null; root?.remove(); root = null; },
    key(ev) {
      if (ev.code === 'Escape') { app.close(); return true; }
      return false;
    },
    draw() { return null; },
  };
}
