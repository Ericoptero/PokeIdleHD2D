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
 * The 12 overlays `studio/canvas.js` already knows how to draw (`grid` through `reach`, plus
 * `textures`) — `[id, label, icon, dotColor]`. `makeOverlayStrip` (net-new) is the first UI
 * that actually calls `editorCanvas.toggleOverlay(id)` for each of these; the render branches
 * themselves already existed.
 */
export const OVERLAYS = [
  ['grid', 'Grade', 'grid-3x3', '#F2EBE0'],
  ['textures', 'Texturas', 'image', '#CFC4B7'],
  ['collision', 'Colisão', 'ban', '#D6685B'],
  ['height', 'Altura', 'mountain', '#E0A64B'],
  ['tags', 'Tags', 'tag', '#9ECBE6'],
  ['footprints', 'Pegadas', 'footprints', '#E0A64B'],
  ['markers', 'Marcadores', 'map-pin', '#7FC98C'],
  ['cameras', 'Câmeras', 'camera', '#E0A64B'],
  ['loop', 'Loop', 'route', '#F2EBE0'],
  ['encounters', 'Encontros', 'paw-print', '#E38FB0'],
  ['lights', 'Luzes', 'lightbulb', '#E29650'],
  ['reach', 'Alcance', 'crosshair', '#7FC98C'],
];

/** The 13 tools `studio/canvas.js` dispatches (`applyToolAt`) — `[id, icon, label, keybind]`. */
export const TOOLS = [
  ['select', 'mouse-pointer-2', 'Selecionar', 'S'],
  ['pencil', 'pencil', 'Lápis', 'B'],
  ['eraser', 'eraser', 'Borracha', 'E'],
  ['rect', 'square-dashed', 'Retângulo', 'U'],
  ['fill', 'paint-bucket', 'Balde', 'F'],
  ['object', 'box', 'Objeto', 'O'],
  ['height', 'mountain', 'Altura', 'H'],
  ['coll', 'ban', 'Colisão', 'C'],
  ['tag', 'tag', 'Tag', 'T'],
  ['marker', 'map-pin', 'Marcador', 'M'],
  ['spawn', 'flag', 'Spawn', 'P'],
  ['eyedrop', 'pipette', 'Conta-gotas', 'I'],
  ['pan', 'hand', 'Mover vista', 'Espaço'],
];

export const WEATHERS = [
  ['Limpo', 'sun'], ['Chuva', 'cloud-rain'], ['Névoa', 'cloud-fog'], ['Neve', 'snowflake'],
];
