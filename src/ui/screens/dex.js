/**
 * The Pokédex (Stage 9) — replaces `panels/dex.js`. `collection` records every sighting and
 * every catch and reports completion per generation and per type
 * (`src/collection/index.js`); this screen is that report, unchanged in substance — a
 * *progress* screen, not a species browser: 995 rows of "not seen" tell the player nothing,
 * while "gen 1 is 12%, ghost is 0%" tells them where to hunt next.
 *
 * The national list (`../models/dex.js`'s `nationalList`, lifted out unchanged) is a single
 * scrollable DOM list rather than the canvas panel's hand-packed multi-column grid with its
 * own scrollbar — `overflow-y: auto` on ~1000 plain rows is exactly the kind of thing a real
 * browser already does for free that a canvas had to build by hand.
 */
import { h } from '../dom/el.js';
import { icon } from '../dom/icons.js';
import { nationalList } from '../models/dex.js';

const isLive = (api) => !!api && api.__missing === undefined;

export function makeDexDomScreen(app, domLayer) {
  let root = null;
  let tab = 'gen';

  const col = () => app.ctx.get('collection');
  const typeBarColour = (type) => {
    const bt = app.ctx.get('battle');
    return isLive(bt) && typeof bt.typeColour === 'function' ? bt.typeColour(type)?.edge ?? null : null;
  };

  function render() {
    const c = col();
    const completion = isLive(c) && typeof c.completion === 'function' ? c.completion() : null;
    const stats = isLive(c) && typeof c.stats === 'function' ? c.stats() : null;
    const records = isLive(c) && typeof c.records === 'function' ? (c.records() ?? []) : [];
    const entries = nationalList(app, records);

    const caught = completion?.caught ?? 0;
    const total = completion?.total ?? 0;
    const fill = h('div', { class: 'ci-meter__fill' });
    fill.style.width = `${total ? (caught / total) * 100 : 0}%`;

    const statRows = [
      ['Seen', `${completion?.seen ?? 0}`],
      ['Living dex', `${(completion?.livingPct ?? 0).toFixed(1)}%`],
      ['Forms', `${completion?.forms?.caught ?? 0} / ${completion?.forms?.total ?? 0}`],
      ['Shinies', `${stats?.shiny ?? 0}`],
      ['Stored', `${stats?.stored ?? 0} of ${isLive(c) && typeof c.totalSlots === 'function' ? c.totalSlots() : 0}`],
      ['Best IV', stats?.averageIvPct != null ? `avg ${stats.averageIvPct}%` : '—'],
    ];

    const bars = tab === 'gen'
      ? (completion?.byGen ?? []).map((b) => ({ label: `Gen ${b.gen}`, caught: b.caught, total: b.total, colour: null }))
      : (completion?.byType ?? []).map((b) => ({ label: b.type, caught: b.caught, total: b.total, colour: typeBarColour(b.type) }));

    const barRows = bars.map((b) => {
      const bf = h('div', { class: 'ci-meter__fill' });
      bf.style.width = `${b.total ? (b.caught / b.total) * 100 : 0}%`;
      if (b.colour) bf.style.background = b.colour;
      return h('div', { class: 'ci-dex-bar-row' }, [
        h('span', { class: 'ci-dex-bar-row__label' }, b.label),
        h('div', { class: 'ci-meter ci-dex-bar-row__meter' }, bf),
        h('span', { class: 'ci-dex-bar-row__value' }, `${b.caught}/${b.total}`),
      ]);
    });

    const entryRows = entries.length ? entries.map((r) => {
      const known = r.caught > 0 || r.seen > 0;
      return h('div', { class: `ci-dex-entry${r.caught > 0 ? ' ci-dex-entry--caught' : ''}`, 'data-ui': `dex-${r.key}` }, [
        h('span', { class: 'ci-dex-entry__id' }, String(r.id).padStart(3, '0')),
        h('span', { class: 'ci-dex-entry__mark' }, r.caught > 0 ? '✓' : (r.seen > 0 ? '·' : '')),
        h('span', { class: 'ci-dex-entry__name' }, known ? r.display : '------'),
        r.shinyCaught > 0 ? h('span', { class: 'ci-dex-entry__shiny' }, '★')
          : (r.owned > 0 ? h('span', { class: 'ci-dex-entry__owned' }, `×${r.owned}`) : null),
      ].filter(Boolean));
    }) : [h('div', { class: 'ci-shelf-empty' },
      'Nothing recorded yet. The idle loop meets Pokémon while you are away — every sighting and catch lands here.')];

    return h('div', { class: 'ci-offline-scrim', 'data-ui': 'dex-scrim' }, [
      h('div', { class: 'ci-shelf-card' }, [
        h('div', { class: 'ci-shelf-head' }, [
          h('h2', { class: 'ci-shelf-head__title' }, 'Pokédex'),
          h('button', { type: 'button', class: 'ci-icon-btn', 'data-ui': 'dex-close', onClick: () => app.close() }, icon('close', { size: 18 })),
        ]),
        h('div', { class: 'ci-shelf-body' }, [
          h('nav', { class: 'ci-shelf-rail ci-dex-rail', 'data-ui': 'dex-rail' }, [
            h('div', { class: 'ci-dex-completion' }, [
              icon('capture', { size: 18 }),
              h('span', {}, `${caught} / ${total}`),
              h('span', { class: 'ci-dex-completion__pct' }, `${(completion?.caughtPct ?? 0).toFixed(1)}%`),
            ]),
            h('div', { class: 'ci-meter' }, fill),
            ...statRows.map(([label, value]) => h('div', { class: 'ci-shelf-detail__row' }, [
              h('span', { class: 'ci-shelf-detail__row-label' }, label), h('span', { class: 'ci-shelf-detail__row-value' }, value),
            ])),
            h('div', { class: 'ci-shelf-tabs', style: { marginTop: '8px' } }, [
              h('button', {
                type: 'button', class: `ci-shelf-tab${tab === 'gen' ? ' ci-shelf-tab--active' : ''}`, 'data-ui': 'dex-tab-gen',
                onClick: () => { tab = 'gen'; renderRoot(); },
              }, 'Gen'),
              h('button', {
                type: 'button', class: `ci-shelf-tab${tab === 'type' ? ' ci-shelf-tab--active' : ''}`, 'data-ui': 'dex-tab-type',
                onClick: () => { tab = 'type'; renderRoot(); },
              }, 'Type'),
            ]),
            ...barRows,
          ]),
          h('div', { class: 'ci-dex-list', 'data-ui': 'dex-entries' }, entryRows),
        ]),
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
    id: 'dex',
    open() {
      tab = 'gen';
      root = render();
      domLayer.host.appendChild(root);
    },
    close() { root?.remove(); root = null; },
    key(ev) {
      if (ev.code === 'Escape') { app.close(); return true; }
      if (ev.code === 'ArrowLeft' || ev.code === 'ArrowRight') { tab = tab === 'gen' ? 'type' : 'gen'; renderRoot(); return true; }
      return false;
    },
    draw() { return null; },
  };
}
