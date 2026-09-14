/**
 * panels.js — the toolbar, tool rail, status bar and brush bar: everything around the canvas
 * that is NOT the inspector (`inspector.js`) or the bottom tab strip (`bottom.js`), which grew
 * large enough to earn their own files.
 */

import { h, setText } from '@/ui/dom/el.js';
import { icon, iconBtn } from './icons.js';
import { TOOLS, COLLISIONS, COLLISION_LABEL } from './kinds.js';
import { runValidation, invalidateValidation } from './validation.js';

export function makeToolRail({ root, editorCanvas }) {
  const buttons = new Map();
  for (const [id, iconName, name, key] of TOOLS) {
    const btn = h('button', { class: 'ms-rail-btn', title: `${name} · ${key}`, onClick: () => setTool(id) },
      [icon(iconName, { size: 17 })]);
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
    // `e.key` for the spacebar is the literal string ' ', which never matches the rail's
    // display label 'Espaço' — normalize it to the label before comparing.
    const key = e.key === ' ' ? 'Espaço' : e.key;
    const hit = TOOLS.find(([, , , k]) => k.toLowerCase() === key.toLowerCase());
    if (hit) { e.preventDefault(); setTool(hit[0]); }
  });
  return { setTool };
}

const VIEWS = [['edit', 'grid-3x3', 'Edição'], ['game', 'gamepad-2', 'Jogo'], ['split', 'columns-2', 'Dividida']];

export function makeToolbar({ root, doc, history, onNew, onOpenPicker, onImport, onExport, onSave, onValidate, onView, onWalkLoop }) {
  const nameBtn = h('button', { class: 'ms-map-badge', onClick: onOpenPicker }, []);
  const nameEl = h('span', { class: 'ms-map-name' }, '—');
  const dirtyDot = h('span', { class: 'ms-dirty-dot', hidden: true });
  nameBtn.append(icon('layers', { size: 14 }), nameEl, dirtyDot, icon('chevron-down', { size: 14 }));

  const undoBtn = iconBtn('undo-2', { title: 'Desfazer', keybind: 'Ctrl+Z', class: 'ms-toolbtn', onClick: () => { history.undo(); refresh(); } });
  const redoBtn = iconBtn('redo-2', { title: 'Refazer', keybind: 'Ctrl+Shift+Z', class: 'ms-toolbtn', onClick: () => { history.redo(); refresh(); } });
  const errBadge = h('span', { class: 'ms-err-badge' }, '0');

  const viewBtns = new Map();
  const viewSeg = h('div', { class: 'ms-view-seg' });
  for (const [id, iconName, label] of VIEWS) {
    const btn = h('button', { class: 'ms-view-btn', onClick: () => { setView(id); onView(id); } },
      [icon(iconName, { size: 14 }), h('span', {}, label)]);
    viewBtns.set(id, btn);
    viewSeg.appendChild(btn);
  }
  function setView(id) {
    for (const [vid, btn] of viewBtns) btn.classList.toggle('ms-view-btn--active', vid === id);
  }
  setView('edit');

  const walkBtn = iconBtn('route', { title: 'Percorrer loop de caça', class: 'ms-btn', onClick: onWalkLoop, label: 'Percorrer loop' });
  const saveBtn = iconBtn('save', { title: 'Salvar em public/maps/ (servidor de desenvolvimento)', class: 'ms-btn', label: 'Salvar', onClick: async () => {
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    try { await onSave(); } finally { refresh(); }
  } });

  root.appendChild(h('div', { class: 'ms-toolbar' }, [
    h('div', { class: 'ms-brand' }, [icon('map', { size: 18 }), h('span', {}, 'PokeIdle Map Studio')]),
    h('div', { class: 'ms-sep' }),
    nameBtn,
    h('div', { class: 'ms-sep' }),
    iconBtn('file-plus', { title: 'Novo mapa', class: 'ms-btn', onClick: onNew, label: 'Novo' }),
    iconBtn('folder-open', { title: 'Abrir mapa do jogo', class: 'ms-btn', onClick: onOpenPicker, label: 'Abrir' }),
    saveBtn,
    iconBtn('upload', { title: 'Importar .map.json', class: 'ms-btn', onClick: onImport, label: 'Importar' }),
    iconBtn('download', { title: 'Exportar .map.json', class: 'ms-btn ms-btn--primary', onClick: () => { onExport(); refresh(); }, label: 'Exportar' }),
    h('div', { class: 'ms-sep' }),
    undoBtn, redoBtn,
    h('div', { class: 'ms-spacer' }),
    viewSeg,
    walkBtn,
    h('button', { class: 'ms-btn ms-btn--warn', onClick: onValidate }, [icon('list-checks', { size: 15 }), h('span', {}, 'Validar mapa'), errBadge]),
  ]));

  function refresh() {
    const d = doc.get();
    setText(nameEl, d?.name ?? d?.id ?? '—');
    dirtyDot.hidden = !d?.dirty;
    invalidateValidation();
    const { errors } = runValidation(d);
    setText(errBadge, errors.length);
    const sz = history.size();
    undoBtn.disabled = sz.undo === 0;
    redoBtn.disabled = sz.redo === 0;
    saveBtn.disabled = !d;
    walkBtn.disabled = !d?.loop?.resolved?.cells?.length;
    walkBtn.title = walkBtn.disabled ? 'este mapa não tem loop resolvido' : 'Percorrer o loop de caça na prévia 3D';
  }
  refresh();
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); history.undo(); refresh(); }
    else if (e.key.toLowerCase() === 'z' && e.shiftKey) { e.preventDefault(); history.redo(); refresh(); }
  });
  return { refresh, setView };
}

