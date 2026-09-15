/**
 * inspector.js — the right-hand panel: always-on cards (map info, gameplay, economy, camera/
 * environment) plus one entity-specific card driven by the current selection
 * (`session.getSelection()`'s `{cell, kind, ref}` — `session.js`'s own header), reading and
 * writing the live document. Moved out of `panels.js`, which was becoming the whole Studio in
 * one file.
 *
 * The per-kind dispatch (`makeInspector`'s `rebuild()`) is a lookup into `ENTITIES` (a single
 * source of truth shared with `viewport/index.js`'s gizmos and `session.js`'s select-tool hit test —
 * see `entities.js`'s own header), not a hand-written `if (sel.lightIndex != null) ... else if
 * (sel.spawnPointIndex != null) ...` chain — that chain is exactly what made adding one more
 * selectable kind (an NPC's own card, this slice's motivating example) a three-file change
 * before. Every card builder below still reuses this file's own `fieldRow`/`selectRow`/
 * `section` helpers and hand-writes its own irregular editors, matching the file's existing
 * style — a declarative field-schema engine would not fit a weighted species table, a type-
 * >multiplier map, or a marker/inline-waypoint union without becoming its own framework.
 */

import { h } from '@/ui/dom/el.js';
import { icon } from './icons.js';
import { COLLISIONS, COLLISION_LABEL, COLLISION_DOT, DIR_LABEL, WEATHERS, CELL_TAGS, MAP_TAGS } from './kinds.js';
import { peekCatalog, peekSpeciesNames } from './catalog.js';
import { ENTITIES, regionCellCount } from './entities.js';
import {
  setCollision, toggleTag, adjustHeight, setSpawn,
  setCellRotation, setCellTint, updateObject, moveObject, removeObject,
  updateLight, removeLight,
  setField, setLoopVia, setDefaultCamera, setEconomy,
  updateSpawnPoint, removeSpawnPoint,
  updateMarker, removeMarker,
  updateNpc, removeNpc,
  addLink, updateLink, removeLink,
  updateRegion, removeRegion,
  moveLoopWaypoint, removeLoopWaypoint, placeMarker,
  setCameraPreset, removeCameraPreset,
  updateExtraObject, moveExtraObject, removeExtraObject,
} from './tools.js';

const TINTS = [0xffffff, 0xe0a64b, 0x7fc98c, 0x9ecbe6, 0xc79bd6];

/** Field rows: label + value; `onChange` makes it editable, omitted keeps it read-only text. */
function fieldRow(label, value, onChange) {
  const valueEl = onChange
    ? h('input', { class: 'ms-field-input', value: String(value ?? ''), onChange: (e) => onChange(e.target.value) })
    : h('span', { class: 'ms-field-value' }, String(value ?? ''));
  return h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, label), valueEl]);
}

function selectRow(label, value, options, onChange) {
  const sel = h('select', { class: 'ms-select ms-select--row', onChange: (e) => onChange(e.target.value) },
    options.map((o) => h('option', { value: o, selected: o === value }, o)));
  return h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, label), sel]);
}

/** A number-input field row — every new position/size editor below (link/region/loop waypoint/
 *  camera preset/object/extras object) shares this instead of five near-identical hand-rolled
 *  `<input type="number">` blocks. */
function numberRow(label, value, onChange) {
  return h('div', { class: 'ms-field-row' }, [
    h('span', { class: 'ms-field-label' }, label),
    h('input', { class: 'ms-field-input', type: 'number', value: String(value ?? 0), onChange: (e) => onChange(Number(e.target.value) || 0) }),
  ]);
}

function dirRow(label, value, onChange) {
  const btns = DIR_LABEL.map((l, d) => h('button', {
    class: `ms-dir-btn${(value ?? 0) === d ? ' ms-dir-btn--active' : ''}`,
    onClick: () => onChange(d),
  }, l));
  return h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, label), h('div', { class: 'ms-dir-row' }, btns)]);
}

function toggleRow(label, on, onClick) {
  return h('div', { class: 'ms-field-row' }, [
    h('span', { class: 'ms-field-label' }, label),
    h('button', { class: `ms-toggle${on ? ' ms-toggle--on' : ''}`, onClick }, [h('div', { class: 'ms-toggle-knob' })]),
  ]);
}

function removeButton(label, onClick) {
  return h('button', { class: 'ms-btn ms-btn--small ms-btn--danger', onClick }, [icon('trash', { size: 13 }), h('span', {}, label)]);
}

function section(title, iconName, body) {
  const content = h('div', { class: 'ms-section-body' }, body);
  const chevron = icon('chevron-up', { size: 14 });
  const head = h('div', { class: 'ms-section-head', onClick: () => {
    content.classList.toggle('ms-hidden');
    chevron.replaceWith(icon(content.classList.contains('ms-hidden') ? 'chevron-down' : 'chevron-up', { size: 14 }));
  } }, [icon(iconName, { size: 15 }), h('span', { class: 'ms-section-title' }, title), h('div', { class: 'ms-spacer' }), chevron]);
  return h('div', { class: 'ms-section' }, [head, content]);
}

/**
 * @param {{root:HTMLElement, session:object, docRef:{get:() => object|null}, history:object,
 *   onChange:() => void, getGameMaps?:() => {id:string,name:string,kind:string}[]}} opts
 *   `getGameMaps` feeds the link card's destination-map picker — threaded in once from
 *   `main.js`'s own `gameMapsCache` rather than re-fetched per render.
 */
