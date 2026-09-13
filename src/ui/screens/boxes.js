/**
 * Storage (Stage 9) — replaces `panels/boxes.js`. `collection` owns 960 slots across 32 boxes,
 * ten sort orderings and the duplicate-release rules (`src/collection/index.js`); this is the
 * box screen over them, unchanged in substance — the grid is still the real box shape
 * (`collection.layout()`), the sprite is still the species' own overworld art, and "is this one
 * safe to release" is still the one question the detail pane exists to answer.
 *
 * Release stays a **two-step confirm** (`confirmRelease`, local screen state, not module
 * state) — the one irreversible action in this module, so the small control asks first and
 * the wide, reversible one (favourite) never has to.
 */
import { h } from '../dom/el.js';
import { icon } from '../dom/icons.js';

const isLive = (api) => !!api && api.__missing === undefined;
const SHORT_SORT = {
  species: 'Dex', name: 'Name', level: 'Level', iv: 'IV', bst: 'BST',
  shiny: 'Shiny', type: 'Type', caught: 'Caught', favourite: 'Fav', duplicates: 'Dupes',
};
const IV_KEYS = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];

export function makeBoxesDomScreen(app, domLayer) {
  let root = null;
  let boxIndex = 0;
  let slot = 0;
  let sortMode = 'species';
  let confirmRelease = false;

  const col = () => app.ctx.get('collection');
  const boxesOf = () => {
    const c = col();
    return isLive(c) && typeof c.boxes === 'function' ? (c.boxes() ?? []) : [];
  };
  const layout = () => {
    const c = col();
    const l = isLive(c) && typeof c.layout === 'function' ? c.layout() : null;
    return { cols: l?.cols ?? 6, rows: l?.rows ?? 5, capacity: l?.capacity ?? 30 };
  };
  const spriteUrl = (entry) => {
    const pk = app.ctx.get('pokemon');
    return isLive(pk) && typeof pk.spriteUrl === 'function' && entry?.species
      ? pk.spriteUrl(entry.species, { shiny: !!entry.shiny }) : null;
  };

  function release(entry) {
    const c = col();
    if (!isLive(c) || !entry) return;
    c.release?.(entry.uid ?? entry);
    confirmRelease = false;
    renderRoot();
  }

  function detailPane() {
    const c = col();
    const all = boxesOf();
    const box = all[boxIndex] ?? null;
    const entry = box ? (box[slot] ?? null) : null;
    if (!entry) {
      return h('div', { class: 'ci-shelf-detail', 'data-ui': 'boxes-detail' }, [
        h('p', { class: 'ci-shelf-detail__desc' }, 'Empty slot.'),
        h('p', { class: 'ci-shelf-detail__desc' }, 'Pokémon caught by the idle loop land here automatically.'),
      ]);
    }
    const ivPct = isLive(c) && typeof c.ivPct === 'function' ? c.ivPct(entry.ivTotal ?? 0) : null;
    const grade = isLive(c) && typeof c.ivGrade === 'function' ? c.ivGrade(entry.ivTotal ?? 0) : null;
    const facts = [
      ['Type', (entry.types ?? []).join(' / ') || '—'],
      ['Dex', entry.dexId ? `#${String(entry.dexId).padStart(3, '0')}` : '—'],
      ['IV total', `${entry.ivTotal ?? 0}${ivPct != null ? `  ${Math.round(ivPct)}%` : ''}`],
      ...(grade ? [['Grade', String(grade)]] : []),
      ['Origin', entry.origin ?? '—'],
      ['Gen', entry.gen ? String(entry.gen) : '—'],
      ...(entry.ball ? [['Ball', entry.ball]] : []),
    ];
    const owned = isLive(c) && typeof c.owned === 'function' ? c.owned(entry.species) : 0;
    const onlyOne = owned <= 1;
    const favOn = !!entry.favourite;

    const portrait = h('div', { class: 'ci-party-screen-portrait', style: { width: '44px', height: '44px' } });
    const url = spriteUrl(entry);
    if (url) { portrait.style.backgroundImage = `url(${url})`; portrait.style.backgroundSize = '200% 400%'; portrait.style.backgroundPosition = '0% 66.6667%'; }

    return h('div', { class: 'ci-shelf-detail', 'data-ui': 'boxes-detail' }, [
      h('div', { class: 'ci-party-screen-head' }, [
        portrait,
        h('div', {}, [
          h('h3', { class: 'ci-shelf-detail__name' }, [entry.nickname ?? entry.display, entry.shiny ? ' ✨' : '']),
          h('span', { class: 'ci-shelf-detail__row-label' }, `Lv ${entry.level}`),
        ]),
      ]),
      ...facts.map(([label, value]) => h('div', { class: 'ci-shelf-detail__row' }, [
        h('span', { class: 'ci-shelf-detail__row-label' }, label), h('span', { class: 'ci-shelf-detail__row-value' }, value),
      ])),
      h('div', { class: 'ci-party-screen-stats', style: { marginTop: '6px' } }, IV_KEYS.map(([key, label]) => {
        const iv = Number(entry.ivs?.[key] ?? 0);
        const fill = h('div', { class: 'ci-meter__fill' });
        fill.style.width = `${(iv / 31) * 100}%`;
        if (iv >= 28) fill.style.background = 'var(--c-good)';
        return h('div', { class: 'ci-party-screen-stat-row' }, [
          h('span', { class: 'ci-party-screen-stat-row__label' }, label),
          h('div', { class: 'ci-meter ci-party-screen-stat-row__meter' }, fill),
          h('span', { class: 'ci-party-screen-stat-row__value' }, String(iv)),
        ]);
      })),
      h('div', { class: 'ci-shelf-detail__actions' }, confirmRelease ? [
        h('p', { class: 'ci-shelf-detail__desc' }, onlyOne ? 'Release your only one?' : 'Release for good?'),
        h('div', { class: 'ci-shelf-detail__row-group' }, [
          h('button', {
            type: 'button', class: 'ci-shelf-btn', 'data-ui': 'boxes-release-yes', style: { color: 'var(--c-bad-light)' },
            onClick: () => release(entry),
          }, [h('span', {}, 'Yes, release')]),
          h('button', {
            type: 'button', class: 'ci-shelf-btn ci-shelf-btn--primary', 'data-ui': 'boxes-release-no',
            onClick: () => { confirmRelease = false; renderRoot(); },
          }, [h('span', {}, 'Keep')]),
        ]),
      ] : [
        h('p', { class: 'ci-shelf-detail__desc' }, onlyOne ? 'The only one you hold.' : `${owned} of this species held.`),
        h('div', { class: 'ci-shelf-detail__row-group' }, [
          h('button', {
            type: 'button', class: `ci-shelf-btn${favOn ? ' ci-shelf-btn--primary' : ''}`, 'data-ui': 'boxes-favourite',
            onClick: () => { c.favourite?.(entry.uid ?? entry, !favOn); renderRoot(); },
          }, [h('span', {}, favOn ? '★ Favourite' : 'Mark favourite')]),
          h('button', {
            type: 'button', class: 'ci-shelf-btn', 'data-ui': 'boxes-release', style: { color: 'var(--c-bad-light)' },
            onClick: () => { confirmRelease = true; renderRoot(); },
          }, [h('span', {}, 'Release')]),
        ]),
      ]),
    ]);
  }

  function render() {
    const c = col();
    const all = boxesOf();
    if (boxIndex >= all.length) boxIndex = 0;
    const { cols, capacity } = layout();
    const box = all[boxIndex] ?? null;
    const stats = isLive(c) && typeof c.stats === 'function' ? c.stats() : null;
    const modes = isLive(c) && typeof c.sortModes === 'function' ? c.sortModes() : [];

    const sortRow = h('div', { class: 'ci-shelf-tabs', style: { overflowX: 'auto', flexWrap: 'nowrap' }, 'data-ui': 'boxes-sort' },
      modes.map((m) => h('button', {
        type: 'button', class: `ci-shelf-tab${sortMode === m.id ? ' ci-shelf-tab--active' : ''}`, 'data-ui': `boxes-sort-${m.id}`,
        style: { flexShrink: '0' },
        onClick: () => { sortMode = m.id; c.sort?.(m.id); renderRoot(); },
      }, SHORT_SORT[m.id] ?? m.label)));

    const railRows = all.map((b, i) => h('button', {
      type: 'button', class: `ci-shelf-rail__item${i === boxIndex ? ' ci-shelf-rail__item--active' : ''}`, 'data-ui': `boxes-box-${i}`,
      onClick: () => { boxIndex = i; slot = 0; renderRoot(); },
    }, [
      h('span', { class: 'ci-shelf-rail__item-label' }, b.name ?? `Box ${i + 1}`),
      h('span', { class: 'ci-shelf-rail__item-sub' }, `${b.count}`),
    ]));

    const cells = [];
    for (let i = 0; i < capacity; i++) {
      const occupant = box ? box[i] : null;
      const url = occupant ? spriteUrl(occupant) : null;
      const cell = h('button', {
        type: 'button', class: `ci-boxes-cell${i === slot ? ' ci-boxes-cell--active' : ''}`, 'data-ui': `boxes-slot-${i}`,
        onClick: () => { slot = i; confirmRelease = false; renderRoot(); },
      }, occupant ? [
        (() => {
          const p = h('div', { class: 'ci-boxes-cell__sprite' });
          if (url) { p.style.backgroundImage = `url(${url})`; p.style.backgroundSize = '200% 400%'; p.style.backgroundPosition = '0% 66.6667%'; }
          return p;
        })(),
        occupant.shiny ? h('span', { class: 'ci-boxes-cell__shiny' }, '★') : null,
      ].filter(Boolean) : []);
      cells.push(cell);
    }

    return h('div', { class: 'ci-offline-scrim', 'data-ui': 'boxes-scrim' }, [
      h('div', { class: 'ci-shelf-card' }, [
        h('div', { class: 'ci-shelf-head' }, [
          h('h2', { class: 'ci-shelf-head__title' }, 'Storage'),
          h('span', { class: 'ci-shelf-detail__row-label' },
            stats ? `${stats.stored} stored · ${stats.uniqueOwned} species · ${stats.shiny} ★` : ''),
          h('button', { type: 'button', class: 'ci-icon-btn', 'data-ui': 'boxes-close', onClick: () => app.close() }, icon('close', { size: 18 })),
        ]),
        sortRow,
        h('div', { class: 'ci-shelf-body' }, [
          h('nav', { class: 'ci-shelf-rail', 'data-ui': 'boxes-rail' }, railRows),
          h('div', { class: 'ci-boxes-grid-wrap', 'data-ui': 'boxes-grid' }, [
            h('div', { class: 'ci-boxes-grid', style: { gridTemplateColumns: `repeat(${cols}, 1fr)` } }, cells),
            h('p', { class: 'ci-shelf-detail__row-label', style: { padding: '6px 10px' } }, `${box ? box.count : 0} / ${capacity} slots used`),
          ]),
          detailPane(),
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
    id: 'boxes',
    open(opts = {}) {
      confirmRelease = false;
      if (Number.isFinite(opts.box)) boxIndex = opts.box;
      if (Number.isFinite(opts.slot)) slot = opts.slot;
      root = render();
      domLayer.host.appendChild(root);
    },
    close() { confirmRelease = false; root?.remove(); root = null; },
    key(ev) {
      const { cols, capacity } = layout();
      const all = boxesOf();
      const code = ev.code;
      if (code === 'Escape') { app.close(); return true; }
      if (code === 'ArrowLeft' || code === 'KeyA') { slot = (slot + capacity - 1) % capacity; renderRoot(); return true; }
      if (code === 'ArrowRight' || code === 'KeyD') { slot = (slot + 1) % capacity; renderRoot(); return true; }
      if (code === 'ArrowUp' || code === 'KeyW') { slot = (slot + capacity - cols) % capacity; renderRoot(); return true; }
      if (code === 'ArrowDown' || code === 'KeyS') { slot = (slot + cols) % capacity; renderRoot(); return true; }
      if (code === 'BracketLeft' || code === 'PageUp') { boxIndex = (boxIndex + all.length - 1) % Math.max(1, all.length); renderRoot(); return true; }
      if (code === 'BracketRight' || code === 'PageDown') { boxIndex = (boxIndex + 1) % Math.max(1, all.length); renderRoot(); return true; }
      return false;
    },
    draw() { return null; },
  };
}
