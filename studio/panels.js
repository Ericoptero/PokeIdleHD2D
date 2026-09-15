/**
 * panels.js — the toolbar, tool rail, status bar and brush bar: everything around the canvas
 * that is NOT the inspector (`inspector.js`) or the bottom tab strip (`bottom.js`), which grew
 * large enough to earn their own files.
 */

import { h, setText } from '@/ui/dom/el.js';
import { icon, iconBtn } from './icons.js';
import { TOOLS, COLLISIONS, COLLISION_LABEL } from './kinds.js';
import { runValidation, invalidateValidation } from './validation.js';
import { addRegion } from './tools.js';
import { listStamps, saveStamp, deleteStamp } from './stamps.js';

export function makeToolRail({ root, session }) {
  const buttons = new Map();
  for (const [id, iconName, name, key] of TOOLS) {
    const btn = h('button', { class: 'ms-rail-btn', title: `${name} · ${key}`, onClick: () => setTool(id) },
      [icon(iconName, { size: 17 })]);
    buttons.set(id, btn);
    root.appendChild(btn);
  }
  function setTool(id) {
    session.setTool(id);
    for (const [bid, btn] of buttons) btn.classList.toggle('ms-rail-btn--active', bid === id);
  }
  setTool('select');
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.isContentEditable) return;
    // A modified keystroke is never a bare tool-keybind — without this guard, `main.js`'s
    // Ctrl+C/Ctrl+V clipboard shortcuts (Slice 9a) would ALSO match this table's `coll`/`loop`
    // tool keybinds (`C`/`V`, 4th column below) and silently switch the active tool as an
    // unwanted side effect of every copy/paste — a real collision, not a hypothetical one,
    // caught while wiring up those two shortcuts.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // `e.key` for the spacebar is the literal string ' ', which never matches the rail's
    // display label 'Espaço' — normalize it to the label before comparing.
    const key = e.key === ' ' ? 'Espaço' : e.key;
    const hit = TOOLS.find(([, , , k]) => k.toLowerCase() === key.toLowerCase());
    if (hit) { e.preventDefault(); setTool(hit[0]); }
  });
  return { setTool };
}

export function makeToolbar({ root, doc, history, session, onNew, onOpenPicker, onImport, onExport, onSave, onValidate, onWalkLoop }) {
  const nameBtn = h('button', { class: 'ms-map-badge', onClick: onOpenPicker }, []);
  const nameEl = h('span', { class: 'ms-map-name' }, '—');
  const dirtyDot = h('span', { class: 'ms-dirty-dot', hidden: true });
  nameBtn.append(icon('layers', { size: 14 }), nameEl, dirtyDot, icon('chevron-down', { size: 14 }));

  // A bundled bug fix, found while verifying this slice's own stroke-batched undo: `history.
  // undo()`/`redo()` mutate `doc` directly (every command in `tools.js` does — undo/redo is not
  // routed through `session.applyToolAt`), so nothing here used to tell `session` a change just
  // happened. `refresh()` below only touches THIS toolbar's own buttons/badges — it does not
  // reach `main.js`'s `refreshAll` (bound to `session.subscribe`), so the 3D pane, its overlays
  // and the minimap all silently went stale on every undo/redo, for every tool, not just
  // `sculpt` — confirmed by a real Ctrl+Z smoke test on a sculpt stroke that changed `doc.height`
  // (and moved the entry to the redo list) while the 3D pane kept showing the raised terrain
  // until an unrelated later edit finally notified. `session.notify()`, not `refreshAll()`
  // directly — same reasoning as every other direct `tools.js`-call site in `main.js`.
  const undoBtn = iconBtn('undo-2', { title: 'Desfazer', keybind: 'Ctrl+Z', class: 'ms-toolbtn', onClick: () => { history.undo(); refresh(); session.notify(); } });
  const redoBtn = iconBtn('redo-2', { title: 'Refazer', keybind: 'Ctrl+Shift+Z', class: 'ms-toolbtn', onClick: () => { history.redo(); refresh(); session.notify(); } });
  const errBadge = h('span', { class: 'ms-err-badge' }, '0');

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
    if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); history.undo(); refresh(); session.notify(); }
    else if (e.key.toLowerCase() === 'z' && e.shiftKey) { e.preventDefault(); history.redo(); refresh(); session.notify(); }
  });
  return { refresh };
}

