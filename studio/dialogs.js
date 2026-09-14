/**
 * dialogs.js — the new-map modal (3 templates), the always-visible map picker popover, and
 * the validation drawer. Moved out of `main.js`, which was building these inline.
 */

import { h } from '@/ui/dom/el.js';
import { icon } from './icons.js';
import { createBlankDocument } from './state.js';
import { runValidation, issueRow } from './validation.js';
import { loadCatalog } from './catalog.js';
import { DIR_LABEL } from './kinds.js';

/** Every token in `@/ui/css/tokens.css` is scoped to `#ui-dom` (never `:root`), and these
 *  dialogs render on top of the app rather than inside its normal layout flow — appending to
 *  `document.body` would put them OUTSIDE that scope and every `var(--c-*)` would resolve to
 *  nothing. Mounting under the Studio's own root instead keeps the theme in scope. */
function studioRoot() { return document.getElementById('ui-dom') ?? document.body; }

const TEMPLATES = [
  { kind: 'city', name: 'Cidade', icon: 'layers', tileset: 'sylvan-town', biome: 'town', w: 48, h: 48,
    bullets: ['Colisão inicial andável', 'Módulo city', 'Preset de ambiente urbano'] },
  { kind: 'hunt', name: 'Caça', icon: 'paw-print', tileset: 'bw2-adastra', biome: 'meadow', w: 64, h: 60,
    bullets: ['Colisão inicial andável', 'Módulo hunts', 'Loop e vagas selvagens esperados'] },
  { kind: 'interior', name: 'Interior', icon: 'door-open', tileset: 'pt-house-indoor', biome: 'interior', w: 13, h: 10,
    bullets: ['Colisão inicial andável', 'Sem módulo de mundo', 'Luzes internas'] },
];

function field(label, input) {
  return h('div', { class: 'ms-field-row' }, [h('span', { class: 'ms-field-label' }, label), input]);
}

export function openNewMapDialog({ onCreate, hasUnsaved }) {
  let selected = TEMPLATES[1]; // hunt — the most common map to author
  const idInput = h('input', { class: 'ms-field-input', value: 'novo_mapa' });
  const nameInput = h('input', { class: 'ms-field-input', value: 'Novo Mapa' });
  const wInput = h('input', { class: 'ms-field-input', value: String(selected.w) });
  const hInput = h('input', { class: 'ms-field-input', value: String(selected.h) });
  const biomeInput = h('input', { class: 'ms-field-input', value: selected.biome });
  const tilesetInput = h('input', { class: 'ms-field-input', value: selected.tileset });
  const groundSelect = h('select', { class: 'ms-select' }, [h('option', { value: '' }, '—')]);
  const seedInput = h('input', { class: 'ms-field-input', value: '1337' });

  async function refreshGroundOptions() {
    groundSelect.innerHTML = '';
    groundSelect.appendChild(h('option', { value: '' }, '—'));
    try {
      const cat = await loadCatalog(tilesetInput.value.trim());
      for (const m of cat.models.filter((m2) => m2.category === 'ground')) groundSelect.appendChild(h('option', { value: m.name }, m.name));
    } catch { /* tileset typed by hand may not exist yet — leave the list empty */ }
  }
  refreshGroundOptions();
  tilesetInput.addEventListener('change', refreshGroundOptions);

  const cardChecks = new Map();
  const cards = TEMPLATES.map((t) => {
    const check = icon('check', { size: 15 });
    check.classList.toggle('ms-hidden', t !== selected);
    cardChecks.set(t, check);
    const card = h('div', { class: `ms-template-card${t === selected ? ' ms-template-card--sel' : ''}` }, [
      h('div', { class: 'ms-template-art' }, [icon(t.icon, { size: 22 })]),
      h('div', { class: 'ms-template-head' }, [h('span', {}, t.name), check]),
      h('div', { class: 'ms-template-bullets' }, t.bullets.map((b) => h('div', { class: 'ms-template-bullet' }, b))),
    ]);
    card.onclick = () => {
      selected = t;
      // A template sets the fields it owns (biome/tileset/size); it never touches the name,
      // id or seed the admin may already have typed.
      biomeInput.value = t.biome; tilesetInput.value = t.tileset;
      wInput.value = String(t.w); hInput.value = String(t.h);
      refreshGroundOptions();
      for (const [tpl, c] of cardChecks) c.classList.toggle('ms-hidden', tpl !== selected);
      for (const c of cards) c.classList.toggle('ms-template-card--sel', c === card);
    };
    return card;
  });

  const dialog = h('div', { class: 'ms-modal-scrim' }, [
    h('div', { class: 'ms-modal ms-modal--wide' }, [
      h('div', { class: 'ms-modal-head' }, [icon('file-plus', { size: 18 }), h('div', { class: 'ms-modal-head-text' }, [
        h('span', {}, 'Novo mapa'), h('span', { class: 'ms-modal-sub' }, 'o modelo define colisão, formação e ambiente iniciais'),
      ]), h('button', { class: 'ms-iconbtn', onClick: () => dialog.remove() }, [icon('close', { size: 16 })])]),
      h('div', { class: 'ms-modal-body' }, [
        h('div', { class: 'ms-template-grid' }, cards),
        h('div', { class: 'ms-field-grid' }, [
          field('Nome do mapa', nameInput), field('Map ID', idInput),
          field('Largura', wInput), field('Altura', hInput),
          field('Bioma', biomeInput), field('Tileset primário', tilesetInput),
          field('Tile de solo', groundSelect), field('Seed', seedInput),
        ]),
      ]),
      h('div', { class: 'ms-modal-foot' }, [
        hasUnsaved ? h('span', { class: 'ms-hint-line' }, 'o mapa atual tem alterações não salvas') : h('div', { class: 'ms-spacer' }),
        h('button', { class: 'ms-btn', onClick: () => dialog.remove() }, 'Cancelar'),
        h('button', { class: 'ms-btn ms-btn--primary', onClick: () => {
          const doc = createBlankDocument({
            id: idInput.value.trim() || 'novo_mapa', name: nameInput.value.trim() || 'Novo Mapa',
            w: Math.max(4, Number(wInput.value) || selected.w), h: Math.max(4, Number(hInput.value) || selected.h),
            tileset: tilesetInput.value.trim() || selected.tileset, biome: biomeInput.value.trim() || selected.biome,
            kind: selected.kind, groundModel: groundSelect.value || null,
          });
          doc.seed = Number(seedInput.value) || 1337;
          onCreate(doc);
          dialog.remove();
        } }, [icon('plus', { size: 15 }), h('span', {}, 'Criar mapa')]),
      ]),
    ]),
  ]);
  studioRoot().appendChild(dialog);
}

