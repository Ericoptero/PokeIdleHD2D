/**
 * viewport/index.js — the live "Prévia HD-2D" pane: a second, small three.js game instance
 * embedded in the Studio, running the real `tiles`/`terrain`/`environment` modules so what the
 * panel shows IS the game's own render pipeline — the same models, the same autotile resolution,
 * the same dusk emissive ramp, the same per-cell multiply tint — not a CSS approximation of one.
 * If the preview draws it, the shipped game draws it identically — both run the same
 * `tiles`/`terrain`/`environment` module stack, not a hand-maintained lookalike. (There is no
 * longer a dedicated tool asserting this pixel-for-pixel — `tools/mapstudio/parity.js` did,
 * before procedural biome generation was replaced with Studio-authored maps;
 * `tools/mapstudio/roundtrip.js` and `studio-roundtrip.js` instead prove the underlying map
 * *data* survives authoring and replay untouched, which is what matters now.)
 *
 * A minimal boot, not the full game: only `tiles`, `terrain` and `environment` are registered
 * (`registry.init(ctx, { only: [...] })`) — no `city`/`hunts`/`ui`/`simulation`, so no NPCs, no
 * dialogue, nothing that would try to touch a DOM the Studio does not have.
 *
 * This is Slice 6's split of what used to be one file (`studio/preview.js`) into a
 * `studio/viewport/` module, plus this slice's own two additions:
 *   - `viewport/camera.js` — pan/zoom (moved verbatim, no behavior change) and the new
 *     Studio-only 90°-yaw control. Its methods are re-exposed on this module's own returned
 *     object below, so `main.js`'s existing `preview.panBy(...)`/`.zoomSteps(...)`/
 *     `.setZoomCells(...)`/`.fitMap(...)`/`.getZoom()` call sites need no changes.
 *   - `viewport/overlay.js` — a real-time 3D overlay pass (grid/collision/selection), drawn on
 *     top of the composited frame in `frame()` below. See its own header for the technique.
 *
 * Interactive since the Studio's P3 pass: `pickCell`/`pickGizmo` raycast the pane so `main.js`
 * can turn a click/drag into a cell (select, paint) or an entity — every kind `entities.js`'s
 * `ENTITIES` table marks with a gizmo, rendered here as small always-visible sprites (see
 * "gizmos" below, moved verbatim — gizmo hit-testing/movement logic is out of this slice's
 * scope). This is the only raycaster in the codebase, scoped to the Studio on purpose; nothing
 * about it assumes the fixed 45-degree rig, but nothing outside the Studio has needed one yet
 * either.
 */

import * as THREE from 'three';
import { makeBus } from '@/core/bus.js';
import { makeRegistry } from '@/core/registry.js';
import { makeClock } from '@/core/clock.js';
import { makeConfig } from '@/core/config.js';
import { makeRng } from '@/core/rng.js';
import { log } from '@/core/log.js';
import { makeRenderer, makeCameraRig, makeSunShadow } from '@/core/render.js';
import tiles from '@/tiles/index.js';
import terrain from '@/terrain/index.js';
import environment from '@/environment/index.js';
import { ENTITIES } from '../entities.js';
import { makeViewportCamera } from './camera.js';
import { makeOverlay } from './overlay.js';

/** @param {{container: HTMLElement, session: object}} opts `session` (`studio/session.js`) is
 *  read live by `viewport/overlay.js` for the grid/collision/selection overlays — not a
 *  serialized snapshot, since this module runs inside the same Studio process `session` does. */