export function makeInspector({ root, session, docRef, history, onChange, getGameMaps }) {
  const body = h('div', { class: 'ms-inspector-body' });
  // Collapse toggle — same technique as `library.js`'s own header strip (a fixed left/right
  // chevron via the core `chevron-down` rotated, `root.classList.toggle` on the panel element
  // passed in directly): the Inspector had no header row at all before this, since every card
  // inside `body` already carries its own collapsible `section()`. This one is for the whole
  // panel, so a card's own collapsed state stays reachable at a glance without opening it back up.
  const collapseIcon = icon('chevron-down', { size: 14 });
  collapseIcon.style.transform = 'rotate(-90deg)'; // points right, toward the outer edge: "collapse"
  const collapseBtn = h('button', { class: 'ms-iconbtn ms-iconbtn--ghost', title: 'Recolher painel', onClick: () => {
    const collapsed = root.classList.toggle('ms-panel--collapsed');
    collapseIcon.style.transform = collapsed ? 'rotate(90deg)' : 'rotate(-90deg)'; // left, back toward the content: "expand"
    collapseBtn.title = collapsed ? 'Expandir painel' : 'Recolher painel';
  } }, [collapseIcon]);
  root.appendChild(h('div', { class: 'ms-lib-row ms-panel-strip' }, [h('span', { class: 'ms-eyebrow' }, 'Propriedades'), collapseBtn]));
  root.appendChild(h('div', { class: 'ms-panel-content' }, [body]));

  function rebuild() {
    const doc = docRef.get();
    body.innerHTML = '';
    if (!doc) { body.appendChild(h('div', { class: 'ms-empty' }, 'Nenhum mapa aberto')); return; }
    const sel = session.getSelection();
    const set = (key, coerce) => (v) => { setField(doc, history, { key, value: coerce ? coerce(v) : v }); onChange(); };
    const catalog = peekCatalog(doc.tileset);
    const ui = { onChange, session, catalog, gameMaps: getGameMaps ? getGameMaps() : [] };

    body.appendChild(mapInfoCard(doc, history, set, onChange));

    // The `coll` tool's own "which kind does it paint" picker — shown whenever that tool is
    // active, independent of the current selection, so this panel stays the ONE place collision
    // is ever chosen (the brush bar used to duplicate this with its own select + a "Preservar
    // colisão" checkbox that quietly let the pencil stamp collision too — both removed).
    if (session.getTool() === 'coll') body.appendChild(collisionBrushCard(session, onChange));

    // One lookup into `ENTITIES` instead of the old `sel.lightIndex != null` / `sel.
    // spawnPointIndex != null` chain — `sel.kind` is `null` for a bare cell (the ordinary
    // `select`-tool click-on-empty-ground case) or for a kind with nothing to show beyond the
    // cell itself (`spawn` — see `entities.js`'s own note on why it has no `inspect`).
    const entity = sel.kind ? ENTITIES[sel.kind] : null;
    if (entity?.inspect) {
      body.appendChild(entity.inspect(doc, history, sel.ref, ui));
    } else if (sel.cell) {
      body.appendChild(tileCard(doc, history, sel, ui));
      body.appendChild(cellCard(doc, history, sel, ui));
    }

    body.appendChild(gameplayCard(doc, history, sel, onChange));
    body.appendChild(economyCard(doc, history, onChange));
    body.appendChild(cameraCard(doc, history, onChange));
  }

  return { rebuild };
}

/** `doc.mapTags` (`state.js`) — map-wide gameplay categories, DISTINCT from a cell's own
 *  `doc.tags[i]` (`cellCard` below) despite the similar name; see `state.js`'s own header on why
 *  they are two unrelated arrays. Chip-editable, same removable-chip pattern `regionCard` already
 *  uses, fed by `kinds.js`'s `MAP_TAGS` shortlist so the two ball bonuses that actually key off
 *  this field are a click away instead of typed blind into a bare comma-separated string. */
function mapTagsRow(doc, history, onChange) {
  const tags = doc.mapTags ?? [];
  const setTags = (next) => { setField(doc, history, { key: 'mapTags', value: next }); onChange(); };
  const known = (t) => MAP_TAGS.find(([tag]) => tag === t);
  const chips = tags.map((t) => h('span', { class: 'ms-tag-chip ms-tag-chip--removable', title: known(t)?.[2] ?? '' }, [
    t, h('span', { onClick: () => setTags(tags.filter((x) => x !== t)) }, [icon('close', { size: 10 })]),
  ]));
  const addSelect = h('select', { class: 'ms-select ms-select--tiny', title: 'Tags conhecidas e seu efeito',
    onChange: (e) => {
      if (!e.target.value || tags.includes(e.target.value)) return;
      setTags([...tags, e.target.value]);
      e.target.value = '';
    } }, [
    h('option', { value: '' }, '— tag conhecida —'),
    ...MAP_TAGS.filter(([tag]) => !tags.includes(tag)).map(([tag, label, effect]) => h('option', { value: tag, title: effect }, `${label} (${tag})`)),
  ]);
  const addCustom = h('span', { class: 'ms-tag-add', onClick: () => {
    const t = prompt('Nova tag do mapa:');
    if (t && !tags.includes(t.trim())) setTags([...tags, t.trim()]);
  } }, '+ outra');
  return [
    h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, 'Tags do mapa'), addSelect]),
    h('div', { class: 'ms-tag-row' }, [...chips, addCustom]),
    h('div', { class: 'ms-hint-line' }, 'cave → Dusk Ball ×3 · coastal → Dive Ball ×3.5. Uma tag sem efeito conhecido não faz nada hoje.'),
  ];
}

function mapInfoCard(doc, history, set, onChange) {
  return section('Informações do mapa', 'map', [
    fieldRow('Map ID', doc.id, set('id')),
    fieldRow('Nome exibido', doc.name, set('name')),
    selectRow('Tipo', doc.kind, ['hunt', 'city', 'interior'], set('kind')),
    fieldRow('Tamanho', `${doc.w} × ${doc.h}`),
    fieldRow('Seed', doc.seed, set('seed', Number)),
    fieldRow('Tileset base', doc.tileset),
    doc.extras?.length ? fieldRow('Tilesets extra', doc.extras.map((e) => e.tileset).join(', ')) : null,
    fieldRow('Nível exigido', doc.requiredLevel, set('requiredLevel', Number)),
    ...mapTagsRow(doc, history, onChange),
  ].filter(Boolean));
}