/**
 * The `npc` tool's placement form — a trainer or a wild Pokémon, at the cell the tool was
 * clicked on. `tools.js`'s `addNpc` is undo-wired already; this is only the missing UI in
 * front of it (the Objetos tab's empty state has claimed one existed since the Studio shipped).
 */
export function openAddNpcDialog({ cx, cz, onCreate }) {
  const kindSel = h('select', { class: 'ms-select' }, [
    h('option', { value: 'species' }, 'Pokémon selvagem'), h('option', { value: 'trainer' }, 'Trainer'),
  ]);
  const idInput = h('input', { class: 'ms-field-input', placeholder: 'ex.: pikachu ou hero' });
  const nameInput = h('input', { class: 'ms-field-input', placeholder: '(opcional) nome de exibição' });
  const dirSelect = h('select', { class: 'ms-select' }, DIR_LABEL.map((label, d) => h('option', { value: d }, label)));
  const routeInput = h('input', { class: 'ms-field-input', placeholder: '(opcional) rota, ex.: e3 w3' });
  // Off by default — a decorative walker (the common case: city's wildlife/pedestrians) should
  // not block the tile it stands on. `src/pokecenter/index.js`'s nurse is the counter-example
  // that needs this on, which is exactly why it is a per-NPC choice and not a fixed default.
  const solidCheck = h('input', { type: 'checkbox' });
  const dialog = h('div', { class: 'ms-modal-scrim' }, [
    h('div', { class: 'ms-modal' }, [
      h('div', { class: 'ms-modal-head' }, [icon('paw-print', { size: 18 }),
        h('div', { class: 'ms-modal-head-text' }, [h('span', {}, 'Novo NPC'), h('span', { class: 'ms-modal-sub' }, `célula ${cx}, ${cz}`)]),
        h('button', { class: 'ms-iconbtn', onClick: () => dialog.remove() }, [icon('close', { size: 16 })])]),
      h('div', { class: 'ms-modal-body' }, [
        field('Tipo', kindSel), field('Espécie / ID do trainer', idInput), field('Nome de exibição', nameInput),
        field('Direção', dirSelect), field('Rota', routeInput),
        h('label', { class: 'ms-brush-check' }, [solidCheck, h('span', {}, 'Sólido (bloqueia a célula)')]),
      ]),
      h('div', { class: 'ms-modal-foot' }, [
        h('div', { class: 'ms-spacer' }),
        h('button', { class: 'ms-btn', onClick: () => dialog.remove() }, 'Cancelar'),
        h('button', { class: 'ms-btn ms-btn--primary', onClick: () => {
          const id = idInput.value.trim();
          if (!id) return;
          const npc = { name: nameInput.value.trim() || id, cx, cz, dir: Number(dirSelect.value) || 0 };
          if (kindSel.value === 'trainer') npc.trainer = id; else npc.species = id;
          if (routeInput.value.trim()) npc.route = routeInput.value.trim();
          if (solidCheck.checked) npc.solid = true;
          onCreate(npc);
          dialog.remove();
        } }, [icon('plus', { size: 15 }), h('span', {}, 'Criar NPC')]),
      ]),
    ]),
  ]);
  studioRoot().appendChild(dialog);
}

