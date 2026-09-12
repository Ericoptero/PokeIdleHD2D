#!/usr/bin/env node
/**
 * The verification loop (src/main.js). Loads the running dev server in headless Chrome,
 * waits for the app to say it is ready, sets a camera preset and a time of day, lets the
 * scene settle, then writes a PNG next to a JSON log of fps, draw calls, module status and
 * every console error.
 *
 *   node tools/shots/shoot.js --out shots/out/city/noon.png \
 *        --showcase city --preset plaza --tod 12 --size 1920x1080
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { decodePng, sceneStats } from './png.js';
import { CHROME, assertChrome, chromeArgs } from './chrome.js';

export function parseArgs(argv) {
  const a = { base: 'http://127.0.0.1:5173', size: '1920x1080', tod: null, preset: null,
    showcase: null, mode: null, seed: null, settle: 30, out: null, timeout: 30000,
    focus: null, pixelScale: null, software: false, debug: false, hidden: false, retries: 3,
    steps: null, extra: {} };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    const flagOnly = next === undefined || next.startsWith('--');
    const v = flagOnly ? true : argv[++i];
    if (key in a) a[key] = v;
    else a.extra[key] = v;
  }
  return a;
}

/**
 * Takes one screenshot, retrying a page that navigated out from under us. Several agents
 * edit the tree at once and Vite reloads the page on every save, so a capture that lands
 * mid-reload is normal traffic rather than a failure.
 */
export async function shoot(opts) {
  const attempts = Number(opts.retries ?? 3);
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await shootOnce(opts);
    const transient = last.error && /Execution context was destroyed|Target closed|detached Frame|Navigation/i.test(last.error);
    if (!transient) return last;
    await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
  }
  return last;
}