/**
 * The selected tile OR object's card — `ENTITIES.object.inspect` is a thin wrapper around this
 * exact function (see `entities.js`), so it doubles as the "object" entity's own card and as
 * half of the bare-cell fallback pair (`sel.kind` unset/unhandled, `sel.cell` set) `makeInspector`
 * renders directly. `sel.kind === 'object'` reads the object via `sel.ref` (the real
 * `doc.objects` element); anything else reads the active layer's grid `Map` by cell key.
 */
export function tileCard(doc, history, sel, ui) {
  const { session, catalog, onChange } = ui;
  const { cx, cz } = sel.cell;
  const layer = session.getActiveLayer();
  const grid = doc.tileLayers.get(layer);
  const key = `${cx},${cz}`;
  const isObject = sel.kind === 'object';
  const cell = isObject ? sel.ref : grid?.get(key);
  if (!cell) {
    return section('Tile selecionado', 'square-dashed', [h('div', { class: 'ms-empty' }, 'Nenhum tile na camada ativa nesta célula')]);
  }
  const model = catalog?.byName?.get(cell.m) ?? null;
  const rotBtns = [0, 1, 2, 3].map((r) => h('button', {
    class: `ms-rot-btn${cell.rot === r ? ' ms-rot-btn--active' : ''}`,
    onClick: () => {
      if (isObject) updateObject(doc, history, { object: cell, patch: { rot: r } });
      else setCellRotation(doc, history, { layer, cx, cz, rot: r });
      onChange();
    },
  }, `${r * 90}°`));
  const tintSwatches = TINTS.map((t) => h('div', {
    class: `ms-tint-swatch${cell.tint === t ? ' ms-tint-swatch--active' : ''}`,
    style: { background: `#${t.toString(16).padStart(6, '0')}` },
    onClick: () => {
      if (isObject) updateObject(doc, history, { object: cell, patch: { tint: t } });
      else setCellTint(doc, history, { layer, cx, cz, tint: t });
      onChange();
    },
  }));
  return section('Tile selecionado', 'square-dashed', [
    h('div', { class: 'ms-detail-row' }, [
      h('div', { class: 'ms-detail-swatch', style: { backgroundColor: '#3a3128' } }),
      h('div', { class: 'ms-detail-text' }, [
        h('div', { class: 'ms-detail-name' }, cell.m),
        h('div', { class: 'ms-detail-id' }, `${isObject ? 'objeto' : 'tile'} · camada ${layer}`),
      ]),
    ]),
    model ? h('div', { class: 'ms-prop-grid' }, [
      ['Categoria', model.category ?? '—'], ['Subcat.', model.subcategory ?? '—'],
      ['Tamanho', `${model.w ?? 1}×${model.h ?? 1}`], ['Colisão', model.collision ?? '—'],
      ['Orientação', model.orientation ?? '—'], ['Elev. base', (model.baseY ?? 0).toFixed(2)],
      ['Autotile', model.autotile ? `${model.autotile.set} · ${model.autotile.name}` : '—'],
    ].map(([k, v]) => h('div', { class: 'ms-prop-cell' }, [h('span', { class: 'ms-prop-k' }, k), h('span', { class: 'ms-prop-v' }, String(v))]))) : null,
    h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, 'Rotação'), h('div', { class: 'ms-rot-row' }, rotBtns)]),
    h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, 'Tint'), h('div', { class: 'ms-tint-row' }, tintSwatches)]),
    // Position/layer editing — new: an object could not be repositioned from the inspector
    // before (only placed, or moved by re-placing). A grid tile has no equivalent: its cell
    // IS its identity in the `Map`, so "moving" one is paint-elsewhere, not an edit.
    isObject ? numberRow('CX', cell.cx, (v) => { moveObject(doc, history, { object: cell, cx: v, cz: cell.cz }); onChange(); }) : null,
    isObject ? numberRow('CZ', cell.cz, (v) => { moveObject(doc, history, { object: cell, cx: cell.cx, cz: v }); onChange(); }) : null,
    isObject ? numberRow('Camada', cell.layer ?? 0, (v) => { updateObject(doc, history, { object: cell, patch: { layer: v } }); onChange(); }) : null,
    isObject ? removeButton('Remover objeto', () => { removeObject(doc, history, cell); onChange(); }) : null,
  ].filter(Boolean));
}

/** The `coll` tool's active kind — same chip markup `cellCard`'s own `collisionChips` renders
 *  below, bound to the BRUSH (`session.getBrush().collision`/`setBrush`) instead of a selected
 *  cell, since this shows regardless of what (if anything) is selected. */
function collisionBrushCard(session, onChange) {
  const active = session.getBrush().collision;
  const chips = COLLISIONS.map((c) => h('button', {
    class: `ms-coll-chip${active === c ? ' ms-coll-chip--active' : ''}`,
    onClick: () => { session.setBrush({ collision: c }); onChange(); },
  }, [h('span', { class: 'ms-coll-dot', style: { background: COLLISION_DOT[c] } }), COLLISION_LABEL[c]]));
  return section('Colisão (ferramenta ativa)', 'ban', [
    h('div', { class: 'ms-hint-line' }, 'Clique numa célula na prévia 3D para pintar com esta colisão.'),
    h('div', { class: 'ms-coll-grid' }, chips),
  ]);
}