export async function makeViewport({ container, session }) {
  const config = makeConfig('');
  const bus = makeBus({ onError: (err, meta) => log.error(`viewport: bus listener threw on ${meta.type}`, err) });
  const registry = makeRegistry({ bus, log });
  const clock = makeClock();
  const rng = makeRng(config.seed, 'studio-viewport');

  const view = makeRenderer({ container, config, log });
  const rig = makeCameraRig({ camera: view.camera, config, view });
  const sun = makeSunShadow({ config });
  view.scene.add(sun.light, sun.light.target);

  const ctx = {
    THREE, registry, bus, clock, rng, config, log,
    three: { renderer: view.renderer, scene: view.scene, camera: view.camera, view, rig, sun },
    get: (id) => registry.get(id),
  };

  for (const m of [tiles, terrain, environment]) registry.add(m);
  await registry.init(ctx, { only: ['tiles', 'terrain', 'environment'] });

  function resize() {
    view.resize(container.clientWidth || 1, container.clientHeight || 1);
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  const camera = makeViewportCamera({ rig, view, config, ctx, resize });
  const overlay = makeOverlay({ session, getHeight: (cx, cz) => ctx.get('terrain').height(cx, cz) });

  let extraWorlds = [];
  let generation = 0;
  let running = true;
  let hasFramedOnce = false;
  // Which map `load()` last built for. `main.js`'s `schedulePreviewRebuild` calls `load()` again
  // on every real document edit (debounced 400ms) so the 3D pane stays in sync while painting —
  // that reload must never re-home the camera on the spawn point, only a genuinely *different*
  // map opening should. `hasFramedOnce` answers the same "first time or not" question for the
  // one-shot auto-zoom (`fitMap`), which belongs to the Studio session rather than to the map:
  // switching maps re-centers the camera but does not re-fit the zoom the admin already chose.
  let lastMapId = null;
  // The map object itself, not just its id — `setYaw` below needs to reload the CURRENT map
  // after a yaw change (to rebuild every placement's baked instance matrices), and it has no
  // other way to get one: `main.js` only calls `load(map)` with a freshly serialized document,
  // never hands this module a live reference to `main.js`'s own `currentDoc`.
  let lastMap = null;

  function disposeExtras() {
    for (const w of extraWorlds) w.dispose();
    extraWorlds = [];
  }

  /** @param {object} map a `.map.json`-shaped document (`@/terrain/mapfile.js` / `studio/state.js`) */
  async function load(map) {
    lastMap = map;
    const gen = ++generation;
    try {
      ctx.get('terrain').registerMapFile('studio-preview', map);
      await ctx.get('terrain').load('studio-preview', {
        w: map.w, h: map.h, tileset: map.tileset, seed: map.seed,
      });
      if (gen !== generation) return; // a newer load started while this one was in flight

      disposeExtras();
      const report = ctx.get('terrain').report();
      for (const extra of report?.extras ?? []) {
        if (!extra.placements?.length) continue;
        extraWorlds.push(ctx.get('tiles').buildInstances(
          view.scene, extra.tileset, extra.placements, { name: `studio-preview:${extra.tileset}` },
        ));
      }
      rebuildGizmos(map);

      const env = ctx.get('environment');
      env.setBiomePreset?.(map.environmentPreset);
      env.setWeather?.(map.weather?.[0] ?? 'clear', map.weather?.[1] ?? 0);
      if (env.lamps) {
        env.lamps.clear();
        for (const light of map.lights ?? []) env.lamps.add(light);
      }

      // Only a new/different map snaps the camera to spawn — an edit-triggered reload of the
      // SAME map id (including a yaw-change reload — see `setYaw` below) leaves the camera
      // exactly where the admin left it (the confirmed bug this replaces: this line used to run
      // unconditionally, so hovering the 2D canvas — which notifies on every `pointermove`, not
      // just a drag — eventually fired a debounced reload that snapped the 3D view back to spawn
      // out from under whatever the admin was looking at).
      const isNewMap = map.id !== lastMapId;
      lastMapId = map.id;
      if (isNewMap) {
        const spawn = map.spawn ?? { cx: map.w >> 1, cz: map.h >> 1 };
        const y = ctx.get('terrain').height(spawn.cx, spawn.cz);
        rig.setFocus(spawn.cx + 0.5, y, spawn.cz + 0.5, true);
      }
      if (!hasFramedOnce) { hasFramedOnce = true; camera.fitMap(map.w, map.h); }
    } catch (err) {
      log.error('viewport: load failed', err);
    }
  }

  function setTod(tod) {
    config.set({ tod: Number(tod) });
    ctx.get('environment').setTimeOfDay?.(Number(tod));
  }
  function setFocus(cx, cz) {
    const y = ctx.get('terrain').height(cx, cz);
    rig.setFocus(cx + 0.5, y, cz + 0.5, true);
  }

  /**
   * Studio-only 90°-step view rotation (Slice 6). `camera.setYaw` alone only turns the camera
   * rig (`rig.setYaw`) and records the new quarter-turn for FUTURE placements
   * (`tiles.setViewYaw`) — it does nothing to the `InstancedWorld`s already sitting in the
   * scene, whose instance matrices (`cameraFacingRot`, `@/tiles/instanced.js`) were baked in at
   * construction time. So a yaw change here always follows with a full reload of the currently
   * loaded map, which rebuilds every placement (`extraWorlds` included) with the new
   * `viewYawQuarter` baked in from the start.
   *
   * This is a deliberate full reload, not a missed optimization: `InstancedWorld.patch()`
   * exists for high-frequency per-cell paint edits at a FIXED yaw, a different problem — a
   * global yaw change would need to identify and touch every crossed-billboard bucket across
   * every `extraWorld` depending on which of its models are crossed billboards, which is not
   * worth the complexity for an explicit, infrequent "rotate the view" click. Reloading the SAME
   * map id also means `load()`'s own new-map guard above leaves the camera exactly where it was
   * instead of snapping back to spawn.
   */
  function setYaw(q) {
    camera.setYaw(q);
    if (lastMap) load(lastMap);
  }

  // --- picking: the first raycaster anywhere in this codebase (`grep -r Raycaster src/ studio/`
  // turns up nothing) — scoped to the Studio only, per the plan. The rig's camera is a locked,
  // fixed-pitch `THREE.OrthographicCamera`; `Raycaster.setFromCamera` needs no special-casing
  // for that versus a perspective one. A click/drag in the 3D pane resolves to a cell by casting
  // against a horizontal plane and flooring the hit — `ARCHITECTURE.md`'s height field "varies
  // gently", so a second pass re-cast at the first guess's actual terrain height (below) is
  // already enough to stay correct on a ramp or a terrace edge without any real ground mesh
  // intersection test.
  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pickPoint = new THREE.Vector3();

  /** Client (page) px -> normalized device coords, against the renderer's own canvas box — not
   *  the container's — since `resize()` above intentionally overscans the container by up to
   *  one `pixelScale` step per edge. */
  function ndcFromClient(clientX, clientY) {
    const rect = view.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );
  }

  /**
   * Resolves a client (page) point to the map cell under it, or `null` when the ray cannot hit
   * the ground plane at all (a fixed 45-degree pitch never actually produces that — the guard is
   * for a future camera, not this one). Exported for `main.js` to drive click-to-select, tool
   * painting and gizmo dragging in the 3D pane from the same pointer events it already handles
   * for panning. Still correct after a yaw change (`setYaw` above): the raycaster reads
   * `view.camera` fresh on every call, and `rig.setYaw` is the only thing that ever rotates it.
   */
  function pickCell(clientX, clientY) {
    raycaster.setFromCamera(ndcFromClient(clientX, clientY), view.camera);
    if (!raycaster.ray.intersectPlane(groundPlane, pickPoint)) return null;
    let cx = Math.floor(pickPoint.x);
    let cz = Math.floor(pickPoint.z);
    const h = ctx.get('terrain').height(cx, cz);
    if (h) {
      const refined = new THREE.Plane(new THREE.Vector3(0, 1, 0), -h);
      if (raycaster.ray.intersectPlane(refined, pickPoint)) {
        cx = Math.floor(pickPoint.x);
        cz = Math.floor(pickPoint.z);
      }
    }
    return { cx, cz };
  }

  // --- gizmos: every `ENTITIES` kind with a truthy `gizmo`, always visible and (where that
  // kind's own `moveTo` exists) draggable in 3D ------------------------------------------------
  //
  // Sprites, not meshes with their own rotation logic: a sprite always faces the camera, so a
  // click always lands on a face-on shape regardless of the fixed 45-degree pitch (or this
  // slice's own 90°-step yaw), and `Raycaster.intersectObjects` already knows how to hit-test
  // one for free. One shared dot texture plus one shared triangle texture (spawn only, so it
  // reads as a distinct shape from everything else — matching `canvas.js`'s own amber spawn
  // glyph), tinted per instance through `SpriteMaterial.color`, so this never allocates a canvas
  // per gizmo. Moved verbatim from `preview.js` — no changes to gizmo logic itself in this slice.
  function makeDotTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    g.beginPath(); g.arc(16, 16, 13, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    return new THREE.CanvasTexture(c);
  }
  function makeTriangleTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    g.beginPath(); g.moveTo(16, 2); g.lineTo(30, 29); g.lineTo(2, 29); g.closePath();
    g.fillStyle = '#fff'; g.fill();
    return new THREE.CanvasTexture(c);
  }
  const dotTexture = makeDotTexture();
  const spawnTexture = makeTriangleTexture();
  const GIZMO_LIFT = 0.4; // world units above the ground a cell-based gizmo floats, so it reads over flat tile art instead of being half-buried in it
  /** @type {{mesh: THREE.Sprite, kind: string, index: number}[]} */
  let gizmos = [];

  function disposeGizmos() {
    for (const g of gizmos) { view.scene.remove(g.mesh); g.mesh.material.dispose(); }
    gizmos = [];
  }

  /**
   * `index` — a gizmo's position within `ENTITIES[kind].list(map)` — not the snapshot's own
   * item object. `rebuildGizmos` below builds from `map`, the SERIALIZED `.map.json`-shaped
   * snapshot `load()` works from (`serializeDocument`'s output), whose `npcs`/`markers`/
   * `lights`/`links`/`regions`/`spawnPoints` are all fresh `{...x}` clones of the live
   * document's own arrays (`state.js`'s `serializeDocument`) — never the same object references
   * `currentDoc.npcs[i]` etc. actually hold. `main.js` is the one place that owns `currentDoc`,
   * so it is the one place that can resolve an index back to the LIVE object
   * (`ENTITIES[kind].list(currentDoc)[index]`) before handing it to a `moveTo`/an inspector
   * card — the same re-resolution the pre-`entities.js` code already relied on (`currentDoc.
   * npcs[gizmo.index]`) for exactly this reason. Handing `main.js` the snapshot's own clone
   * instead would silently mutate a throwaway object on every drag/edit and never touch the
   * real document — confirmed as a real regression risk while reviewing this slice, not a
   * hypothetical one, which is why this file deals only in indices, never gizmo-carried refs.
   */
  function addGizmo(kind, index, x, y, z, color, texture, scale) {
    const material = new THREE.SpriteMaterial({ map: texture, color, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(x, y, z);
    sprite.scale.setScalar(scale);
    sprite.renderOrder = 999; // "always visible" per the plan — never occluded by a wall or a tree
    view.scene.add(sprite);
    gizmos.push({ mesh: sprite, kind, index });
  }

  /**
   * Rebuilds every draggable gizmo from the just-loaded map, driven by `ENTITIES` (`entities.
   * js`) instead of five hand-written blocks — one per kind whose own `gizmo` field is truthy,
   * placed via that kind's own `list`/`positionOf`. Cheap (a handful of sprites, not the tens of
   * thousands of tile instances `extraWorlds` holds), so a full rebuild on every `load()` — same
   * place `extraWorlds` itself rebuilds — is simpler than diffing and stays correct even when an
   * add/remove command changed how many there are.
   *
   * `map` is the SERIALIZED `.map.json`-shaped snapshot `load()` already works from, not the
   * live editable `doc` — `ENTITIES[k].list`/`positionOf` are written to accept either (see
   * `entities.js`'s own header, which verifies this field by field for every gizmo-bearing kind
   * used here: `spawn`/`markers`/`npcs`/`lights`/`spawnPoints` pass straight through
   * `serializeDocument`, `links`/`regions`/`loop.via` round-trip the same shape, and `cameras`
   * is not even cloned). Only `object`/`extraObject` would need an adapter (`tileLayers`/
   * `objects`/`extras` genuinely differ between the two shapes) — neither has a gizmo, so
   * neither is ever reached from here.
   */
  function rebuildGizmos(map) {
    disposeGizmos();
    const terrainApi = ctx.get('terrain');
    for (const [kind, entity] of Object.entries(ENTITIES)) {
      if (!entity.gizmo) continue;
      const texture = entity.gizmo === 'triangle' ? spawnTexture : dotTexture;
      entity.list(map).forEach((ref, index) => {
        const pos = entity.positionOf(map, ref);
        if (!pos) return; // e.g. a camera preset whose marker was deleted out from under it
        let x; let y; let z;
        if (entity.space === 'world') {
          x = pos.x; z = pos.z;
          y = (pos.y ?? 1) + GIZMO_LIFT * 0.5;
        } else {
          x = pos.cx + 0.5; z = pos.cz + 0.5;
          y = terrainApi.height(pos.cx, pos.cz) + GIZMO_LIFT;
        }
        // Light is the one gizmo whose color varies per-instance (`state.js`'s own authored
        // `light.color`, defaulting to the table's swatch) rather than being fixed per kind.
        const color = kind === 'light' ? (ref.color ?? entity.color) : entity.color;
        addGizmo(kind, index, x, y, z, color, texture, entity.scale ?? 0.6);
      });
    }
  }

  /** Gizmo hit-test, tried before `pickCell` on every `main.js` pointerdown — a click on a
   *  gizmo selects or drags THAT entity, not just the cell it happens to sit over. */
  function pickGizmo(clientX, clientY) {
    if (!gizmos.length) return null;
    raycaster.setFromCamera(ndcFromClient(clientX, clientY), view.camera);
    const hit = raycaster.intersectObjects(gizmos.map((g) => g.mesh))[0];
    if (!hit) return null;
    const found = gizmos.find((g) => g.mesh === hit.object);
    return found ? { kind: found.kind, index: found.index } : null;
  }

  /**
   * Moves one gizmo's sprite to a cell, visually only — no `doc`/history write. `main.js` calls
   * this on every `pointermove` while a gizmo drag is captured (only for a kind whose `ENTITIES`
   * entry actually has a `moveTo`, per its own guard), and only commits the real edit (through
   * the matching `tools.js` command, via `ENTITIES[kind].moveTo`, resolved against the LIVE doc
   * — see `addGizmo`'s own note on why an index, not a snapshot-derived ref) on `pointerup` —
   * one undo step per drag, not one per animation frame.
   */
  function moveGizmoTo(kind, index, cx, cz) {
    const g = gizmos.find((x) => x.kind === kind && x.index === index);
    if (!g) return;
    const y = ENTITIES[kind].space === 'world' ? g.mesh.position.y : ctx.get('terrain').height(cx, cz) + GIZMO_LIFT;
    g.mesh.position.set(cx + 0.5, y, cz + 0.5);
  }

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    const { frameDt, steps, alpha } = clock.beginFrame(now);
    for (let i = 0; i < steps; i++) registry.tick(clock.SIM_DT, ctx);
    registry.frame(frameDt, alpha, ctx);
    rig.update(frameDt);
    registry.lateFrame(frameDt, alpha, ctx);
    sun.update(rig.focus);
    view.render();
    // --- overlay pass (Slice 6): grid/collision/selection, drawn straight on top of the frame
    // `view.render()` just composited. `autoClear = false` so this draw does not wipe what was
    // just written; restored immediately after, or the NEXT frame's bloom blit chain breaks (it
    // relies on `autoClear` being on for its own internal `renderer.clear()` calls). See
    // `viewport/overlay.js`'s own header for why this needs no depth/aspect correction of its own.
    view.renderer.autoClear = false;
    view.renderer.render(overlay.scene, view.camera);
    view.renderer.autoClear = true;
  }
  requestAnimationFrame(frame);

  return {
    load, setTod, setFocus,
    panBy: camera.panBy, zoomSteps: camera.zoomSteps, setZoomCells: camera.setZoomCells,
    fitMap: camera.fitMap, getZoom: camera.getZoom,
    getYaw: camera.getYaw, setYaw,
    pickCell, pickGizmo, moveGizmoTo,
    dispose() {
      running = false;
      ro.disconnect();
      disposeExtras();
      disposeGizmos();
      dotTexture.dispose();
      spawnTexture.dispose();
      overlay.dispose();
      ctx.get('terrain').unload();
    },
  };
}
