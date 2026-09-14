/**
 * bottom.js — the bottom tab strip: Camadas, Objetos, Jogabilidade, Validação, Histórico.
 * Moved out of `panels.js`.
 */

import { h } from '@/ui/dom/el.js';
import { icon } from './icons.js';
import { TABLES, todBand } from '@/encounter/tables.js';
import { runValidation, issueRow } from './validation.js';
import { removeObject, removeMarker, removeNpc, removeLight, removeWildSlot, setEncounterRows } from './tools.js';

const TABS = [
  ['layers', 'Camadas', 'layers'], ['objects', 'Objetos', 'box'], ['gameplay', 'Jogabilidade', 'gamepad-2'],
  ['validation', 'Validação', 'list-checks'], ['history', 'Histórico', 'clock'],
];

export function makeBottomPanel({ root, editorCanvas, docRef, history }) {
  let active = 'validation';
  const tabsEl = h('div', { class: 'ms-bottom-tabs' });
  const bodyEl = h('div', { class: 'ms-bottom-body' });
  root.appendChild(tabsEl);
  root.appendChild(bodyEl);

  function setTab(id) { active = id; rebuild(); }
  const badges = new Map();
  for (const [id, name, iconName] of TABS) {
    const badge = h('span', { class: 'ms-tab-badge', hidden: true });
    badges.set(id, badge);
    tabsEl.appendChild(h('div', { class: 'ms-bottom-tab', onClick: () => setTab(id) },
      [icon(iconName, { size: 13 }), h('span', {}, name), badge]));
  }

  function rebuild() {
    [...tabsEl.children].forEach((el, i) => el.classList.toggle('ms-bottom-tab--active', TABS[i][0] === active));
    bodyEl.innerHTML = '';
    const doc = docRef.get();
    if (!doc) return;

    const v = runValidation(doc);
    const errBadge = badges.get('validation');
    errBadge.hidden = v.errors.length === 0;
    errBadge.textContent = String(v.errors.length);
    const objBadge = badges.get('objects');
    const objCount = doc.objects.length + doc.markers.length + doc.lights.length + doc.npcs.length;
    objBadge.hidden = objCount === 0;
    objBadge.textContent = String(objCount);

    if (active === 'layers') renderLayers(bodyEl, doc, editorCanvas, rebuild);
    else if (active === 'objects') renderObjects(bodyEl, doc, history, editorCanvas, rebuild);
    else if (active === 'gameplay') renderGameplay(bodyEl, doc, history, editorCanvas, rebuild);
    else if (active === 'validation') renderValidation(bodyEl, v, editorCanvas);
    else if (active === 'history') renderHistory(bodyEl, history);
  }

  return { rebuild, setTab };
}

