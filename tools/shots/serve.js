#!/usr/bin/env node
/**
 * Starts the dev server if nothing is on the port, and hands back a stop function.
 *
 * `npm run check` used to assume Vite was already running: from a cold shell its screenshot
 * half failed on a connection refused, so the one gate anyone actually typed was broken by
 * default and the failure looked like a broken scene rather than a missing server. A gate
 * you have to remember to set up is a gate that gets skipped.
 *
 * If the port is already serving, this attaches to it and stops nothing on the way out —
 * a developer's own `npm run dev` is not ours to kill.
 */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';

const PORT = Number(process.env.GATE_PORT ?? 5173);
const HOST = '127.0.0.1';

/** Resolves true if something is accepting connections on the port. */
export function portOpen(port = PORT, host = HOST, timeout = 400) {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    const done = (v) => { sock.destroy(); resolve(v) };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * @returns {Promise<() => void>} a stop function; a no-op when we attached to a server that
 *   was already running.
 */
export async function ensureServer({ quiet = false } = {}) {
  if (await portOpen()) {
    if (!quiet) console.log(`· dev server already up on ${HOST}:${PORT}`);
    return () => {};
  }

  if (!quiet) console.log(`· starting vite on ${HOST}:${PORT}`);
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  const startupLog = [];
  child.stdout.on('data', (d) => startupLog.push(String(d)));
  child.stderr.on('data', (d) => startupLog.push(String(d)));

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      console.error(`✗ vite exited ${child.exitCode} before serving:\n${startupLog.join('')}`);
      process.exit(1);
    }
    if (await portOpen()) {
      const stop = () => { try { child.kill('SIGTERM') } catch { /* already gone */ } };
      // A gate that throws must not leave a server behind holding the port.
      process.once('exit', stop);
      process.once('SIGINT', () => { stop(); process.exit(130) });
      return stop;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill('SIGTERM');
  console.error(`✗ vite did not serve within 30s:\n${startupLog.join('')}`);
  process.exit(1);
}

/**
 * Serves the **production build** on `port`, for the one measurement a dev server cannot
 * make: tools/shots/shoot.js's cold-start budget. Vite's dev server hands the browser several hundred separate
 * ES modules and compiles them on demand, so time-to-`__READY__` there is 7.5-15 s cold and
 * 3.6-6 s warm for a page whose own boot never moved. `vite preview` serves the bundle a
 * player would actually download.
 *
 * Assumes `vite build` has already run — the gate runs it two stages earlier.
 */
export async function servePreview(port) {
  if (await portOpen(port)) {
    console.error(`✗ preview: port ${port} is already in use`);
    process.exit(1);
  }
  const child = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const startupLog = [];
  child.stdout.on('data', (d) => startupLog.push(String(d)));
  child.stderr.on('data', (d) => startupLog.push(String(d)));

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      console.error(`✗ vite preview exited ${child.exitCode}:\n${startupLog.join('')}`);
      process.exit(1);
    }
    if (await portOpen(port)) {
      const stop = () => { try { child.kill('SIGTERM') } catch { /* already gone */ } };
      process.once('exit', stop);
      return stop;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill('SIGTERM');
  console.error(`✗ vite preview did not serve within 30s:\n${startupLog.join('')}`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(await portOpen() ? 'up' : 'down');
}
