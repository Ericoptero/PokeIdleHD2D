/**
 * viewport/overlay.js — a real-time 3D overlay pass, drawn straight on top of the composited
 * game frame (`viewport/index.js`'s `frame()`: `view.renderer.autoClear = false` around one
 * extra `view.renderer.render(overlay.scene, view.camera)` call, restored right after). Safe
 * against this renderer specifically because `resize()` in `@/core/render.js` makes the output
 * canvas an exact integer multiple of the internal buffer with `NearestFilter` sampling — the
 * same `view.camera` already projects overlay geometry onto exactly the pixels the world
 * occupies, no separate aspect/frustum correction needed — and the composite blit that just ran
 * left the default framebuffer's depth cleared to 1.0 everywhere (the composite material has
 * `depthTest:false, depthWrite:false`), so overlay geometry never needs to occlusion-test
 * against the 3D scene: it always draws on top, the same way a gizmo sprite already fakes
 * "always visible" via `depthTest:false` + a high `renderOrder`.
 *
 * Reads live from `session` (`session.getDoc()`/`overlays()`/`getSelection()`), NOT a
 * serialized snapshot — this file runs inside the same Studio process `session` does, unlike
 * `viewport/index.js`'s `rebuildGizmos`, which necessarily works from `preview.load()`'s
 * already-serialized `.map.json`-shaped map (a 3D pane can be showing an in-flight edit the 2D
 * canvas's own `session.getDoc()` already has and the 3D pane's last `load()` snapshot does not).
 *
 * Four overlays now (Slice 6 proved the technique with `grid`/`collision`; Slice 7 added
 * `reach`/`loop` and deleted the 2D canvas that used to draw the other eight) — the full list
 * `kinds.js`'s `OVERLAYS` table carries. Not a subset still being ported: `kinds.js`'s own
 * header explains why `textures`/`markers`/`cameras`/`encounters` are gone for good (real
 * materials and always-visible gizmos replace them, not a deferred overlay) versus
 * `height`/`tags`/`footprints`/`lights`, which ARE real overlays with no 3D port yet — deferred
 * to a later slice, the same way this header already deferred `reach`/`loop` before this one.
 *   1. a world-space grid along cell boundaries, toggled by `overlays().grid`;
 *   2. semi-transparent collision tint quads, toggled by `overlays().collision`, reusing
 *      `kinds.js`'s own `COLLISION_COLOR` palette rather than re-authoring the colors a third
 *      time (`canvas.js`'s 2D overlay was the second, before Slice 7 deleted it);
 *   3. reachability tint quads (Slice 7), toggled by `overlays().reach` — `session.js`'s own
 *      exported `reachableFrom` BFS (no second, drifting implementation), tinted with the exact
 *      same two colors the 2D canvas used for continuity;
 *   4. the loop route (Slice 7), toggled by `overlays().loop` — `doc.loop.resolved.cells` as a
 *      closed line loop, plus `doc.loop.via` resolved through the same marker-or-inline-cell
 *      logic the 2D canvas used, as a second line;
 *   5. a selection outline over `getSelection().cell`, always on regardless of the overlay
 *      toggles above — selection feedback is the same "always visible" category as a gizmo, not
 *      an optional overlay.
 */

import * as THREE from 'three';
import { COLLISION_COLOR } from '../kinds.js';
import { reachableFrom } from '../session.js';

/** The 2D canvas's own selection-ring color (`canvas.js`, before Slice 7 deleted it) — matched
 *  here so the two views read as one document's selection, not two independently-colored ones. */
const SELECTION_COLOR = 0xE0A64B;
/** `kinds.js`'s `OVERLAYS` table's own dot color for the `grid` entry. */
const GRID_COLOR = 0xF2EBE0;
const GRID_OPACITY = 0.35;

/** Parses one `rgba()` string into a `THREE.Color` + opacity — once, at module load, so every
 *  rebuild reuses the same small table instead of re-parsing strings every time a cell repaints.
 *  Shared by `COLLISION_PARSED` and `REACH_PARSED` below. */
function parseRgba(str) {
  const [r, g, b, a] = str.slice(str.indexOf('(') + 1, -1).split(',').map(Number);
  return { color: new THREE.Color(r / 255, g / 255, b / 255), opacity: a ?? 1 };
}
const COLLISION_PARSED = Object.fromEntries(
  Object.entries(COLLISION_COLOR).map(([kind, rgba]) => [kind, parseRgba(rgba)]),
);