async function shootOnce(opts) {
  const a = { ...opts };
  const [w, h] = String(a.size).split('x').map(Number);
  const out = resolve(a.out);
  mkdirSync(dirname(out), { recursive: true });

  assertChrome();

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    // The flags live in chrome.js so the flow tests launch the same browser the same way; see
    // there for why the real GPU is the default and `--software` exists.
    args: ['--headless=new', ...chromeArgs({ software: !!a.software }), `--window-size=${w},${h}`],
    defaultViewport: { width: w, height: h, deviceScaleFactor: 1 },
  });

  const page = await browser.newPage();
  // Never screenshot a cached asset. Vite serves `public/` with far-future caching, so after
  // an asset rebuild the page can fetch a stale pack.bin whose offsets no longer match the
  // catalog it is paired with: the draw calls and triangle count look completely normal and
  // the scene renders nothing. That failure is indistinguishable from a real bug, which is
  // exactly the kind of thing this harness exists to rule out.
  await page.setCacheEnabled(false);
  const consoleErrors = [];
  const consoleWarnings = [];
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error') consoleErrors.push(msg.text());
    else if (t === 'warning') consoleWarnings.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => consoleErrors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`));

  const params = new URLSearchParams();
  if (a.showcase) params.set('showcase', a.showcase);
  if (a.mode) params.set('mode', a.mode);
  if (a.tod != null) params.set('tod', a.tod);
  if (a.seed != null) params.set('seed', a.seed);
  if (a.pixelScale != null) params.set('pixelScale', a.pixelScale);
  // Freeze the clock by default: environment advances the time of day every sim step, so
  // without this the same URL does not give the same pixels and tools/shots/shoot.js is a lie.
  if (a.extra?.timeFrozen === undefined) params.set('timeFrozen', '1');
  params.set('debug', a.debug ? '1' : '0');
  for (const [k, v] of Object.entries(a.extra ?? {})) params.set(k, v);
  const url = `${a.base}/?${params}`;

  const t0 = Date.now();
  const log = { url, out, size: [w, h], preset: a.preset ?? null, tod: a.tod ?? null, ok: false };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(a.timeout) });
    await page.waitForFunction('window.__READY__ === true', { timeout: Number(a.timeout), polling: 100 });
    // tools/shots/shoot.js budgets a 6 s cold start. It was collected by nobody, so a boot that crept from 2 s
    // to 5.9 s was invisible until it crossed the timeout and became a hard failure instead.
    log.readyMs = Date.now() - t0;

    const fatal = await page.evaluate(() => window.__FATAL__ ?? null);
    if (fatal) log.fatal = fatal;

    if (a.preset) {
      log.presetApplied = await page.evaluate((p) => window.__HOOKS__?.setPreset?.(p) ?? false, a.preset);
    }
    if (a.tod != null) await page.evaluate((t) => window.__HOOKS__?.setTimeOfDay?.(Number(t)), a.tod);
    if (a.focus) {
      const [fx, fz] = String(a.focus).split(',').map(Number);
      await page.evaluate((x, z) => window.__HOOKS__?.focus?.(x, z), fx, fz);
    }

    // `--steps N` advances the simulation by N fixed sim ticks and stops. It is how the
    // parity gate takes two frames one step apart: with the clock frozen, the only difference
    // between them is that the party walked, which is exactly the claim being tested
    // ("nothing changes when I walk").
    if (a.steps != null) await page.evaluate((n) => window.__HOOKS__?.step?.(Number(n)), a.steps);

    // Settle springs, streaming and shader compilation; then throw away that fps window and
    // measure a clean one, so the number in the log is steady-state and not warm-up.
    const spin = (n) => page.evaluate((k) => new Promise((done) => {
      let i = 0;
      const step = () => (++i >= k ? done() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    }), Number(n));
    await spin(a.settle);
    await page.evaluate(() => window.__HOOKS__?.resetMetrics?.());

    // `--hidden` proves the thing the idle brief is actually about: that the game keeps
    // accruing with the tab in the background. A second tab is opened and brought to the
    // front, which is what makes the browser report `document.hidden` and throttle
    // requestAnimationFrame on this one — nothing else in headless Chrome does.
    let backgrounder = null;
    if (a.hidden) {
      backgrounder = await browser.newPage();
      await backgrounder.goto('about:blank');
      await backgrounder.bringToFront();
      log.hidden = await page.evaluate(() => document.hidden);
      await new Promise((r) => setTimeout(r, Number(a.hiddenMs ?? 5000)));
      await page.bringToFront();
      await backgrounder.close();
      // rAF was throttled while hidden, so the fps window is meaningless; take a fresh one.
      await spin(a.settle);
      await page.evaluate(() => window.__HOOKS__?.resetMetrics?.());
    }
    await spin(60);

    // The pixel grid this shot was actually drawn on. Cheap, and it turns "the sprites are
    // bigger on my laptop" from a thing you argue about into a number in every shot's JSON.
    log.grid = await page.evaluate(() => window.__HOOKS__?.grid?.() ?? null);
    // Every destination `travel` will accept, so `tools/shots/boot.js` derives its matrix
    // from the running tree instead of carrying a list that goes stale when a biome is added.
    log.destinations = await page.evaluate(() => window.__HOOKS__?.destinations?.() ?? []);
    // How much text the DOM layer is actually showing. Some showcases prove themselves with
    // evidence rather than with a frame — `battle` and `economy` print real transcripts and
    // real ledgers — and for those a draw-call count says nothing at all: a broken one draws
    // exactly as much empty stage as a working one. This is their floor.
    log.uiChars = await page.evaluate(() => (document.getElementById('ui')?.innerText ?? '').trim().length);
    const metrics = await page.evaluate(() => window.__HOOKS__?.metrics?.() ?? null);
    const events = await page.evaluate(() => window.__HOOKS__?.events?.().slice(-64) ?? []);
    Object.assign(log, metrics ?? {}, { events });

    await page.screenshot({ path: out, type: 'png' });
    // Statistics come from the file a critic would open, not from the WebGL buffer — that
    // reads back black once the frame is presented, and preserving it would cost every
    // frame the game ever draws. `hudRows` skips the HUD: measuring with the cream panels
    // in frame reads p99 234 where the scene itself reaches 150, which is exactly how a real
    // defect once got reported as "does not reproduce".
    try {
      log.scene = sceneStats(decodePng(readFileSync(out)), { hudRows: Number(a.hudRows ?? 0) });
    } catch (err) {
      log.sceneError = String(err.message ?? err);
    }
    log.ok = !log.fatal && consoleErrors.length === 0;
  } catch (err) {
    log.error = String(err.message ?? err);
    try { await page.screenshot({ path: out, type: 'png' }); } catch { /* nothing to save */ }
  } finally {
    log.consoleErrors = [...new Set([...(log.consoleErrors ?? []), ...consoleErrors])];
    log.consoleWarnings = [...new Set([...(log.consoleWarnings ?? []), ...consoleWarnings])].slice(0, 40);
    log.ms = Date.now() - t0;
    writeFileSync(out.replace(/\.png$/, '.json'), JSON.stringify(log, null, 1));
    await browser.close();
  }
  return log;
}

/** Budget check (tools/shots/shoot.js), so a passing screenshot is a passing *measurement*. */
export function checkBudgets(log, a = {}) {
  const fails = [];
  if (log.consoleErrors?.length) fails.push(`${log.consoleErrors.length} console errors`);
  if (log.fatal) fails.push(`fatal: ${log.fatal}`);
  if (log.error) fails.push(`harness: ${log.error}`);
  if (log.fps && log.fps.mean < 50) fails.push(`fps ${log.fps.mean} < 50`);
  // The mean hides a stutter: 58 fps mean with one 40 ms frame per second reads fine and
  // feels wrong. tools/shots/shoot.js budgets the p95 for exactly that, and it has been in every metrics
  // payload since the harness was written without anything reading it.
  if (log.fps && log.fps.p95ms > 20) fails.push(`p95 frame ${log.fps.p95ms}ms > 20ms`);
  if (log.drawCalls > 1500) fails.push(`drawCalls ${log.drawCalls} > 1500`);
  if (log.triangles > 900000) fails.push(`triangles ${log.triangles} > 900k`);
  if (log.programs > 60) fails.push(`programs ${log.programs} > 60`);
  // tools/shots/shoot.js's cold-start budget is deliberately NOT asserted here. Against the dev server
  // `readyMs` measures Vite compiling several hundred unbundled ES modules on first request
  // — 7.5-15 s cold, 3.6-6 s warm, for a page whose own boot never changed. It is the
  // bundler's number, not the game's. `tools/gate.js` measures it where it means something:
  // once, against `vite preview` on the production build. The field is still
  // recorded in every shot's JSON, because it is useful data even when it is not a budget.
  if (a?.readyBudget && log.readyMs > a.readyBudget) {
    fails.push(`ready in ${(log.readyMs / 1000).toFixed(1)}s > ${a.readyBudget / 1000}s`);
  }
  const down = (log.modules ?? []).filter((m) => m.status === 'failed' || m.status === 'blocked');
  if (down.length) fails.push(`modules down: ${down.map((d) => `${d.id}(${d.status})`).join(', ')}`);
  return fails;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.out) { console.error('shoot.js: --out <path.png> is required'); process.exit(2); }
  const log = await shoot(a);
  const fails = checkBudgets(log, a);
  const badge = fails.length ? '✗' : '✓';
  console.log(`${badge} ${a.out}  ${log.fps?.mean ?? '?'}fps  ${log.drawCalls ?? '?'}draws  ` +
    `${Math.round((log.triangles ?? 0) / 1000)}k tris  ${log.ms}ms`);
  for (const f of fails) console.log(`   ! ${f}`);
  for (const e of (log.consoleErrors ?? []).slice(0, 8)) console.log(`   · ${e.slice(0, 200)}`);
  process.exit(fails.length ? 1 : 0);
}
