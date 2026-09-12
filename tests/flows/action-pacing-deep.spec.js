/**
 * The deeper pacing properties `action-pacing.spec.js` does not reach (DECISIONS #86) — that
 * file proves the first two-strike turn it finds is spaced correctly and stops there. This
 * file goes further, against a real fight and real automation, not a synthetic scenario:
 *
 *  1. Every consecutive strike pair across a WHOLE fight (start to `battle:ended`) respects
 *     its beat, not just the first pair found.
 *  2. A real item use — `automation`'s own auto-heal, forced on via `loadState` — gets an
 *     `T.ITEM` beat, not an ordinary `actionSteps` one, whether the next strike lands in the
 *     same turn or (an item is often the only strike of its own `between()`-driven turn) the
 *     first strike of the next one.
 *  3. A turn with three or more strikes (forced by dropping the lead to 1 HP so the wild's
 *     first hit faints it mid-turn and `nextAlly` swaps in within the same `run.step()` call)
 *     has every consecutive pair in it spaced, not only the first.
 */
import { test, expect } from '@playwright/test';
import { installEventLog, boot, step, events, stepUntil, call } from './harness.js';

const CHUNK = 2;
const T_ITEM = 16; // src/encounter/index.js T.ITEM literal
const ACTION_STEPS = 18; // config.actionSteps default

/** Ticks every event in the log so far, deduped by the log's own array index. */
async function collectStrikesUntil(page, { stopType, maxTicks = 4000, chunk = CHUNK }) {
  const seenAt = new Set();
  /** @type {{at:number, tick:number, payload:object}[]} */
  const strikes = [];
  let stopTick = null;
  let tick = 0;
  for (; tick <= maxTicks; tick += chunk) {
    const log = await events(page);
    for (const e of log) {
      if (seenAt.has(e.at)) continue;
      seenAt.add(e.at);
      if (e.type === 'battle:strike') strikes.push({ at: e.at, tick, payload: e.payload });
      if (e.type === stopType && stopTick == null) stopTick = tick;
    }
    if (stopTick != null) break;
    await step(page, chunk);
  }
  return { strikes, stopTick, timedOut: stopTick == null };
}

test('pacing holds for every consecutive strike pair across a whole real fight', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page, { scene: 'hunt-meadow' });
  expect(errors).toEqual([]);

  const started = await stepUntil(page, 'battle:started', { chunk: 10, maxTicks: 3000 });
  expect(started.hit.payload).toEqual(expect.objectContaining({
    level: expect.any(Number), moves: expect.any(Array), ally: expect.any(String), wild: expect.any(String),
  }));
  expect(started.hit.payload.moves.length, 'battle:started carries real moves').toBeGreaterThan(0);

  const { strikes, timedOut } = await collectStrikesUntil(page, { stopType: 'battle:ended', maxTicks: 3000 });
  expect(timedOut, 'battle:ended within budget').toBe(false);
  expect(strikes.length, 'the fight produced at least one strike').toBeGreaterThan(0);

  // Group by turn, preserving arrival order.
  const byTurn = new Map();
  for (const s of strikes) {
    const t = s.payload.turn;
    if (!byTurn.has(t)) byTurn.set(t, []);
    byTurn.get(t).push(s);
  }

  const violations = [];
  for (const [turn, list] of byTurn) {
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i];
      const b = list[i + 1];
      const gap = b.tick - a.tick;
      const floor = (a.payload.cause === 'item' ? (a.payload.use === 'revive' ? 40 : T_ITEM) : ACTION_STEPS) - CHUNK;
      if (gap < floor) {
        violations.push(`turn ${turn} pair ${i}->${i + 1}: gap ${gap} < floor ${floor} `
          + `(cause=${a.payload.cause}, use=${a.payload.use})`);
      }
    }
  }
  expect(violations, `all consecutive strike pairs across the fight respect their beat:\n${violations.join('\n')}`)
    .toEqual([]);

  test.info().annotations.push({ type: 'turns', description:
    `${byTurn.size} turns, ${strikes.length} strikes, per-turn sizes: `
    + [...byTurn.entries()].map(([t, l]) => `${t}:${l.length}`).join(' ') });

  expect(errors, 'no console error').toEqual([]);
});