function cellCard(doc, history, sel, ui) {
  const { session, onChange } = ui;
  const { cx, cz } = sel.cell;
  const i = cz * doc.w + cx;
  const stack = session.stackAtSelection();
  const currentCollision = doc.collision[i];
  const collisionChips = COLLISIONS.map((c) => h('button', {
    class: `ms-coll-chip${currentCollision === c ? ' ms-coll-chip--active' : ''}`,
    onClick: () => { setCollision(doc, history, { cx, cz, kind: c }); onChange(); },
  }, [h('span', { class: 'ms-coll-dot', style: { background: COLLISION_DOT[c] } }), COLLISION_LABEL[c]]));

  const ledgeDir = doc.tags[i].find((t) => t.startsWith('ledge:'));
  const ledgeSection = currentCollision === 'ledge' ? h('div', { class: 'ms-ledge-row' }, [
    icon('chevrons-up', { size: 14 }),
    h('span', {}, 'Direção do salto'),
    h('div', { class: 'ms-spacer' }),
    ...DIR_LABEL.map((label, d) => h('button', {
      class: `ms-dir-btn${ledgeDir === `ledge:${d}` ? ' ms-dir-btn--active' : ''}`,
      onClick: () => {
        for (const t of doc.tags[i].filter((x) => x.startsWith('ledge:'))) toggleTag(doc, history, { cx, cz, tag: t });
        toggleTag(doc, history, { cx, cz, tag: `ledge:${d}` });
        onChange();
      },
    }, label)),
  ]) : null;

  // `CELL_TAGS` (`kinds.js`) — the known-effect shortlist; a known tag's chip carries its effect
  // as a tooltip instead of leaving it to tribal knowledge. Any other tag (typed via "+ outra")
  // is still accepted and round-trips fine — it simply does nothing at runtime today.
  const known = (t) => CELL_TAGS.find(([tag]) => tag === t);
  const tagChips = doc.tags[i].map((t) => h('span', { class: 'ms-tag-chip ms-tag-chip--removable', title: known(t)?.[2] ?? 'Tag sem efeito conhecido' }, [
    t, h('span', { onClick: () => { toggleTag(doc, history, { cx, cz, tag: t }); onChange(); } }, [icon('close', { size: 10 })]),
  ]));
  const addKnownSelect = h('select', { class: 'ms-select ms-select--tiny', title: 'Tags conhecidas e seu efeito',
    onChange: (e) => {
      if (!e.target.value) return;
      toggleTag(doc, history, { cx, cz, tag: e.target.value });
      onChange();
      e.target.value = '';
    } }, [
    h('option', { value: '' }, '— tag conhecida —'),
    ...CELL_TAGS.filter(([tag]) => !doc.tags[i].includes(tag)).map(([tag, label, effect]) => h('option', { value: tag, title: effect }, `${label} (${tag})`)),
  ]);
  const addTag = h('span', { class: 'ms-tag-add', onClick: () => {
    const t = prompt('Nova tag:');
    if (t) { toggleTag(doc, history, { cx, cz, tag: t }); onChange(); }
  } }, '+ outra');

  return section('Propriedades da célula', 'square', [
    h('div', { class: 'ms-coll-grid' }, collisionChips),
    ledgeSection,
    h('div', { class: 'ms-prop-grid' }, [
      ['Altura', doc.height[i].toFixed(2)],
      ['Ocupada', doc.occupied[i] ? 'sim' : 'não'],
    ].map(([k, v]) => h('div', { class: 'ms-prop-cell' }, [h('span', { class: 'ms-prop-k' }, k), h('span', { class: 'ms-prop-v' }, v)]))),
    h('div', { class: 'ms-field-row' }, [
      h('span', { class: 'ms-field-label' }, 'Ajustar altura'),
      h('button', { class: 'ms-btn ms-btn--small', onClick: () => { adjustHeight(doc, history, { cx, cz, delta: -0.25 }); onChange(); } }, '−0.25'),
      h('button', { class: 'ms-btn ms-btn--small', onClick: () => { adjustHeight(doc, history, { cx, cz, delta: 0.25 }); onChange(); } }, '+0.25'),
    ]),
    h('div', { class: 'ms-stack-title' }, 'Tags da célula'),
    h('div', { class: 'ms-tag-row' }, [...tagChips, addKnownSelect, addTag]),
    h('div', { class: 'ms-stack-title' }, 'Objetos nesta célula'),
    h('div', { class: 'ms-stack-list' }, stack.length
      ? stack.map((s) => h('div', { class: 'ms-stack-item' }, `${s.kind === 'object' ? 'objeto' : 'tile'} · camada ${s.layer} · ${s.m}`))
      : [h('div', { class: 'ms-stack-item ms-muted' }, 'nada nesta célula')]),
  ].filter(Boolean));
}

function gameplayCard(doc, history, sel, onChange) {
  const dirBtns = DIR_LABEL.map((label, d) => h('button', {
    class: `ms-dir-btn${doc.spawn.dir === d ? ' ms-dir-btn--active' : ''}`,
    onClick: () => { setSpawn(doc, history, { cx: doc.spawn.cx, cz: doc.spawn.cz, dir: d }); onChange(); },
  }, label));
  const via = doc.loop?.via ?? [];
  // A `via` entry is either a marker name (unchanged, shown as-is) or an inline `{cx,cz}`
  // waypoint placed with the `loop` tool (no name to show, so it renders as its coordinates).
  const viaChips = via.map((entry, i) => h('span', { class: 'ms-tag-chip ms-tag-chip--removable' }, [
    typeof entry === 'string' ? entry : `(${entry.cx},${entry.cz})`,
    h('span', { onClick: () => { setLoopVia(doc, history, { via: via.filter((_, k) => k !== i) }); onChange(); } }, [icon('close', { size: 10 })]),
  ]));
  const addVia = h('select', { class: 'ms-select', onChange: (e) => {
    if (!e.target.value) return;
    setLoopVia(doc, history, { via: [...via, e.target.value] });
    onChange(); e.target.value = '';
  } }, [h('option', { value: '' }, '+ marcador'), ...doc.markers.map((m) => h('option', { value: m.name }, m.name))]);

  return section('Jogabilidade do mapa', 'gamepad-2', [
    fieldRow('Spawn', `${doc.spawn.cx}, ${doc.spawn.cz}`),
    h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, 'Virado para'), h('div', { class: 'ms-dir-row' }, dirBtns)]),
    fieldRow('Cabeça da fila', doc.formation?.head ?? '—'),
    fieldRow('Pontos de spawn', doc.spawnPoints.length),
    h('div', { class: 'ms-field-row' }, [
      h('span', { class: 'ms-field-label' }, 'Portas/links'),
      h('span', { class: 'ms-field-value' }, String(doc.links.length)),
      // A minimal "add link" entry point — the rest of this slice makes an EXISTING link
      // selectable/editable/removable (`ENTITIES.link`); building a full placement tool/gizmo
      // flow is explicitly out of scope, but a blank link anchored at the current selection (or
      // the map center, with none) costs one button and closes the loop on this slice's own
      // headline example ("a city's entrance to another map").
      h('button', { class: 'ms-btn ms-btn--small', onClick: () => {
        const cx = sel.cell?.cx ?? (doc.w >> 1);
        const cz = sel.cell?.cz ?? (doc.h >> 1);
        addLink(doc, history, { id: `link-${doc.links.length}-${Date.now().toString(36)}`, kind: 'door', from: { cx, cz }, to: { map: '', dir: 0 } });
        onChange();
      } }, [icon('plus', { size: 12 }), h('span', {}, 'link')]),
    ]),
    fieldRow('Restrição (nível)', doc.requiredLevel),
    fieldRow('NPCs', doc.npcs.length),
    h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, 'Loop (via)'), addVia]),
    h('div', { class: 'ms-tag-row' }, viaChips),
  ]);
}