function renderLayers(bodyEl, doc, editorCanvas, rebuild) {
  const layers = [...doc.tileLayers.keys()].sort((a, b) => a - b);
  const head = h('div', { class: 'ms-layer-head' }, [
    h('span', { class: 'ms-layer-head-cell', style: { width: '20px' } }, ''),
    h('span', { class: 'ms-layer-head-cell', style: { width: '20px' } }, ''),
    h('span', { class: 'ms-layer-head-cell ms-flex' }, 'Camada'),
    h('span', { class: 'ms-layer-head-cell', style: { width: '150px' } }, 'Tileset'),
    h('span', { class: 'ms-layer-head-cell', style: { width: '70px', textAlign: 'right' } }, 'Tiles'),
  ]);
  bodyEl.appendChild(head);
  for (const layer of layers) {
    const count = doc.tileLayers.get(layer).size;
    const visible = editorCanvas.isLayerVisible(layer);
    const locked = editorCanvas.isLayerLocked(layer);
    // Order is the layer number itself (`title` explains it) — no drag-to-reorder handle here;
    // a grip icon reads as "drag me" regardless of what a tooltip says, so it isn't shown.
    const row = h('div', { class: 'ms-layer-row', title: 'ordem = número da camada', onClick: () => { editorCanvas.setActiveLayer(layer); rebuild(); } }, [
      h('span', { class: 'ms-layer-icon', onClick: (e) => { e.stopPropagation(); editorCanvas.setLayerVisible(layer, !visible); rebuild(); } },
        [icon(visible ? 'eye' : 'eye-off', { size: 14 })]),
      h('span', { class: 'ms-layer-icon', onClick: (e) => { e.stopPropagation(); editorCanvas.setLayerLocked(layer, !locked); rebuild(); } },
        [icon(locked ? 'lock' : 'unlock', { size: 13 })]),
      h('span', { class: 'ms-flex' }, `Camada ${layer}`),
      h('span', { class: 'ms-muted', style: { width: '150px' } }, doc.tileset),
      h('span', { class: 'ms-mono', style: { width: '70px', textAlign: 'right' } }, String(count)),
    ]);
    if (editorCanvas.getActiveLayer() === layer) row.classList.add('ms-layer-row--active');
    bodyEl.appendChild(row);
  }
  const numInput = h('input', { class: 'ms-field-input', placeholder: 'nº da nova camada', style: { width: '140px' } });
  bodyEl.appendChild(h('div', { class: 'ms-layer-row ms-layer-row--add' }, [
    numInput,
    h('button', { class: 'ms-btn ms-btn--small', onClick: () => {
      const n = Number(numInput.value);
      if (Number.isFinite(n) && !doc.tileLayers.has(n)) { doc.tileLayers.set(n, new Map()); editorCanvas.setActiveLayer(n); rebuild(); }
    } }, [icon('plus', { size: 12 }), h('span', {}, 'camada')]),
  ]));
}

function renderObjects(bodyEl, doc, history, editorCanvas, rebuild) {
  const grid = h('div', { class: 'ms-object-grid' });
  bodyEl.appendChild(grid);
  const entry = (iconName, color, name, meta, onClick, onRemove) => grid.appendChild(h('div', { class: 'ms-object-card', onClick }, [
    h('span', { style: { color } }, [icon(iconName, { size: 16 })]),
    h('div', { class: 'ms-object-text' }, [h('span', { class: 'ms-object-name' }, name), h('span', { class: 'ms-object-meta' }, meta)]),
    onRemove ? h('button', { class: 'ms-iconbtn ms-iconbtn--ghost', onClick: (e) => { e.stopPropagation(); onRemove(); rebuild(); } }, [icon('close', { size: 12 })]) : null,
  ].filter(Boolean)));

  for (const o of doc.objects) {
    entry('box', '#CFC4B7', o.m, `objeto · (${o.cx},${o.cz}) · camada ${o.layer}`,
      () => editorCanvas.setSelection({ objectId: o.id, cell: { cx: o.cx, cz: o.cz } }),
      () => removeObject(doc, history, { id: o.id }));
  }
  for (const m of doc.markers) {
    entry('map-pin', '#7FC98C', m.name, `marcador · (${m.cx},${m.cz})`,
      () => editorCanvas.setSelection({ cell: { cx: m.cx, cz: m.cz } }),
      () => removeMarker(doc, history, { name: m.name }));
  }
  for (const l of doc.lights) {
    entry('lightbulb', '#E29650', `luz`, `raio ${l.radius} · int ${l.intensity}`,
      () => editorCanvas.setSelection({ cell: { cx: Math.round(l.x), cz: Math.round(l.z) } }),
      () => removeLight(doc, history, l));
  }
  for (const n of doc.npcs) {
    entry('paw-print', '#9ECBE6', n.name ?? n.species ?? n.trainer, `npc · (${n.cx},${n.cz})`,
      () => editorCanvas.setSelection({ cell: { cx: n.cx, cz: n.cz } }),
      () => removeNpc(doc, history, n));
  }
  if (!grid.children.length) bodyEl.appendChild(h('div', { class: 'ms-empty' }, 'Nenhum objeto — use as ferramentas de objeto/marcador/luz/npc no canvas'));
}

/** The four time-of-day bands a row's `when` can take — same vocabulary as `todBand`'s output. */
const BANDS = ['any', 'morning', 'day', 'night'];

