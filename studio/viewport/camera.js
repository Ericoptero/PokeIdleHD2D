/**
 * viewport/camera.js — the 3D pane's navigation: drag-to-pan and wheel-to-zoom, moved verbatim
 * out of the old `preview.js` (no behavior change), plus the new Studio-only 90°-yaw control
 * (Slice 6). Pulled into its own file because navigation has nothing to do with booting the
 * minimal three.js engine or picking/gizmos — `viewport/index.js` constructs exactly one
 * instance of this and re-exposes its methods on its own returned object, so `main.js`'s
 * existing `preview.panBy(...)`/`.zoomSteps(...)`/`.setZoomCells(...)`/`.fitMap(...)`/
 * `.getZoom()` call sites need no changes at all.
 *
 * `ctx` — the same `{ get: (id) => registry.get(id), ... }` object `viewport/index.js` builds
 * for its own mini-registry — is threaded in rather than importing `@/tiles/index.js` directly
 * here: this file has no business reaching around the Studio's own registry to import a module
 * `viewport/index.js` already resolved through it (and doing so risks two different `tiles`
 * instances existing if the import graph ever changed) — `ctx.get('tiles')` is the one seam.
 * `resize` is `viewport/index.js`'s own function (it owns `container`, this file does not) —
 * passed in so `applyZoom`/`refitZoom` can trigger it after moving `pixelsPerUnit`, exactly as
 * the un-split code did for `fitFraming`.
 */
