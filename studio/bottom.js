/**
 * bottom.js — the bottom tab strip: Camadas, Objetos, Jogabilidade, Validação, Histórico.
 * Moved out of `panels.js`.
 */

import { h } from '@/ui/dom/el.js';
import { icon } from './icons.js';
import { runValidation, issueRow } from './validation.js';
import { addLayer, removeObject, removeMarker, removeNpc, removeLight, removeSpawnPoint, removeLink } from './tools.js';

const TABS = [
  ['layers', 'Camadas', 'layers'], ['objects', 'Objetos', 'box'], ['gameplay', 'Jogabilidade', 'gamepad-2'],
  ['validation', 'Validação', 'list-checks'], ['history', 'Histórico', 'clock'],
];

export function makeBottomPanel({ root, editorCanvas, session, docRef, history }) {
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
    const objCount = doc.objects.length + doc.markers.length + doc.lights.length + doc.npcs.length + doc.links.length;
    objBadge.hidden = objCount === 0;
    objBadge.textContent = String(objCount);

    if (active === 'layers') renderLayers(bodyEl, doc, history, session, rebuild);
    else if (active === 'objects') renderObjects(bodyEl, doc, history, session, rebuild);
    else if (active === 'gameplay') renderGameplay(bodyEl, doc, history, session, editorCanvas, rebuild);
    else if (active === 'validation') renderValidation(bodyEl, v, session);
    else if (active === 'history') renderHistory(bodyEl, history);
  }

  return { rebuild, setTab };
}

function renderLayers(bodyEl, doc, history, session, rebuild) {
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
    const visible = session.isLayerVisible(layer);
    const locked = session.isLayerLocked(layer);
    // Order is the layer number itself (`title` explains it) — no drag-to-reorder handle here;
    // a grip icon reads as "drag me" regardless of what a tooltip says, so it isn't shown.
    const row = h('div', { class: 'ms-layer-row', title: 'ordem = número da camada', onClick: () => { session.setActiveLayer(layer); rebuild(); } }, [
      h('span', { class: 'ms-layer-icon', onClick: (e) => { e.stopPropagation(); session.setLayerVisible(layer, !visible); rebuild(); } },
        [icon(visible ? 'eye' : 'eye-off', { size: 14 })]),
      h('span', { class: 'ms-layer-icon', onClick: (e) => { e.stopPropagation(); session.setLayerLocked(layer, !locked); rebuild(); } },
        [icon(locked ? 'lock' : 'unlock', { size: 13 })]),
      h('span', { class: 'ms-flex' }, `Camada ${layer}`),
      h('span', { class: 'ms-muted', style: { width: '150px' } }, doc.tileset),
      h('span', { class: 'ms-mono', style: { width: '70px', textAlign: 'right' } }, String(count)),
    ]);
    if (session.getActiveLayer() === layer) row.classList.add('ms-layer-row--active');
    bodyEl.appendChild(row);
  }
  const numInput = h('input', { class: 'ms-field-input', placeholder: 'nº da nova camada', style: { width: '140px' } });
  bodyEl.appendChild(h('div', { class: 'ms-layer-row ms-layer-row--add' }, [
    numInput,
    h('button', { class: 'ms-btn ms-btn--small', onClick: () => {
      const n = Number(numInput.value);
      // Goes through `tools.js`'s `addLayer` (undo/redo + `touch()`), not a direct
      // `doc.tileLayers.set(...)` — a bare mutation here used to skip undo and dirty tracking.
      if (Number.isFinite(n) && !doc.tileLayers.has(n)) { addLayer(doc, history, n); session.setActiveLayer(n); rebuild(); }
    } }, [icon('plus', { size: 12 }), h('span', {}, 'camada')]),
  ]));
}