/** The 2D canvas's own `reach` overlay colors (`canvas.js`, before Slice 7), converted the same
 *  way `COLLISION_PARSED` above already is — matched exactly for continuity, not re-authored. */
const REACH_PARSED = {
  reachable: parseRgba('rgba(127,201,140,0.14)'),
  unreachable: parseRgba('rgba(214,104,91,0.30)'),
};

/** The 2D canvas's own loop colors: `#F7F1E7` for the resolved cache, amber for the authored
 *  `via` sequence (the same amber `SELECTION_COLOR` above already uses, and `entities.js`'s own
 *  `loopWaypoint` gizmo color — one amber across the whole Studio, not three). */
const LOOP_RESOLVED_COLOR = 0xF7F1E7;
const LOOP_VIA_COLOR = 0xE0A64B;
const LOOP_LINE_OPACITY = 0.85;

/** Resolves one `loop.via` entry to a concrete cell — a marker name looked up in `doc.markers`
 *  (`null` if the marker was deleted out from under it), or an inline `{cx,cz}` waypoint used
 *  as-is. A tiny copy of `canvas.js`'s old `viaPoint` (deleted with the rest of that file in
 *  Slice 7) rather than an import — `entities.js`'s own `cameraPresetPosition` sets the same
 *  precedent for a three-line rule not worth reaching across a file boundary for. */
function viaPoint(doc, entry) {
  if (typeof entry === 'string') {
    const m = doc.markers.find((x) => x.name === entry);
    return m ? { cx: m.cx, cz: m.cz } : null;
  }
  return entry;
}

/**
 * @param {{session: object, getHeight: (cx:number, cz:number) => number}} opts `getHeight` is
 *   `viewport/index.js`'s own `ctx.get('terrain').height` — threaded in rather than importing
 *   `terrain` here, so this file stays a pure "read session, draw three.js objects" module with
 *   no registry access of its own.
 */
