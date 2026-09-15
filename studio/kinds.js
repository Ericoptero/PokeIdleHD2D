/**
 * kinds.js — shared vocabulary tables (collision kinds, overlays, directions) the toolbar,
 * canvas and inspector all need. De-dupes what used to be two independent copies:
 * `COLLISION_COLOR` in `canvas.js` and `COLLISIONS`/`COLLISION_LABEL` in `panels.js`.
 */

/** The eight collision kinds `MapDraft` recognizes (`src/terrain/draft.js`), in the order the
 *  UI presents them. */
export const COLLISIONS = ['walk', 'block', 'water', 'shallow', 'stairs', 'door', 'ledge', 'none'];

export const COLLISION_LABEL = {
  walk: 'Andável', block: 'Bloqueio', water: 'Água', shallow: 'Rasa',
  stairs: 'Escada', door: 'Porta', ledge: 'Degrau', none: 'Nenhuma',
};

/** `studio/icons.js` names — closest Lucide meaning per kind. */
export const COLLISION_ICON = {
  walk: 'footprints', block: 'ban', water: 'droplet', shallow: 'droplet',
  stairs: 'chevrons-up', door: 'door-open', ledge: 'route', none: 'square-dashed',
};

/** A solid dot colour per kind — used on collision chips and cell-stack rows. */
export const COLLISION_DOT = {
  walk: '#7FC98C', block: '#D6685B', water: '#5FA8DC', shallow: '#9ECBE6',
  door: '#E0A64B', stairs: '#B28EDC', ledge: '#E29650', none: '#8F8579',
};

/** The overlay tint painted across a cell when the "Colisão" overlay is on
 *  (`studio/canvas.js`'s render loop) — moved here verbatim, unchanged. */
export const COLLISION_COLOR = {
  walk: 'rgba(127,201,140,0.0)', block: 'rgba(214,104,91,0.38)', water: 'rgba(95,168,220,0.40)',
  shallow: 'rgba(158,203,230,0.30)', door: 'rgba(224,166,75,0.42)', stairs: 'rgba(178,142,220,0.42)',
  ledge: 'rgba(226,150,80,0.46)', none: 'rgba(255,255,255,0.05)',
};

/** `core/dir.js`: south=0, west=1, north=2, east=3 — fixed forever, saves and sprite sheets
 *  index by these. */
export const DIR_LABEL = ['S', 'O', 'N', 'L'];
export const DIR_NAME = ['sul', 'oeste', 'norte', 'leste'];

/**
 * The four overlays with a real 3D implementation (`studio/viewport/overlay.js`) — `[id, label,
 * icon, dotColor]`. `main.js`'s `buildOverlayStrip` calls `session.toggleOverlay(id)` for each.
 *
 * Slice 7 deleted `studio/canvas.js` (the 2D edit canvas) and, with it, eight of the twelve
 * overlays that table used to draw — not moved elsewhere, actually gone, for three different
 * reasons:
 *  - `textures` is a non-concept once 2D is gone: a 3D placement always shows its real material,
 *    there is nothing left to toggle.
 *  - `markers`/`cameras`/`encounters` each already render as an always-visible 3D gizmo,
 *    unconditionally (`entities.js`'s `ENTITIES` table, wired into `viewport/index.js`'s
 *    `rebuildGizmos` in an earlier slice) — a deliberate difference from the old 2D behavior,
 *    which DID gate marker/camera-preset/spawn-point visibility behind these three toggles. An
 *    always-visible manipulator handle is the same convention any 3D editor uses; gating it
 *    behind an overlay toggle here would be the odd choice, not the safe default.
 *  - `height`/`tags`/`footprints`/`lights` are real overlays with no 3D port yet — genuinely
 *    deferred, not dropped; see `viewport/overlay.js`'s own header for what's left and why.
 */
export const OVERLAYS = [
  ['grid', 'Grade', 'grid-3x3', '#F2EBE0'],
  ['collision', 'Colisão', 'ban', '#D6685B'],
  ['loop', 'Loop', 'route', '#F2EBE0'],
  ['reach', 'Alcance', 'crosshair', '#7FC98C'],
];