function renderObjects(bodyEl, doc, history, session, rebuild) {
  const grid = h('div', { class: 'ms-object-grid' });
  bodyEl.appendChild(grid);
  const entry = (iconName, color, name, meta, onClick, onRemove) => grid.appendChild(h('div', { class: 'ms-object-card', onClick }, [
    h('span', { style: { color } }, [icon(iconName, { size: 16 })]),
    h('div', { class: 'ms-object-text' }, [h('span', { class: 'ms-object-name' }, name), h('span', { class: 'ms-object-meta' }, meta)]),
    onRemove ? h('button', { class: 'ms-iconbtn ms-iconbtn--ghost', onClick: (e) => { e.stopPropagation(); onRemove(); rebuild(); } }, [icon('close', { size: 12 })]) : null,
  ].filter(Boolean)));

  for (const o of doc.objects) {
    entry('box', '#CFC4B7', o.m, `objeto · (${o.cx},${o.cz}) · camada ${o.layer}`,
      () => session.setSelection({ kind: 'object', ref: o, cell: { cx: o.cx, cz: o.cz } }),
      () => removeObject(doc, history, o));
  }
  for (const m of doc.markers) {
    entry('map-pin', '#7FC98C', m.name, `marcador · (${m.cx},${m.cz})`,
      () => session.setSelection({ kind: 'marker', ref: m, cell: { cx: m.cx, cz: m.cz } }),
      () => removeMarker(doc, history, m));
  }
  for (const l of doc.lights) {
    entry('lightbulb', '#E29650', `luz`, `raio ${l.radius} · int ${l.intensity}`,
      () => session.setSelection({ kind: 'light', ref: l, cell: { cx: Math.round(l.x), cz: Math.round(l.z) } }),
      () => removeLight(doc, history, l));
  }
  for (const n of doc.npcs) {
    entry('paw-print', '#9ECBE6', n.name ?? n.species ?? n.trainer, `npc · (${n.cx},${n.cz})`,
      () => session.setSelection({ kind: 'npc', ref: n, cell: { cx: n.cx, cz: n.cz } }),
      () => removeNpc(doc, history, n));
  }
  // Links (map-to-map doors/edges/stairs) get their own row here too — a plain cell click can
  // lose a link to a light/spawnPoint/etc. sharing the same cell in `session.js`'s select-tool
  // priority chain (a light right at a doorway is a realistic, not even rare, authoring choice —
  // `demo-city.map.json`'s own door link has exactly this), so this row is the reliable way to
  // reach one regardless of what else occupies its `from` cell.
  for (const l of doc.links) {
    entry('door-open', '#C79BD6', l.id, `link · (${l.from?.cx},${l.from?.cz}) → ${l.to?.map ?? '?'}`,
      () => session.setSelection({ kind: 'link', ref: l, cell: { cx: l.from?.cx, cz: l.from?.cz } }),
      () => removeLink(doc, history, l));
  }
  if (!grid.children.length) bodyEl.appendChild(h('div', { class: 'ms-empty' }, 'Nenhum objeto — use as ferramentas de objeto/marcador/luz/npc no canvas'));
}

/**
 * The Jogabilidade tab's gameplay-data section: a summary list of every spawn point on the
 * map, each with its own respawn timer and its own weighted species list
 * (`@/terrain/mapfile.js`'s `spawnPoints[]`) — the full editor for one point is the
 * inspector's own card (`inspector.js`'s `spawnPointCard`), which comes up when a point's
 * gizmo (3D) or cell (2D) is selected; clicking a row here selects it the same way.
 */
function renderGameplay(bodyEl, doc, history, session, editorCanvas, rebuild) {
  const refresh = () => { rebuild(); editorCanvas.render(); };
  const points = doc.spawnPoints ?? [];
  const rows = points.map((p) => {
    const label = (p.species ?? []).map((s) => s.name || '(sem nome)').join(', ') || 'sem espécies';
    return h('div', { class: 'ms-slot-row', onClick: () => {
      session.setSelection({ cell: { cx: p.cx, cz: p.cz }, kind: 'spawnPoint', ref: p });
      refresh();
    } }, [
      icon('paw-print', { size: 13 }),
      h('span', { class: 'ms-mono' }, `${p.cx},${p.cz}`),
      h('span', { class: 'ms-flex' }, label),
      h('span', { class: 'ms-muted' }, `${p.respawnSeconds ?? 26}s`),
      h('button', { class: 'ms-iconbtn ms-iconbtn--ghost', onClick: (e) => { e.stopPropagation(); removeSpawnPoint(doc, history, p); refresh(); } }, [icon('close', { size: 12 })]),
    ]);
  });

  bodyEl.appendChild(h('div', { class: 'ms-enc-col' }, [
    h('div', { class: 'ms-eyebrow' }, `Pontos de spawn (${points.length})`),
    ...rows,
    !points.length ? h('div', { class: 'ms-empty' }, 'nenhum — use a ferramenta "Vaga selvagem" no canvas ou pane 3D') : null,
  ].filter(Boolean)));
}

function renderValidation(bodyEl, v, session) {
  // Jumping to a validation issue's cell means "select just this cell" — explicit
  // `kind: null, ref: null` clears whatever entity was previously selected.
  const onFocus = (cx, cz) => session.setSelection({ cell: { cx, cz }, kind: null, ref: null });
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