function cameraCard(doc, history, onChange) {
  const weatherBtns = WEATHERS.map(([name, iconName]) => h('button', {
    class: `ms-weather-btn${doc.weather?.[0] === name ? ' ms-weather-btn--active' : ''}`,
    onClick: () => { setField(doc, history, { key: 'weather', value: name === 'Limpo' ? null : [name, 0.5] }); onChange(); },
  }, [icon(iconName, { size: 15 }), h('span', {}, name)]));
  const presets = Object.entries(doc.cameras?.presets ?? {});
  return section('Câmera e ambiente', 'camera', [
    h('div', { class: 'ms-hint-line' }, 'Hora do dia e zoom são estado da prévia 3D (acima) — aqui é o dado salvo no mapa.'),
    h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, 'Clima'), h('div', { class: 'ms-weather-row' }, weatherBtns)]),
    fieldRow('Preset ambiente', doc.environmentPreset, (v) => { setField(doc, history, { key: 'environmentPreset', value: v }); onChange(); }),
    fieldRow('Pitch (fixo)', '45°'),
    presets.length ? h('div', { class: 'ms-cam-grid' }, presets.map(([name, p]) => h('div', {
      class: `ms-cam-card${doc.cameras.default === name ? ' ms-cam-card--active' : ''}`,
      onClick: () => { setDefaultCamera(doc, history, { name }); onChange(); },
    }, [h('span', { class: 'ms-cam-name' }, name), h('span', { class: 'ms-cam-meta' }, p.marker ? `${p.marker} · ${p.ppu}px/u` : `${p.cx},${p.cz}`)]))) : null,
  ].filter(Boolean));
}

/** The map's own yield-multiplier profile (`@/terrain/mapfile.js`'s `economy`) — `idle/
 *  accrual.js` reads this off `terrain.handle().economy` instead of picking a fixed biome. */
function economyCard(doc, history, onChange) {
  const eco = doc.economy;
  const set = (key) => (v) => {
    const value = Math.max(0, Number(v) || 0);
    setEconomy(doc, history, { economy: { ...eco, [key]: value } });
    onChange();
  };
  const num = (label, key) => h('div', { class: 'ms-field-row' }, [
    h('span', { class: 'ms-field-label' }, label),
    h('input', { class: 'ms-field-input', type: 'number', step: '0.05', min: '0', value: String(eco[key] ?? 1), onChange: (e) => set(key)(e.target.value) }),
  ]);
  const favours = Object.entries(eco.favours ?? {});
  const favourChips = favours.map(([type, mult]) => h('span', { class: 'ms-tag-chip ms-tag-chip--removable' }, [
    `${type} ×${mult}`,
    h('span', { onClick: () => {
      const next = { ...eco.favours }; delete next[type];
      setEconomy(doc, history, { economy: { ...eco, favours: next } }); onChange();
    } }, [icon('close', { size: 10 })]),
  ]));
  const addFavour = h('button', { class: 'ms-btn ms-btn--small', onClick: () => {
    const type = prompt('Tipo (ex: grass):');
    if (!type) return;
    const mult = Number(prompt('Multiplicador (ex: 1.3):', '1.2')) || 1;
    setEconomy(doc, history, { economy: { ...eco, favours: { ...eco.favours, [type.trim().toLowerCase()]: mult } } });
    onChange();
  } }, '+ favorecimento');

  return section('Economia do mapa', 'coins', [
    h('div', { class: 'ms-hint-line' }, 'Multiplicadores de produção por segundo — substitui o antigo catálogo fixo de biomas.'),
    num('Dinheiro', 'money'), num('Experiência', 'exp'), num('Pesquisa', 'research'), num('Encontros', 'encounters'),
    h('div', { class: 'ms-stack-title' }, 'Favorecimento por tipo'),
    h('div', { class: 'ms-tag-row' }, [...favourChips, addFavour]),
  ]);
}

/** A marker — editable `name` (new: renaming used to mean delete-and-re-place), a read-only
 *  position readout (moved via its gizmo drag, matching today), and a read-only dump of
 *  whatever else a shipped marker happens to carry (`demo-city.map.json`'s markers have `kind`/
 *  `plot`/`cell`/`head` — nothing in `src/` reads these today, so they are shown, not silently
 *  hidden, rather than given a full editor). */
