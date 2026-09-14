/**
 * library.js — the asset library panel: browses one tileset's catalog with real texture
 * previews (`catalog.js`'s `textureUrlFor`/`dominantMaterialId`), filters by category/tag/
 * biome/collision, splits tiles from autotile sets, and reports the selection back to
 * `canvas.js` (`setSelectedAsset`).
 */

import { h } from '@/ui/dom/el.js';
import { icon } from './icons.js';
import { loadCatalog, colorFor, listTilesets, textureUrlFor } from './catalog.js';
import { COLLISION_DOT } from './kinds.js';

const RECENTS_MAX = 5;

export function makeLibraryPanel({ root, editorCanvas, docRef, onCatalogLoaded }) {
  let catalog = null;
  let query = '';
  let assetTab = 'tiles'; // 'tiles' | 'autotiles'
  const filters = { category: '', tag: '', biome: '', collision: '' };
  const favorites = new Set();
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

  root.appendChild(h('div', { class: 'ms-lib-head' }, [
    h('div', { class: 'ms-lib-row' }, [h('span', { class: 'ms-eyebrow' }, 'Biblioteca'), icon('sliders-horizontal', { size: 14 })]),
    h('div', { class: 'ms-lib-row' }, [icon('layers', { size: 14 }), tilesetSelect]),
    searchInput,
    filterRow,
  ]));
  root.appendChild(tabsRow);
  root.appendChild(h('div', { class: 'ms-lib-cats' }, catLabel));
  root.appendChild(h('div', { class: 'ms-lib-scroll' }, [grid,
    h('div', { class: 'ms-recents-head' }, [h('span', { class: 'ms-eyebrow' }, 'Recentes')]),
    recentsRow]));
  root.appendChild(detail);

  function makeFilterSelect(key, label, values) {
    return h('select', { class: 'ms-select ms-select--tiny', onChange: (e) => { filters[key] = e.target.value; renderGrid(); } },
      [h('option', { value: '' }, label), ...values.map((v) => h('option', { value: v }, v))]);
  }

  function rebuildFilters() {
    filterRow.innerHTML = '';
    if (!catalog) return;
    const cats = [...new Set(catalog.models.map((m) => m.category).filter(Boolean))].sort();
    const tags = [...new Set(catalog.models.flatMap((m) => m.tags ?? []))].sort();
    const biomes = [...new Set(catalog.models.flatMap((m) => m.biomes ?? []))].sort();
    const collisions = [...new Set(catalog.models.map((m) => m.collision).filter(Boolean))].sort();
    filterRow.append(
      makeFilterSelect('category', 'Categoria', cats),
      makeFilterSelect('tag', 'Tag', tags),
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

  function assetCard(m) {
    const bg = colorFor(m);
    const tex = textureUrlFor(m, catalog);
    const isFav = favorites.has(m.name);
    const top = h('div', { class: 'ms-asset-thumb-top', style: { backgroundColor: bg, backgroundImage: tex ? `url(${tex})` : '' } });
    const side = h('div', { class: 'ms-asset-thumb-side', style: { backgroundColor: bg, backgroundImage: tex ? `url(${tex})` : '' } });
    const card = h('div', { class: 'ms-asset-card', title: m.name }, [
      h('div', { class: 'ms-asset-thumb' }, [
        top, side,
        (m.w ?? 1) * (m.h ?? 1) > 1 ? h('span', { class: 'ms-asset-badge' }, `${m.w ?? 1}×${m.h ?? 1}`) : null,
        h('span', { class: 'ms-asset-dot', style: { background: dotFor(m.collision) } }),
        h('span', { class: `ms-asset-fav${isFav ? ' ms-asset-fav--on' : ''}`, onClick: (e) => {
          e.stopPropagation();
          if (isFav) favorites.delete(m.name); else favorites.add(m.name);
          renderGrid();
        } }, [icon('star', { size: 11 })]),
      ].filter(Boolean)),
      h('span', { class: 'ms-asset-name' }, m.name),
    ]);
    card.onclick = () => select(m);
    return card;
  }

  function select(m) {
    editorCanvas.setSelectedAsset({ name: m.name, tileset: catalog.tileset, w: m.w ?? 1, h: m.h ?? 1, collision: m.collision });
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
    if (autotileNames) models = models.filter((m) => !autotileNames.has(m.autotile?.set) || autotileNames.add(m.autotile.set));
    const selectedAsset = editorCanvas.getSelectedAsset();
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
      const tex = textureUrlFor(m, catalog);
      recentsRow.appendChild(h('div', { class: 'ms-recent-swatch', title: name,
        style: { backgroundColor: colorFor(m), backgroundImage: tex ? `url(${tex})` : '' },
        onClick: () => select(m) }));
    }
  }

  function renderDetail(m) {
    detail.innerHTML = '';
    const tex = textureUrlFor(m, catalog);
    const swatchStyle = { backgroundColor: colorFor(m), backgroundImage: tex ? `url(${tex})` : '' };
    detail.appendChild(h('div', { class: 'ms-detail-row' }, [
      h('div', { class: 'ms-detail-iso' }, [h('div', { class: 'ms-detail-iso-face', style: swatchStyle })]),
      h('div', { class: 'ms-detail-text' }, [
        h('div', { class: 'ms-detail-name' }, m.name),
        h('div', { class: 'ms-detail-id' }, `${m.category ?? '?'} · ${m.w ?? 1}×${m.h ?? 1} · ${m.collision ?? 'block'}`),
      ]),
      h('div', { class: 'ms-detail-actions' }, [
        h('button', { class: 'ms-iconbtn', title: 'Usar como pincel', onClick: () => { editorCanvas.setTool('pencil'); select(m); } }, [icon('pencil', { size: 14 })]),
        h('button', { class: 'ms-iconbtn', title: 'Focar a primeira ocorrência no mapa', onClick: () => focusFirst(m) }, [icon('crosshair', { size: 14 })]),
      ]),
    ]));
    if (m.tags?.length) detail.appendChild(h('div', { class: 'ms-tag-row' }, m.tags.map((t) => h('span', { class: 'ms-tag-chip' }, t))));
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
        if (cell.m === m.name) { const [cx, cz] = key.split(',').map(Number); editorCanvas.setSelection({ cell: { cx, cz } }); return; }
      }
    }
    const obj = doc.objects.find((o) => o.m === m.name);
    if (obj) editorCanvas.setSelection({ cell: { cx: obj.cx, cz: obj.cz }, objectId: obj.id });
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
  };
}

function dotFor(collision) { return COLLISION_DOT[collision] ?? '#8F8579'; }
