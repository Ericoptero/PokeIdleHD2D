/**
 * Boot. Wires core, registers every module, and runs the frame loop.
 *
 * Two contracts the screenshot harness depends on (ARCHITECTURE §8) and that must never
 * regress: `window.__READY__` flips true exactly once the first real frame has been
 * presented, and `window.__HOOKS__` exposes deterministic camera / time / seed control.
 */

import * as THREE from 'three';
import { makeBus } from './core/bus.js';
import { makeRegistry } from './core/registry.js';
import { makeClock } from './core/clock.js';
import { makeConfig } from './core/config.js';
import { makeRng } from './core/rng.js';
import { log } from './core/log.js';
import { makeRenderer, makeCameraRig, makeSunShadow } from './core/render.js';

import tiles from './tiles/index.js';
import terrain from './terrain/index.js';
import environment from './environment/index.js';
import pokemon from './pokemon/index.js';
import simulation from './simulation/index.js';
import travel from './travel/index.js';
import battle from './battle/index.js';
import encounter from './encounter/index.js';
import economy from './economy/index.js';
import collection from './collection/index.js';
import idle from './idle/index.js';
import offline from './offline/index.js';
import automation from './automation/index.js';
import ui from './ui/index.js';
import city from './city/index.js';
import hunts from './hunts/index.js';
import preview from './preview/index.js';

// `travel` sits after `simulation` and **before `offline`** on purpose: `offline` builds its
// provider list during its own `init`, so a module registered after it never gets a save
// slice — and the scene the player was standing in would be lost on every reload.
//
// `battle` sits before `encounter` for the same class of reason and one of its own: it
// declares `needs: []` and fetches 330 KB of move data in its own `init`, so starting it early
// overlaps that fetch with the tile packs instead of stalling `encounter` behind it. It also
// keeps the registry's alphabetical tie-break from deciding the order for us (DECISIONS #61).
const MODULES = [
  tiles, terrain, environment, pokemon, simulation, travel, battle, encounter,
  economy, collection, idle, offline, automation, ui, city, hunts, preview,
];

const bootEl = document.getElementById('boot');
const fatalEl = document.getElementById('fatal');
const progress = bootEl?.querySelector('.bar i');
const setProgress = (p, label) => {
  if (progress) progress.style.width = `${Math.round(p * 100)}%`;
  const t = bootEl?.querySelector('p');
  if (t && label) t.textContent = label;
};

function fatal(err) {
  log.error('fatal', err);
  if (fatalEl) fatalEl.textContent = `startup failed: ${err?.message ?? err}\n${err?.stack ?? ''}`;
  bootEl?.classList.add('gone');
  window.__READY__ = true;      // let the harness capture the failure instead of timing out
  window.__FATAL__ = String(err?.message ?? err);
}

