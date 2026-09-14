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
 * passed in so `applyZoom` can trigger it after `fitFraming` moves `pixelScale`, exactly as the
 * un-split code did.
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
  // Zoom never sets `pixelsPerUnit` to an off-ladder value — tiles are authored at 32
  // texels/unit, so anything but 16/32/64 minifies unevenly as the camera pans (visible
  // shimmer). `fitFraming` already searches `ppu × pixelScale` and lands on the ladder.
  let zoomCells = 22;
  function applyZoom() {
    rig.fitFraming(zoomCells);
    // The confirmed bug this replaces: `resize()`'s frustum rewrite is guarded by an early
    // return when none of (outW,outH,inW,inH) changed, and a bare `pixelsPerUnit` write moves
    // none of them — the old `setPpu` was a silent no-op for exactly that reason. `fitFraming`
    // also sets `pixelScale`, which does move `inW/inH`, but only once `resize()` is actually
    // called — hence this explicit call rather than relying on some other code path to do it.
    resize();
  }
  function zoomSteps(dir) {
    zoomCells = Math.max(4, Math.min(96, Math.round(zoomCells * (dir > 0 ? 1.12 : 1 / 1.12))));
    applyZoom();
  }
  function setZoomCells(n) { zoomCells = Math.max(4, Math.min(96, n)); applyZoom(); }
  function fitMap(w, h) { setZoomCells(Math.max(w, h)); }
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

  return { panBy, zoomSteps, setZoomCells, fitMap, getZoom, setYaw, getYaw, stepYaw };
}
