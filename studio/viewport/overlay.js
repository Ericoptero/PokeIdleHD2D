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
 *   6. (Slice 9a) a second, differently-colored outline over `getRectSelection()` — the
 *      `boxselect` tool's committed (or, mid-drag, live) rectangle. Same "always visible"
 *      category as #5, not gated by a toggle, and a distinct color so the two outlines never
 *      read as the same kind of highlight when both happen to be showing at once (selecting a
 *      single cell inside an existing box-select rect is an explicitly supported workflow —
 *      `session.js`'s own header). A solid line, not a literal animated marching-ants dash —
 *      `THREE.Line` has no dash support without a shader/material extension, the same
 *      simplification `buildLoop`'s own comment below already accepts for the loop route.
 *   7. (Slice 9a) a paste ghost — a translucent quad sized to the clipboard's `w`×`h`, anchored
 *      at the hovered cell, shown only while `boxselect` is the active tool, a clipboard exists,
 *      and a cell is hovered. A flat tinted rectangle, not the clip's real tile art — enough
 *      feedback for "here is where a paste would land" without re-rendering actual placements
 *      for content that has not been committed yet.
 *   8. (Slice 9c) a live brush-radius ring for the `sculpt` tool, centered on `session.
 *      getHover()` and sized to `session.getBrush().sculptRadius` — the same "always visible
 *      while relevant" category as the selection outline, gated on the active tool instead of an
 *      overlay toggle since it is direct tool feedback, not optional map information.
 *   9. the región paint tool's own live preview (Slice 9b) — gated on `session.getTool() ===
 *      'region'`, not on an `OVERLAYS`-table toggle like 1-4 above (there is nothing to leave on
 *      once the tool is put away; a região has no meaning to keep tinted while painting a fence).
 *      A FLAT MASK TINT, deliberately, not the actual resolved autotile case art: see
 *      `buildRegion`'s own comment for why that scope cut is honest rather than a missed corner.
 *  10. (Slice 9d) the `stamp` tool's own hover-ghost — the same flat-tinted-quad technique as #7's
 *      paste ghost, sized to the PICKED, SAVED stamp's own `w`×`h` (after any pending `,`/`.`
 *      placement-only rotation) instead of the plain clipboard's, and in a different color so the
 *      two previews never look like the same thing even though both commit through `pasteClip`.
 */

import * as THREE from 'three';
import { COLLISION_COLOR } from '../kinds.js';
import { reachableFrom } from '../session.js';
import { rotateClipBy } from '../tools.js';
import { getStamp } from '../stamps.js';
import { decodeRuns } from '@/terrain/mapfile.js';

/** The 2D canvas's own selection-ring color (`canvas.js`, before Slice 7 deleted it) — matched
 *  here so the two views read as one document's selection, not two independently-colored ones. */
const SELECTION_COLOR = 0xE0A64B;
/** `kinds.js`'s `OVERLAYS` table's own dot color for the `grid` entry. */
const GRID_COLOR = 0xF2EBE0;
const GRID_OPACITY = 0.35;

/** The `boxselect` rectangle's own outline color (Slice 9a) — deliberately NOT `SELECTION_COLOR`
 *  (see this file's header, item 6) so a multi-cell rect and a single selected cell never blur
 *  into "the same highlight" when both are visible together. Lavender, matching one of
 *  `panels.js`'s own `BRUSH_TINTS` swatches — an "authoring accent" already used elsewhere in
 *  the Studio's UI, not a brand-new hue invented just for this. */
const RECT_SELECTION_COLOR = 0xC79BD6;

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

/** The paste-ghost quad's own tint (Slice 9a) — a cool blue found nowhere else in this file's
 *  palette (collision/reach lean warm-red/green, the rect outline above is lavender), so a
 *  pending-paste preview never reads as one of those other overlays by color alone. */
const PASTE_GHOST_PARSED = parseRgba('rgba(100,181,246,0.28)');

/** The `stamp` tool's own hover-ghost tint (Slice 9d) — a distinct teal, unclaimed by every
 *  other color in this file (the paste ghost's blue, the rect-selection outline's lavender, the
 *  warm collision/región/reach tints), so a stamp preview never reads as an ad-hoc paste ghost
 *  even though both ultimately place through the identical `pasteClip` — the two previews are
 *  different SOURCES to the author (a plain clipboard vs. a saved, named stamp) and are worth
 *  looking different for that reason alone. */
const STAMP_GHOST_PARSED = parseRgba('rgba(94,204,184,0.32)');

/** The 2D canvas's own loop colors: `#F7F1E7` for the resolved cache, amber for the authored
 *  `via` sequence (the same amber `SELECTION_COLOR` above already uses, and `entities.js`'s own
 *  `loopWaypoint` gizmo color — one amber across the whole Studio, not three). */
const LOOP_RESOLVED_COLOR = 0xF7F1E7;
const LOOP_VIA_COLOR = 0xE0A64B;
const LOOP_LINE_OPACITY = 0.85;

/** The `sculpt` brush ring's own color (Slice 9c) — a cool blue unclaimed by any other overlay
 *  or gizmo in this file (collision/reach/loop/selection are all warm greens/reds/amber), so a
 *  brush preview never reads as one of those instead. */
const SCULPT_RING_COLOR = 0x6FB8E0;
const SCULPT_RING_SEGMENTS = 48; // enough to read as round, not faceted, at any on-screen zoom

/**
 * Região (Slice 9b) tint colors — same `parseRgba`/`makeTintMesh` technique as collision/reach
 * above, three buckets instead of a per-kind palette: the ACTIVE region's own already-committed
 * mask (dim, so it reads as "already saved"), and the in-progress stroke's pending cells, colored
 * by whether the drag is currently ADDING or REMOVING membership so it reads correctly before the
 * pointer is even released.
 */
const REGION_MASK_PARSED = parseRgba('rgba(242,217,168,0.30)');  // `entities.js`'s own region gizmo color (0xF2D9A8), translucent
const REGION_ADD_PARSED = parseRgba('rgba(247,241,231,0.55)');   // brighter than the mask tint — `LOOP_RESOLVED_COLOR`'s own off-white
const REGION_REMOVE_PARSED = parseRgba('rgba(214,104,91,0.50)'); // `COLLISION_PARSED.block`'s own red — a removal reads as a warning, not a fill

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

  // --- região (Slice 9b): the active region's mask tint + the in-progress stroke's own tint,
  // both flat at y=0, tool-gated rather than overlay-toggle-gated (see this file's own header) --
  let regionGroup = null;

  // --- selection: always-on outline, independent of every toggle above ------------------------
  const selectionOutline = makeSelectionOutline(SELECTION_COLOR);
  scene.add(selectionOutline);

  // --- box-select rectangle: a second always-on outline (Slice 9a), same category as the
  // single-cell one above — see this file's header, item 6. Built from the SAME unit-square
  // geometry as `selectionOutline`, just scaled to the rect's own `w`×`h` instead of always 1×1
  // (a `LineLoop`'s vertex positions do not need to change to trace a bigger square — scaling
  // the whole object does the same thing far cheaper than rebuilding geometry per rect resize). -
  const rectSelectionOutline = makeSelectionOutline(RECT_SELECTION_COLOR);
  scene.add(rectSelectionOutline);

  /** A closed 1×1 square tracing one cell's own footprint — `LineLoop` needs only the four
   *  corners, unlike the eight endpoints `LineSegments` would take for the same shape. Shared
   *  shape for both outlines above; only the color differs per call site. */
  function makeSelectionOutline(color) {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
    const loop = new THREE.LineLoop(geo, mat);
    loop.renderOrder = 999; // same "always visible" convention `viewport/index.js`'s gizmo sprites use
    loop.visible = false;
    return loop;
  }

  // --- paste ghost: a translucent quad, rebuilt (not resized in place — its cell count changes
  // with the clipboard's own `w`×`h`, unlike the fixed-shape outlines above) whenever it needs to
  // show, move, resize or hide (Slice 9a) ------------------------------------------------------
  let pasteGhost = null;
  function disposePasteGhost() {
    if (!pasteGhost) return;
    scene.remove(pasteGhost);
    pasteGhost.geometry.dispose();
    pasteGhost.material.dispose();
    pasteGhost = null;
  }

  // --- stamp ghost (Slice 9d): same rebuild-from-scratch technique as the paste ghost above,
  // sized to the picked, saved stamp instead of the plain clipboard --------------------------
  let stampGhost = null;
  function disposeStampGhost() {
    if (!stampGhost) return;
    scene.remove(stampGhost);
    stampGhost.geometry.dispose();
    stampGhost.material.dispose();
    stampGhost = null;
  }

  // --- sculpt brush ring: always-on (while the tool is active), independent of every toggle ----
  const sculptRing = makeSculptRing();
  scene.add(sculptRing);

  /** A unit circle (radius 1, centered on the origin, flat on XZ) — `updateSculptRing` below
   *  scales it to the brush's actual `sculptRadius` on every notify rather than rebuilding the
   *  geometry each time a radius input changes, the same "scale, don't regeometry" trick a sprite
   *  gizmo already uses for its own size. */
  function makeSculptRing() {
    const positions = new Float32Array(SCULPT_RING_SEGMENTS * 3);
    for (let i = 0; i < SCULPT_RING_SEGMENTS; i++) {
      const t = (i / SCULPT_RING_SEGMENTS) * Math.PI * 2;
      positions.set([Math.cos(t), 0, Math.sin(t)], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: SCULPT_RING_COLOR, depthTest: false, transparent: true, opacity: 0.9 });
    const loop = new THREE.LineLoop(geo, mat);
    loop.renderOrder = 999;
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

  function disposeRegion() {
    if (!regionGroup) return;
    scene.remove(regionGroup);
    for (const child of regionGroup.children) { child.geometry.dispose(); child.material.dispose(); }
    regionGroup = null;
  }

  /**
   * Região (Slice 9b) live preview: the ACTIVE region's own committed mask, plus — while a
   * stroke is in progress — the cells it is about to add or remove. `stroke` is `session.
   * getRegionStroke()`'s own `{on, cells:Set<string>}` shape (`null` when no drag is live).
   *
   * A FLAT TINT over mask membership, not the actual resolved autotile case art
   * (`tiles.autotile.solvePlacements`) — a deliberate, honest scope cut for this slice: wiring
   * real tile geometry into this overlay scene would need a second tile renderer here (materials,
   * per-case geometry lookups, a live `tiles` module reference this file otherwise has none of —
   * this file's own header, "no registry access of its own"), for a preview that is only ever a
   * few hundred milliseconds stale anyway. `main.js`'s own debounced `schedulePreviewRebuild`
   * reloads the whole 3D pane through the EXACT SAME `frommap.js`/`draft.autotile` path the
   * shipped game uses the moment a stroke commits (`paintRegionMask`'s `history.push` bumps
   * `doc._rev`), at which point the real resolved art already shows correctly. Matches the
   * technique `buildCollision`/`buildReach` above already use — one merged mesh per tint color,
   * not one draw call per cell.
   */
  function buildRegion(doc, activeRegionId, stroke) {
    const group = new THREE.Group();
    const region = doc.regions.find((r) => r.id === activeRegionId);
    if (region) {
      const mask = decodeRuns(region.mask, doc.w * doc.h);
      const cells = [];
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        cells.push(i % doc.w, Math.floor(i / doc.w));
      }
      if (cells.length) group.add(makeTintMesh(cells, REGION_MASK_PARSED));
    }
    if (stroke?.cells?.size) {
      const cells = [];
      for (const key of stroke.cells) { const [cx, cz] = key.split(',').map(Number); cells.push(cx, cz); }
      group.add(makeTintMesh(cells, stroke.on ? REGION_ADD_PARSED : REGION_REMOVE_PARSED));
    }
    group.renderOrder = 3; // above collision/reach/loop (2) — a live stroke must never look hidden under them
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

  /** `boxselect`'s own rectangle (Slice 9a) — either the committed selection or, mid-drag, the
   *  live in-progress one (`main.js` calls `session.setRectSelection` continuously during the
   *  drag, not just on release, specifically so this reads a live-growing rect with no second
   *  "live rect" concept of its own to plumb through). Flat at the rect's own top-left corner's
   *  height, not per-cell — a reasonable approximation for a multi-cell footprint (the height
   *  field only "varies gently" per `ARCHITECTURE.md`), unlike the single-cell outline above,
   *  which can afford to be exactly right for just one cell. */
  function updateRectSelection(doc, rect) {
    if (!doc || !rect) { rectSelectionOutline.visible = false; return; }
    rectSelectionOutline.visible = true;
    rectSelectionOutline.position.set(rect.x0, getHeight(rect.x0, rect.z0) + 0.02, rect.z0);
    rectSelectionOutline.scale.set(rect.x1 - rect.x0 + 1, 1, rect.z1 - rect.z0 + 1);
  }

  /** The pending-paste preview (Slice 9a) — a flat tinted quad sized to the clipboard's own
   *  `w`×`h`, anchored at the hovered cell. Rebuilt from scratch on every call rather than
   *  resized in place: cheap (a handful of quads at most, the same tolerance every other overlay
   *  in this file gets) and simpler than tracking whether the clip's own dimensions changed
   *  since the last hover. Hidden (disposed) whenever any one of its three preconditions —
   *  `boxselect` is the active tool, a clipboard exists, a cell is hovered — is not met. */
  function updatePasteGhost(doc) {
    disposePasteGhost();
    if (!doc || session.getTool() !== 'boxselect') return;
    const clip = session.getClipboard();
    const hover = session.getHover();
    if (!clip || !clip.w || !clip.h || !hover) return;
    const cells = [];
    for (let dz = 0; dz < clip.h; dz++) for (let dx = 0; dx < clip.w; dx++) cells.push(hover.cx + dx, hover.cz + dz);
    pasteGhost = makeTintMesh(cells, PASTE_GHOST_PARSED);
    pasteGhost.renderOrder = 3;
    scene.add(pasteGhost);
  }

  /** The `stamp` tool's own pending-placement preview (Slice 9d) — `updatePasteGhost`'s exact
   *  technique, re-anchored to the picked, SAVED stamp (`stamps.js`'s own `getStamp`, resolved by
   *  name from `session.getActiveStampName()`) instead of the plain clipboard, and rotated by
   *  whatever pending quarter-turn count `session.getStampRotation()` currently holds
   *  (`rotateClipBy`, `tools.js` — a scratch rotation, never written back to the saved stamp).
   *  Hidden whenever any precondition — `stamp` is the active tool, a stamp is actually picked
   *  and still exists, a cell is hovered — is not met. */
  function updateStampGhost(doc) {
    disposeStampGhost();
    if (!doc || session.getTool() !== 'stamp') return;
    const raw = getStamp(session.getActiveStampName());
    if (!raw) return;
    const clip = rotateClipBy(raw, session.getStampRotation());
    const hover = session.getHover();
    if (!clip.w || !clip.h || !hover) return;
    const cells = [];
    for (let dz = 0; dz < clip.h; dz++) for (let dx = 0; dx < clip.w; dx++) cells.push(hover.cx + dx, hover.cz + dz);
    stampGhost = makeTintMesh(cells, STAMP_GHOST_PARSED);
    stampGhost.renderOrder = 3;
    scene.add(stampGhost);
  }

  /** Positions/sizes/shows the `sculpt` brush ring — visible only while the tool is active AND
   *  the pointer is actually over the pane (`session.getHover()`, `main.js`'s own pointermove
   *  handler is what keeps this current; see that file's comment on why it is scoped to `sculpt`
   *  rather than tracked for every tool). Terrain-following like the selection outline, not flat
   *  like the grid/collision/reach/loop meshes — both are "where is my cursor" feedback, and both
   *  already pay for a per-notify `getHeight` call for the exact same reason. */
  function updateSculptRing(doc) {
    const hover = session.getHover();
    if (!doc || !hover || session.getTool() !== 'sculpt') { sculptRing.visible = false; return; }
    const radius = Math.max(session.getBrush().sculptRadius ?? 0, 0.001); // a zero-radius ring would collapse to an invisible point via scale
    sculptRing.visible = true;
    sculptRing.scale.set(radius, 1, radius);
    sculptRing.position.set(hover.cx + 0.5, getHeight(hover.cx, hover.cz) + 0.03, hover.cz + 0.5);
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
  let lastRegionSig = null;

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

    // Região (Slice 9b): its own change signature, independent of the `changed` block above — it
    // depends on the ACTIVE TOOL and the in-progress stroke, neither of which the four overlay
    // toggles have any reason to know about, and it must react on EVERY stroke pointermove
    // (`main.js` calls `session.notify()` on each one via `session.setRegionStroke`), not only on
    // a committed document edit.
    const tool = session.getTool();
    const activeRegionId = session.getActiveRegionId();
    const stroke = session.getRegionStroke();
    const regionSig = tool !== 'region' ? 'off'
      : `${activeRegionId ?? ''}|${rev}|${stroke ? `${stroke.on}:${stroke.cells.size}` : ''}`;
    if (regionSig !== lastRegionSig) {
      lastRegionSig = regionSig;
      disposeRegion();
      if (doc && tool === 'region') { regionGroup = buildRegion(doc, activeRegionId, stroke); scene.add(regionGroup); }
    }

    // The selection can move independently of the document (a bare `select`-tool click touches
    // no `doc._rev`), so this runs on every notify regardless of `changed` above — cheap either
    // way, it only repositions one existing object. `rectSelection`/the paste ghost (Slice 9a)
    // and the sculpt ring (Slice 9c) are the same story — session-local state that changes far
    // more often than `doc._rev` does (every dragged cell of a `boxselect`, every hovered cell
    // of a pending paste or an active sculpt stroke) and are cheap enough (a handful of quads/
    // one line loop, at most) to just redo unconditionally too.
    updateSelection(doc, session.getSelection());
    updateRectSelection(doc, session.getRectSelection());
    updatePasteGhost(doc);
    updateStampGhost(doc);
    updateSculptRing(doc);
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
      disposePasteGhost();
      disposeStampGhost();
      disposeRegion();
      selectionOutline.geometry.dispose();
      selectionOutline.material.dispose();
      rectSelectionOutline.geometry.dispose();
      rectSelectionOutline.material.dispose();
      sculptRing.geometry.dispose();
      sculptRing.material.dispose();
    },
  };
}