/**
 * Add/remove/edit UI for `doc.encounters.rows` — the per-map inline encounter table, checked
 * before the shared `TABLES[doc.encounters.table]` lookup at read time (`renderGameplay`'s own
 * preview below, and eventually the runtime). Every field edit rebuilds the whole `rows` array
 * with just that field changed and funnels through the single wholesale-replace
 * `setEncounterRows` command — the same coarse-grained-undo shape `setLoopVia` already uses for
 * `loop.via`, rather than one granular command per column.
 */
function encounterRowsEditor(doc, history, refresh) {
  const rows = doc.encounters?.rows ?? [];
  const patch = (i, field, value) => setEncounterRows(doc, history, { rows: rows.map((r, k) => (k === i ? { ...r, [field]: value } : r)) });
  const rowEl = (r, i) => h('div', { class: 'ms-enc-row ms-enc-row--edit' }, [
    h('input', { class: 'ms-field-input', style: { width: '86px' }, value: r.n, placeholder: 'espécie',
      onChange: (e) => { patch(i, 'n', e.target.value); refresh(); } }),
    h('input', { class: 'ms-field-input ms-mono', type: 'number', style: { width: '44px' }, value: r.w, title: 'peso',
      onChange: (e) => { patch(i, 'w', Number(e.target.value) || 0); refresh(); } }),
    h('input', { class: 'ms-field-input ms-mono', type: 'number', style: { width: '44px' }, value: r.r, title: 'taxa de captura',
      onChange: (e) => { patch(i, 'r', Number(e.target.value) || 0); refresh(); } }),
    h('select', { class: 'ms-select', style: { width: '76px' }, onChange: (e) => { patch(i, 'when', e.target.value); refresh(); } },
      BANDS.map((b) => h('option', { value: b, selected: b === (r.when ?? 'any') }, b))),
    h('input', { class: 'ms-field-input ms-mono', type: 'number', style: { width: '38px' }, value: r.bump ?? 0, title: 'bump (níveis extra)',
      onChange: (e) => { patch(i, 'bump', Number(e.target.value) || 0); refresh(); } }),
    h('button', { class: 'ms-iconbtn ms-iconbtn--ghost', onClick: () => {
      setEncounterRows(doc, history, { rows: rows.filter((_, k) => k !== i) }); refresh();
    } }, [icon('close', { size: 12 })]),
  ]);
  const addBtn = h('button', { class: 'ms-btn ms-btn--small', onClick: () => {
    setEncounterRows(doc, history, { rows: [...rows, { n: '', w: 10, r: 200, when: 'any', bump: 0 }] }); refresh();
  } }, [icon('plus', { size: 12 }), h('span', {}, 'linha')]);
  return h('div', { class: 'ms-enc-editor' }, [
    h('div', { class: 'ms-eyebrow' }, 'Linhas do mapa (encounters.rows)'),
    ...rows.map(rowEl),
    addBtn,
  ]);
}

/**
 * The Jogabilidade tab's gameplay-data section: a read-only preview of whichever encounter
 * rows are actually in effect (`doc.encounters.rows` first, the shared `TABLES[table]`
 * otherwise), the editor that writes those rows, and the wild-spawn-slot lists — the authored
 * ones (`doc.wild.slots`, editable here) alongside the machine-derived cache
 * (`doc.wild.resolved.slots`, read-only, unchanged from before).
 */