/** The `light` tool's placement form — a point light at the cell the tool was clicked on,
 *  the same fields the inspector's "Luz #N" card edits after the fact. */
export function openAddLightDialog({ cx, cz, onCreate }) {
  const colorInput = h('input', { type: 'color', value: '#e0a64b' });
  const intensityInput = h('input', { class: 'ms-field-input', type: 'number', step: '0.1', value: '2' });
  const radiusInput = h('input', { class: 'ms-field-input', type: 'number', step: '0.5', value: '8' });
  const sizeInput = h('input', { class: 'ms-field-input', type: 'number', step: '0.02', value: '0.3' });
  const dialog = h('div', { class: 'ms-modal-scrim' }, [
    h('div', { class: 'ms-modal' }, [
      h('div', { class: 'ms-modal-head' }, [icon('lightbulb', { size: 18 }),
        h('div', { class: 'ms-modal-head-text' }, [h('span', {}, 'Nova luz'), h('span', { class: 'ms-modal-sub' }, `célula ${cx}, ${cz}`)]),
        h('button', { class: 'ms-iconbtn', onClick: () => dialog.remove() }, [icon('close', { size: 16 })])]),
      h('div', { class: 'ms-modal-body' }, [
        field('Cor', colorInput), field('Intensidade', intensityInput), field('Raio', radiusInput), field('Brilho visível', sizeInput),
      ]),
      h('div', { class: 'ms-modal-foot' }, [
        h('div', { class: 'ms-spacer' }),
        h('button', { class: 'ms-btn', onClick: () => dialog.remove() }, 'Cancelar'),
        h('button', { class: 'ms-btn ms-btn--primary', onClick: () => {
          onCreate({
            x: cx + 0.5, y: 1, z: cz + 0.5,
            color: parseInt(colorInput.value.slice(1), 16) || 0xe0a64b,
            intensity: Number(intensityInput.value) || 2,
            radius: Number(radiusInput.value) || 8,
            size: Number(sizeInput.value) || 0.3,
          });
          dialog.remove();
        } }, [icon('plus', { size: 15 }), h('span', {}, 'Criar luz')]),
      ]),
    ]),
  ]);
  studioRoot().appendChild(dialog);
}

/**
 * The always-visible map picker: a popover anchored under the toolbar's map-name badge
 * (`anchor`), not a full-screen modal — one click from anywhere in the editor.
 */