export function makeOverlay({ session, getHeight }) {
  const scene = new THREE.Scene();

  // --- grid: world-space lines along cell boundaries, doc.w × doc.h --------------------------
  //
  // Flat at y=0 — an acceptable first pass per the plan. Following terrain height per-cell (so
  // the grid hugs a ramp or a terrace edge the way the ground mesh itself does) is a reasonable
  // future improvement, not attempted here: a flat grid still reads correctly for this slice's
  // purpose (orientation and cell-boundary counting), and the height field only "varies gently"
  // (`ARCHITECTURE.md`) so the flat approximation is rarely far from the ground.
  let gridLines = null;

  // --- collision / reach: semi-transparent tint quads, one merged mesh per color in use --------
  //
  // Grouped by color (at most 7 draw calls for collision — `block`/`water`/`shallow`/`door`/
  // `stairs`/`ledge`/`none`, `walk` skipped as fully transparent; exactly 2 for reach —
  // reachable/unreachable) rather than one draw call per cell: a per-group `THREE.Color`/opacity
  // is uniform across a `MeshBasicMaterial`, so cells sharing a color can share one geometry with
  // no visual difference and far fewer draw calls on a large map. Both flat at y=0, same
  // rationale as the grid above.
  let collisionGroup = null;
  let reachGroup = null;

  // --- loop: the resolved-cache line plus the authored-via line, both flat at y=0 --------------
  let loopGroup = null;

  // --- selection: always-on outline, independent of every toggle above ------------------------
  const selectionOutline = makeSelectionOutline();
  scene.add(selectionOutline);

  function makeSelectionOutline() {
    // A closed 1×1 square tracing the selected cell's own footprint — `LineLoop` needs only the
    // four corners, unlike the eight endpoints `LineSegments` would take for the same shape.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: SELECTION_COLOR, depthTest: false, transparent: true });
    const loop = new THREE.LineLoop(geo, mat);
    loop.renderOrder = 999; // same "always visible" convention `viewport/index.js`'s gizmo sprites use
    loop.visible = false;
    return loop;
  }

  function disposeGrid() {
    if (!gridLines) return;
    scene.remove(gridLines);
    gridLines.geometry.dispose();
    gridLines.material.dispose();
    gridLines = null;
  }

  function buildGrid(doc) {
    const pts = [];
    for (let cx = 0; cx <= doc.w; cx++) pts.push(cx, 0, 0, cx, 0, doc.h);
    for (let cz = 0; cz <= doc.h; cz++) pts.push(0, 0, cz, doc.w, 0, cz);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    const mat = new THREE.LineBasicMaterial({
      color: GRID_COLOR, opacity: GRID_OPACITY, transparent: true, depthTest: false,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = 1;
    return lines;
  }

  /** Two triangles' worth of positions for one flat 1×1 quad at cell `(x,z)`, y=0 — shared by
   *  `buildCollision` and `buildReach` below so the two do not maintain two copies of the same
   *  6-vertex quad math. */
  function quadPositions(cells) {
    const positions = new Float32Array((cells.length / 2) * 18); // 2 tris × 3 verts × 3 comps
    let o = 0;
    for (let i = 0; i < cells.length; i += 2) {
      const x = cells[i]; const z = cells[i + 1];
      positions.set([
        x, 0, z, x + 1, 0, z, x + 1, 0, z + 1,
        x, 0, z, x + 1, 0, z + 1, x, 0, z + 1,
      ], o);
      o += 18;
    }
    return positions;
  }

  function makeTintMesh(cells, parsed) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(quadPositions(cells), 3));
    const mat = new THREE.MeshBasicMaterial({
      color: parsed.color, opacity: parsed.opacity, transparent: true, depthTest: false, side: THREE.DoubleSide,
    });
    return new THREE.Mesh(geo, mat);
  }

  function disposeCollision() {
    if (!collisionGroup) return;
    scene.remove(collisionGroup);
    for (const child of collisionGroup.children) { child.geometry.dispose(); child.material.dispose(); }
    collisionGroup = null;
  }

  function buildCollision(doc) {
    const group = new THREE.Group();
    const cellsByKind = new Map();
    for (let cz = 0; cz < doc.h; cz++) {
      for (let cx = 0; cx < doc.w; cx++) {
        const kind = doc.collision[cz * doc.w + cx];
        if (kind === 'walk') continue; // fully transparent in COLLISION_COLOR — skip per the plan
        if (!cellsByKind.has(kind)) cellsByKind.set(kind, []);
        cellsByKind.get(kind).push(cx, cz);
      }
    }
    for (const [kind, cells] of cellsByKind) {
      const parsed = COLLISION_PARSED[kind];
      if (!parsed) continue; // an unknown kind has no color to tint with
      group.add(makeTintMesh(cells, parsed));
    }
    group.renderOrder = 2;
    return group;
  }

  function disposeReach() {
    if (!reachGroup) return;
    scene.remove(reachGroup);
    for (const child of reachGroup.children) { child.geometry.dispose(); child.material.dispose(); }
    reachGroup = null;
  }

  /** `reach` overlay (Slice 7): reuses `session.js`'s own `reachableFrom` BFS — no second,
   *  drifting implementation — and skips `block`/`water` cells exactly like the 2D canvas's own
   *  `reach` render branch did (a wall or a lake reading as "unreachable" is not useful
   *  information; it is just always true and drowns out the cells that DO matter). */
  function buildReach(doc) {
    const group = new THREE.Group();
    const seen = reachableFrom(doc, doc.spawn);
    const buckets = { reachable: [], unreachable: [] };
    for (let cz = 0; cz < doc.h; cz++) {
      for (let cx = 0; cx < doc.w; cx++) {
        const kind = doc.collision[cz * doc.w + cx];
        if (kind === 'block' || kind === 'water') continue;
        buckets[seen[cz * doc.w + cx] ? 'reachable' : 'unreachable'].push(cx, cz);
      }
    }
    for (const key of ['reachable', 'unreachable']) {
      if (buckets[key].length) group.add(makeTintMesh(buckets[key], REACH_PARSED[key]));
    }
    group.renderOrder = 2;
    return group;
  }

  function disposeLoop() {
    if (!loopGroup) return;
    scene.remove(loopGroup);
    for (const child of loopGroup.children) { child.geometry.dispose(); child.material.dispose(); }
    loopGroup = null;
  }

  /** One closed line through a list of `{cx,cz}`-ish points, flat at y=0. `THREE.Line` has no
   *  dash support without a dash shader/material extension — a solid line in the loop's own
   *  color is an acceptable simplification for this slice (still visually distinct: two
   *  different colors, same as the 2D canvas's solid-vs-dashed pair used to be), not a silent
   *  under-delivery. */
  function makeLoopLine(points, color) {
    const pts = [];
    for (const p of points) pts.push(p.cx + 0.5, 0, p.cz + 0.5);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    const mat = new THREE.LineBasicMaterial({ color, opacity: LOOP_LINE_OPACITY, transparent: true, depthTest: false });
    return new THREE.LineLoop(geo, mat);
  }

  /** `loop` overlay (Slice 7): the resolved-cache loop (what the game actually walks) plus the
   *  authored `via` sequence resolved through `viaPoint` above — matching the 2D canvas's own
   *  two-line, two-color rendering of the same two arrays. Deliberately NOT drawing a marker per
   *  inline `via` waypoint here: `entities.js`'s `loopWaypoint` kind already gives each one its
   *  own always-visible gizmo (wired up in an earlier slice), so a second marker would be
   *  redundant, not helpful. */
  function buildLoop(doc) {
    const group = new THREE.Group();
    const resolvedCells = doc.loop?.resolved?.cells;
    if (resolvedCells?.length) group.add(makeLoopLine(resolvedCells, LOOP_RESOLVED_COLOR));
    const via = doc.loop?.via;
    if (via?.length) {
      const resolved = via.map((entry) => viaPoint(doc, entry)).filter(Boolean);
      if (resolved.length > 1) group.add(makeLoopLine(resolved, LOOP_VIA_COLOR));
    }
    group.renderOrder = 2;
    return group;
  }

  function updateSelection(doc, selection) {
    const cell = selection.cell;
    if (!doc || !cell) { selectionOutline.visible = false; return; }
    selectionOutline.visible = true;
    // Terrain-following, unlike the flat grid/collision/reach/loop above — a single cell is
    // cheap to query and "always visible" selection feedback is the same category as a gizmo,
    // which already floats off the real ground height rather than off a flat plane.
    selectionOutline.position.set(cell.cx, getHeight(cell.cx, cell.cz) + 0.02, cell.cz);
  }

  // --- rebuild cadence: on `session` notify, not on every frame --------------------------------
  //
  // A full-map grid/collision/reach/loop rebuild is cheap (a handful of line segments and, at
  // most, a few dozen merged quads) and only needs to happen when the document, its dimensions
  // or an overlay toggle actually changed — not on every `session` notify, which also fires on a
  // bare hover-turned-selection-change (`session.js`'s `setSelection`, called unconditionally by
  // a plain cell click, matching `main.js`'s own `lastRebuildRev` guard for exactly this reason).
  // `doc._rev` (`state.js`'s `touch()`) is the same signal `main.js` already uses to tell
  // "something was painted" apart from "the selection changed".
  let lastDoc = null;
  let lastRev = -1;
  let lastGridOn = null;
  let lastCollisionOn = null;
  let lastReachOn = null;
  let lastLoopOn = null;

  function rebuildIfNeeded() {
    const doc = session.getDoc();
    const overlays = session.overlays();
    const rev = doc?._rev ?? -1;
    const changed = doc !== lastDoc || rev !== lastRev
      || overlays.grid !== lastGridOn || overlays.collision !== lastCollisionOn
      || overlays.reach !== lastReachOn || overlays.loop !== lastLoopOn;
    if (changed) {
      lastDoc = doc; lastRev = rev;
      lastGridOn = overlays.grid; lastCollisionOn = overlays.collision;
      lastReachOn = overlays.reach; lastLoopOn = overlays.loop;
      disposeGrid();
      disposeCollision();
      disposeReach();
      disposeLoop();
      if (doc && overlays.grid) { gridLines = buildGrid(doc); scene.add(gridLines); }
      if (doc && overlays.collision) { collisionGroup = buildCollision(doc); scene.add(collisionGroup); }
      if (doc && overlays.reach) { reachGroup = buildReach(doc); scene.add(reachGroup); }
      if (doc && overlays.loop) { loopGroup = buildLoop(doc); scene.add(loopGroup); }
    }
    // The selection can move independently of the document (a bare `select`-tool click touches
    // no `doc._rev`), so this runs on every notify regardless of `changed` above — cheap either
    // way, it only repositions one existing object.
    updateSelection(doc, session.getSelection());
  }
  const unsubscribe = session.subscribe(rebuildIfNeeded);
  rebuildIfNeeded(); // paint whatever `session` already holds at construction time

  return {
    scene,
    dispose() {
      unsubscribe();
      disposeGrid();
      disposeCollision();
      disposeReach();
      disposeLoop();
      selectionOutline.geometry.dispose();
      selectionOutline.material.dispose();
    },
  };
}
