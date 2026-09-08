#!/usr/bin/env node
/**
 * The verification loop (ARCHITECTURE §8). Loads the running dev server in headless Chrome,
 * waits for the app to say it is ready, sets a camera preset and a time of day, lets the
 * scene settle, then writes a PNG next to a JSON log of fps, draw calls, module status and
 * every console error.
 *
 * No agent may claim a module works without one of these PNGs and having looked at it.
 *
 *   node tools/shots/shoot.js --out docs/progress/city/r0/noon.png \
 *        --showcase city --preset plaza --tod 12 --size 1920x1080
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function parseArgs(argv) {
  const a = { base: 'http://127.0.0.1:5173', size: '1920x1080', tod: null, preset: null,
    showcase: null, mode: null, seed: null, settle: 30, out: null, timeout: 30000,
    focus: null, pixelScale: null, software: false, debug: false, hidden: false, retries: 3, extra: {} };
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

  if (!existsSync(CHROME)) {
    throw new Error(`Chrome not found at ${CHROME}. Set CHROME_PATH.`);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: [
      '--headless=new',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-sandbox',
      '--enable-unsafe-swiftshader',
      // The real GPU by default: SwiftShader renders the same pixels but at a tenth of the
      // frame rate, so a software fps number cannot be checked against the budget. Pass
      // --software when you want bit-identical output across machines instead.
      ...(a.software ? ['--use-gl=angle', '--use-angle=swiftshader'] : ['--enable-gpu']),
      `--window-size=${w},${h}`,
    ],
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
  // without this the same URL does not give the same pixels and ARCHITECTURE §6.3 is a lie.
  if (a.extra?.timeFrozen === undefined) params.set('timeFrozen', '1');
  params.set('debug', a.debug ? '1' : '0');
  for (const [k, v] of Object.entries(a.extra ?? {})) params.set(k, v);
  const url = `${a.base}/?${params}`;

  const t0 = Date.now();
  const log = { url, out, size: [w, h], preset: a.preset ?? null, tod: a.tod ?? null, ok: false };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(a.timeout) });
    await page.waitForFunction('window.__READY__ === true', { timeout: Number(a.timeout), polling: 100 });

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

    const metrics = await page.evaluate(() => window.__HOOKS__?.metrics?.() ?? null);
    const events = await page.evaluate(() => window.__HOOKS__?.events?.().slice(-64) ?? []);
    Object.assign(log, metrics ?? {}, { events });

    await page.screenshot({ path: out, type: 'png' });
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

/** Budget check (ARCHITECTURE §7), so a passing screenshot is a passing *measurement*. */
export function checkBudgets(log) {
  const fails = [];
  if (log.consoleErrors?.length) fails.push(`${log.consoleErrors.length} console errors`);
  if (log.fatal) fails.push(`fatal: ${log.fatal}`);
  if (log.error) fails.push(`harness: ${log.error}`);
  if (log.fps && log.fps.mean < 50) fails.push(`fps ${log.fps.mean} < 50`);
  if (log.drawCalls > 1500) fails.push(`drawCalls ${log.drawCalls} > 1500`);
  if (log.triangles > 900000) fails.push(`triangles ${log.triangles} > 900k`);
  const down = (log.modules ?? []).filter((m) => m.status === 'failed' || m.status === 'blocked');
  if (down.length) fails.push(`modules down: ${down.map((d) => `${d.id}(${d.status})`).join(', ')}`);
  return fails;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.out) { console.error('shoot.js: --out <path.png> is required'); process.exit(2); }
  const log = await shoot(a);
  const fails = checkBudgets(log);
  const badge = fails.length ? '✗' : '✓';
  console.log(`${badge} ${a.out}  ${log.fps?.mean ?? '?'}fps  ${log.drawCalls ?? '?'}draws  ` +
    `${Math.round((log.triangles ?? 0) / 1000)}k tris  ${log.ms}ms`);
  for (const f of fails) console.log(`   ! ${f}`);
  for (const e of (log.consoleErrors ?? []).slice(0, 8)) console.log(`   · ${e.slice(0, 200)}`);
  process.exit(fails.length ? 1 : 0);
}
