/**
 * inspector.js — the right-hand panel: six collapsible cards (map info, selected tile,
 * selected cell, gameplay, camera/environment, light) reading and writing the live document.
 * Moved out of `panels.js`, which was becoming the whole Studio in one file.
 */

import { h } from '@/ui/dom/el.js';
import { icon } from './icons.js';
import { COLLISIONS, COLLISION_LABEL, COLLISION_DOT, DIR_LABEL, WEATHERS } from './kinds.js';
import { peekCatalog, peekSpeciesNames } from './catalog.js';
import {
  setCollision, toggleTag, adjustHeight, setSpawn,
  setCellRotation, setCellTint, updateLight, removeLight,
  setField, setLoopVia, setDefaultCamera, setEconomy,
  updateSpawnPoint, removeSpawnPoint,
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

function section(title, iconName, body) {
  const content = h('div', { class: 'ms-section-body' }, body);
  const chevron = icon('chevron-up', { size: 14 });
  const head = h('div', { class: 'ms-section-head', onClick: () => {
    content.classList.toggle('ms-hidden');
    chevron.replaceWith(icon(content.classList.contains('ms-hidden') ? 'chevron-down' : 'chevron-up', { size: 14 }));
  } }, [icon(iconName, { size: 15 }), h('span', { class: 'ms-section-title' }, title), h('div', { class: 'ms-spacer' }), chevron]);
  return h('div', { class: 'ms-section' }, [head, content]);
}

export function makeInspector({ root, session, docRef, history, onChange }) {
  const body = h('div', { class: 'ms-inspector-body' });
  root.appendChild(body);

  function rebuild() {
    const doc = docRef.get();
    body.innerHTML = '';
    if (!doc) { body.appendChild(h('div', { class: 'ms-empty' }, 'Nenhum mapa aberto')); return; }
    const sel = session.getSelection();
    const set = (key, coerce) => (v) => { setField(doc, history, { key, value: coerce ? coerce(v) : v }); onChange(); };
    const catalog = peekCatalog(doc.tileset);

    body.appendChild(mapInfoCard(doc, set));

    if (sel.lightIndex != null) body.appendChild(lightCard(doc, history, sel.lightIndex, onChange));
    else if (sel.spawnPointIndex != null) body.appendChild(spawnPointCard(doc, history, sel.spawnPointIndex, onChange));
    else if (sel.cell) {
      body.appendChild(tileCard(doc, history, sel, session, catalog, onChange));
      body.appendChild(cellCard(doc, history, sel, session, onChange));
    }

    body.appendChild(gameplayCard(doc, history, onChange));
    body.appendChild(economyCard(doc, history, onChange));
    body.appendChild(cameraCard(doc, history, onChange));
  }

  return { rebuild };
}

function mapInfoCard(doc, set) {
  return section('Informações do mapa', 'map', [
    fieldRow('Map ID', doc.id, set('id')),
    fieldRow('Nome exibido', doc.name, set('name')),
    selectRow('Tipo', doc.kind, ['hunt', 'city', 'interior'], set('kind')),
    fieldRow('Tamanho', `${doc.w} × ${doc.h}`),
    fieldRow('Seed', doc.seed, set('seed', Number)),
    fieldRow('Tileset base', doc.tileset),
    doc.extras?.length ? fieldRow('Tilesets extra', doc.extras.map((e) => e.tileset).join(', ')) : null,
    fieldRow('Nível exigido', doc.requiredLevel, set('requiredLevel', Number)),
    // `mapTags` (`state.js`) — free-form gameplay categories ('cave', 'coastal', …) a ball
    // can key off (`economy/items.js`'s Dive/Dusk Ball) since the map no longer needs to be
    // named after the one biome it happens to look like. Comma-separated in and out, same
    // convention the game's own tag fields use nowhere else in the UI but reads plainly here.
    fieldRow('Tags de jogabilidade', (doc.mapTags ?? []).join(', '),
      (v) => set('mapTags')(v.split(',').map((t) => t.trim()).filter(Boolean))),
  ].filter(Boolean));
}

function tileCard(doc, history, sel, session, catalog, onChange) {
  const { cx, cz } = sel.cell;
  const layer = session.getActiveLayer();
  const grid = doc.tileLayers.get(layer);
  const key = `${cx},${cz}`;
  const cell = sel.objectId != null ? doc.objects.find((o) => o.id === sel.objectId) : grid?.get(key);
  const isObject = sel.objectId != null;
  if (!cell) {
    return section('Tile selecionado', 'square-dashed', [h('div', { class: 'ms-empty' }, 'Nenhum tile na camada ativa nesta célula')]);
  }
  const model = catalog?.byName?.get(cell.m) ?? null;
  const rotBtns = [0, 1, 2, 3].map((r) => h('button', {
    class: `ms-rot-btn${cell.rot === r ? ' ms-rot-btn--active' : ''}`,
    onClick: () => { setCellRotation(doc, history, { layer, cx, cz, rot: r, objectId: sel.objectId }); onChange(); },
  }, `${r * 90}°`));
  const tintSwatches = TINTS.map((t) => h('div', {
    class: `ms-tint-swatch${cell.tint === t ? ' ms-tint-swatch--active' : ''}`,
    style: { background: `#${t.toString(16).padStart(6, '0')}` },
    onClick: () => { setCellTint(doc, history, { layer, cx, cz, tint: t, objectId: sel.objectId }); onChange(); },
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
  ].filter(Boolean));
}

function cellCard(doc, history, sel, session, onChange) {
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

  const tagChips = doc.tags[i].map((t) => h('span', { class: 'ms-tag-chip ms-tag-chip--removable' }, [
    t, h('span', { onClick: () => { toggleTag(doc, history, { cx, cz, tag: t }); onChange(); } }, [icon('close', { size: 10 })]),
  ]));
  const addTag = h('span', { class: 'ms-tag-add', onClick: () => {
    const t = prompt('Nova tag:');
    if (t) { toggleTag(doc, history, { cx, cz, tag: t }); onChange(); }
  } }, '+ tag');

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
    h('div', { class: 'ms-tag-row' }, [...tagChips, addTag]),
    h('div', { class: 'ms-stack-title' }, 'Objetos nesta célula'),
    h('div', { class: 'ms-stack-list' }, stack.length
      ? stack.map((s) => h('div', { class: 'ms-stack-item' }, `${s.kind === 'object' ? 'objeto' : 'tile'} · camada ${s.layer} · ${s.m}`))
      : [h('div', { class: 'ms-stack-item ms-muted' }, 'nada nesta célula')]),
  ].filter(Boolean));
}