export function makeMapPicker({ anchor, getMaps, getCurrentId, onPick, hasUnsaved }) {
  let pop = null;
  function close() { pop?.remove(); pop = null; document.removeEventListener('pointerdown', onOutside, true); }
  function onOutside(e) { if (pop && !pop.contains(e.target) && e.target !== anchor) close(); }

  function open() {
    if (pop) { close(); return; }
    const maps = getMaps();
    const currentId = getCurrentId();
    const search = h('input', { class: 'ms-search', placeholder: 'Buscar mapa…' });
    const list = h('div', { class: 'ms-picker-list' });
    function renderList() {
      list.innerHTML = '';
      const q = search.value.toLowerCase();
      const groups = { city: 'Cidades', hunt: 'Caças', interior: 'Interiores' };
      for (const kind of ['city', 'hunt', 'interior']) {
        const rows = maps.filter((m) => m.kind === kind && (!q || m.name.toLowerCase().includes(q) || m.id.includes(q)));
        if (!rows.length) continue;
        list.appendChild(h('div', { class: 'ms-picker-group' }, groups[kind]));
        for (const m of rows) {
          list.appendChild(h('div', { class: `ms-picker-row${m.id === currentId ? ' ms-picker-row--current' : ''}`, onClick: () => pick(m) }, [
            m.id === currentId ? icon('check', { size: 13 }) : h('span', { style: { width: '13px' } }),
            h('div', { class: 'ms-picker-text' }, [h('span', {}, m.name), h('span', { class: 'ms-muted' }, `${m.id} · ${m.w}×${m.h} · ${m.kind}`)]),
          ]));
        }
      }
      if (!list.children.length) list.appendChild(h('div', { class: 'ms-empty' }, maps.length ? 'nenhum resultado' : 'nenhum mapa exportado ainda — rode "node tools/mapstudio/snapshot.js"'));
    }
    function pick(m) {
      if (hasUnsaved() && !confirm(`Descartar alterações não salvas e abrir "${m.name}"?`)) return;
      close();
      onPick(m.id);
    }
    search.addEventListener('input', renderList);
    renderList();
    pop = h('div', { class: 'ms-picker-pop' }, [search, list]);
    studioRoot().appendChild(pop);
    // `position:fixed` from the anchor's own rect — no assumption that an ancestor is a
    // positioning context, and it survives the toolbar clipping/scrolling.
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.round(r.left)}px`;
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  }
  return { open, close, toggle: () => (pop ? close() : open()) };
}

export function makeValidationDrawer({ docRef, editorCanvas, onRevalidate }) {
  let scrim = null;
  function close() { scrim?.remove(); scrim = null; }
  function open() {
    if (scrim) { rebuild(); return; }
    scrim = h('div', { class: 'ms-modal-scrim ms-modal-scrim--right' });
    studioRoot().appendChild(scrim);
    rebuild();
    scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(); });
  }
  function rebuild() {
    if (!scrim) return;
    const doc = docRef.get();
    const v = runValidation(doc, { force: true });
    const onFocus = (cx, cz) => editorCanvas.setSelection({ cell: { cx, cz } });
    scrim.innerHTML = '';
    scrim.appendChild(h('div', { class: 'ms-drawer' }, [
      h('div', { class: 'ms-drawer-head' }, [
        icon('list-checks', { size: 18 }), h('span', { class: 'ms-drawer-title' }, 'Validação do mapa'),
        h('span', { class: 'ms-muted' }, `${v.ms?.toFixed(0) ?? 0} ms`),
        h('button', { class: 'ms-iconbtn', onClick: close }, [icon('close', { size: 16 })]),
      ]),
      h('div', { class: 'ms-drawer-summary' }, [
        h('div', { class: 'ms-summary-card ms-summary-card--err' }, [h('span', { class: 'ms-summary-n' }, String(v.errors.length)), h('span', {}, 'Erros')]),
        h('div', { class: 'ms-summary-card ms-summary-card--warn' }, [h('span', { class: 'ms-summary-n' }, String(v.warnings.length)), h('span', {}, 'Avisos')]),
        h('div', { class: 'ms-summary-card ms-summary-card--info' }, [h('span', { class: 'ms-summary-n' }, String(v.infos.length)), h('span', {}, 'Informações')]),
      ]),
      h('div', { class: 'ms-drawer-body' }, [
        v.errors.length ? h('div', { class: 'ms-drawer-group' }, [h('div', { class: 'ms-drawer-group-head ms-drawer-group-head--err' }, [icon('circle-alert', { size: 14 }), 'Erros']), ...v.errors.map((i) => issueRow({ ...i, severity: 'error' }, { onFocus }))]) : null,
        v.warnings.length ? h('div', { class: 'ms-drawer-group' }, [h('div', { class: 'ms-drawer-group-head ms-drawer-group-head--warn' }, [icon('triangle-alert', { size: 14 }), 'Avisos']), ...v.warnings.map((i) => issueRow({ ...i, severity: 'warn' }, { onFocus }))]) : null,
        v.infos.length ? h('div', { class: 'ms-drawer-group' }, [h('div', { class: 'ms-drawer-group-head ms-drawer-group-head--info' }, [icon('info', { size: 14 }), 'Informações']), ...v.infos.map((i) => issueRow({ ...i, severity: 'info' }, { onFocus }))]) : null,
        v.skipped.length ? h('div', { class: 'ms-hint-line' }, `Não avaliadas sem contexto: ${v.skipped.join(', ')}`) : null,
      ].filter(Boolean)),
      h('div', { class: 'ms-drawer-foot' }, [
        h('button', { class: 'ms-btn', onClick: () => { onRevalidate?.(); rebuild(); } }, [icon('refresh-cw', { size: 14 }), h('span', {}, 'Validar de novo')]),
        h('span', { class: 'ms-muted' }, 'clicar num item foca a célula'),
      ]),
    ]));
  }
  return { open, close, rebuild };
}
