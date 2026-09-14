/**
 * main.js — boots the Map Studio: assembles the layout, wires the canvas/panels to one
 * shared document reference, and owns the open/new/import/export flows.
 */

import { h } from '@/ui/dom/el.js';
import tokens from '@/ui/css/tokens.css?inline';
import base from '@/ui/css/base.css?inline';
import studioCss from './css/studio.css?inline';

import { createDocument, createBlankDocument, serializeDocument, createHistory } from './state.js';
import { makeEditorCanvas } from './canvas.js';
import { makeLibraryPanel } from './library.js';
import {
  makeToolRail, makeToolbar, makeInspector, makeBottomPanel, makeStatusBar, makeAssetBrushBar,
} from './panels.js';
import { listGameMaps, loadGameMap, importFile, exportFile } from './io.js';

// A single synchronous <style>, the way `src/ui/dom/layer.js` injects the game's own theme —
// no flash of an unstyled panel while a stylesheet link resolves.
const style = document.createElement('style');
style.id = 'ms-style';
style.textContent = `${tokens}\n${base}\n${studioCss}`;
document.head.appendChild(style);

const root = h('div', { id: 'ui-dom', class: 'ms-root' });
document.body.appendChild(root);

let currentDoc = null;
const docRef = { get: () => currentDoc };
const history = createHistory();

const toolbarEl = h('div', {});
const libraryEl = h('div', { class: 'ms-panel ms-panel--library' });
const railEl = h('div', { class: 'ms-tool-rail' });
const brushBarEl = h('div', {});
const canvasWrap = h('div', { class: 'ms-canvas-wrap' });
const canvasEl = h('canvas', { class: 'ms-canvas' });
canvasWrap.appendChild(canvasEl);
const bottomEl = h('div', { class: 'ms-panel ms-panel--bottom' });
const inspectorEl = h('div', { class: 'ms-panel ms-panel--inspector' });
const statusEl = h('div', {});

const centerEl = h('div', { class: 'ms-center' }, [brushBarEl, canvasWrap, bottomEl]);
const bodyEl = h('div', { class: 'ms-body' }, [libraryEl, railEl, centerEl, inspectorEl]);
root.appendChild(h('div', { class: 'ms-app' }, [toolbarEl, bodyEl, statusEl]));

const editorCanvas = makeEditorCanvas({ canvas: canvasEl, history });

makeToolRail({ root: railEl, editorCanvas });
const library = makeLibraryPanel({
  root: libraryEl, editorCanvas,
  onCatalogLoaded: () => bottom.rebuild(),
});
makeAssetBrushBar({ root: brushBarEl, editorCanvas });
const inspector = makeInspector({ root: inspectorEl, editorCanvas, docRef, onChange: refreshAll });
const bottom = makeBottomPanel({ root: bottomEl, editorCanvas, docRef, history });
const status = makeStatusBar({ root: statusEl, editorCanvas, docRef });
const toolbar = makeToolbar({
  root: toolbarEl, doc: docRef, history,
  onNew: () => openNewMapDialog(),
  onOpen: () => openGameMapDialog(),
  onImport: async () => { const map = await importFile(); if (map) setDocument(createDocument(map)); },
  onExport: () => { if (currentDoc) { exportFile(serializeDocument(currentDoc)); currentDoc.dirty = false; } },
  onValidate: () => bottom.setTab('validation'),
});

function refreshAll() {
  toolbar.refresh();
  inspector.rebuild();
  bottom.rebuild();
  status.refresh();
  editorCanvas.render();
}

function setDocument(doc) {
  currentDoc = doc;
  editorCanvas.setDoc(doc);
  history.clear();
  library.setTileset(doc.tileset);
  refreshAll();
}
editorCanvas.subscribe(refreshAll);

// --- new map dialog --------------------------------------------------------------------------

function openNewMapDialog() {
  const idInput = h('input', { class: 'ms-field-input', value: 'novo_mapa' });
  const nameInput = h('input', { class: 'ms-field-input', value: 'Novo Mapa' });
  const wInput = h('input', { class: 'ms-field-input', value: '32' });
  const hInput = h('input', { class: 'ms-field-input', value: '32' });
  const tilesetInput = h('input', { class: 'ms-field-input', value: 'bw2-adastra' });
  const biomeInput = h('input', { class: 'ms-field-input', value: 'meadow' });
  const kindSelect = h('select', { class: 'ms-select' }, ['hunt', 'city', 'interior'].map((k) => h('option', { value: k }, k)));

  const field = (label, input) => h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, label), input]);
  const dialog = h('div', { class: 'ms-modal-scrim' }, [
    h('div', { class: 'ms-modal' }, [
      h('div', { class: 'ms-modal-head' }, 'Novo mapa'),
      h('div', { class: 'ms-modal-body' }, [
        field('Map ID', idInput), field('Nome exibido', nameInput), field('Tipo', kindSelect),
        field('Largura', wInput), field('Altura', hInput),
        field('Tileset', tilesetInput), field('Bioma', biomeInput),
      ]),
      h('div', { class: 'ms-modal-foot' }, [
        h('button', { class: 'ms-btn', onClick: () => dialog.remove() }, 'Cancelar'),
        h('button', { class: 'ms-btn ms-btn--primary', onClick: () => {
          setDocument(createBlankDocument({
            id: idInput.value.trim() || 'novo_mapa', name: nameInput.value.trim() || 'Novo Mapa',
            w: Math.max(4, Number(wInput.value) || 32), h: Math.max(4, Number(hInput.value) || 32),
            tileset: tilesetInput.value.trim() || 'bw2-adastra', biome: biomeInput.value.trim() || 'meadow',
            kind: kindSelect.value,
          }));
          dialog.remove();
        } }, 'Criar mapa'),
      ]),
    ]),
  ]);
  document.body.appendChild(dialog);
}

async function openGameMapDialog() {
  const maps = await listGameMaps();
  const dialog = h('div', { class: 'ms-modal-scrim' }, [
    h('div', { class: 'ms-modal' }, [
      h('div', { class: 'ms-modal-head' }, 'Abrir mapa do jogo'),
      h('div', { class: 'ms-modal-body' }, maps.length
        ? maps.map((m) => h('div', { class: 'ms-open-row', onClick: async () => {
          setDocument(createDocument(await loadGameMap(m.id)));
          dialog.remove();
        } }, [h('span', {}, m.name), h('span', { class: 'ms-muted' }, `${m.id} · ${m.w}×${m.h} · ${m.kind}`)]))
        : [h('div', { class: 'ms-empty' }, 'Nenhum mapa exportado ainda — rode "node tools/mapstudio/snapshot.js" no jogo.')]),
      h('div', { class: 'ms-modal-foot' }, [h('button', { class: 'ms-btn', onClick: () => dialog.remove() }, 'Fechar')]),
    ]),
  ]);
  document.body.appendChild(dialog);
}

new ResizeObserver(() => editorCanvas.render()).observe(canvasWrap);

// Boot: open the game's first shipped map so the Studio starts on something real, not blank —
// falling back to a fresh blank map (still `bw2-adastra`) when none have been snapshotted yet.
(async function boot() {
  const maps = await listGameMaps();
  const doc = maps.length
    ? createDocument(await loadGameMap(maps[0].id))
    : createBlankDocument({ id: 'novo_mapa', name: 'Novo Mapa', w: 32, h: 32, tileset: 'bw2-adastra', biome: 'meadow', kind: 'hunt' });
  await library.init(doc.tileset);
  setDocument(doc);
})();
