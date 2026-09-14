/**
 * studio/snapshot/main.js — proves a `.map.json` round-trips exactly through the real engine.
 *
 * Every map is authored in the Map Studio and loaded straight from its own file now — nothing
 * generates one from code, so this page no longer "freezes" a code-built scene the way it
 * once did. What is still worth proving, and the only thing this page does now: fetch a
 * shipped map file (`before`), replay it onto a fresh draft through the real `terrain`/`tiles`
 * modules (`src/terrain/frommap.js`), freeze the result the same way the Studio's own exporter
 * does (`src/terrain/mapfile.js`), and hand both back so `tools/mapstudio/roundtrip.js` can
 * assert they are semantically identical. That guarantee is what makes a map file trustworthy
 * at all — the Studio, and every scene that loads one, rest on it.
 *
 * A minimal boot, not the full game: only `tiles`, `terrain` and `environment` register, the
 * same subset `studio/viewport/index.js` uses — replaying a map needs no NPCs, no battle, no economy.
 *
 * Driven by `tools/mapstudio/roundtrip.js` over `puppeteer-core`, the same way
 * `tools/shots/shoot.js` drives a capture — this page never runs on its own.
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

import { draftToMapFile, parseMapFile } from '@/terrain/mapfile.js';

const MODULES = [tiles, terrain, environment];

async function boot() {
  const config = makeConfig();
  const bus = makeBus({ onError: (err, meta) => log.error(`bus listener threw on ${meta.type}`, err) });
  const registry = makeRegistry({ bus, log });
  const clock = makeClock();
  const rng = makeRng(config.seed, 'root');

  const stage = document.getElementById('stage');
  const view = makeRenderer({ container: stage, config, log });
  const rig = makeCameraRig({ camera: view.camera, config, view });
  const sun = makeSunShadow({ config });
  view.scene.add(sun.light, sun.light.target);

  const ctx = {
    THREE, registry, bus, clock, rng, config, log,
    three: { renderer: view.renderer, scene: view.scene, camera: view.camera, view, rig, sun },
    get: (id) => registry.get(id),
  };
  window.__CTX__ = ctx;

  for (const m of MODULES) {
    try { registry.add(m); } catch (err) { log.error('registry.add failed', err); }
  }
  await registry.init(ctx);
  window.__READY__ = true;

  const resolveModel = (slug, id) => ctx.get('tiles').byId(slug, id);

  /**
   * Fetches and parses `/maps/<id>.map.json` — the same fetch `terrain.loadMapFile` does at
   * runtime, kept separate here so `before` is the file exactly as shipped, untouched by any
   * replay.
   */
  async function fetchMap(mapId) {
    const res = await fetch(`/maps/${mapId}.map.json`);
    if (!res.ok) throw new Error(`snapshot: /maps/${mapId}.map.json ${res.status}`);
    return parseMapFile(await res.json());
  }

  /**
   * The round-trip proof `tools/mapstudio/roundtrip.js` drives: fetch a shipped map file
   * (`before`), replay it through `terrain.registerMapFile` + `applyMapFile` onto a fresh
   * draft, freeze the result the same way the Studio's own exporter does (`after`). Exact
   * equality between the two — on everything that matters, not byte-for-byte JSON — is what
   * makes the format trustworthy.
   */
  window.__ROUNDTRIP__ = async (mapId) => {
    const before = await fetchMap(mapId);
    const rtId = `${mapId}::roundtrip`;
    ctx.get('terrain').registerMapFile(rtId, before);
    await ctx.get('terrain').load(rtId, {
      w: before.w, h: before.h, tileset: before.tileset, seed: before.seed,
    });
    const draft = ctx.get('terrain').draft();
    const report = ctx.get('terrain').report();
    const after = draftToMapFile(draft, {
      name: before.name, kind: before.kind, resolveModel,
      requiredLevel: before.requiredLevel, weather: before.weather,
      environmentPreset: before.environmentPreset, economy: before.economy,
      extras: report?.extras ?? [],
      spawnPoints: before.spawnPoints, loop: before.loop,
      npcs: before.npcs, links: before.links, lights: report?.lights ?? before.lights,
      cameras: before.cameras, formation: before.formation, tags: before.tags,
    });
    return { before, after };
  };

  /** Every map the manifest lists, for `roundtrip.js` to iterate without a hardcoded list. */
  window.__SNAPSHOT_LIST__ = async () => {
    const res = await fetch('/maps/index.json');
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list.map((m) => m.id) : [];
  };
}

boot().catch((err) => { log.error('snapshot boot failed', err); window.__READY__ = true; window.__FATAL__ = String(err?.message ?? err); });
