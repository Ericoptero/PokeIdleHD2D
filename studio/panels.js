/**
 * panels.js — everything around the canvas: the tool rail, the top toolbar, the right
 * inspector (map/cell/gameplay/camera/light sections), the bottom tab strip (layers,
 * objects, validation, history) and the status bar. One file, several `make*Panel`
 * factories — the Studio is small enough that splitting these further bought organization
 * this session's time budget could better spend on the editing features themselves.
 */

import { h, setText } from '@/ui/dom/el.js';
import { validateMap } from '@/terrain/validate.js';
import { serializeDocument } from './state.js';
import { loadedCatalogs } from './catalog.js';

const TOOLS = [
  ['select', '◇', 'Selecionar', 'S'], ['pencil', '✎', 'Lápis', 'B'], ['eraser', '⌫', 'Borracha', 'E'],
  ['rect', '▭', 'Retângulo', 'U'], ['fill', '▨', 'Balde', 'F'], ['object', '◆', 'Objeto', 'O'],
  ['height', '▲', 'Altura', 'H'], ['coll', '■', 'Colisão', 'C'], ['tag', '⌗', 'Tag', 'T'],
  ['marker', '●', 'Marcador', 'M'], ['spawn', '⚑', 'Spawn', 'P'], ['eyedrop', '⊙', 'Conta-gotas', 'I'],
  ['pan', '✥', 'Mover vista', 'Espaço'],
];

const COLLISIONS = ['walk', 'block', 'water', 'shallow', 'stairs', 'door', 'ledge', 'none'];
const COLLISION_LABEL = { walk: 'Andável', block: 'Bloqueio', water: 'Água', shallow: 'Rasa', stairs: 'Escada', door: 'Porta', ledge: 'Degrau', none: 'Nenhuma' };

export function makeToolRail({ root, editorCanvas }) {
  const buttons = new Map();
  for (const [id, icon, name, key] of TOOLS) {
    const btn = h('button', { class: 'ms-rail-btn', title: `${name} · ${key}`,
      onClick: () => setTool(id) }, icon);
    buttons.set(id, btn);
    root.appendChild(btn);
  }
  function setTool(id) {
    editorCanvas.setTool(id);
    for (const [bid, btn] of buttons) btn.classList.toggle('ms-rail-btn--active', bid === id);
  }
  setTool('select');
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.isContentEditable) return;
    const hit = TOOLS.find(([, , , key]) => key.toLowerCase() === e.key.toLowerCase());
    if (hit) setTool(hit[0]);
  });
  return { setTool };
}

export function makeToolbar({ root, doc, history, onNew, onOpen, onImport, onExport, onValidate }) {
  const nameEl = h('span', { class: 'ms-map-name' }, '—');
  const dirtyDot = h('span', { class: 'ms-dirty-dot', hidden: true });
  const undoBtn = h('button', { class: 'ms-toolbtn', title: 'Desfazer · Ctrl+Z', onClick: () => { history.undo(); refresh(); } }, '↶');
  const redoBtn = h('button', { class: 'ms-toolbtn', title: 'Refazer · Ctrl+Shift+Z', onClick: () => { history.redo(); refresh(); } }, '↷');
  const errBadge = h('span', { class: 'ms-err-badge' }, '0');

  root.appendChild(h('div', { class: 'ms-toolbar' }, [
    h('div', { class: 'ms-brand' }, [h('span', { class: 'ms-brand-icon' }, '🗺'), h('span', {}, 'PokeIdle Map Studio')]),
    h('div', { class: 'ms-sep' }),
    h('div', { class: 'ms-map-badge' }, [nameEl, dirtyDot]),
    h('div', { class: 'ms-sep' }),
    h('button', { class: 'ms-btn', onClick: onNew }, '+ Novo'),
    h('button', { class: 'ms-btn', onClick: onOpen }, 'Abrir'),
    h('button', { class: 'ms-btn', onClick: onImport }, 'Importar'),
    h('button', { class: 'ms-btn ms-btn--primary', onClick: () => { onExport(); refresh(); } }, 'Exportar'),
    h('div', { class: 'ms-sep' }),
    undoBtn, redoBtn,
    h('div', { class: 'ms-spacer' }),
    h('button', { class: 'ms-btn ms-btn--warn', onClick: onValidate }, ['Validar mapa ', errBadge]),
  ]));

  function refresh() {
    setText(nameEl, doc.get()?.id ?? '—');
    dirtyDot.hidden = !doc.get()?.dirty;
    const { errors } = doc.get() ? validateMap(serializeDocument(doc.get())) : { errors: [] };
    setText(errBadge, errors.length);
    const sz = history.size();
    undoBtn.disabled = sz.undo === 0;
    redoBtn.disabled = sz.redo === 0;
  }
  refresh();
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); history.undo(); refresh(); }
    else if (e.key.toLowerCase() === 'z' && e.shiftKey) { e.preventDefault(); history.redo(); refresh(); }
  });
  return { refresh };
}

