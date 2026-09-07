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

const MODULES = [
  tiles, terrain, environment, pokemon, simulation, encounter,
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
  const rig = makeCameraRig({ camera: view.camera, config });
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
    // The default scene is the city lobby; if it is down, fall back to a hunt so the page
    // is never blank for the agents screenshotting it.
    const lobby = registry.has('city') ? 'city' : 'hunts';
    try {
      await registry.get(lobby).enter?.();
    } catch (err) {
      log.error(`entering "${lobby}" failed`, err);
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
      const scene = registry.has('city') ? registry.get('city') : registry.get('hunts');
      if (scene.preset?.(name)) return true;
      if (env.preset?.(name)) return true;
      log.warn(`no camera preset "${name}"`);
      return false;
    },
    setTimeOfDay(tod) { config.set({ tod: Number(tod) }); registry.get('environment').setTimeOfDay?.(Number(tod)); },
    setSeed(n) { config.set({ seed: Number(n) }); },
    setConfig(patch) { config.set(patch); resize(); },
    step(n = 1) { for (let i = 0; i < n; i++) { registry.tick(clock.SIM_DT, ctx); } clock.forceSteps(n); },
    focus(cx, cz, y = 0) { rig.setFocus(cx + 0.5, y, cz + 0.5, true); },
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