test('a real auto-heal item use gets an itemSteps beat, not actionSteps', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page, { scene: 'hunt-meadow' });
  expect(errors).toEqual([]);

  await call(page, 'economy', 'give', 'potion', 20, 'test');
  const restored = await call(page, 'automation', 'loadState', {
    v: 1,
    engine: {
      automations: {
        heal: {
          unlocked: true, enabled: true,
          settings: { ladder: [{ item: 'potion', enabled: true, atPercent: 100 }] },
          rules: [], stats: { runs: 0, actions: 0, skipped: 0, money: 0, errors: 0 },
        },
      },
    },
  });
  expect(restored, 'automation.loadState accepted the forced heal config').toBe(true);
  expect(await call(page, 'automation', 'isActive', 'heal'), 'heal automation is now active').toBe(true);

  await stepUntil(page, 'battle:started', { chunk: 10, maxTicks: 3000 });
  const { strikes, timedOut } = await collectStrikesUntil(page, { stopType: 'battle:ended', maxTicks: 3000 });
  expect(timedOut, 'battle:ended within budget').toBe(false);

  const itemStrikes = strikes.filter((s) => s.payload.cause === 'item');
  expect(itemStrikes.length, `at least one item strike fired (${strikes.map((s) => s.payload.cause).join(',')})`)
    .toBeGreaterThan(0);

  // For each item strike, find its immediate successor **in the overall strike order**,
  // whether that lands in the same turn or (an item is often the only strike of its own
  // between()-driven turn) the first strike of the next one — `nextTurnAt` is only set once
  // the item's own beat has elapsed, so the delay shows up there just as reliably.
  const sorted = [...strikes].sort((a, b) => a.at - b.at);
  const checked = [];
  for (const item of itemStrikes) {
    const pos = sorted.findIndex((s) => s.at === item.at);
    const next = sorted[pos + 1];
    if (!next) continue; // the item was the very last strike of the whole fight
    const gap = next.tick - item.tick;
    const floor = item.payload.use === 'revive' ? 40 : T_ITEM;
    checked.push({ turn: item.payload.turn, use: item.payload.use, gap, nextTurn: next.payload.turn });
    expect(gap, `item(${item.payload.use}) -> next strike gap (turn ${item.payload.turn} -> ${next.payload.turn})`)
      .toBeGreaterThanOrEqual(floor - CHUNK);
  }
  expect(checked.length, 'at least one item strike had a following strike to measure against').toBeGreaterThan(0);

  test.info().annotations.push({ type: 'item-beats', description: JSON.stringify(checked) });
  expect(errors, 'no console error').toEqual([]);
});

test('a mid-turn faint + swap produces a 3-strike turn, and every pair in it is spaced', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page, { scene: 'hunt-meadow' });
  expect(errors).toEqual([]);

  // Drop the lead to 1 HP before the fight starts, so the wild's first successful hit faints
  // it mid-turn and `nextAlly` swaps in the SAME `run.step()` call — one turn, three-plus
  // strikes: the ally's own move, the wild's fainting blow, and the swap.
  const party = await page.evaluate(() => window.__CTX__.get('pokemon').party());
  expect(party.length, 'a bench member exists to swap in').toBeGreaterThan(1);
  const lead = party[0];
  await page.evaluate((p) => {
    window.__CTX__.get('pokemon').damage(p.instanceId, p.maxHp - 1);
  }, lead);
  const hpNow = await page.evaluate((id) =>
    window.__CTX__.get('pokemon').party().find((m) => m.instanceId === id)?.hp, lead.instanceId);
  expect(hpNow, 'lead is at 1 hp going into the fight').toBe(1);

  await stepUntil(page, 'battle:started', { chunk: 10, maxTicks: 3000 });

  // Keep collecting strikes across possibly MULTIPLE fights (bench member could also need to
  // faint before we see a swap on the very first fight, or the wild could miss for a while) —
  // bounded by maxTicks, and it fails with a message rather than a timeout if no 3+ turn shows.
  let found = null;
  let strikesAll = [];
  let tick = 0;
  const seenAt = new Set();
  const MAX = 4000;
  for (; tick <= MAX; tick += CHUNK) {
    const log = await events(page);
    for (const e of log) {
      if (seenAt.has(e.at)) continue;
      seenAt.add(e.at);
      if (e.type === 'battle:strike') strikesAll.push({ at: e.at, tick, payload: e.payload });
    }
    const byTurn = new Map();
    for (const s of strikesAll) {
      const key = `${s.payload.index}#${s.payload.turn}`;
      if (!byTurn.has(key)) byTurn.set(key, []);
      byTurn.get(key).push(s);
    }
    for (const [key, list] of byTurn) {
      if (list.length >= 3) { found = { key, list }; break; }
    }
    if (found) break;
    await step(page, CHUNK);
  }
  expect(found, `no turn with 3+ strikes within ${MAX} ticks; strikes so far: `
    + JSON.stringify(strikesAll.map((s) => ({ turn: s.payload.turn, cause: s.payload.cause, fainted: s.payload.fainted }))))
    .not.toBeNull();

  const list = found.list;
  test.info().annotations.push({ type: 'three-strike-turn', description:
    JSON.stringify(list.map((s) => ({ tick: s.tick, cause: s.payload.cause, attacker: s.payload.attacker, fainted: s.payload.fainted }))) });

  const violations = [];
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i];
    const b = list[i + 1];
    const gap = b.tick - a.tick;
    const floor = (a.payload.cause === 'item' ? (a.payload.use === 'revive' ? 40 : T_ITEM) : ACTION_STEPS) - CHUNK;
    if (gap < floor) violations.push(`pair ${i}->${i + 1}: gap ${gap} < floor ${floor}`);
  }
  expect(violations, `all pairs in the 3+ strike turn are spaced:\n${violations.join('\n')}`).toEqual([]);

  expect(errors, 'no console error').toEqual([]);
});