export function markerCard(doc, history, marker, ui) {
  const { onChange } = ui;
  const extras = Object.entries(marker).filter(([k]) => !['name', 'cx', 'cz'].includes(k));
  return section('Marcador', 'map-pin', [
    fieldRow('Nome', marker.name, (v) => { updateMarker(doc, history, { marker, patch: { name: v.trim() || marker.name } }); onChange(); }),
    fieldRow('Posição', `${marker.cx}, ${marker.cz}`),
    extras.length ? h('div', { class: 'ms-stack-title' }, 'Outros campos') : null,
    ...extras.map(([k, v]) => fieldRow(k, typeof v === 'object' ? JSON.stringify(v) : v)),
    removeButton('Remover marcador', () => { removeMarker(doc, history, marker); onChange(); }),
  ].filter(Boolean));
}

/** An NPC — the field set mirrors `openAddNpcDialog`'s exact choice (name/kind/id/display/dir/
 *  route/solid), plus `shiny` (only meaningful for a wild `species` NPC, not a `trainer` one —
 *  `terrain/populate.js` reads it straight into `pokemon.sprites.prepare`/`sim.spawnNpc`). */
export function npcCard(doc, history, npc, ui) {
  const { onChange } = ui;
  const isTrainer = npc.trainer != null;
  const set = (patch) => { updateNpc(doc, history, { npc, patch }); onChange(); };
  return section('NPC', 'paw-print', [
    fieldRow('Nome', npc.name, (v) => set({ name: v.trim() || npc.name })),
    h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, 'Tipo'), h('div', { class: 'ms-weather-row' }, [
      h('button', { class: `ms-weather-btn${!isTrainer ? ' ms-weather-btn--active' : ''}`,
        onClick: () => set({ species: npc.species ?? npc.trainer ?? '', trainer: undefined }) }, 'Pokémon selvagem'),
      h('button', { class: `ms-weather-btn${isTrainer ? ' ms-weather-btn--active' : ''}`,
        onClick: () => set({ trainer: npc.trainer ?? npc.species ?? '', species: undefined }) }, 'Trainer'),
    ])]),
    fieldRow(isTrainer ? 'ID do trainer' : 'Espécie', isTrainer ? npc.trainer : npc.species,
      (v) => set(isTrainer ? { trainer: v.trim() } : { species: v.trim() })),
    fieldRow('Nome de exibição', npc.display ?? '', (v) => set({ display: v.trim() || undefined })),
    dirRow('Direção', npc.dir, (d) => set({ dir: d })),
    fieldRow('Rota', npc.route ?? '', (v) => set({ route: v.trim() || undefined })),
    toggleRow('Sólido (bloqueia a célula)', !!npc.solid, () => set({ solid: !npc.solid || undefined })),
    !isTrainer ? toggleRow('Shiny', !!npc.shiny, () => set({ shiny: !npc.shiny || undefined })) : null,
    removeButton('Remover NPC', () => { removeNpc(doc, history, npc); onChange(); }),
  ].filter(Boolean));
}

export function lightCard(doc, history, light, ui) {
  const { onChange } = ui;
  const l = light;
  const cols = [0xe0a64b, 0xf2d9a8, 0x9ecbe6, 0xc79bd6];
  const sliders = [
    ['Intensidade', 'intensity', 0, 8, 0.1], ['Raio', 'radius', 1, 24, 0.5], ['Brilho visível', 'size', 0.02, 1, 0.02],
  ];
  return section(`Luz${l.id ? ` · ${l.id}` : ''}`, 'lightbulb', [
    h('div', { class: 'ms-prop-grid' }, ['x', 'y', 'z'].map((k) => h('div', { class: 'ms-prop-cell' },
      [h('span', { class: 'ms-prop-k' }, k.toUpperCase()), h('span', { class: 'ms-prop-v' }, (l[k] ?? 0).toFixed(1))]))),
    h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, 'Cor'), h('div', { class: 'ms-tint-row' },
      cols.map((c) => h('div', { class: `ms-tint-swatch${l.color === c ? ' ms-tint-swatch--active' : ''}`,
        style: { background: `#${c.toString(16).padStart(6, '0')}` },
        onClick: () => { updateLight(doc, history, { light, patch: { color: c } }); onChange(); } })))]),
    ...sliders.map(([label, key, min, max, step]) => h('div', { class: 'ms-slider-row' }, [
      h('div', { class: 'ms-slider-head' }, [h('span', {}, label), h('span', { class: 'ms-muted' }, (l[key] ?? 0).toFixed(2))]),
      h('input', { type: 'range', min, max, step, value: l[key] ?? 0, class: 'ms-slider',
        onInput: (e) => { updateLight(doc, history, { light, patch: { [key]: Number(e.target.value) } }); onChange(); } }),
    ])),
    toggleRow('Point light', l.point !== false, () => { updateLight(doc, history, { light, patch: { point: l.point === false } }); onChange(); }),
    toggleRow('Poça no chão', l.pool !== false, () => { updateLight(doc, history, { light, patch: { pool: l.pool === false } }); onChange(); }),
    removeButton('Remover luz', () => { removeLight(doc, history, light); onChange(); }),
  ]);
}

/** A wild spawn point — its own respawn timer and its own weighted species list
 *  (`@/terrain/mapfile.js`'s `spawnPoints[]`). Selecting its gizmo in 3D (or its cell in 2D)
 *  brings this card up instead of the generic tile/cell cards. */
