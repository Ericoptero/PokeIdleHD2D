/**
 * entities.js — the single source of truth for every kind of point a map can carry: what it
 * looks like as a 3D gizmo (`preview.js`), how a click resolves to one (`session.js`'s
 * `select` tool, `main.js`'s gizmo pick), and what card the inspector shows for it
 * (`inspector.js`). Before this file, those three concerns were three separate hand-written
 * switches, each covering a different 5 of the 13 kinds below — adding NPC's inspector card
 * (this slice's own motivating example: "no dedicated NPC inspector card yet") meant touching
 * three files in three different shapes. Now it means adding one row here.
 *
 * `ENTITIES[kind]` is deliberately data, not a mini-framework: `inspect` is a plain function
 * pointer to a hand-written card builder in `inspector.js` (or, for `object`, a thin adapter
 * around `tileCard`) — see this repo's own note on why a declarative field-schema engine would
 * be the wrong shape for cards this irregular (a weighted species table, a marker/inline-
 * waypoint union, a trainer/species radio).
 *
 * @typedef {{
 *   label: string, icon: string, color: number, gizmo: 'dot'|'triangle'|null,
 *   scale?: number, space: 'cell'|'world', pickPriority: number,
 *   list: (doc) => any[],
 *   positionOf: (doc, ref) => ({cx:number,cz:number}|{x:number,y:number,z:number}|null),
 *   moveTo?: (doc, history, ref, pos:{cx:number,cz:number}) => void,
 *   remove?: (doc, history, ref) => void,
 *   inspect?: (doc, history, ref, ui:{onChange:() => void}) => HTMLElement,
 * }} EntityKind
 *
 * `ref` is whatever a kind's own `tools.js` commands need to identify one instance: the real
 * array-element object for everything that already worked that way (`marker`, `npc`, `light`,
 * `spawnPoint`, `link`, `region`, `object`), and a small plain wrapper for the two kinds that
 * need extra context beyond one array element — `extraObject` -> `{extraIndex, object}` (object
 * is the real reference inside `doc.extras[extraIndex].objects`), `loopWaypoint` ->
 * `{index, entry}` (index into the FULL `doc.loop.via[]`, entries included, so a later rewrite
 * targets the right slot). `spawn` has no array to reference at all — `ref` is always exactly
 * `doc.spawn` itself, which is also why `spawn.list` below is a length-1/0 array rather than
 * `undefined`: every other piece of code here (gizmo rebuild, the select-tool hit test) iterates
 * `entity.list(doc)` uniformly and would need a spawn-shaped special case otherwise.
 *
 * `list`/`positionOf` are written to run identically whether handed the live, decoded `doc`
 * (`state.js`) or a freshly `serializeDocument`d `.map.json`-shaped object (`preview.js`'s
 * `rebuildGizmos`, which operates on the 3D pane's own loaded snapshot, not the editable
 * document directly). This holds for every kind that gets a gizmo below — verified field by
 * field: `spawn`/`markers`/`npcs`/`lights`/`spawnPoints` pass straight through
 * `serializeDocument` under the same names; `links`/`regions` (`regions[]` keeps its mask
 * RLE-encoded in BOTH shapes — `state.js`'s own header notes this is deliberately NOT decoded to
 * a dense array yet) and `loop.via` round-trip with the same shape; `cameras` is not even
 * cloned by `serializeDocument` (`map.cameras === doc.cameras`, the same object). The two kinds
 * with no gizmo (`object`, `extraObject`) are the only ones that touch `tileLayers`/`objects`/
 * `extras`, which DO differ between the two shapes — they are never hit through this doc/map
 * ambiguity because nothing in `preview.js` ever calls their `list`/`positionOf`.
 */

import { decodeRuns } from '@/terrain/mapfile.js';
import {
  setSpawn, placeMarker, removeMarker,
  moveNpc, removeNpc,
  updateLight, removeLight,
  updateSpawnPoint, removeSpawnPoint,
  removeLink,
  removeRegion,
  removeLoopWaypoint,
  removeCameraPreset,
  moveObject, removeObject,
  moveExtraObject, removeExtraObject,
} from './tools.js';
import {
  markerCard, npcCard, lightCard, spawnPointCard, linkCard, regionCard,
  loopWaypointCard, cameraPresetCard, extraObjectCard, tileCard,
} from './inspector.js';

/** Whole-mask membership/centroid for a region — `region.mask` is `{p,r}` RLE against `w*h`
 *  (`state.js`'s header: deliberately NOT decoded to a dense array at the document-model level,
 *  since painting one is a later slice's job). Decoding on demand here, rather than once at
 *  `createDocument` time, keeps that deferral honest — nothing eagerly materializes a dense mask
 *  just because the entity table exists. */
function regionMask(doc, region) {
  return decodeRuns(region.mask, doc.w * doc.h);
}

/** Whether `(cx,cz)` is a truthy cell of `region`'s mask — the select tool's per-region hit
 *  test (a region has no single point to click, only a shape) and `regionCentroid`'s own walk
 *  share this. */