export function makeStatusBar({ root, session, docRef }) {
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
    const hover = session.getHover();
    setText(cellEl, hover ? `célula ${hover.cx}, ${hover.cz}` : (doc ? `${doc.w} × ${doc.h}` : '—'));
    setText(toolEl, `ferramenta: ${session.getTool()}`);
    setText(editsEl, `${session.getEditCount()} edição(ões) nesta sessão`);
    const reach = session.getReachStats();
    setText(reachEl, `${reach.unreachable} célula(s) inalcançável(is)`);
    const v = runValidation(doc);
    setText(errCount, `${v.errors.length} erros`);
    setText(warnCount, `${v.warnings.length} avisos`);
    setText(infoCount, `${v.infos.length} infos`);
    setText(seedEl, doc ? `seed ${doc.seed}` : '—');
  }
  session.subscribe(refresh);
  refresh();
  return { refresh };
}

/** Same swatch set the inspector's "Tile selecionado" tint row offers (`inspector.js`'s
 *  `TINTS`) — kept as its own local copy rather than a shared import, since the two rows
 *  serve different callers (a live paint brush vs. one placed tile) and have no reason to
 *  stay identical if either grows independently. */
const BRUSH_TINTS = [0xffffff, 0xe0a64b, 0x7fc98c, 0x9ecbe6, 0xc79bd6];

/**
 * @param {object} opts
 * @param {() => object[]} opts.getAutotileSets returns the current map's own draft-tileset
 *   autotile sets (`tiles.autotile.sets(doc.tileset)`, via `main.js`'s `preview.autotileSets` —
 *   the viewport's own loaded `tiles` instance is the one seam, see that file's own comment) for
 *   the região "nova região" set picker below. Called lazily, on demand, not once at
 *   construction — `preview` itself only exists once `main.js`'s async `bootViewport` resolves.
 */
