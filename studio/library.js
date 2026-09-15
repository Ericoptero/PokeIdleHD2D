/**
 * library.js — the asset library panel: browses one tileset's catalog with real 3D previews
 * (`viewport/thumbnails.js`, reached through `getViewport()` — the same `tiles`/`InstancedWorld`
 * pipeline the 3D pane itself renders with, not a 2D texture crop), filters by category/tag/
 * biome/collision, splits tiles from autotile sets, and reports the selection back to
 * `session.setSelectedAsset`.
 */

import { h } from '@/ui/dom/el.js';
import { icon } from './icons.js';
import { loadCatalog, colorFor, listTilesets } from './catalog.js';
import { COLLISION_DOT, CELL_TAGS } from './kinds.js';

const RECENTS_MAX = 5;
const FAVORITES_KEY = 'pokeidle-studio-favorites';

/** localStorage is per-viewer and can throw (private window, cleared/blocked site data) —
 *  favorites degrade to session-only rather than break the panel when it does. */
function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}
function saveFavorites(favorites) {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites])); } catch { /* ignore */ }
}

export function makeLibraryPanel({ root, session, docRef, toolRail, onCatalogLoaded, getViewport }) {
  let catalog = null;
  let query = '';
  let assetTab = 'tiles'; // 'tiles' | 'autotiles'
  const filters = { category: '', tag: '', biome: '', collision: '' };
  const favorites = loadFavorites();
  const recents = [];
  let allTilesets = [];

  const searchInput = h('input', {
    class: 'ms-search', placeholder: 'Buscar tile, tag ou categoria',
    onInput: (e) => { query = e.target.value.toLowerCase(); renderGrid(); },
  });
  const tilesetSelect = h('select', { class: 'ms-select', onChange: (e) => loadFor(e.target.value) });
  const filterRow = h('div', { class: 'ms-filter-row' });
  const tabsRow = h('div', { class: 'ms-lib-tabs' });
  const catLabel = h('span', { class: 'ms-muted-label' }, 'tiles');
  const grid = h('div', { class: 'ms-asset-grid' });
  const recentsRow = h('div', { class: 'ms-recents-row' });
  const detail = h('div', { class: 'ms-asset-detail' }, h('div', { class: 'ms-empty' }, 'Selecione um tile'));
  // A persistent, live-orbit 3D view of the selected tile (item 5) — created once and reused,
  // never rebuilt by `renderDetail`'s own `detail.innerHTML = ''`: that clears it OUT of the DOM
  // on every call, but re-appending the same node (`renderDetail`, below) moves it back in with
  // its WebGL context still alive, instead of tearing down and recreating a renderer per click.
  const liveViewHost = h('div', { class: 'ms-detail-iso' });
  let liveViewer = null;

  // Collapse toggle: `root` is `libraryEl` (`main.js`), a fixed panel element passed in directly
  // — toggling a class on it here needs no extra plumbing back up to `main.js`. The title row
  // itself stays OUTSIDE `contentEl` below so the toggle is always reachable even when collapsed.
  // No dedicated left/right chevron glyph is vendored anywhere in the Studio — reusing the core
  // `chevron-down` rotated 90° each way (same mirroring trick `main.js`'s yaw-left button already
  // uses on `rotate-cw`) instead of adding one.
  const collapseIcon = icon('chevron-down', { size: 14 });
  collapseIcon.style.transform = 'rotate(90deg)'; // points left, toward the outer edge: "collapse"
  const collapseBtn = h('button', { class: 'ms-iconbtn ms-iconbtn--ghost', title: 'Recolher painel', onClick: () => {
    const collapsed = root.classList.toggle('ms-panel--collapsed');
    collapseIcon.style.transform = collapsed ? 'rotate(-90deg)' : 'rotate(90deg)'; // right, back toward the content: "expand"
    collapseBtn.title = collapsed ? 'Expandir painel' : 'Recolher painel';
  } }, [collapseIcon]);
  const contentEl = h('div', { class: 'ms-panel-content' }, [
    h('div', { class: 'ms-lib-head' }, [
      h('div', { class: 'ms-lib-row' }, [tilesetSelect]),
      searchInput,
      filterRow,
    ]),
    tabsRow,
    h('div', { class: 'ms-lib-cats' }, catLabel),
    h('div', { class: 'ms-lib-scroll' }, [grid,
      h('div', { class: 'ms-recents-head' }, [h('span', { class: 'ms-eyebrow' }, 'Recentes')]),
      recentsRow]),
    detail,
  ]);
  root.appendChild(h('div', { class: 'ms-lib-row ms-panel-strip' }, [h('span', { class: 'ms-eyebrow' }, 'Biblioteca'), collapseBtn]));
  root.appendChild(contentEl);

  function makeFilterSelect(key, label, values, { title, describe } = {}) {
    return h('select', { class: 'ms-select ms-select--tiny', title, onChange: (e) => { filters[key] = e.target.value; renderGrid(); } },
      [h('option', { value: '' }, label), ...values.map((v) => h('option', { value: v, title: describe?.(v) }, v))]);
  }

  /** `kinds.js`'s `CELL_TAGS` — a few catalog tags double as the exact tag `terrain/draft.js`
   *  auto-stamps onto a cell the instant a model carrying them is painted (`tallgrass`), or share
   *  a name with a known cell-tag effect; surfaced as a tooltip so this filter (which otherwise
   *  edits nothing) still explains what a tag actually does elsewhere in the Studio. */
  function knownTagEffect(tag) { return CELL_TAGS.find(([t]) => t === tag)?.[2] ?? null; }

  function rebuildFilters() {
    filterRow.innerHTML = '';
    if (!catalog) return;
    const cats = [...new Set(catalog.models.map((m) => m.category).filter(Boolean))].sort();
    const tags = [...new Set(catalog.models.flatMap((m) => m.tags ?? []))].sort();
    const biomes = [...new Set(catalog.models.flatMap((m) => m.biomes ?? []))].sort();
    const collisions = [...new Set(catalog.models.map((m) => m.collision).filter(Boolean))].sort();
    filterRow.append(
      makeFilterSelect('category', 'Categoria', cats),
      // "Tag do tileset": this filters which tiles are SHOWN below, from the tileset's own
      // build-time metadata — it edits nothing on the map, unlike the tag pickers in the brush
      // bar/inspector (`panels.js`/`inspector.js`'s `CELL_TAGS`), which write a per-cell tag.
      makeFilterSelect('tag', 'Tag do tileset', tags, {
        title: 'Filtra os tiles exibidos pela tag do catálogo — não edita o mapa',
        describe: (t) => knownTagEffect(t) ?? undefined,
      }),
      makeFilterSelect('biome', 'Bioma', biomes),
      makeFilterSelect('collision', 'Colisão', collisions),
    );
  }

  async function loadFor(slug) {
    catalog = await loadCatalog(slug);
    Object.assign(filters, { category: '', tag: '', biome: '', collision: '' });
    rebuildFilters();
    onCatalogLoaded?.(slug, catalog);
    renderTabs();
    renderGrid();
    renderRecents();
  }

  function renderTabs() {
    tabsRow.innerHTML = '';
    const hasAutotiles = (catalog?.autotileSets?.length ?? 0) > 0;
    for (const [id, name] of [['tiles', 'Tiles normais'], ['autotiles', 'Autotiles']]) {
      const btn = h('button', { class: `ms-lib-tab${assetTab === id ? ' ms-lib-tab--active' : ''}`,
        disabled: id === 'autotiles' && !hasAutotiles, onClick: () => { assetTab = id; renderTabs(); renderGrid(); } }, name);
      tabsRow.appendChild(btn);
    }
  }

  // Lazy 3D thumbnail loading (item 5): one shared `IntersectionObserver` for the whole grid
  // instead of rendering all ~400 possible cards' worth of thumbnails up front — a 445-model
  // tileset (hgss-overworld) would otherwise pay for every model's own offscreen render on
  // load, most of them never scrolled into view. `colorFor(m)`'s flat HSL swatch is the
  // placeholder background until a card's real thumbnail resolves (or forever, on failure).
  let thumbObserver = null;
  function getThumbObserver() {
    if (thumbObserver) return thumbObserver;
    thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbObserver.unobserve(entry.target);
        loadThumbInto(entry.target, entry.target._model);
      }
    }, { root: grid.parentElement, rootMargin: '200px' });
    return thumbObserver;
  }
  function loadThumbInto(el, m) {
    const viewport = getViewport?.();
    if (!viewport || !catalog) return;
    viewport.renderThumbnail(catalog.tileset, m)
      .then((url) => { el.style.backgroundImage = `url(${url})`; })
      .catch(() => { /* stays on the colorFor() swatch */ });
  }

  function assetCard(m) {
    const bg = colorFor(m);
    const isFav = favorites.has(m.name);
    // A real 3D render (once loaded) rather than a stretched 2D texture crop — `background-size:
    // contain` (`.ms-asset-thumb-render`, studio.css) so the whole model shows, unlike the old
    // faux-isometric top/side split this replaces (that was compensating for flat texture art;
    // a real 3D angle shot needs no such illusion).
    const render = h('div', { class: 'ms-asset-thumb-render', style: { backgroundColor: bg } });
    render._model = m;
    getThumbObserver().observe(render);
    const card = h('div', { class: 'ms-asset-card', title: m.name }, [
      h('div', { class: 'ms-asset-thumb' }, [
        render,
        (m.w ?? 1) * (m.h ?? 1) > 1 ? h('span', { class: 'ms-asset-badge' }, `${m.w ?? 1}×${m.h ?? 1}`) : null,
        h('span', { class: 'ms-asset-dot', style: { background: dotFor(m.collision) } }),
        h('span', { class: `ms-asset-fav${isFav ? ' ms-asset-fav--on' : ''}`, title: isFav ? 'Remover dos favoritos' : 'Favoritar', onClick: (e) => {
          e.stopPropagation();
          if (isFav) favorites.delete(m.name); else favorites.add(m.name);
          saveFavorites(favorites);
          renderGrid();
        } }, [icon('star', { size: 11 })]),
      ].filter(Boolean)),
      h('span', { class: 'ms-asset-name' }, m.name),
    ]);
    card.onclick = () => select(m);
    return card;
  }

  function select(m) {
    session.setSelectedAsset({ name: m.name, tileset: catalog.tileset, w: m.w ?? 1, h: m.h ?? 1, collision: m.collision });
    touchRecent(m.name);
    renderGrid();
    renderRecents();
    renderDetail(m);
  }

  function touchRecent(name) {
    const i = recents.indexOf(name);
    if (i >= 0) recents.splice(i, 1);
    recents.unshift(name);
    recents.length = Math.min(RECENTS_MAX, recents.length);
  }

  function renderGrid() {
    grid.innerHTML = '';
    // Every card below is a fresh element `getThumbObserver()` will `observe()` again — drop the
    // old observer (and, with it, any still-pending observation of an element this just detached
    // and will never re-attach) rather than letting them accumulate across searches/filters.
    thumbObserver?.disconnect();
    thumbObserver = null;
    if (!catalog) return;
    const autotileNames = assetTab === 'autotiles' ? new Set() : null;
    let models = catalog.models.filter((m) => {
      if (m.category === 'meta') return false;
      if (assetTab === 'autotiles' && !m.autotile) return false;
      if (assetTab === 'tiles' && m.autotile) return false;
      if (filters.category && m.category !== filters.category) return false;
      if (filters.tag && !(m.tags ?? []).includes(filters.tag)) return false;
      if (filters.biome && !(m.biomes ?? []).includes(filters.biome)) return false;
      if (filters.collision && m.collision !== filters.collision) return false;
      if (!query) return true;
      return m.name.toLowerCase().includes(query) || (m.tags ?? []).some((t) => t.includes(query))
        || (m.category ?? '').includes(query) || (m.subcategory ?? '').includes(query);
    });
    // One card per autotile SET, not per individual edge/corner variant — `||` short-circuits
    // before `.add()` runs once `.has()` is already false, which used to skip populating the
    // set entirely and left every variant visible; this filters procedurally instead.
    if (autotileNames) {
      models = models.filter((m) => {
        const set = m.autotile?.set;
        if (autotileNames.has(set)) return false;
        autotileNames.add(set);
        return true;
      });
    }
    // A stable sort: favorites float to the top of whatever category/search order already applied.
    models = models.map((m, i) => ({ m, i })).sort((a, b) => {
      const fav = (favorites.has(b.m.name) ? 1 : 0) - (favorites.has(a.m.name) ? 1 : 0);
      return fav || a.i - b.i;
    }).map(({ m }) => m);
    const selectedAsset = session.getSelectedAsset();
    catLabel.textContent = query ? `${models.length} resultados` : `${models.length} tiles`;
    for (const m of models.slice(0, 400)) {
      const card = assetCard(m);
      if (selectedAsset?.name === m.name) card.classList.add('ms-asset-card--sel');
      grid.appendChild(card);
    }
  }

  function renderRecents() {
    recentsRow.innerHTML = '';
    for (const name of recents) {
      const m = catalog?.byName?.get(name);
      if (!m) continue;
      const swatch = h('div', { class: 'ms-recent-swatch', title: name,
        style: { backgroundColor: colorFor(m) }, onClick: () => select(m) });
      recentsRow.appendChild(swatch);
      getViewport?.()?.renderThumbnail(catalog.tileset, m)
        .then((url) => { swatch.style.backgroundImage = `url(${url})`; })
        .catch(() => {});
    }
  }

  function renderDetail(m) {
    detail.innerHTML = '';
    // `liveViewHost` (created once, above) is moved back into the freshly rebuilt tree here —
    // see its own comment for why this is safe and deliberate rather than a leftover reference.
    if (!liveViewer) liveViewer = getViewport?.()?.mountLiveModelView(liveViewHost) ?? null;
    liveViewer?.setModel(catalog.tileset, m).catch((e) => console.error('live model view failed', e));
    detail.appendChild(h('div', { class: 'ms-detail-row' }, [
      liveViewHost,
      h('div', { class: 'ms-detail-text' }, [
        h('div', { class: 'ms-detail-name' }, m.name),
        h('div', { class: 'ms-detail-id' }, `${m.category ?? '?'} · ${m.w ?? 1}×${m.h ?? 1} · ${m.collision ?? 'block'}`),
      ]),
      h('div', { class: 'ms-detail-actions' }, [
        h('button', { class: 'ms-iconbtn', title: 'Usar como pincel', onClick: () => { toolRail?.setTool('pencil'); select(m); } }, [icon('pencil', { size: 14 })]),
        h('button', { class: 'ms-iconbtn', title: 'Focar a primeira ocorrência no mapa', onClick: () => focusFirst(m) }, [icon('crosshair', { size: 14 })]),
      ]),
    ]));
    if (m.tags?.length) {
      detail.appendChild(h('div', { class: 'ms-tag-row' }, m.tags.map((t) => h('span', { class: 'ms-tag-chip', title: catalogTagHint(t) }, t))));
    }
    const doc = docRef?.get?.();
    const usage = doc ? countUsage(doc, m.name) : 0;
    detail.appendChild(h('div', { class: 'ms-prop-grid' }, [
      ['Categoria', m.category ?? '—'], ['Subcat.', m.subcategory ?? '—'],
      ['Tamanho', `${m.w ?? 1}×${m.h ?? 1}`], ['Colisão', m.collision ?? '—'],
      ['Orientação', m.orientation ?? '—'], ['Elev. base', (m.baseY ?? 0).toFixed(2)],
      ['Autotile', m.autotile ? `${m.autotile.set} · ${m.autotile.name}` : '—'], ['Uso no mapa', String(usage)],
    ].map(([k, v]) => h('div', { class: 'ms-prop-cell' }, [h('span', { class: 'ms-prop-k' }, k), h('span', { class: 'ms-prop-v' }, v)]))));
  }

  function countUsage(doc, name) {
    let n = 0;
    for (const grid_ of doc.tileLayers.values()) for (const cell of grid_.values()) if (cell.m === name) n++;
    for (const o of doc.objects) if (o.m === name) n++;
    return n;
  }

  function focusFirst(m) {
    const doc = docRef?.get?.();
    if (!doc) return;
    for (const [, grid_] of doc.tileLayers) {
      for (const [key, cell] of grid_) {
        if (cell.m === m.name) {
          const [cx, cz] = key.split(',').map(Number);
          // A plain cell jump, no entity — explicit `kind: null, ref: null` so a previously
          // selected entity's card does not linger under the new cell (`setSelection`'s merge
          // never clears a field a patch omits).
          session.setSelection({ cell: { cx, cz }, kind: null, ref: null });
          return;
        }
      }
    }
    const obj = doc.objects.find((o) => o.m === m.name);
    if (obj) session.setSelection({ cell: { cx: obj.cx, cz: obj.cz }, kind: 'object', ref: obj });
  }

  async function init(defaultTileset) {
    allTilesets = await listTilesets().catch(() => []);
    tilesetSelect.innerHTML = '';
    for (const t of allTilesets) tilesetSelect.appendChild(h('option', { value: t.slug }, t.slug));
    if (defaultTileset) tilesetSelect.value = defaultTileset;
    await loadFor(tilesetSelect.value || allTilesets[0]?.slug);
  }

  return {
    init,
    setTileset: (slug) => { tilesetSelect.value = slug; return loadFor(slug); },
    /** Re-applies the `.ms-asset-card--sel` highlight from `session.getSelectedAsset()` without
     *  reloading the catalog — `refreshAll()` (`main.js`) never rebuilds this panel on an
     *  ordinary session notify (a search keystroke would otherwise blow away the grid's own
     *  scroll position on every unrelated selection change), so the eyedrop tool's pick
     *  (`session.js`'s `eyedrop` case) needs this one explicit call to catch the card up when
     *  the newly selected asset was not clicked from the grid itself. A no-op — same cost as one
     *  more keystroke in the search box — when nothing changed or the catalog has not loaded. */
    syncSelection: () => { if (catalog) renderGrid(); },
  };
}