function gameplayCard(doc, history, onChange) {
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
    fieldRow('Restrição (nível)', doc.requiredLevel),
    fieldRow('NPCs', doc.npcs.length),
    fieldRow('Portas/links', doc.links.length),
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

/** A wild spawn point — its own respawn timer and its own weighted species list
 *  (`@/terrain/mapfile.js`'s `spawnPoints[]`). Selecting its gizmo in 3D (or its cell in 2D)
 *  brings this card up instead of the generic tile/cell cards. */
function spawnPointCard(doc, history, index, onChange) {
  const point = doc.spawnPoints[index];
  if (!point) return section('Ponto de spawn', 'paw-print', [h('div', { class: 'ms-empty' }, 'ponto removido')]);
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
    h('button', { class: 'ms-btn ms-btn--small ms-btn--danger', onClick: () => { removeSpawnPoint(doc, history, point); onChange(); } },
      [icon('trash', { size: 13 }), h('span', {}, 'Remover ponto de spawn')]),
  ]);
}

function lightCard(doc, history, index, onChange) {
  const l = doc.lights[index];
  const cols = [0xe0a64b, 0xf2d9a8, 0x9ecbe6, 0xc79bd6];
  const sliders = [
    ['Intensidade', 'intensity', 0, 8, 0.1], ['Raio', 'radius', 1, 24, 0.5], ['Brilho visível', 'size', 0.02, 1, 0.02],
  ];
  return section(`Luz #${index}`, 'lightbulb', [
    h('div', { class: 'ms-prop-grid' }, ['x', 'y', 'z'].map((k) => h('div', { class: 'ms-prop-cell' },
      [h('span', { class: 'ms-prop-k' }, k.toUpperCase()), h('span', { class: 'ms-prop-v' }, (l[k] ?? 0).toFixed(1))]))),
    h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, 'Cor'), h('div', { class: 'ms-tint-row' },
      cols.map((c) => h('div', { class: `ms-tint-swatch${l.color === c ? ' ms-tint-swatch--active' : ''}`,
        style: { background: `#${c.toString(16).padStart(6, '0')}` },
        onClick: () => { updateLight(doc, history, { index, patch: { color: c } }); onChange(); } })))]),
    ...sliders.map(([label, key, min, max, step]) => h('div', { class: 'ms-slider-row' }, [
      h('div', { class: 'ms-slider-head' }, [h('span', {}, label), h('span', { class: 'ms-muted' }, (l[key] ?? 0).toFixed(2))]),
      h('input', { type: 'range', min, max, step, value: l[key] ?? 0, class: 'ms-slider',
        onInput: (e) => { updateLight(doc, history, { index, patch: { [key]: Number(e.target.value) } }); onChange(); } }),
    ])),
    h('div', { class: 'ms-field-row' }, [
      h('span', { class: 'ms-field-label' }, 'Point light'),
      h('button', { class: `ms-toggle${l.point !== false ? ' ms-toggle--on' : ''}`,
        onClick: () => { updateLight(doc, history, { index, patch: { point: l.point === false } }); onChange(); } }, [h('div', { class: 'ms-toggle-knob' })]),
    ]),
    h('div', { class: 'ms-field-row' }, [
      h('span', { class: 'ms-field-label' }, 'Poça no chão'),
      h('button', { class: `ms-toggle${l.pool !== false ? ' ms-toggle--on' : ''}`,
        onClick: () => { updateLight(doc, history, { index, patch: { pool: l.pool === false } }); onChange(); } }, [h('div', { class: 'ms-toggle-knob' })]),
    ]),
    h('button', { class: 'ms-btn ms-btn--small ms-btn--danger', onClick: () => { removeLight(doc, history, l); onChange(); } }, [icon('trash', { size: 13 }), h('span', {}, 'Remover luz')]),
  ]);
}
