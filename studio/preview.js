/**
 * preview.js — the live "Prévia HD-2D" pane: a second, small three.js game instance embedded
 * in the Studio, running the real `tiles`/`terrain`/`environment` modules so what the panel
 * shows IS the game's own render pipeline — the same models, the same autotile resolution,
 * the same dusk emissive ramp, the same per-cell multiply tint — not a CSS approximation of
 * one. If the preview draws it, the shipped game draws it identically (this is exactly what
 * `tools/mapstudio/parity.js` independently proves for the six shipped scenes).
 *
 * A minimal boot, not the full game: only `tiles`, `terrain` and `environment` are
 * registered (`registry.init(ctx, { only: [...] })`) — no `city`/`hunts`/`ui`/`simulation`,
 * so no NPCs, no dialogue, nothing that would try to touch a DOM the Studio does not have.
 *
 * Interactive since the Studio's P3 pass: `pickCell`/`pickGizmo` raycast the pane so `main.js`
 * can turn a click/drag into a cell (select, paint) or an entity (spawn/marker/npc/light,
 * rendered here as small always-visible sprites — see "gizmos" below). This is the only
 * raycaster in the codebase, scoped to the Studio on purpose; nothing about it assumes the
 * fixed 45-degree rig, but nothing outside the Studio has needed one yet either.
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

/** @param {{container: HTMLElement}} opts */
export async function makePreview({ container }) {
  const config = makeConfig('');
  const bus = makeBus({ onError: (err, meta) => log.error(`preview: bus listener threw on ${meta.type}`, err) });
  const registry = makeRegistry({ bus, log });
  const clock = makeClock();
  const rng = makeRng(config.seed, 'studio-preview');

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

  function disposeExtras() {
    for (const w of extraWorlds) w.dispose();
    extraWorlds = [];
  }

  /** @param {object} map a `.map.json`-shaped document (`@/terrain/mapfile.js` / `studio/state.js`) */
  async function load(map) {
    const gen = ++generation;
    try {
      ctx.get('terrain').registerMapFile('studio-preview', map);
      await ctx.get('terrain').load('studio-preview', {
        w: map.w, h: map.h, tileset: map.tileset, biome: map.biome, seed: map.seed,
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
      env.setBiomePreset?.(map.environmentPreset ?? map.biome);
      env.setWeather?.(map.weather?.[0] ?? 'clear', map.weather?.[1] ?? 0);
      if (env.lamps) {
        env.lamps.clear();
        for (const light of map.lights ?? []) env.lamps.add(light);
      }

      // Only a new/different map snaps the camera to spawn — an edit-triggered reload of the
      // SAME map id leaves the camera exactly where the admin left it (the confirmed bug this
      // replaces: this line used to run unconditionally, so hovering the 2D canvas — which
      // notifies on every `pointermove`, not just a drag — eventually fired a debounced reload
      // that snapped the 3D view back to spawn out from under whatever the admin was looking at).
      const isNewMap = map.id !== lastMapId;
      lastMapId = map.id;
      if (isNewMap) {
        const spawn = map.spawn ?? { cx: map.w >> 1, cz: map.h >> 1 };
        const y = ctx.get('terrain').height(spawn.cx, spawn.cz);
        rig.setFocus(spawn.cx + 0.5, y, spawn.cz + 0.5, true);
      }
      if (!hasFramedOnce) { hasFramedOnce = true; fitMap(map.w, map.h); }
    } catch (err) {
      log.error('preview: load failed', err);
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

  function resize() {
    view.resize(container.clientWidth || 1, container.clientHeight || 1);
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  // --- navigation: drag to pan, wheel to zoom, the game's own fixed 45° rig ------------------
  //
  // The rig (`@/core/render.js` `makeCameraRig`) is a fixed-pitch, locked-yaw follow camera by
  // construction — the sprite pre-stretch math and `dropEdgeOnTwins`'s billboard culling both
  // assume the camera never yaws. There is no pan()/zoom()/orbit() anywhere in the engine, only
  // `setFocus`/`update`/`fitFraming`/`frame` — this is the minimal navigation those four give.

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
   * for panning.
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

  // --- gizmos: spawn/marker/npc/light, always visible and draggable in 3D --------------------
  //
  // Sprites, not meshes with their own rotation logic: a sprite always faces the camera, so a
  // click always lands on a face-on shape regardless of the fixed 45-degree pitch, and
  // `Raycaster.intersectObjects` already knows how to hit-test one for free. One shared dot
  // texture plus one shared triangle texture (spawn only, so it reads as a distinct shape from
  // everything else — matching `canvas.js`'s own amber spawn glyph), tinted per instance through
  // `SpriteMaterial.color`, so this never allocates a canvas per gizmo.
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
  /** @type {{mesh: THREE.Sprite, kind: 'spawn'|'marker'|'npc'|'light', index: number|null}[]} */
  let gizmos = [];

  function disposeGizmos() {
    for (const g of gizmos) { view.scene.remove(g.mesh); g.mesh.material.dispose(); }
    gizmos = [];
  }

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
   * Rebuilds every draggable gizmo from the just-loaded map. Cheap (a handful of sprites, not
   * the tens of thousands of tile instances `extraWorlds` holds), so a full rebuild on every
   * `load()` — same place `extraWorlds` itself rebuilds — is simpler than diffing and stays
   * correct even when an add/remove command changed how many there are. Colors match
   * `canvas.js`'s own 2D glyphs (`#E0A64B` spawn, `#7FC98C` markers, `#9ECBE6` NPCs) so the two
   * views read as one document, not two independent renderings of it.
   */
  function rebuildGizmos(map) {
    disposeGizmos();
    const terrain = ctx.get('terrain');
    const spawn = map.spawn ?? { cx: map.w >> 1, cz: map.h >> 1 };
    addGizmo('spawn', null, spawn.cx + 0.5, terrain.height(spawn.cx, spawn.cz) + GIZMO_LIFT, spawn.cz + 0.5, 0xE0A64B, spawnTexture, 0.9);
    (map.markers ?? []).forEach((m, i) => addGizmo(
      'marker', i, m.cx + 0.5, terrain.height(m.cx, m.cz) + GIZMO_LIFT, m.cz + 0.5, 0x7FC98C, dotTexture, 0.6,
    ));
    (map.npcs ?? []).forEach((n, i) => addGizmo(
      'npc', i, n.cx + 0.5, terrain.height(n.cx, n.cz) + GIZMO_LIFT, n.cz + 0.5, 0x9ECBE6, dotTexture, 0.6,
    ));
    // Lights are already world-space (`state.js`'s header) — no `+0.5` here, unlike the
    // cell-based gizmos above.
    (map.lights ?? []).forEach((l, i) => addGizmo(
      'light', i, l.x, (l.y ?? 1) + GIZMO_LIFT * 0.5, l.z, l.color ?? 0xE0A64B, dotTexture, 0.5,
    ));
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
   * this on every `pointermove` while a gizmo drag is captured, and only commits the real edit
   * (through the matching `tools.js` command) on `pointerup` — one undo step per drag, not one
   * per animation frame.
   */
  function moveGizmoTo(kind, index, cx, cz) {
    const g = gizmos.find((x) => x.kind === kind && x.index === index);
    if (!g) return;
    const y = kind === 'light' ? g.mesh.position.y : ctx.get('terrain').height(cx, cz) + GIZMO_LIFT;
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
  }
  requestAnimationFrame(frame);

  return {
    load, setTod, setFocus, panBy, zoomSteps, setZoomCells, fitMap, getZoom,
    pickCell, pickGizmo, moveGizmoTo,
    dispose() {
      running = false;
      ro.disconnect();
      disposeExtras();
      disposeGizmos();
      dotTexture.dispose();
      spawnTexture.dispose();
      ctx.get('terrain').unload();
    },
  };
}
