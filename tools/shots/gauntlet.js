#!/usr/bin/env node
/**
 * Runs a module's whole screenshot matrix — presets x times of day x zoom levels — writes
 * every PNG and JSON, and prints one table a critic can read at a glance
 * (ARCHITECTURE §8, §11).
 *
 *   node tools/shots/gauntlet.js --module city --round r1
 *   node tools/shots/gauntlet.js --module tiles --round r0 --presets default,catalog
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shoot, checkBudgets, parseArgs } from './shoot.js';

/** Per-module matrices. A module not listed here gets the generic one. */
const MATRIX = {
  city: {
    showcase: 'city',
    presets: ['plaza', 'high-street', 'pokecenter-door', 'garden', 'pond'],
    tods: [8, 12, 17.8, 19.4, 22.5],
    distances: [22, 30, 40],
  },
  hunts: {
    showcase: 'hunts',
    modes: ['forest', 'meadow', 'coast', 'cave'],
    presets: ['entrance', 'clearing', 'deep'],
    tods: [8, 12, 17.8, 22.5],
    distances: [24, 32],
  },
  tiles: { showcase: 'tiles', modes: ['default', 'catalog'], tods: [12], distances: [30, 44] },
  terrain: { showcase: 'terrain', presets: ['overview'], tods: [9, 12, 17.8], distances: [26, 36] },
  environment: {
    showcase: 'environment',
    presets: ['dawn', 'morning', 'noon', 'golden', 'dusk', 'night'],
    tods: [null], distances: [22, 32],
  },
  pokemon: { showcase: 'pokemon', tods: [12, 19.4], distances: [16, 24] },
  ui: { showcase: 'ui', tods: [12], distances: [24] },
};

const GENERIC = { tods: [12], distances: [30] };

const a = parseArgs(process.argv.slice(2));
const moduleId = a.extra.module ?? a.showcase ?? 'city';
const round = a.extra.round ?? 'r0';
const size = a.size ?? '1920x1080';
const spec = { ...GENERIC, ...(MATRIX[moduleId] ?? {}) };

const outDir = join('docs', 'progress', moduleId, round);
mkdirSync(outDir, { recursive: true });

const jobs = [];
for (const mode of spec.modes ?? [null]) {
  for (const preset of (a.extra.presets?.split(',') ?? spec.presets ?? [null])) {
    for (const tod of spec.tods ?? [12]) {
      for (const distance of spec.distances ?? [30]) {
        const name = [mode, preset, tod == null ? null : `t${tod}`, `d${distance}`]
          .filter(Boolean).join('-') || 'default';
        jobs.push({ name, mode, preset, tod, distance });
      }
    }
  }
}

console.log(`gauntlet: ${moduleId} ${round} — ${jobs.length} shots -> ${outDir}`);
const results = [];
for (const job of jobs) {
  const log = await shoot({
    ...a, size,
    out: join(outDir, `${job.name}.png`),
    showcase: spec.showcase ?? moduleId,
    mode: job.mode, preset: job.preset, tod: job.tod,
    extra: { ...a.extra, cameraDistance: job.distance },
    settle: a.settle ?? 40,
  });
  const fails = checkBudgets(log);
  results.push({ ...job, log, fails });
  console.log(` ${fails.length ? '✗' : '✓'} ${job.name.padEnd(34)} ` +
    `${String(log.fps?.mean ?? '?').padStart(5)}fps ${String(log.drawCalls ?? '?').padStart(5)}draws` +
    (fails.length ? `   ${fails.join('; ')}` : ''));
}

const summary = {
  module: moduleId, round, size, at: new Date().toISOString(),
  shots: results.map((r) => ({
    name: r.name, png: `${r.name}.png`, ok: r.fails.length === 0, fails: r.fails,
    fps: r.log.fps?.mean ?? null, drawCalls: r.log.drawCalls ?? null,
    triangles: r.log.triangles ?? null, errors: r.log.consoleErrors?.length ?? 0,
  })),
};
summary.passed = summary.shots.filter((s) => s.ok).length;
summary.failed = summary.shots.length - summary.passed;
writeFileSync(join(outDir, 'gauntlet.json'), JSON.stringify(summary, null, 1));

console.log(`\n${summary.passed}/${summary.shots.length} shots inside budget with no console errors`);
process.exit(summary.failed ? 1 : 0);
