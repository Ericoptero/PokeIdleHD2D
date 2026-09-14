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

      const env = ctx.get('environment');
      env.setBiomePreset?.(map.environmentPreset ?? map.biome);
      env.setWeather?.(map.weather?.[0] ?? 'clear', map.weather?.[1] ?? 0);
      if (env.lamps) {
        env.lamps.clear();
        for (const light of map.lights ?? []) env.lamps.add(light);
      }

      const spawn = map.spawn ?? { cx: map.w >> 1, cz: map.h >> 1 };
      const y = ctx.get('terrain').height(spawn.cx, spawn.cz);
      rig.setFocus(spawn.cx + 0.5, y, spawn.cz + 0.5, true);
      if (!hasFramedOnce) { hasFramedOnce = true; fitMap(map.w, map.h); }
    } catch (err) {
      log.error('preview: load failed', err);
    }
  }
  let hasFramedOnce = false;

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
    dispose() {
      running = false;
      ro.disconnect();
      disposeExtras();
      ctx.get('terrain').unload();
    },
  };
}