export function makeAssetBrushBar({ root, session, docRef, history, getAutotileSets }) {
  const rotBtn = iconBtn('rotate-cw', { title: 'Girar o pincel 90°', class: 'ms-btn ms-btn--small', onClick: () => {
    session.setBrush({ rot: (session.getBrush().rot + 1) & 3 });
    setText(rotLabel, `${session.getBrush().rot * 90}°`);
  } });
  const rotLabel = h('span', { class: 'ms-muted' }, '0°');
  const collSelect = h('select', { class: 'ms-select', onChange: (e) => session.setBrush({ collision: e.target.value }) },
    COLLISIONS.map((c) => h('option', { value: c }, COLLISION_LABEL[c])));
  const tagInput = h('input', { class: 'ms-field-input', value: 'tallgrass', style: { width: '110px' },
    onChange: (e) => session.setBrush({ tag: e.target.value }) });

  const tintRow = h('div', { class: 'ms-tint-row' }, BRUSH_TINTS.map((t, i) => h('div', {
    class: `ms-tint-swatch${i === 0 ? ' ms-tint-swatch--active' : ''}`,
    style: { background: `#${t.toString(16).padStart(6, '0')}` },
    onClick: (e) => {
      session.setBrush({ tint: t });
      for (const el of tintRow.children) el.classList.remove('ms-tint-swatch--active');
      e.currentTarget.classList.add('ms-tint-swatch--active');
    },
  })));
  const heightStepInput = h('input', { class: 'ms-field-input', type: 'number', step: '0.05', value: '0.25', style: { width: '56px' },
    onChange: (e) => session.setBrush({ heightStep: Number(e.target.value) || 0.25 }) });
  const claimToggle = h('label', { class: 'ms-brush-check', title: 'Marca a célula como ocupada ao pintar' }, [
    h('input', { type: 'checkbox', onChange: (e) => session.setBrush({ claimFootprint: e.target.checked }) }),
    h('span', {}, 'Reservar área'),
  ]);
  const keepCollisionToggle = h('label', { class: 'ms-brush-check', title: 'Ao desmarcar, pintar com este tile também aplica a colisão do tile' }, [
    h('input', { type: 'checkbox', checked: true, onChange: (e) => session.setBrush({ keepCollision: e.target.checked }) }),
    h('span', {}, 'Preservar colisão'),
  ]);

  // `sculpt` tool's own controls (Slice 9c) — mode/raio/força for the multi-cell height brush,
  // matching `heightStepInput` right above for the single-cell `height` tool. Rendered
  // unconditionally, same as every other row in this bar (`rotBtn`/`tintRow`/`collSelect`/… are
  // all always visible regardless of which tool is active) rather than only while `sculpt` is
  // selected — this bar has no precedent for tool-conditional visibility, and adding the first
  // one here would be a bigger, unreviewed change than three more always-on controls.
  const sculptModeSelect = h('select', { class: 'ms-select', onChange: (e) => session.setBrush({ sculptMode: e.target.value }) }, [
    h('option', { value: 'raise' }, 'Levantar'),
    h('option', { value: 'lower' }, 'Abaixar'),
    h('option', { value: 'flatten' }, 'Nivelar'),
    h('option', { value: 'smooth' }, 'Suavizar'),
  ]);
  const sculptRadiusInput = h('input', { class: 'ms-field-input', type: 'number', min: '0', max: '12', step: '1', value: '2', style: { width: '48px' },
    onChange: (e) => session.setBrush({ sculptRadius: Math.max(0, Number(e.target.value) || 0) }) });
  const sculptStrengthInput = h('input', { class: 'ms-field-input', type: 'number', min: '0.05', max: '1', step: '0.05', value: '0.25', style: { width: '56px' },
    onChange: (e) => session.setBrush({ sculptStrength: Number(e.target.value) || 0.25 }) });
  // --- região (Slice 9b): which region is ACTIVE — the `region` tool's own create-or-select
  // control. Hidden unless that tool is selected: every OTHER control in this bar stays visible
  // regardless of the active tool (this file's own long-standing convention — rot/tint/collision/
  // tag/height apply whenever their own tool happens to run), but "which region" has no meaning
  // for any other tool, so a dead dropdown would be the odd one out here, not this one.
  //
  // `set` is picked ONCE, right here, at creation time, and never again: `inspector.js`'s own
  // `regionCard` only ever shows it as a read-only field row (`fieldRow('Conjunto (set)',
  // region.set)`) — `layer`/`collision`/`tags` are the fields that card actually lets an author
  // edit afterward (this slice's own plan). Restricted to the map's own DRAFT tileset (`doc.
  // tileset`) — `draft.autotile()` (`src/terrain/draft.js`) only ever resolves against that one
  // tileset's catalog, never an extra layer's; painting a region against a different tileset is
  // out of this slice's scope (`mapfile.js`'s own header on why extras are a separate concept).
  const regionSelect = h('select', { class: 'ms-select', onChange: (e) => session.setActiveRegionId(e.target.value || null) });
  const newRegionSetSelect = h('select', { class: 'ms-select ms-select--tiny' });
  const newRegionBtn = h('button', { class: 'ms-btn ms-btn--small', onClick: () => {
    const doc = docRef.get();
    const set = newRegionSetSelect.value;
    if (!doc || !set) return;
    const region = addRegion(doc, history, { set, layer: session.getActiveLayer(), collision: null, tags: [] });
    // `addRegion`'s own `history.push` already bumped `doc._rev`; this is what tells the section
    // below (and `viewport/overlay.js`'s tool-gated preview) a new region now exists to select.
    session.setActiveRegionId(region.id);
  } }, [icon('plus', { size: 12 }), h('span', {}, 'Nova região')]);
  const regionSection = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
    h('span', { class: 'ms-eyebrow' }, 'Região'), regionSelect,
    h('span', { class: 'ms-eyebrow' }, 'Conjunto'), newRegionSetSelect, newRegionBtn,
  ]);
  function refreshRegionUi() {
    const isRegionTool = session.getTool() === 'region';
    regionSection.hidden = !isRegionTool;
    if (!isRegionTool) return;
    const doc = docRef.get();
    const activeId = session.getActiveRegionId();
    regionSelect.innerHTML = '';
    regionSelect.appendChild(h('option', { value: '' }, doc?.regions.length ? '— selecione —' : '— nenhuma região —'));
    for (const r of doc?.regions ?? []) {
      regionSelect.appendChild(h('option', { value: r.id, selected: r.id === activeId }, `${r.id} · ${r.set}`));
    }
    const sets = getAutotileSets?.() ?? [];
    const prevSet = newRegionSetSelect.value;
    newRegionSetSelect.innerHTML = '';
    for (const s of sets) newRegionSetSelect.appendChild(h('option', { value: s.id, selected: s.id === prevSet }, s.name ?? s.id));
    newRegionBtn.disabled = !doc || !sets.length;
  }
  // Fires on every `session.notify()` — including every región stroke pointermove and, since this
  // slice's own `setTool` change, every tool switch — cheap either way (a handful of `<option>`s).
  session.subscribe(refreshRegionUi);
  refreshRegionUi();

  // --- carimbo/stamp (Slice 9d): pick a SAVED stamp for the `stamp` tool to place, save the
  // current clipboard as a new named one, or delete the picked one — hidden unless that tool is
  // active, same convention as `regionSection` right above. `stamps.js` is a flat, doc-independent
  // localStorage table (never touches `doc`/`history`), so — unlike `newRegionBtn`, which mints a
  // real `doc.regions[]` entry through an undoable `tools.js` command — saving/deleting a stamp
  // is NOT an undo-able document edit; only PLACING one (`session.applyToolAt`'s own `stamp`
  // case) ever touches `history`.
  const stampSelect = h('select', { class: 'ms-select', onChange: (e) => session.setActiveStampName(e.target.value || null) });
  const saveStampBtn = h('button', { class: 'ms-btn ms-btn--small', title: 'Salva o recorte (Ctrl+C/X) atual como um novo carimbo nomeado', onClick: () => {
    const clip = session.getClipboard();
    if (!clip || (!clip.cells.length && !clip.objects.length)) return;
    const name = prompt('Nome do carimbo:');
    if (!name) return;
    saveStamp(name, clip);
    session.setActiveStampName(name);
    refreshStampUi();
  } }, [icon('plus', { size: 12 }), h('span', {}, 'Salvar carimbo')]);
  const deleteStampBtn = h('button', { class: 'ms-btn ms-btn--small ms-btn--warn', title: 'Apaga o carimbo selecionado', onClick: () => {
    const name = session.getActiveStampName();
    if (!name) return;
    deleteStamp(name);
    session.setActiveStampName(null);
    refreshStampUi();
  } }, [icon('trash', { size: 12 })]);
  const stampSection = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
    h('span', { class: 'ms-eyebrow' }, 'Carimbo'), stampSelect, saveStampBtn, deleteStampBtn,
  ]);
  function refreshStampUi() {
    const isStampTool = session.getTool() === 'stamp';
    stampSection.hidden = !isStampTool;
    if (!isStampTool) return;
    const names = listStamps();
    const activeName = session.getActiveStampName();
    stampSelect.innerHTML = '';
    stampSelect.appendChild(h('option', { value: '' }, names.length ? '— selecione —' : '— nenhum carimbo —'));
    for (const n of names) stampSelect.appendChild(h('option', { value: n, selected: n === activeName }, n));
    const clip = session.getClipboard();
    saveStampBtn.disabled = !clip || (!clip.cells.length && !clip.objects.length);
    deleteStampBtn.disabled = !activeName;
  }
  // Same "cheap enough to just rerun" reasoning as `refreshRegionUi` above.
  session.subscribe(refreshStampUi);
  refreshStampUi();

  const bar = h('div', { class: 'ms-brush-bar' }, [
    h('span', { class: 'ms-eyebrow' }, 'Pincel'), rotBtn, rotLabel,
    h('span', { class: 'ms-eyebrow' }, 'Tint'), tintRow,
    h('span', { class: 'ms-eyebrow' }, 'Colisão'), collSelect,
    h('span', { class: 'ms-eyebrow' }, 'Tag'), tagInput,
    h('span', { class: 'ms-eyebrow' }, 'Passo altura'), heightStepInput,
    claimToggle, keepCollisionToggle,
    h('span', { class: 'ms-eyebrow' }, 'Modo escultura'), sculptModeSelect,
    h('span', { class: 'ms-eyebrow' }, 'Raio'), sculptRadiusInput,
    h('span', { class: 'ms-eyebrow' }, 'Força'), sculptStrengthInput,
    regionSection,
    stampSection,
  ]);
  root.appendChild(bar);
  return bar; // so a caller (main.js: the overlay strip, the preview toggle) can append into the same row
}