/** Field rows: label + value; `onChange` makes it editable, omitted keeps it read-only text. */
function fieldRow(label, value, onChange) {
  const valueEl = onChange
    ? h('input', { class: 'ms-field-input', value: String(value ?? ''),
      onChange: (e) => onChange(e.target.value) })
    : h('span', { class: 'ms-field-value' }, String(value ?? ''));
  return h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, label), valueEl]);
}

function section(title, icon, body) {
  const content = h('div', { class: 'ms-section-body' }, body);
  const head = h('div', { class: 'ms-section-head', onClick: () => content.classList.toggle('ms-hidden') },
    [h('span', {}, icon), h('span', { class: 'ms-section-title' }, title)]);
  return h('div', { class: 'ms-section' }, [head, content]);
}

export function makeInspector({ root, editorCanvas, docRef, onChange }) {
  const body = h('div', { class: 'ms-inspector-body' });
  root.appendChild(body);

  function rebuild() {
    const doc = docRef.get();
    body.innerHTML = '';
    if (!doc) { body.appendChild(h('div', { class: 'ms-empty' }, 'Nenhum mapa aberto')); return; }
    const sel = editorCanvas.getSelection();
    const set = (key, coerce) => (v) => { doc[key] = coerce ? coerce(v) : v; doc.dirty = true; onChange(); };

    body.appendChild(section('Informações do mapa', '🗺', [
      fieldRow('Map ID', doc.id, set('id')),
      fieldRow('Nome exibido', doc.name, set('name')),
      fieldRow('Tipo', doc.kind, set('kind')),
      fieldRow('Tamanho', `${doc.w} × ${doc.h}`),
      fieldRow('Seed', doc.seed, set('seed', Number)),
      fieldRow('Bioma', doc.biome, set('biome')),
      fieldRow('Tileset base', doc.tileset),
      fieldRow('Nível exigido', doc.requiredLevel, set('requiredLevel', Number)),
    ]));

    if (sel.cell) {
      const { cx, cz } = sel.cell;
      const i = cz * doc.w + cx;
      const stack = editorCanvas.stackAtSelection();
      body.appendChild(section('Célula selecionada', '▦', [
        fieldRow('Posição', `${cx}, ${cz}`),
        fieldRow('Colisão', doc.collision[i]),
        fieldRow('Altura', doc.height[i].toFixed(2)),
        fieldRow('Tags', doc.tags[i].join(', ') || '—'),
        h('div', { class: 'ms-stack-list' }, stack.length
          ? stack.map((s) => h('div', { class: 'ms-stack-item' }, `${s.kind === 'object' ? 'objeto' : 'tile'} · camada ${s.layer} · ${s.m}`))
          : [h('div', { class: 'ms-stack-item ms-muted' }, 'nada nesta célula')]),
      ]));
    }

    body.appendChild(section('Jogabilidade', '🎮', [
      fieldRow('Spawn', `${doc.spawn.cx}, ${doc.spawn.cz}`),
      fieldRow('Direção do spawn', doc.spawn.dir, (v) => { doc.spawn = { ...doc.spawn, dir: Number(v) & 3 }; doc.dirty = true; onChange(); }),
      fieldRow('Tabela de encontro', doc.encounters?.table ?? '—', (v) => { doc.encounters = v ? { table: v } : null; doc.dirty = true; onChange(); }),
      fieldRow('Loop de caça (via)', (doc.loop?.via ?? []).join(', ') || '—',
        (v) => { doc.loop = { ...(doc.loop ?? {}), via: v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null }; doc.dirty = true; onChange(); }),
      fieldRow('Marcadores', doc.markers.map((m) => m.name).join(', ') || '—'),
    ]));

    body.appendChild(section('Luzes', '💡', [
      ...doc.lights.map((l, i) => h('div', { class: 'ms-light-row' }, [
        h('span', {}, `#${i} (${l.x?.toFixed?.(1) ?? l.x}, ${l.z?.toFixed?.(1) ?? l.z}) · int ${l.intensity} · raio ${l.radius}`),
        h('button', { class: 'ms-btn ms-btn--small', onClick: () => { doc.lights.splice(i, 1); doc.dirty = true; onChange(); } }, '✕'),
      ])),
      h('button', { class: 'ms-btn ms-btn--small', onClick: () => {
        const c = sel.cell ?? { cx: doc.w >> 1, cz: doc.h >> 1 };
        doc.lights.push({ x: c.cx + 0.5, z: c.cz + 0.5, y: 0.5, color: 0xe0a64b, intensity: 1.5, radius: 8, size: 0.2 });
        doc.dirty = true; onChange();
      } }, '+ luz na célula selecionada'),
    ]));
  }

  return { rebuild };
}

