/**
 * library.js — the asset library panel: browses one tileset's catalog, searches by name/
 * category, and reports the selection back to `canvas.js` (`setSelectedAsset`).
 */

import { h } from '@/ui/dom/el.js';
import { loadCatalog, colorFor, listTilesets } from './catalog.js';

export function makeLibraryPanel({ root, editorCanvas, onCatalogLoaded }) {
  let catalog = null;
  let query = '';
  let categoryFilter = null;
  let allTilesets = [];

  const searchInput = h('input', {
    class: 'ms-search', placeholder: 'Buscar tile, tag ou categoria',
    onInput: (e) => { query = e.target.value.toLowerCase(); renderGrid(); },
  });
  const tilesetSelect = h('select', {
    class: 'ms-select',
    onChange: (e) => loadFor(e.target.value),
  });
  const catLabel = h('span', { class: 'ms-muted-label' }, 'tiles');
  const grid = h('div', { class: 'ms-asset-grid' });
  const detail = h('div', { class: 'ms-asset-detail' }, 'Selecione um tile');

  root.appendChild(h('div', { class: 'ms-lib-head' }, [
    h('div', { class: 'ms-lib-row' }, [h('span', { class: 'ms-eyebrow' }, 'Biblioteca'), tilesetSelect]),
    searchInput,
  ]));
  root.appendChild(h('div', { class: 'ms-lib-cats' }, catLabel));
  root.appendChild(h('div', { class: 'ms-lib-scroll' }, [grid]));
  root.appendChild(detail);

  async function loadFor(slug) {
    catalog = await loadCatalog(slug);
    onCatalogLoaded?.(slug, catalog);
    renderGrid();
  }

  function renderGrid() {
    grid.innerHTML = '';
    if (!catalog) return;
    const models = catalog.models.filter((m) => {
      if (m.category === 'meta') return false;
      if (categoryFilter && m.category !== categoryFilter) return false;
      if (!query) return true;
      return m.name.toLowerCase().includes(query) || (m.tags ?? []).some((t) => t.includes(query))
        || (m.category ?? '').includes(query) || (m.subcategory ?? '').includes(query);
    });
    catLabel.textContent = `${models.length} tiles`;
    for (const m of models.slice(0, 400)) {
      const swatch = h('div', { class: 'ms-asset-swatch', style: { background: colorFor(m) } });
      const card = h('div', { class: 'ms-asset-card', title: m.name }, [
        swatch,
        h('span', { class: 'ms-asset-name' }, m.name),
      ]);
      card.onclick = () => {
        editorCanvas.setSelectedAsset({ name: m.name, tileset: catalog.tileset, w: m.w ?? 1, h: m.h ?? 1 });
        renderDetail(m);
        [...grid.children].forEach((c) => c.classList.remove('ms-asset-card--sel'));
        card.classList.add('ms-asset-card--sel');
      };
      grid.appendChild(card);
    }
  }

  function renderDetail(m) {
    detail.innerHTML = '';
    detail.appendChild(h('div', { class: 'ms-detail-row' }, [
      h('div', { class: 'ms-detail-swatch', style: { background: colorFor(m) } }),
      h('div', { class: 'ms-detail-text' }, [
        h('div', { class: 'ms-detail-name' }, m.name),
        h('div', { class: 'ms-detail-id' }, `${m.category ?? '?'} · ${m.w ?? 1}×${m.h ?? 1} · ${m.collision ?? 'block'}`),
      ]),
    ]));
    if (m.tags?.length) {
      detail.appendChild(h('div', { class: 'ms-tag-row' }, m.tags.map((t) => h('span', { class: 'ms-tag-chip' }, t))));
    }
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
    setCategoryFilter(cat) { categoryFilter = cat; renderGrid(); },
  };
}