export function spawnPointCard(doc, history, point, ui) {
  const { onChange } = ui;
  const names = peekSpeciesNames();

  const speciesRows = (point.species ?? []).map((row, i) => {
    const setRow = (patch) => {
      const species = point.species.map((r, k) => (k === i ? { ...r, ...patch } : r));
      updateSpawnPoint(doc, history, { point, patch: { species } });
      onChange();
    };
    const removeRow = () => {
      const species = point.species.filter((_, k) => k !== i);
      updateSpawnPoint(doc, history, { point, patch: { species } });
      onChange();
    };
    const known = !names || names.has(row.name);
    return h('div', { class: 'ms-field-row' }, [
      h('input', {
        class: `ms-field-input${known ? '' : ' ms-field-input--invalid'}`, value: row.name, style: { flex: '2' },
        onChange: (e) => setRow({ name: e.target.value.trim() }),
      }),
      h('input', {
        class: 'ms-field-input', type: 'number', min: '0', step: '1', value: String(row.chance ?? 1),
        title: 'chance (peso relativo)', onChange: (e) => setRow({ chance: Math.max(0, Number(e.target.value) || 0) }),
      }),
      h('select', { class: 'ms-select', onChange: (e) => setRow({ when: e.target.value || undefined }) },
        ['any', 'morning', 'day', 'night'].map((w) => h('option', { value: w === 'any' ? '' : w, selected: (row.when ?? 'any') === w }, w))),
      h('button', { class: 'ms-iconbtn ms-iconbtn--ghost', onClick: removeRow }, [icon('close', { size: 12 })]),
    ]);
  });
  const addRow = h('button', { class: 'ms-btn ms-btn--small', onClick: () => {
    const species = [...(point.species ?? []), { name: '', chance: 10 }];
    updateSpawnPoint(doc, history, { point, patch: { species } });
    onChange();
  } }, [icon('plus', { size: 12 }), h('span', {}, 'espécie')]);

  return section('Ponto de spawn', 'paw-print', [
    fieldRow('Posição', `${point.cx}, ${point.cz}`),
    h('div', { class: 'ms-field-row' }, [
      h('span', { class: 'ms-field-label' }, 'Reaparecimento (s)'),
      h('input', {
        class: 'ms-field-input', type: 'number', min: '1', step: '1', value: String(point.respawnSeconds ?? 26),
        onChange: (e) => { updateSpawnPoint(doc, history, { point, patch: { respawnSeconds: Math.max(1, Number(e.target.value) || 26) } }); onChange(); },
      }),
    ]),
    h('div', { class: 'ms-stack-title' }, 'Espécies (peso relativo decide qual aparece)'),
    ...speciesRows,
    addRow,
    removeButton('Remover ponto de spawn', () => { removeSpawnPoint(doc, history, point); onChange(); }),
  ]);
}

/** A map-to-map link/door — the literal answer to "the entrance of city to the other map".
 *  `to.map` picks from `ui.gameMaps` when the list is available (falls back to a free-text
 *  field so an unsaved/renamed map id can still be typed by hand). */
export function linkCard(doc, history, link, ui) {
  const { onChange, gameMaps = [] } = ui;
  const setPatch = (patch) => { updateLink(doc, history, { link, patch }); onChange(); };
  const mapOptions = gameMaps.map((m) => m.id);
  return section('Link (porta para outro mapa)', 'door-open', [
    fieldRow('ID', link.id),
    selectRow('Tipo', link.kind ?? 'door', ['door', 'edge', 'stairs'], (v) => setPatch({ kind: v })),
    numberRow('De · CX', link.from?.cx, (v) => setPatch({ from: { cx: v, cz: link.from?.cz ?? 0 } })),
    numberRow('De · CZ', link.from?.cz, (v) => setPatch({ from: { cx: link.from?.cx ?? 0, cz: v } })),
    mapOptions.length
      ? selectRow('Mapa de destino', link.to?.map ?? '', mapOptions.includes(link.to?.map) ? mapOptions : [link.to?.map ?? '', ...mapOptions], (v) => setPatch({ to: { map: v } }))
      : fieldRow('Mapa de destino', link.to?.map ?? '', (v) => setPatch({ to: { map: v.trim() } })),
    fieldRow('Marcador de destino', link.to?.marker ?? '', (v) => setPatch({ to: { marker: v.trim() || undefined } })),
    numberRow('Para · CX (sem marcador)', link.to?.cx ?? 0, (v) => setPatch({ to: { cx: v } })),
    numberRow('Para · CZ (sem marcador)', link.to?.cz ?? 0, (v) => setPatch({ to: { cz: v } })),
    dirRow('Direção de chegada', link.to?.dir, (d) => setPatch({ to: { dir: d } })),
    fieldRow('Rótulo', link.label ?? '', (v) => setPatch({ label: v.trim() || undefined })),
    removeButton('Remover link', () => { removeLink(doc, history, link); onChange(); }),
  ]);
}

/** An authored autotile region — `set`/`mask` stay read-only here (picking a set and painting a
 *  mask are the paint tool's job, a later slice); this card only edits the metadata around an
 *  already-authored one. */
export function regionCard(doc, history, region, ui) {
  const { onChange } = ui;
  const cellCount = regionCellCount(doc, region);
  const setPatch = (patch) => { updateRegion(doc, history, { region, patch }); onChange(); };
  const tagChips = (region.tags ?? []).map((t) => h('span', { class: 'ms-tag-chip ms-tag-chip--removable' }, [
    t, h('span', { onClick: () => setPatch({ tags: (region.tags ?? []).filter((x) => x !== t) }) }, [icon('close', { size: 10 })]),
  ]));
  const addTag = h('span', { class: 'ms-tag-add', onClick: () => {
    const t = prompt('Nova tag:');
    if (t) setPatch({ tags: [...(region.tags ?? []), t] });
  } }, '+ tag');
  const collisionSelect = h('select', { class: 'ms-select ms-select--row', onChange: (e) => setPatch({ collision: e.target.value || undefined }) }, [
    h('option', { value: '', selected: !region.collision }, '— nenhuma —'),
    ...COLLISIONS.map((c) => h('option', { value: c, selected: region.collision === c }, COLLISION_LABEL[c])),
  ]);
  return section('Região (autotile)', 'route', [
    fieldRow('ID', region.id),
    fieldRow('Conjunto (set)', region.set),
    numberRow('Camada', region.layer ?? 0, (v) => setPatch({ layer: v })),
    h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, 'Colisão'), collisionSelect]),
    h('div', { class: 'ms-tag-row' }, [...tagChips, addTag]),
    fieldRow('Células na máscara', cellCount),
    removeButton('Remover região', () => { removeRegion(doc, history, region); onChange(); }),
  ]);
}