const BOTTOM_TABS = [['layers', 'Camadas'], ['objects', 'Objetos'], ['validation', 'Validação'], ['history', 'Histórico']];

export function makeBottomPanel({ root, editorCanvas, docRef, history }) {
  let active = 'validation';
  const tabsEl = h('div', { class: 'ms-bottom-tabs' });
  const bodyEl = h('div', { class: 'ms-bottom-body' });
  root.appendChild(tabsEl);
  root.appendChild(bodyEl);

  function setTab(id) { active = id; rebuild(); }
  for (const [id, name] of BOTTOM_TABS) {
    tabsEl.appendChild(h('div', { class: 'ms-bottom-tab', onClick: () => setTab(id) }, name));
  }

  function rebuild() {
    [...tabsEl.children].forEach((el, i) => el.classList.toggle('ms-bottom-tab--active', BOTTOM_TABS[i][0] === active));
    bodyEl.innerHTML = '';
    const doc = docRef.get();
    if (!doc) return;

    if (active === 'layers') {
      const layers = [...doc.tileLayers.keys()].sort((a, b) => a - b);
      for (const layer of layers) {
        const count = doc.tileLayers.get(layer).size;
        const row = h('div', { class: 'ms-layer-row', onClick: () => { editorCanvas.setActiveLayer(layer); rebuild(); } },
          [h('span', {}, `Camada ${layer}`), h('span', { class: 'ms-muted' }, `${count} tiles`)]);
        if (editorCanvas.getActiveLayer() === layer) row.classList.add('ms-layer-row--active');
        bodyEl.appendChild(row);
      }
      const addRow = h('div', { class: 'ms-layer-row ms-layer-row--add' }, [
        h('input', { class: 'ms-field-input', id: 'ms-new-layer-num', placeholder: 'nº da nova camada', style: { width: '120px' } }),
        h('button', { class: 'ms-btn ms-btn--small', onClick: () => {
          const input = document.getElementById('ms-new-layer-num');
          const n = Number(input.value);
          if (Number.isFinite(n) && !doc.tileLayers.has(n)) { doc.tileLayers.set(n, new Map()); editorCanvas.setActiveLayer(n); rebuild(); }
        } }, '+ camada'),
      ]);
      bodyEl.appendChild(addRow);
    } else if (active === 'objects') {
      for (const o of doc.objects) {
        bodyEl.appendChild(h('div', { class: 'ms-layer-row', onClick: () => editorCanvas.setSelection({ objectId: o.id, cell: { cx: o.cx, cz: o.cz } }) },
          [h('span', {}, `${o.m} · (${o.cx},${o.cz}) · camada ${o.layer}`),
            h('button', { class: 'ms-btn ms-btn--small', onClick: (e) => { e.stopPropagation(); doc.objects = doc.objects.filter((x) => x.id !== o.id); doc.dirty = true; editorCanvas.render(); rebuild(); } }, '✕')]));
      }
      if (!doc.objects.length) bodyEl.appendChild(h('div', { class: 'ms-empty' }, 'Nenhum objeto — use a ferramenta "Objeto" no canvas'));
    } else if (active === 'validation') {
      const { errors, warnings, infos, skipped } = validateMap(serializeDocument(doc), { catalogs: loadedCatalogs() });
      const row = (i, cls) => h('div', { class: `ms-issue-row ms-issue-row--${cls}`, onClick: () => {
        if (i.at?.cx != null) editorCanvas.setSelection({ cell: { cx: i.at.cx, cz: i.at.cz } });
      } }, [h('span', { class: 'ms-issue-code' }, i.code), h('span', {}, i.message)]);
      for (const i of errors) bodyEl.appendChild(row(i, 'err'));
      for (const i of warnings) bodyEl.appendChild(row(i, 'warn'));
      for (const i of infos) bodyEl.appendChild(row(i, 'info'));
      if (skipped.length) bodyEl.appendChild(h('div', { class: 'ms-empty' }, `${skipped.length} checagem(ns) não avaliadas sem contexto: ${skipped.join(', ')}`));
    } else if (active === 'history') {
      const sz = history.size();
      bodyEl.appendChild(h('div', { class: 'ms-empty' }, `${sz.undo} ação(ões) no histórico · ${sz.redo} para refazer`));
    }
  }

  return { rebuild, setTab };
}

