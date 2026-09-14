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
 * Three overlays this slice proves the technique with end-to-end — NOT the 2D canvas's full
 * 12-branch parity (`kinds.js`'s `OVERLAYS`): height shading, tags, reach, loop, lights-radius,
 * camera-presets, footprints and textures are all deferred to a later slice. `canvas.js` still
 * exists and still draws every one of those in 2D.
 *   1. a world-space grid along cell boundaries, toggled by `overlays().grid`;
 *   2. semi-transparent collision tint quads, toggled by `overlays().collision`, reusing
 *      `kinds.js`'s own `COLLISION_COLOR` palette rather than re-authoring the colors a third
 *      time (`canvas.js`'s 2D overlay is the second);
 *   3. a selection outline over `getSelection().cell`, always on regardless of the overlay
 *      toggles above — selection feedback is the same "always visible" category as a gizmo, not
 *      an optional overlay.
 */

import * as THREE from 'three';
import { COLLISION_COLOR } from '../kinds.js';

/** The 2D canvas's own selection-ring color (`canvas.js`) — matched here so the two views read
 *  as one document's selection, not two independently-colored ones. */
const SELECTION_COLOR = 0xE0A64B;
/** `kinds.js`'s `OVERLAYS` table's own dot color for the `grid` entry. */
const GRID_COLOR = 0xF2EBE0;
const GRID_OPACITY = 0.35;

/** Parses one of `kinds.js`'s `COLLISION_COLOR` rgba() strings into a `THREE.Color` + opacity —
 *  once, at module load, so every rebuild reuses the same small table instead of re-parsing
 *  strings every time a cell repaints. */
function parseRgba(str) {
  const [r, g, b, a] = str.slice(str.indexOf('(') + 1, -1).split(',').map(Number);
  return { color: new THREE.Color(r / 255, g / 255, b / 255), opacity: a ?? 1 };
}
const COLLISION_PARSED = Object.fromEntries(
  Object.entries(COLLISION_COLOR).map(([kind, rgba]) => [kind, parseRgba(rgba)]),
);

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

  // --- collision: semi-transparent tint quads, one merged mesh per collision kind in use ------
  //
  // Grouped by kind (at most 7 draw calls — `block`/`water`/`shallow`/`door`/`stairs`/`ledge`/
  // `none`, `walk` skipped as fully transparent) rather than one draw call per cell: a per-kind
  // `THREE.Color`/opacity is uniform across a `MeshBasicMaterial`, so cells sharing a kind can
  // share one geometry with no visual difference and far fewer draw calls on a large map.
  let collisionGroup = null;

  // --- selection: always-on outline, independent of both toggles above ------------------------
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
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.MeshBasicMaterial({
        color: parsed.color, opacity: parsed.opacity, transparent: true, depthTest: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      group.add(mesh);
    }
    group.renderOrder = 2;
    return group;
  }

  function updateSelection(doc, selection) {
    const cell = selection.cell;
    if (!doc || !cell) { selectionOutline.visible = false; return; }
    selectionOutline.visible = true;
    // Terrain-following, unlike the flat grid/collision above — a single cell is cheap to query
    // and "always visible" selection feedback is the same category as a gizmo, which already
    // floats off the real ground height rather than off a flat plane.
    selectionOutline.position.set(cell.cx, getHeight(cell.cx, cell.cz) + 0.02, cell.cz);
  }

  // --- rebuild cadence: on `session` notify, not on every frame --------------------------------
  //
  // A full-map grid/collision rebuild is cheap (a handful of line segments and, at most, a few
  // dozen merged quads) and only needs to happen when the document, its dimensions or an overlay
  // toggle actually changed — not on every `session` notify, which also fires on a bare hover
  // (`session.js`'s `setHover`, called unconditionally by `canvas.js`'s `pointermove`, matching
  // `main.js`'s own `lastRebuildRev` guard for exactly this reason). `doc._rev` (`state.js`'s
  // `touch()`) is the same signal `main.js` already uses to tell "something was painted" apart
  // from "the mouse moved" or "the selection changed".
  let lastDoc = null;
  let lastRev = -1;
  let lastGridOn = null;
  let lastCollisionOn = null;

  function rebuildIfNeeded() {
    const doc = session.getDoc();
    const overlays = session.overlays();
    const rev = doc?._rev ?? -1;
    const changed = doc !== lastDoc || rev !== lastRev
      || overlays.grid !== lastGridOn || overlays.collision !== lastCollisionOn;
    if (changed) {
      lastDoc = doc; lastRev = rev; lastGridOn = overlays.grid; lastCollisionOn = overlays.collision;
      disposeGrid();
      disposeCollision();
      if (doc && overlays.grid) { gridLines = buildGrid(doc); scene.add(gridLines); }
      if (doc && overlays.collision) { collisionGroup = buildCollision(doc); scene.add(collisionGroup); }
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
      selectionOutline.geometry.dispose();
      selectionOutline.material.dispose();
    },
  };
}