async function boot() {
  const t0 = performance.now();
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
    three: {
      renderer: view.renderer, scene: view.scene, camera: view.camera,
      view, rig, sun,
    },
    get: (id) => registry.get(id),
  };
  window.__CTX__ = ctx;

  for (const m of MODULES) {
    try { registry.add(m); } catch (err) { log.error('registry.add failed', err); }
  }

  // ?showcase=<id> boots only that module, what it needs, and whatever its showcase needs
  // to stage a scene (ARCHITECTURE §6).
  const showcase = config.showcase;
  setProgress(0.15, showcase ? `showcase: ${showcase}` : 'initialising');
  const showcaseOnly = showcase
    ? [showcase, ...(registry.descriptor(showcase)?.showcaseNeeds ?? []), 'environment', 'ui']
    : null;
  await registry.init(ctx, { only: showcaseOnly });
  setProgress(0.75, 'staging');

  if (showcase) {
    try {
      await registry.showcase(showcase, new URLSearchParams(location.search).get('mode') ?? 'default', ctx);
    } catch (err) {
      log.error(`showcase "${showcase}" failed`, err);
    }
  } else {
    // Where the player was: `?scene=` first so the harness can frame a hunt at `/`, then the
    // save, then the lobby. A quarantined `travel` costs the game travel, not its lobby, so
    // the old direct call is kept as the fallback (§2.1).
    try {
      const nav = registry.get('travel');
      if (nav && nav.__missing === undefined && typeof nav.go === 'function') {
        // `go()` answers `false` rather than throwing — a locked destination, a scene whose
        // owner is quarantined, a map that failed to build. The one thing a boot may not do is
        // leave the player looking at an empty view, so a refusal falls back to the lobby.
        const ok = await nav.go(nav.boot());
        if (!ok && nav.current?.() == null) await nav.go('demo-city');
      } else {
        const lobby = registry.has('city') ? 'city' : 'hunts';
        await registry.get(lobby).enter?.();
      }
    } catch (err) {
      log.error('entering the first scene failed', err);
    }
  }

  // --- sizing ---------------------------------------------------------------
  const resize = () => view.resize(stage.clientWidth || innerWidth, stage.clientHeight || innerHeight);
  resize();
  addEventListener('resize', resize);
  config.onChange(resize);

  // --- metrics --------------------------------------------------------------
  const fpsWindow = [];
  let lastPerfEmit = 0;
  let lastStats = view.stats();

  function sampleFps(frameDt) {
    fpsWindow.push(frameDt * 1000);
    if (fpsWindow.length > 240) fpsWindow.shift();
  }
  function metrics() {
    const sorted = [...fpsWindow].sort((a, b) => a - b);
    const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    return {
      fps: { mean: mean ? +(1000 / mean).toFixed(1) : 0, p95ms: sorted.length ? +sorted[Math.floor(sorted.length * 0.95)].toFixed(2) : 0, samples: sorted.length },
      ...lastStats,
      tod: registry.get('environment').getTimeOfDay?.() ?? config.tod,
      seed: config.seed,
      modules: registry.status(),
      consoleErrors: log.errors().map((e) => e.text),
      consoleWarnings: log.warnings().map((e) => e.text).slice(0, 40),
    };
  }

  // --- frame loop -----------------------------------------------------------
  let running = true;
  let firstFrameDone = false;

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    const { frameDt, steps, alpha } = clock.beginFrame(now);

    for (let i = 0; i < steps; i++) registry.tick(clock.SIM_DT, ctx);
    registry.frame(frameDt, alpha, ctx);

    rig.update(frameDt);
    // The camera is placed; now the work that has to read it. `pokemon` lands its sprites on
    // the internal pixel grid here, and doing it in `frame` snapped them against the camera
    // of the frame before — one frame of camera motion of error, every frame, which is a
    // different sub-pixel offset each time and reads on screen as the sprites reshaping.
    registry.lateFrame(frameDt, alpha, ctx);
    sun.update(rig.focus);
    view.render();
    lastStats = view.stats();
    sampleFps(frameDt);

    if (now - lastPerfEmit > 1000) {
      lastPerfEmit = now;
      bus.emit('perf:sample', { fps: metrics().fps.mean, drawCalls: lastStats.drawCalls, tris: lastStats.triangles });
    }

    if (!firstFrameDone) {
      firstFrameDone = true;
      setProgress(1, 'ready');
      bootEl?.classList.add('gone');
      const ms = Math.round(performance.now() - t0);
      bus.emit('boot:ready', { ms });
      log.info(`boot ready in ${ms}ms`, registry.status().map((s) => `${s.id}:${s.status}`).join(' '));
      window.__READY__ = true;
    }
  }
  requestAnimationFrame(frame);

  // --- harness hooks (ARCHITECTURE §8) --------------------------------------
  window.__HOOKS__ = {
    setPreset(name) {
      const env = registry.get('environment');
      // Follow the scene actually in the world: with `?scene=hunt-forest` a preset asked for
      // here would otherwise be handed to `city`, which does not know the framing.
      const nav = registry.get('travel');
      const owner = (nav && nav.__missing === undefined ? nav.current?.()?.module : null)
        ?? (registry.has('city') ? 'city' : 'hunts');
      const scene = registry.get(owner);
      if (scene.preset?.(name)) return true;
      if (env.preset?.(name)) return true;
      log.warn(`no camera preset "${name}"`);
      return false;
    },
    setTimeOfDay(tod) { config.set({ tod: Number(tod) }); registry.get('environment').setTimeOfDay?.(Number(tod)); },
    setSeed(n) { config.set({ seed: Number(n) }); },
    setConfig(patch) { config.set(patch); resize(); },
    /**
     * Advances the world by `n` fixed sim ticks.
     *
     * A showcase freezes the walk when it has staged its frame, and a frozen `simulation`
     * ignores `registry.tick` outright — so stepping the registry alone moved nothing and the
     * parity gate's "two frames one step apart" was silently comparing a frame with itself.
     * `advanceSteps` is the module's own way through its freeze, and it is the one the harness
     * wants: everything else about the staged frame stays exactly where the showcase put it.
     */
    step(n = 1) {
      const sim = registry.get('simulation');
      if (sim?.frozen?.() && typeof sim.advanceSteps === 'function') sim.advanceSteps(n);
      else for (let i = 0; i < n; i++) registry.tick(clock.SIM_DT, ctx);
      clock.forceSteps(n);
    },
    focus(cx, cz, y = 0) { rig.setFocus(cx + 0.5, y, cz + 0.5, true); },
    /**
     * Presses a key, for real: a `KeyboardEvent` on `window`, so it goes through `ui/input.js`'s
     * own listeners and proves the shipped path rather than a private one. `shoot.js` cannot
     * type, and "the arrow keys do nothing in a hunt" is not a claim a still frame can make.
     */
    key(code, down = true) {
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
      return code;
    },
    /**
     * The pixel grid, for `tools/shots/parity.js`: the internal buffer, the one density the
     * whole scene draws at, and where each sprite's feet landed on it. The claim under test is
     * that every one of these is identical on a phone and on an ultrawide (DECISIONS #60).
     */
    grid() {
      const pk = registry.get('pokemon');
      const g = pk?.sprites?.field?.grid?.() ?? {};
      return { ...g, internal: view.internalSize, displayRect: view.displayRect,
        pixelScale: config.pixelScale, viewport: [innerWidth, innerHeight] };
    },
    metrics,
    /** Drops the fps window so a measurement excludes shader compilation and streaming. */
    resetMetrics() { fpsWindow.length = 0; },
    events: () => bus.spy().slice(-256),
    modules: () => registry.status(),
    pause() { running = false; },
    resume() { if (!running) { running = true; requestAnimationFrame(frame); } },
  };
}

boot().catch(fatal);
addEventListener('error', (e) => log.error('uncaught', e.error ?? e.message));
addEventListener('unhandledrejection', (e) => log.error('unhandled rejection', e.reason));