export function makeStatusBar({ root, editorCanvas, docRef }) {
  const cellEl = h('span', {}, '—');
  const toolEl = h('span', {}, '—');
  const editsEl = h('span', {}, '—');
  const reachEl = h('span', {}, '—');
  const errDot = h('span', { class: 'ms-status-dot ms-status-dot--err' });
  const warnDot = h('span', { class: 'ms-status-dot ms-status-dot--warn' });
  const infoDot = h('span', { class: 'ms-status-dot ms-status-dot--info' });
  const errCount = h('span', {}, '0');
  const warnCount = h('span', {}, '0');
  const infoCount = h('span', {}, '0');
  const seedEl = h('span', { class: 'ms-muted' }, '—');
  root.appendChild(h('div', { class: 'ms-status' }, [
    cellEl, toolEl, editsEl, reachEl,
    h('div', { class: 'ms-spacer' }),
    h('div', { class: 'ms-status-issue' }, [errDot, errCount]),
    h('div', { class: 'ms-status-issue' }, [warnDot, warnCount]),
    h('div', { class: 'ms-status-issue' }, [infoDot, infoCount]),
    seedEl,
  ]));
  function refresh() {
    const doc = docRef.get();
    const hover = editorCanvas.getHover();
    setText(cellEl, hover ? `célula ${hover.cx}, ${hover.cz}` : (doc ? `${doc.w} × ${doc.h}` : '—'));
    setText(toolEl, `ferramenta: ${editorCanvas.getTool()}`);
    setText(editsEl, `${editorCanvas.getEditCount()} edição(ões) nesta sessão`);
    const reach = editorCanvas.getReachStats();
    setText(reachEl, `${reach.unreachable} célula(s) inalcançável(is)`);
    const v = runValidation(doc);
    setText(errCount, `${v.errors.length} erros`);
    setText(warnCount, `${v.warnings.length} avisos`);
    setText(infoCount, `${v.infos.length} infos`);
    setText(seedEl, doc ? `seed ${doc.seed}` : '—');
  }
  editorCanvas.subscribe(refresh);
  refresh();
  return { refresh };
}

/** Same swatch set the inspector's "Tile selecionado" tint row offers (`inspector.js`'s
 *  `TINTS`) — kept as its own local copy rather than a shared import, since the two rows
 *  serve different callers (a live paint brush vs. one placed tile) and have no reason to
 *  stay identical if either grows independently. */
const BRUSH_TINTS = [0xffffff, 0xe0a64b, 0x7fc98c, 0x9ecbe6, 0xc79bd6];

export function makeAssetBrushBar({ root, editorCanvas }) {
  const rotBtn = iconBtn('rotate-cw', { title: 'Girar o pincel 90°', class: 'ms-btn ms-btn--small', onClick: () => {
    editorCanvas.setBrush({ rot: (editorCanvas.getBrush().rot + 1) & 3 });
    setText(rotLabel, `${editorCanvas.getBrush().rot * 90}°`);
  } });
  const rotLabel = h('span', { class: 'ms-muted' }, '0°');
  const collSelect = h('select', { class: 'ms-select', onChange: (e) => editorCanvas.setBrush({ collision: e.target.value }) },
    COLLISIONS.map((c) => h('option', { value: c }, COLLISION_LABEL[c])));
  const tagInput = h('input', { class: 'ms-field-input', value: 'tallgrass', style: { width: '110px' },
    onChange: (e) => editorCanvas.setBrush({ tag: e.target.value }) });

  const tintRow = h('div', { class: 'ms-tint-row' }, BRUSH_TINTS.map((t, i) => h('div', {
    class: `ms-tint-swatch${i === 0 ? ' ms-tint-swatch--active' : ''}`,
    style: { background: `#${t.toString(16).padStart(6, '0')}` },
    onClick: (e) => {
      editorCanvas.setBrush({ tint: t });
      for (const el of tintRow.children) el.classList.remove('ms-tint-swatch--active');
      e.currentTarget.classList.add('ms-tint-swatch--active');
    },
  })));
  const heightStepInput = h('input', { class: 'ms-field-input', type: 'number', step: '0.05', value: '0.25', style: { width: '56px' },
    onChange: (e) => editorCanvas.setBrush({ heightStep: Number(e.target.value) || 0.25 }) });
  const claimToggle = h('label', { class: 'ms-brush-check', title: 'Marca a célula como ocupada ao pintar' }, [
    h('input', { type: 'checkbox', onChange: (e) => editorCanvas.setBrush({ claimFootprint: e.target.checked }) }),
    h('span', {}, 'Reservar área'),
  ]);
  const keepCollisionToggle = h('label', { class: 'ms-brush-check', title: 'Ao desmarcar, pintar com este tile também aplica a colisão do tile' }, [
    h('input', { type: 'checkbox', checked: true, onChange: (e) => editorCanvas.setBrush({ keepCollision: e.target.checked }) }),
    h('span', {}, 'Preservar colisão'),
  ]);

  const bar = h('div', { class: 'ms-brush-bar' }, [
    h('span', { class: 'ms-eyebrow' }, 'Pincel'), rotBtn, rotLabel,
    h('span', { class: 'ms-eyebrow' }, 'Tint'), tintRow,
    h('span', { class: 'ms-eyebrow' }, 'Colisão'), collSelect,
    h('span', { class: 'ms-eyebrow' }, 'Tag'), tagInput,
    h('span', { class: 'ms-eyebrow' }, 'Passo altura'), heightStepInput,
    claimToggle, keepCollisionToggle,
  ]);
  root.appendChild(bar);
  return bar; // so a caller (main.js: the overlay strip, the preview toggle) can append into the same row
}