export function makeViewportCamera({ rig, view, config, ctx, resize }) {
  // --- pan ------------------------------------------------------------------------------------
  //
  // The rig (`@/core/render.js` `makeCameraRig`) is a fixed-pitch follow camera by construction
  // — the sprite pre-stretch math and `dropEdgeOnTwins`'s billboard culling both assume the
  // camera never yaws (true everywhere except this Studio-only `setYaw` below). There is no
  // pan()/zoom()/orbit() anywhere in the engine, only `setFocus`/`update`/`fitFraming`/`frame` —
  // this is the minimal navigation those four give.

  /** Screen CSS px -> world units, at the fixed 45° pitch: a run of L cells in Z covers
   *  `L*sin(pitch)` of screen height (`rig.fitFraming`'s own stated convention). */
  function panBy(dxPx, dyPx) {
    const outW = view.displayRect.w || 1;
    const [inW] = view.internalSize;
    const worldPerCssPx = inW / (outW * config.pixelsPerUnit);
    const sinPitch = Math.sin((config.cameraPitch * Math.PI) / 180) || 1;
    rig.setFocus(
      rig.focus.x - dxPx * worldPerCssPx,
      rig.focus.y,
      rig.focus.z - (dyPx * worldPerCssPx) / sinPitch,
      true, // immediate — a drag has to track the cursor 1:1, not spring toward it
    );
  }

  // --- zoom -----------------------------------------------------------------------------------
  //
  // The confirmed bug this replaces: `rig.fitFraming` searches a fixed `ppu × pixelScale`
  // ladder (`@/core/render.js`) and returns the FIRST combination wide enough for the requested
  // cell count — for a typical Studio pane width that ladder has only two or three distinct
  // rungs across the whole 4-96 cell range, so most zoom clicks changed `zoomCells` with no
  // visible effect at all (the frustum is `inW / ppu`, which never moved), and a plain
  // `round(zoomCells * 1.12)` could additionally get stuck at the ladder's own floor.
  //
  // The Studio pane owns its own isolated `config` (`viewport/index.js`'s `makeConfig('')`, no
  // sprite/tile code outside this module reads it), so — unlike the shipped game, which must
  // stay on 16/32/64 for `dropEdgeOnTwins`'s billboard math and even texel sampling — nothing
  // else depends on this pane's `pixelsPerUnit` landing on that ladder. Zoom here writes it
  // directly off the CURRENT internal buffer width, continuously: `ppu = inW / zoomCells`. An
  // off-ladder `ppu` does minify tile texels slightly unevenly while panning (the reason for the
  // ladder in the first place) — a marginally softer editor preview is the accepted trade for a
  // zoom control that responds to every click. `pixelScale` (the buffer-vs-screen upscale, still
  // auto-fit by `resize()`'s own `autoScale`) is untouched, so the pane keeps its normal chunky-
  // pixel look; only the ladder-quantization of `ppu` is bypassed.
  let zoomCells = 22;
  function applyZoom() {
    const [inW] = view.internalSize;
    const ppu = Math.max(4, Math.min(256, Math.round(inW / zoomCells)));
    config.set({ pixelsPerUnit: ppu });
    // Nothing reads the new `pixelsPerUnit` back into the camera frustum until `resize()` runs
    // (see its own header on why a bare dimension-unchanged call still refreshes the frustum) —
    // this explicit call is what actually applies the zoom.
    resize();
  }
  function zoomSteps(dir) {
    const grown = zoomCells * (dir > 0 ? 1.12 : 1 / 1.12);
    zoomCells = Math.max(4, Math.min(96, grown));
    applyZoom();
  }
  function setZoomCells(n) { zoomCells = Math.max(4, Math.min(96, n)); applyZoom(); }
  /**
   * Frames both map axes, not just the wider one — the ground term is not the screen term at a
   * pitched camera: a run of `L` cells in Z covers only `L * sin(pitch)` of frustum *height*
   * (`@/core/render.js`'s own `fitFraming` header), so `h` cells of depth need a frustum height
   * of `h * sin(pitch)` world units, and (aspect preserved by construction) a frustum WIDTH of
   * `h * sin(pitch) * inW/inH`. `Math.max(w, ...)` picks whichever axis actually constrains the
   * view; the 1.06 gives a small margin so the map edge does not sit flush on the frustum edge.
   */
  function fitMap(w, h) {
    const [inW, inH] = view.internalSize;
    const sinPitch = Math.sin((config.cameraPitch * Math.PI) / 180) || 1;
    const cells = Math.max(w, (h * sinPitch * inW) / Math.max(1, inH)) * 1.06;
    setZoomCells(cells);
  }
  /** Re-applies the current zoom after the pane's own container size changes (the
   *  `ResizeObserver` below) — `applyZoom` reads `view.internalSize`, which `resize()` just
   *  changed, so `zoomCells` (an editor-chosen cell count, not a pixel size) stays put across a
   *  window/panel resize instead of silently drifting. */
  function refitZoom() { resize(); applyZoom(); }
  function getZoom() { return { cellsWide: zoomCells, ppu: config.pixelsPerUnit, pixelScale: config.pixelScale }; }

  // --- yaw (Slice 6) ----------------------------------------------------------------------------
  //
  // Studio-only 90°-step view rotation. `rig.setYaw(deg)` (`@/core/render.js`) turns the CAMERA
  // only; `tiles.setViewYaw(q)` (`@/tiles/index.js`) records the quarter-turn so the NEXT
  // `buildInstances` call bakes a crossed billboard's surviving card to face the new view
  // (`cameraFacingRot` in `@/tiles/instanced.js`). Neither one touches an already-built
  // `InstancedWorld` sitting in the scene — forcing that rebuild is `viewport/index.js`'s own
  // `setYaw`'s job (a deliberate full reload of the current map; see its own comment for why),
  // not this file's: this module only owns the camera-rig/tiles-config half of the change.
  let yawQuarter = 0;
  function applyYaw() {
    rig.setYaw(yawQuarter * 90);
    ctx.get('tiles').setViewYaw(yawQuarter);
  }
  function setYaw(q) { yawQuarter = ((q % 4) + 4) % 4; applyYaw(); }
  function stepYaw(dir) { setYaw(yawQuarter + (dir > 0 ? 1 : -1)); }
  function getYaw() { return yawQuarter; }

  return { panBy, zoomSteps, setZoomCells, fitMap, refitZoom, getZoom, setYaw, getYaw, stepYaw };
}