/** One INLINE loop waypoint (`ref = {index, entry}` — see `entities.js`'s own header on why
 *  `index` is the entry's position in the FULL `via` array). "Converter em marcador" is two
 *  undo steps (`placeMarker` then `setLoopVia`), not one atomic command — both are already
 *  independent, well-tested primitives, and a bespoke combined command for one UI action was
 *  not judged worth the extra surface; Ctrl+Z twice undoes it cleanly either way. */
export function loopWaypointCard(doc, history, ref, ui) {
  const { onChange } = ui;
  const { index, entry } = ref;
  return section('Waypoint do loop', 'route', [
    numberRow('CX', entry.cx, (v) => { moveLoopWaypoint(doc, history, { index, cx: v, cz: entry.cz }); onChange(); }),
    numberRow('CZ', entry.cz, (v) => { moveLoopWaypoint(doc, history, { index, cx: entry.cx, cz: v }); onChange(); }),
    h('button', { class: 'ms-btn ms-btn--small', onClick: () => {
      const name = prompt('Nome do marcador:');
      if (!name) return;
      placeMarker(doc, history, { name, cx: entry.cx, cz: entry.cz });
      const via = doc.loop?.via ?? [];
      setLoopVia(doc, history, { via: via.map((e, i) => (i === index ? name : e)) });
      onChange();
    } }, [icon('map-pin', { size: 13 }), h('span', {}, 'Converter em marcador')]),
    removeButton('Remover da rota', () => { removeLoopWaypoint(doc, history, { index }); onChange(); }),
  ]);
}

/** A camera preset — either shape (`{marker, ppu}` or `{cx, cz}`) stays editable; the toggle
 *  button switches which one is authoritative, clearing the other shape's keys
 *  (`setCameraPreset`'s delete-aware merge) so a saved file never carries both. */
export function cameraPresetCard(doc, history, ref, ui) {
  const { onChange } = ui;
  const { name, preset } = ref;
  const isMarkerMode = preset.marker != null;
  const setPatch = (patch) => { setCameraPreset(doc, history, { name, patch }); onChange(); };
  return section(`Câmera · ${name}`, 'camera', [
    fieldRow('Nome', name),
    h('button', { class: 'ms-btn ms-btn--small', onClick: () => {
      if (isMarkerMode) setPatch({ marker: undefined, ppu: undefined, cx: preset.cx ?? doc.spawn.cx, cz: preset.cz ?? doc.spawn.cz });
      else setPatch({ cx: undefined, cz: undefined, marker: preset.marker ?? '', ppu: preset.ppu ?? 64 });
    } }, isMarkerMode ? 'Usar célula' : 'Usar marcador'),
    isMarkerMode
      ? fieldRow('Marcador', preset.marker, (v) => setPatch({ marker: v.trim() || preset.marker }))
      : h('div', {}, [numberRow('CX', preset.cx ?? 0, (v) => setPatch({ cx: v })), numberRow('CZ', preset.cz ?? 0, (v) => setPatch({ cz: v }))]),
    isMarkerMode ? numberRow('px/unidade', preset.ppu ?? 64, (v) => setPatch({ ppu: v })) : null,
    h('button', { class: `ms-btn ms-btn--small${doc.cameras.default === name ? ' ms-btn--primary' : ''}`,
      onClick: () => { setDefaultCamera(doc, history, { name }); onChange(); } }, 'Definir como padrão'),
    // TODO(later slice): a "definir a partir da vista atual" button needs a live camera-state
    // getter threaded down from `main.js`'s `preview` — lazily booted on first non-"edit" view,
    // i.e. constructed AFTER this inspector already exists, so wiring it here cleanly is its own
    // small plumbing task. Skipped rather than hacked together; everything else this card needs
    // (editing an existing preset's position/ppu, setting default, removing) does not depend on
    // the 3D pane being open at all.
    removeButton('Remover câmera', () => { removeCameraPreset(doc, history, { name }); onChange(); }),
  ].filter(Boolean));
}

/** One extras-layer object (`ref = {extraIndex, object}`) — a different tileset per layer, no
 *  live catalog swap in this slice, so model/tileset stay read-only; rot/tint/position are
 *  editable, matching a regular object's own card. */
export function extraObjectCard(doc, history, ref, ui) {
  const { onChange } = ui;
  const { extraIndex, object } = ref;
  const extra = doc.extras[extraIndex];
  const setPatch = (patch) => { updateExtraObject(doc, history, { object, patch }); onChange(); };
  const rotBtns = [0, 1, 2, 3].map((r) => h('button', {
    class: `ms-rot-btn${(object.rot ?? 0) === r ? ' ms-rot-btn--active' : ''}`,
    onClick: () => setPatch({ rot: r }),
  }, `${r * 90}°`));
  const tintSwatches = TINTS.map((t) => h('div', {
    class: `ms-tint-swatch${(object.tint ?? 0xffffff) === t ? ' ms-tint-swatch--active' : ''}`,
    style: { background: `#${t.toString(16).padStart(6, '0')}` },
    onClick: () => setPatch({ tint: t }),
  }));
  return section('Objeto extra', 'box', [
    fieldRow('Modelo', object.m),
    fieldRow('Tileset', extra?.tileset ?? '—'),
    h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, 'Rotação'), h('div', { class: 'ms-rot-row' }, rotBtns)]),
    h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, 'Tint'), h('div', { class: 'ms-tint-row' }, tintSwatches)]),
    numberRow('CX', object.cx, (v) => { moveExtraObject(doc, history, { extraIndex, object, cx: v, cz: object.cz }); onChange(); }),
    numberRow('CZ', object.cz, (v) => { moveExtraObject(doc, history, { extraIndex, object, cx: object.cx, cz: v }); onChange(); }),
    removeButton('Remover objeto extra', () => { removeExtraObject(doc, history, { extraIndex, object }); onChange(); }),
  ]);
}