export function makeStatusBar({ root, editorCanvas, docRef }) {
  const cellEl = h('span', {}, '—');
  const toolEl = h('span', {}, '—');
  root.appendChild(h('div', { class: 'ms-status' }, [cellEl, toolEl]));
  function refresh() {
    const doc = docRef.get();
    const hover = editorCanvas.getHover();
    setText(cellEl, hover ? `célula ${hover.cx}, ${hover.cz}` : (doc ? `${doc.w} × ${doc.h}` : '—'));
    setText(toolEl, `ferramenta: ${editorCanvas.getTool()}`);
  }
  editorCanvas.subscribe(refresh);
  refresh();
  return { refresh };
}

export function makeAssetBrushBar({ root, editorCanvas }) {
  const rotBtn = h('button', { class: 'ms-btn ms-btn--small', onClick: () => {
    editorCanvas.setBrush({ rot: (editorCanvas.getBrush().rot + 1) & 3 });
    setText(rotLabel, `${editorCanvas.getBrush().rot * 90}°`);
  } }, '⟳');
  const rotLabel = h('span', { class: 'ms-muted' }, '0°');
  const collSelect = h('select', { class: 'ms-select', onChange: (e) => editorCanvas.setBrush({ collision: e.target.value }) },
    COLLISIONS.map((c) => h('option', { value: c }, COLLISION_LABEL[c])));
  const tagInput = h('input', { class: 'ms-field-input', value: 'tallgrass', style: { width: '110px' },
    onChange: (e) => editorCanvas.setBrush({ tag: e.target.value }) });
  root.appendChild(h('div', { class: 'ms-brush-bar' }, [
    h('span', { class: 'ms-eyebrow' }, 'Pincel'), rotBtn, rotLabel,
    h('span', { class: 'ms-eyebrow' }, 'Colisão'), collSelect,
    h('span', { class: 'ms-eyebrow' }, 'Tag'), tagInput,
  ]));
}