/** The tools `studio/session.js` dispatches (`applyToolAt`) — `[id, icon, label, keybind]`.
 *  `rect` and `boxselect` are the two exceptions: a two-corner drag has no single-cell meaning,
 *  so each is its own gesture in `main.js`'s 3D pointer routing (`paintRect` / `rectSelection`,
 *  `tools.js`) rather than a case in `applyToolAt`'s switch — see that file's own comments where
 *  it handles each of them specially. `A` for "Área" (`boxselect`): every plain letter that reads
 *  as "select" is already taken (`S` is the `select` tool itself), and `A` is otherwise unclaimed
 *  on this table.
 *
 *  Carimbo/stamp, Altura (single-cell), Esculpir altura, Tag and Região autotile (Slices 9b–9d)
 *  were removed from the rail as authoring surface the game does not need: height is now an
 *  editable field on the cell's own properties (`inspector.js`'s `cellCard`) rather than a brush,
 *  and the others either duplicated a card already reachable another way (a marker: `bottom.js`'s
 *  own "+ marcador" button) or added a gesture with no matching need (carimbo/tag/região). Their
 *  data — `doc.height`, `doc.tags`, `doc.regions[]`, markers — and every command that still
 *  legitimately writes to it (`toggleTag`, `placeMarker`, the autotile replay) are unaffected;
 *  only the paint-stroke gestures are gone. */
export const TOOLS = [
  ['select', 'mouse-pointer-2', 'Selecionar', 'S'],
  ['boxselect', 'square-dashed', 'Selecionar área', 'A'],
  ['pencil', 'pencil', 'Lápis', 'B'],
  ['eraser', 'eraser', 'Borracha', 'E'],
  ['rect', 'square-dashed', 'Retângulo', 'U'],
  ['fill', 'paint-bucket', 'Balde', 'F'],
  ['object', 'box', 'Objeto', 'O'],
  ['coll', 'ban', 'Colisão', 'C'],
  ['spawn', 'flag', 'Spawn', 'P'],
  ['npc', 'paw-print', 'NPC', 'N'],
  ['light', 'lightbulb', 'Luz', 'L'],
  // `footprints`, not `paw-print` — the `npc` tool already owns that glyph on this same rail.
  ['wildslot', 'footprints', 'Vaga selvagem', 'W'],
  // Click appends an anonymous `{cx,cz}` waypoint to `doc.loop.via`. The deleted 2D canvas used
  // to let a click-and-drag on an existing inline waypoint reposition it instead of adding a
  // new one; that gesture has no 3D-pane replacement yet (`entities.js`'s `loopWaypoint` kind
  // has no `moveTo` — a later slice's viewport work), so repositioning one today goes through
  // its own inspector card's CX/CZ fields once selected, not a drag.
  ['loop', 'route', 'Loop', 'V'],
  ['eyedrop', 'pipette', 'Conta-gotas', 'I'],
  ['pan', 'hand', 'Mover vista', 'Espaço'],
];

export const WEATHERS = [
  ['Limpo', 'sun'], ['Chuva', 'cloud-rain'], ['Névoa', 'cloud-fog'], ['Neve', 'snowflake'],
];

/**
 * Per-cell tags (`doc.tags[]` / `grid.tags`, `state.js`) with a real, verified runtime effect —
 * `[tag, label, effect]`. The brush bar's tag picker and the inspector's cell-tag card both read
 * this instead of leaving "which tag does what" to tribal knowledge; a cell can still carry any
 * other free-form tag typed by hand (`toggleTag`, `tools.js`), this is only the known-effect
 * shortlist. `ledge:0..3` is not here — it already has its own dedicated direction UI
 * (`inspector.js`'s ledge row) rather than being typed as a plain tag.
 */
export const CELL_TAGS = [
  ['tallgrass', 'Grama alta', 'Ativa encontros selvagens (66% de chance) — src/encounter/index.js'],
  ['counter', 'Balcão', 'Cura a equipe ao interagir — Centro Pokémon (src/pokecenter/index.js)'],
  ['path', 'Caminho', 'NPCs e o loop de caça preferem passar por aqui (routing)'],
];

/**
 * Map-wide gameplay tags (`doc.mapTags[]` / top-level `map.tags`, `state.js`) with a real,
 * verified runtime effect — `[tag, label, effect]`. Distinct from `CELL_TAGS` above: these
 * describe the whole map, not one cell, and only a ball's bonus in `economy/items.js` reads them.
 */
export const MAP_TAGS = [
  ['cave', 'Caverna', 'Dusk Ball: ×3 de efetividade — economy/items.js'],
  ['coastal', 'Costeira', 'Dive Ball: ×3.5 de efetividade — economy/items.js'],
];