export function regionContains(doc, region, cx, cz) {
  if (cx < 0 || cz < 0 || cx >= doc.w || cz >= doc.h) return false;
  return !!regionMask(doc, region)[cz * doc.w + cx];
}

/** The average cell of every truthy mask entry — not a real "position" a region has (it is a
 *  shape, not a point), but a reasonable, deterministic place to float its gizmo and to resolve
 *  a click's nearest cell to it for hit-testing purposes. Falls back to the map center for an
 *  empty mask (every shipped map's `regions[]` today — mask PAINTING is a later slice, so this
 *  is unreachable in practice until then, which is expected). */
function regionCentroid(doc, region) {
  const mask = regionMask(doc, region);
  let sx = 0; let sz = 0; let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    sx += i % doc.w; sz += (i / doc.w) | 0; n++;
  }
  return n ? { cx: sx / n, cz: sz / n } : { cx: doc.w / 2, cz: doc.h / 2 };
}

/** A region's authored cell count — the inspector's read-only readout, sharing the same decode
 *  `regionCentroid` already needs (no separate pass over the mask). */
export function regionCellCount(doc, region) {
  const mask = regionMask(doc, region);
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

/** A camera preset's own resolved position — a named marker (preferred) or a bare `{cx,cz}`,
 *  `canvas.js`'s own two-shape resolution (`p.marker ? doc.markers.find(...) : p`) copied
 *  verbatim rather than imported, since `canvas.js` is out of this slice's scope to reach into
 *  for one three-line rule. Returns `null` when a marker-anchored preset's marker was deleted
 *  out from under it (already flagged elsewhere by validation) — callers must guard. */
function cameraPresetPosition(doc, preset) {
  const at = preset.marker ? doc.markers.find((m) => m.name === preset.marker) : preset;
  return at && at.cx != null && at.cz != null ? { cx: at.cx, cz: at.cz } : null;
}

export const ENTITIES = {
  spawn: {
    label: 'Spawn', icon: 'flag', color: 0xE0A64B, gizmo: 'triangle', scale: 0.9,
    space: 'cell', pickPriority: 0,
    // A length-0/1 array, not `doc.spawn` bare — every generic consumer below (gizmo rebuild,
    // the select-tool hit test) iterates `entity.list(doc)` uniformly; `ref` is always
    // `doc.spawn` itself once yielded. No `inspect` — see this file's own header and this
    // slice's plan (Part 3, item 1): selecting it sets `cell` to the spawn's cell exactly like
    // today (the bare-cell `tileCard`+`cellCard` fallback), and the always-rendered
    // `gameplayCard` already shows/edits spawn direction.
    list: (doc) => (doc.spawn ? [doc.spawn] : []),
    positionOf: (doc, ref) => ({ cx: ref.cx, cz: ref.cz }),
    moveTo: (doc, history, ref, { cx, cz }) => setSpawn(doc, history, { cx, cz }),
  },
  marker: {
    label: 'Marcador', icon: 'map-pin', color: 0x7FC98C, gizmo: 'dot', scale: 0.6,
    space: 'cell', pickPriority: 10,
    list: (doc) => doc.markers,
    positionOf: (doc, ref) => ({ cx: ref.cx, cz: ref.cz }),
    moveTo: (doc, history, ref, { cx, cz }) => placeMarker(doc, history, { name: ref.name, cx, cz }),
    remove: (doc, history, ref) => removeMarker(doc, history, ref),
    inspect: markerCard,
  },
  npc: {
    label: 'NPC', icon: 'paw-print', color: 0x9ECBE6, gizmo: 'dot', scale: 0.6,
    space: 'cell', pickPriority: 30,
    list: (doc) => doc.npcs,
    positionOf: (doc, ref) => ({ cx: ref.cx, cz: ref.cz }),
    moveTo: (doc, history, ref, { cx, cz }) => moveNpc(doc, history, { npc: ref, cx, cz }),
    remove: (doc, history, ref) => removeNpc(doc, history, ref),
    inspect: npcCard,
  },
  light: {
    label: 'Luz', icon: 'lightbulb', color: 0xE0A64B, gizmo: 'dot', scale: 0.5,
    space: 'world', pickPriority: 90,
    list: (doc) => doc.lights,
    positionOf: (doc, ref) => ({ x: ref.x, y: ref.y, z: ref.z }),
    // Lights are otherwise free-floating world coordinates (`state.js`'s header) — dragging one
    // still snaps it to a cell center like every other gizmo, keeping its own `y`.
    moveTo: (doc, history, ref, { cx, cz }) => updateLight(doc, history, { light: ref, patch: { x: cx + 0.5, z: cz + 0.5 } }),
    remove: (doc, history, ref) => removeLight(doc, history, ref),
    inspect: lightCard,
  },
  spawnPoint: {
    label: 'Ponto de spawn', icon: 'paw-print', color: 0xE38FB0, gizmo: 'dot', scale: 0.7,
    space: 'cell', pickPriority: 80,
    list: (doc) => doc.spawnPoints,
    positionOf: (doc, ref) => ({ cx: ref.cx, cz: ref.cz }),
    moveTo: (doc, history, ref, { cx, cz }) => updateSpawnPoint(doc, history, { point: ref, patch: { cx, cz } }),
    remove: (doc, history, ref) => removeSpawnPoint(doc, history, ref),
    inspect: spawnPointCard,
  },
  link: {
    // Violet — distinct from every other gizmo color already in use (checked against the
    // others in this table before picking it).
    label: 'Link', icon: 'door-open', color: 0xC79BD6, gizmo: 'dot', scale: 0.6,
    space: 'cell', pickPriority: 40,
    list: (doc) => doc.links,
    positionOf: (doc, ref) => (ref.from ? { cx: ref.from.cx, cz: ref.from.cz } : null),
    // No `moveTo` — a link's `from` cell is edited as plain number inputs on its own card this
    // slice (no gizmo-drag flow yet, a later slice's viewport work).
    remove: (doc, history, ref) => removeLink(doc, history, ref),
    inspect: linkCard,
  },
  region: {
    label: 'Região', icon: 'route', color: 0xF2D9A8, gizmo: 'dot', scale: 0.6,
    space: 'cell', pickPriority: 50,
    list: (doc) => doc.regions,
    positionOf: (doc, ref) => regionCentroid(doc, ref),
    // No `moveTo` — a region is a whole mask, not a point; nothing to drag this slice (mask
    // painting is a later slice's own tool).
    remove: (doc, history, ref) => removeRegion(doc, history, ref),
    inspect: regionCard,
  },
  loopWaypoint: {
    // Matches `canvas.js`'s own dashed-via-line/waypoint-square color exactly.
    label: 'Waypoint do loop', icon: 'route', color: 0xE0A64B, gizmo: 'dot', scale: 0.5,
    space: 'cell', pickPriority: 60,
    // Only the INLINE (non-marker-name) `via` entries — a named-marker entry is moved/removed
    // by moving/removing the marker itself, matching `canvas.js`'s own `inlineViaNear`. `index`
    // is the entry's real position in the FULL `via` array (marker-name strings included), not
    // its position among inline entries only — an off-by-one here would silently retarget the
    // wrong waypoint on a later edit.
    list: (doc) => (doc.loop?.via ?? []).reduce((out, entry, index) => {
      if (typeof entry !== 'string') out.push({ index, entry });
      return out;
    }, []),
    positionOf: (doc, ref) => ({ cx: ref.entry.cx, cz: ref.entry.cz }),
    // No `moveTo` — edited as plain number inputs on its own card (no gizmo-drag flow yet).
    remove: (doc, history, ref) => removeLoopWaypoint(doc, history, { index: ref.index }),
    inspect: loopWaypointCard,
  },
  cameraPreset: {
    // Matches the 2D canvas's own camera-preset rectangle color.
    label: 'Câmera', icon: 'camera', color: 0xE0A64B, gizmo: 'dot', scale: 0.5,
    space: 'cell', pickPriority: 70,
    list: (doc) => Object.entries(doc.cameras?.presets ?? {}).map(([name, preset]) => ({ name, preset })),
    positionOf: (doc, ref) => cameraPresetPosition(doc, ref.preset),
    // No `moveTo` — edited as plain number/text inputs on its own card (no gizmo-drag flow yet).
    remove: (doc, history, ref) => removeCameraPreset(doc, history, { name: ref.name }),
    inspect: cameraPresetCard,
  },
  object: {
    label: 'Objeto', icon: 'box', color: 0xCFC4B7, gizmo: null, space: 'cell', pickPriority: 20,
    list: (doc) => doc.objects,
    positionOf: (doc, ref) => ({ cx: ref.cx, cz: ref.cz }),
    moveTo: (doc, history, ref, { cx, cz }) => moveObject(doc, history, { object: ref, cx, cz }),
    remove: (doc, history, ref) => removeObject(doc, history, ref),
    // No new full card — `tileCard` already partially handled `object` selection (rot/tint);
    // this thin wrapper builds the `sel`-shaped argument `tileCard` still expects for its
    // shared bare-cell-fallback role, so it stays one function either way it is reached.
    inspect: (doc, history, ref, ui) => tileCard(doc, history, { cell: { cx: ref.cx, cz: ref.cz }, kind: 'object', ref }, ui),
  },
  extraObject: {
    label: 'Objeto extra', icon: 'box', color: 0xCFC4B7, gizmo: null, space: 'cell', pickPriority: 15,
    // Flattened across every extras layer — `{extraIndex, object}`, `object` the real reference
    // inside `doc.extras[extraIndex].objects` (extras objects have no stable id of their own;
    // array position within that one layer is the only handle).
    list: (doc) => doc.extras.flatMap((ex, extraIndex) => ex.objects.map((object) => ({ extraIndex, object }))),
    positionOf: (doc, ref) => ({ cx: ref.object.cx, cz: ref.object.cz }),
    moveTo: (doc, history, ref, { cx, cz }) => moveExtraObject(doc, history, { extraIndex: ref.extraIndex, object: ref.object, cx, cz }),
    remove: (doc, history, ref) => removeExtraObject(doc, history, { extraIndex: ref.extraIndex, object: ref.object }),
    inspect: extraObjectCard,
  },
};