function dotFor(collision) { return COLLISION_DOT[collision] ?? '#8F8579'; }

/**
 * Explains a catalog tag's runtime effect, for the detail panel's tag-chip row — most of the
 * 43-value vocabulary a tileset ships with is a pure filter with no effect beyond narrowing this
 * grid (`rebuildFilters` above), but a few genuinely change what happens at runtime the moment a
 * model carrying them is painted or loaded, and those are worth calling out rather than leaving
 * indistinguishable from the rest:
 *  - `tallgrass`/`encounter` auto-stamp the matching cell tag the instant such a model is painted
 *    (`src/terrain/draft.js`'s `place()`) — the one real bridge to `CELL_TAGS`/`doc.tags[]`.
 *  - `raised` is excluded from `tiles.find()`'s default results (`src/tiles/index.js`) — a cliff-
 *    top surface that would otherwise float if placed at ground level.
 *  - `flat` opts a model out of casting its own shadow and into flat-tile instancing merges
 *    (`src/tiles/instanced.js`).
 */
const CATALOG_TAG_HINTS = {
  tallgrass: 'Ao pintar, marca a célula com a tag "tallgrass" — ativa encontros selvagens (66%)',
  encounter: 'Ao pintar, marca a célula com a tag "encounter" (mesmo efeito de "tallgrass")',
  raised: 'Fica acima do nível do chão (ex.: topo de penhasco) — excluído da seleção automática por padrão',
  flat: 'Não projeta sombra própria; mescla com outros tiles planos ao renderizar',
};
function catalogTagHint(tag) { return CATALOG_TAG_HINTS[tag] ?? null; }