function renderGameplay(bodyEl, doc, history, editorCanvas, rebuild) {
  const refresh = () => { rebuild(); editorCanvas.render(); };
  const tod = 12; // a fixed reference band — the live preview's own clock drives the 3D pane
  const band = todBand(tod);
  const authoredRows = doc.encounters?.rows ?? null;
  const rows = authoredRows ?? TABLES[doc.encounters?.table] ?? [];
  const maxW = Math.max(1, ...rows.map((r) => r.w));
  const sourceLabel = authoredRows ? `linhas do mapa (${authoredRows.length})` : (doc.encounters?.table || 'nenhuma');
  const left = h('div', { class: 'ms-enc-col' }, [
    h('div', { class: 'ms-eyebrow' }, `Tabela de encontro · ${sourceLabel}`),
    ...rows.map((r) => h('div', { class: `ms-enc-row${r.when !== 'any' && r.when !== band ? ' ms-enc-row--dim' : ''}` }, [
      h('span', { class: 'ms-enc-name' }, r.n),
      h('span', { class: 'ms-enc-when' }, r.when),
      h('div', { class: 'ms-enc-bar' }, [h('div', { class: 'ms-enc-bar-fill', style: { width: `${(r.w / maxW) * 100}%` } })]),
      h('span', { class: 'ms-mono' }, String(r.w)),
    ])),
    !rows.length ? h('div', { class: 'ms-empty' }, 'sem tabela de encontro') : null,
    encounterRowsEditor(doc, history, refresh),
  ].filter(Boolean));

  const resolvedSlots = doc.wild?.resolved?.slots ?? [];
  const authoredSlots = doc.wild?.slots ?? [];
  const onLoop = new Set((doc.loop?.resolved?.cells ?? []).map((c) => `${c.cx},${c.cz}`));
  const right = h('div', { class: 'ms-enc-col' }, [
    h('div', { class: 'ms-eyebrow' }, `Vagas manuais (${authoredSlots.length})`),
    ...authoredSlots.map((s) => h('div', { class: 'ms-slot-row' }, [
      icon('paw-print', { size: 13 }),
      h('span', { class: 'ms-mono ms-flex' }, `${s.cx},${s.cz}`),
      h('button', { class: 'ms-iconbtn ms-iconbtn--ghost', onClick: () => { removeWildSlot(doc, history, s); refresh(); } }, [icon('close', { size: 12 })]),
    ])),
    !authoredSlots.length ? h('div', { class: 'ms-empty' }, 'nenhuma — use a ferramenta "Vaga selvagem" no canvas') : null,
    h('div', { class: 'ms-eyebrow', style: { marginTop: '6px' } }, 'Vagas de spawn selvagem (resolvidas)'),
    ...resolvedSlots.map((s) => {
      const offLoop = !onLoop.has(`${s.from?.cx},${s.from?.cz}`);
      return h('div', { class: 'ms-slot-row' }, [
        icon('paw-print', { size: 13 }),
        h('span', { class: 'ms-mono' }, `${s.cx},${s.cz}`),
        h('span', { class: `ms-slot-status${offLoop ? ' ms-slot-status--bad' : ''}` }, offLoop ? 'fora do loop' : 'no loop'),
      ]);
    }),
    !resolvedSlots.length ? h('div', { class: 'ms-empty' }, 'sem loop resolvido — sem vagas') : null,
  ].filter(Boolean));

  bodyEl.appendChild(h('div', { class: 'ms-enc-split' }, [left, right]));
}

function renderValidation(bodyEl, v, editorCanvas) {
  const onFocus = (cx, cz) => editorCanvas.setSelection({ cell: { cx, cz } });
  for (const i of v.errors) bodyEl.appendChild(issueRow({ ...i, severity: 'error' }, { onFocus }));
  for (const i of v.warnings) bodyEl.appendChild(issueRow({ ...i, severity: 'warn' }, { onFocus }));
  for (const i of v.infos) bodyEl.appendChild(issueRow({ ...i, severity: 'info' }, { onFocus }));
  if (v.skipped.length) bodyEl.appendChild(h('div', { class: 'ms-empty' }, `${v.skipped.length} checagem(ns) não avaliadas sem contexto: ${v.skipped.join(', ')}`));
}

function renderHistory(bodyEl, history) {
  const { undo, redo } = history.entries();
  if (!undo.length && !redo.length) { bodyEl.appendChild(h('div', { class: 'ms-empty' }, 'Nenhuma ação ainda')); return; }
  for (const e of undo) {
    bodyEl.appendChild(h('div', { class: 'ms-history-row' },
      [icon('check', { size: 12 }), h('span', { class: 'ms-flex' }, e.label), h('span', { class: 'ms-muted' }, relTime(e.at))]));
  }
  for (const e of redo) {
    bodyEl.appendChild(h('div', { class: 'ms-history-row ms-history-row--dim' },
      [icon('redo-2', { size: 12 }), h('span', { class: 'ms-flex' }, e.label), h('span', { class: 'ms-muted' }, relTime(e.at))]));
  }
}

function relTime(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `há ${s}s`;
  return `há ${Math.round(s / 60)}min`;
}
