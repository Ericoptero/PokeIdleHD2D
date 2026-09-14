/**
 * studio/snapshot/main.js — boots the real game module stack, headless, to freeze each of
 * the six shipped maps into a `.map.json` (`src/terrain/mapfile.js`).
 *
 * Why this has to be a browser page and not a Node script: `src/hunts/selftest.js`'s own
 * header documents the two traps a Node-side stand-in falls into. Loading the real tile pack
 * needs `THREE.TextureLoader` and a DOM, so a stub tileset gives every multi-cell model the
 * stub's footprint, not AdAstra's — and the buffer fixups a real load runs
 * (`rewindDownwardFaces`, `liftNormalsAboveHorizon`, `dropEdgeOnTwins`, `src/tiles/index.js`)
 * feed `armsOf`, which the fence autotile solver reads. Worse: the RNG stream a scene forks
 * (`root/hunts/<biome>/<seed>`, `src/main.js`) is a different label path than a hand-rolled
 * `makeRng(seed, 'hunts/<biome>')` — a different stream, therefore a different map, cell for
 * cell, silently. Only a real boot sees the real stream.
 *
 * Driven by `tools/mapstudio/snapshot.js` over `puppeteer-core`, the same way
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
import pokemon from '@/pokemon/index.js';
import simulation from '@/simulation/index.js';
import travel from '@/travel/index.js';
import battle from '@/battle/index.js';
import encounter from '@/encounter/index.js';
import economy from '@/economy/index.js';
import collection from '@/collection/index.js';
import idle from '@/idle/index.js';
import offline from '@/offline/index.js';
import automation from '@/automation/index.js';
import ui from '@/ui/index.js';
import city from '@/city/index.js';
import hunts from '@/hunts/index.js';
import pokecenter from '@/pokecenter/index.js';
import preview from '@/preview/index.js';

import { draftToMapFile } from '@/terrain/mapfile.js';
import { NPCS as CITY_NPCS, PRESETS as CITY_PRESETS, FORMATION as CITY_FORMATION } from '@/city/layout.js';
import { NURSE, PRESETS as PC_PRESETS, FORMATION as PC_FORMATION } from '@/pokecenter/layout.js';

const MODULES = [
  tiles, terrain, environment, pokemon, simulation, travel, battle, encounter,
  economy, collection, idle, offline, automation, ui, city, hunts, pokecenter, preview,
];

/** The six shipped maps and how to build each — mirrors `travel/index.js`'s destination list. */
const TARGETS = [
  { mapId: 'demo-city', owner: 'city', kind: 'city', name: 'Demo City' },
  { mapId: 'pokecenter', owner: 'pokecenter', kind: 'interior', name: 'Pokémon Center' },
  { mapId: 'hunt-forest', owner: 'hunts', kind: 'hunt', biomeId: 'forest' },
  { mapId: 'hunt-meadow', owner: 'hunts', kind: 'hunt', biomeId: 'meadow' },
  { mapId: 'hunt-cave', owner: 'hunts', kind: 'hunt', biomeId: 'cave' },
  { mapId: 'hunt-coast', owner: 'hunts', kind: 'hunt', biomeId: 'coast' },
];

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

  /** Teed lamp specs — `city`/`pokecenter` register lights with `environment` rather than
   *  returning them, unlike `hunts` (`hunts.stats(id).lights` is already public). Patched
   *  once, at module scope, so it survives across every `enter()` call this page makes. */
  let capturedLights = [];
  const env = ctx.get('environment');
  if (env?.lamps && typeof env.lamps.add === 'function') {
    const realAdd = env.lamps.add.bind(env.lamps);
    env.lamps.add = (spec) => { capturedLights.push(spec); return realAdd(spec); };
  }

  const resolveModel = (slug, id) => ctx.get('tiles').byId(slug, id);

  async function snapshot(mapId) {
    const t = TARGETS.find((x) => x.mapId === mapId);
    if (!t) throw new Error(`snapshot: unknown map "${mapId}"`);
    capturedLights = [];

    if (t.owner === 'city') {
      await ctx.get('city').enter();
      const stats = ctx.get('city').stats();
      const draft = ctx.get('terrain').draft();
      return draftToMapFile(draft, {
        name: t.name, kind: t.kind, module: t.owner, resolveModel,
        source: { builder: 'src/city/map.js + src/city/structures.js', snapshotAt: new Date().toISOString() },
        extras: stats.extras ?? [],
        lights: capturedLights,
        npcs: CITY_NPCS.map((n) => ({ ...n })),
        cameras: { default: 'default', presets: CITY_PRESETS },
        formation: CITY_FORMATION,
        environmentPreset: 'city',
      });
    }

    if (t.owner === 'pokecenter') {
      await ctx.get('pokecenter').enter();
      const stats = ctx.get('pokecenter').stats();
      const draft = ctx.get('terrain').draft();
      return draftToMapFile(draft, {
        name: t.name, kind: t.kind, module: t.owner, resolveModel,
        source: { builder: 'src/pokecenter/map.js + src/pokecenter/dress.js', snapshotAt: new Date().toISOString() },
        extras: stats.extras ?? [],
        lights: capturedLights,
        npcs: [{ name: 'nurse', display: 'Nurse Joy', trainer: 'heroine', cx: NURSE.cx, cz: NURSE.cz, dir: NURSE.dir }],
        cameras: { default: 'default', presets: PC_PRESETS },
        formation: PC_FORMATION,
        environmentPreset: 'interior',
      });
    }

    // hunts
    const hunts_ = ctx.get('hunts');
    await hunts_.enter(t.biomeId);
    const descriptor = hunts_.descriptor(t.biomeId);
    const report = hunts_.stats(t.biomeId);
    const draft = ctx.get('terrain').draft();
    return draftToMapFile(draft, {
      name: descriptor.name, kind: 'hunt', module: 'hunts', resolveModel,
      source: { builder: `src/hunts/biomes/${t.biomeId}.js`, snapshotAt: new Date().toISOString() },
      requiredLevel: descriptor.requiredLevel ?? 0,
      weather: descriptor.weather ?? null,
      environmentPreset: descriptor.preset,
      extras: report?.extras ?? [],
      lights: report?.lights ?? [],
      // `report.loop`/`report.slots` are exactly `stitchLoop`/`slotsForLoop`'s own output
      // (`src/hunts/index.js`'s `built` map) — cached verbatim so validation and the Studio's
      // loop/encounter overlays run off pure JSON (`src/terrain/validate.js`'s own header).
      loop: report?.loop ? { via: descriptor.loop?.via ?? null, resolved: { derived: true, ...report.loop } } : null,
      wild: report?.slots?.length ? { resolved: { derived: true, slots: report.slots } } : null,
      encounters: { table: t.biomeId },
      cameras: { default: descriptor.showcaseDefault ?? null, presets: descriptor.presets ?? {} },
      formation: hunts_.biome(t.biomeId)?.formation ?? null,
    });
  }

  window.__SNAPSHOT_LIST__ = () => TARGETS.map((t) => t.mapId);
  window.__SNAPSHOT__ = async (mapId) => snapshot(mapId);

  /**
   * The round-trip proof `tools/mapstudio/roundtrip.js` drives: freeze a map the normal way
   * (`before`), replay that JSON through `terrain.registerMapFile` + `frommap.js`, freeze the
   * result the same way (`after`). Exact equality between the two is what makes the format
   * trustworthy — see `src/terrain/frommap.js`'s own header for the replay-order argument.
   */
  window.__ROUNDTRIP__ = async (mapId) => {
    const before = await snapshot(mapId);
    const rtId = `${mapId}::roundtrip`;
    ctx.get('terrain').registerMapFile(rtId, before);
    await ctx.get('terrain').load(rtId, {
      w: before.w, h: before.h, tileset: before.tileset, biome: before.biome, seed: before.seed,
    });
    const draft = ctx.get('terrain').draft();
    const report = ctx.get('terrain').report();
    const after = draftToMapFile(draft, {
      name: before.name, kind: before.kind, module: before.module, resolveModel,
      source: before.source, requiredLevel: before.requiredLevel, weather: before.weather,
      environmentPreset: before.environmentPreset,
      extras: report?.extras ?? [], lights: report?.lights ?? [],
      loop: before.loop, wild: before.wild, encounters: before.encounters,
      npcs: before.npcs, links: before.links, cameras: before.cameras, formation: before.formation,
    });
    return { before, after };
  };
}

boot().catch((err) => { log.error('snapshot boot failed', err); window.__READY__ = true; window.__FATAL__ = String(err?.message ?? err); });
