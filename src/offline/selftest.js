/**
 * The edge cases, as assertions rather than as prose.
 *
 * A save system's failure modes all live in situations nobody exercises by playing: a
 * clock that moved backwards, a save from a build that does not exist yet, a quota that
 * ran out at exactly the wrong moment. So they are pinned here, against injected storage
 * and an injected clock, and the suite runs in two places:
 *
 *   node  — `node src/offline/selftest.js`, no browser, no dev server,
 *   page  — the offline showcase renders the results, so a screenshot proves them.
 *
 * Everything imported here is `src/offline/`'s own; `idle.simulate` arrives as an
 * argument, because a deep import across module folders is a seam violation (§5) and
 * because a test that depends on another builder's in-flight file is not a test.
 */

import { makeSaveStore, makeMemoryStorage, makeStorage, hashOf, stableStringify, KEY, BROKEN_KEY, FUTURE_KEY } from './save.js';
import { CURRENT_VERSION, MIGRATIONS, freshSave } from './migrations.js';
import { computeCatchUp, makeSummary, effectiveSeconds, efficiencyAt, bandsFor, formatDuration, CURVE_DEFAULTS } from './catchup.js';

const T0 = 1_700_000_000_000;          // a fixed instant, so every run is identical
const HOUR = 3600_000;
const CAP_S = 12 * 3600;

/** A linear, deterministic stand-in for `idle.simulate` — no RNG, exactly additive. */
function stubSimulate(state, elapsedS, seed = 0) {
  return {
    elapsedS, seed,
    perSecond: { money: 10, exp: 2, encounters: 0.05 },
    money: 10 * elapsedS,
    exp: 2 * elapsedS,
    tokens: 0.1 * elapsedS,
    encounters: 0.05 * elapsedS,
    wholeEncounters: Math.floor(0.05 * elapsedS),
    progress: { encounters: (state?.progress?.encounters ?? 0) + 0.05 * elapsedS, seconds: (state?.progress?.seconds ?? 0) + elapsedS },
  };
}

/** A hand-driven clock and timer queue, so debounce behaviour is tested, not slept through. */
function fakeTimers(startMs = T0) {
  let nowMs = startMs;
  let nextId = 1;
  const queue = new Map();
  return {
    now: () => nowMs,
    setTimer(fn, ms) { const id = nextId++; queue.set(id, { fn, at: nowMs + Math.max(0, ms) }); return id; },
    clearTimer(id) { queue.delete(id); },
    advance(ms) {
      nowMs += ms;
      for (const [id, t] of [...queue].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= nowMs) { queue.delete(id); t.fn(); }
      }
    },
    pending: () => queue.size,
  };
}

function storeOn(storage, timers, extra = {}) {
  return makeSaveStore({
    storage, now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    debounceMs: 2000, maxDebounceMs: 10000, ...extra,
  });
}

/** A complete, checksummed v3 save, written the way the store writes one. */
function validSaveText(patch = {}) {
  const timers = fakeTimers();
  const storage = makeMemoryStorage();
  const store = storeOn(storage, timers);
  store.load();
  store.register('economy', { capture: () => ({ wallet: { money: 4200 } }), restore: () => {} });
  store.flush('test');
  const raw = JSON.parse(storage.getItem(KEY));
  Object.assign(raw, patch);
  if (!('h' in patch)) { delete raw.h; raw.h = hashOf(raw); }
  return JSON.stringify(raw);
}

/* ------------------------------------------------------------------- cases */

const CASES = [
  // --- the save document ---------------------------------------------------
  ['first launch creates a current-version document', () => {
    const timers = fakeTimers();
    const store = storeOn(makeMemoryStorage(), timers);
    const data = store.load();
    const info = store.info();
    return [info.firstLaunch === true && data.v === CURRENT_VERSION && data.createdMs === T0 && info.quarantined === null,
      `v${data.v} firstLaunch=${info.firstLaunch}`];
  }],

  ['a save round-trips through storage unchanged', () => {
    const storage = makeMemoryStorage();
    const t1 = fakeTimers();
    const a = storeOn(storage, t1);
    a.load();
    a.register('economy', { capture: () => ({ wallet: { money: 1234 }, items: { pokeball: 7 } }), restore: () => {} });
    a.flush('test');
    const b = storeOn(storage, fakeTimers());
    b.load();
    const got = b.get('economy');
    return [got?.wallet?.money === 1234 && got?.items?.pokeball === 7, JSON.stringify(got)];
  }],

  ['unparseable JSON is quarantined, not repaired in place', () => {
    const storage = makeMemoryStorage({ [KEY]: '{"v":3,"slices":' });
    const store = storeOn(storage, fakeTimers());
    store.load();
    const info = store.info();
    return [info.quarantined?.reason === 'unreadable'
      && storage.getItem(BROKEN_KEY) === '{"v":3,"slices":'
      && storage.getItem(KEY) === null
      && store.data().v === CURRENT_VERSION,
    `reason=${info.quarantined?.reason} broken=${!!storage.getItem(BROKEN_KEY)}`];
  }],

  ['a tampered save fails its checksum and is quarantined', () => {
    const text = validSaveText();
    const tampered = text.replace('4200', '9999');
    const storage = makeMemoryStorage({ [KEY]: tampered });
    const store = storeOn(storage, fakeTimers());
    store.load();
    return [store.info().quarantined?.reason === 'checksum' && storage.getItem(BROKEN_KEY) === tampered,
      `reason=${store.info().quarantined?.reason}`];
  }],

  ['a save with no version is quarantined', () => {
    const storage = makeMemoryStorage({ [KEY]: JSON.stringify({ money: 10 }) });
    const store = storeOn(storage, fakeTimers());
    store.load();
    return [store.info().quarantined?.reason === 'no-version', String(store.info().quarantined?.reason)];
  }],

  ['a save that is not an object is quarantined', () => {
    const storage = makeMemoryStorage({ [KEY]: '[1,2,3]' });
    const store = storeOn(storage, fakeTimers());
    store.load();
    return [store.info().quarantined?.reason === 'not-an-object', String(store.info().quarantined?.reason)];
  }],

  ['a migration that throws quarantines rather than crashing the boot', () => {
    const storage = makeMemoryStorage({ [KEY]: JSON.stringify({ v: 1, lastSeenMs: T0 }) });
    const store = storeOn(storage, fakeTimers(), {
      version: 2,
      migrations: [{ to: 2, describe: 'explodes', apply() { throw new Error('boom'); } }],
    });
    store.load();
    return [store.info().quarantined?.reason === 'migration' && store.data().v === 2,
      String(store.info().quarantined?.reason)];
  }],

  // --- migrations ----------------------------------------------------------
  ['a v1 save migrates forward and keeps its money', () => {
    const storage = makeMemoryStorage({ [KEY]: JSON.stringify({ v: 1, lastSeenMs: T0 - HOUR, totals: { money: 8675 } }) });
    const store = storeOn(storage, fakeTimers());
    const data = store.load();
    return [data.v === CURRENT_VERSION
      && data.slices.economy.wallet.money === 8675
      && data.lastSeenMs === T0 - HOUR
      && store.info().migratedFrom === 1
      && store.info().quarantined === null,
    `v${data.v} money=${data.slices?.economy?.wallet?.money} from=${store.info().migratedFrom}`];
  }],

  ['a v2 save migrates forward and gains meta', () => {
    const storage = makeMemoryStorage({ [KEY]: JSON.stringify({ v: 2, createdMs: T0 - 99, lastSeenMs: T0 - 50, slices: { economy: { wallet: { money: 7 } } } }) });
    const store = storeOn(storage, fakeTimers());
    const data = store.load();
    return [data.v === CURRENT_VERSION && data.meta && data.meta.sessions === 0 && data.slices.economy.wallet.money === 7,
      JSON.stringify(data.meta)];
  }],

  ['every migration is total: a v1 save with no fields still opens', () => {
    const storage = makeMemoryStorage({ [KEY]: JSON.stringify({ v: 1 }) });
    const store = storeOn(storage, fakeTimers());
    const data = store.load();
    return [data.v === CURRENT_VERSION && Number.isFinite(data.lastSeenMs) && store.info().quarantined === null,
      `lastSeenMs=${data.lastSeenMs} repairs=${store.info().repairs.join('|')}`];
  }],

  ['the migration chain covers every version with no gaps', () => {
    const tos = MIGRATIONS.map((m) => m.to).sort((a, b) => a - b);
    const expected = [];
    for (let v = 2; v <= CURRENT_VERSION; v++) expected.push(v);
    return [JSON.stringify(tos) === JSON.stringify(expected), `${JSON.stringify(tos)} vs ${JSON.stringify(expected)}`];
  }],

  ['a save from a future version is kept aside, never overwritten', () => {
    const future = JSON.stringify({ v: CURRENT_VERSION + 96, treasure: 'from a later build' });
    const storage = makeMemoryStorage({ [KEY]: future });
    const store = storeOn(storage, fakeTimers());
    const data = store.load();
    return [store.info().futureVersion === CURRENT_VERSION + 96
      && storage.getItem(FUTURE_KEY) === future
      && storage.getItem(KEY) === null
      && data.v === CURRENT_VERSION
      && store.info().quarantined === null,
    `future=${store.info().futureVersion}`];
  }],

  ['a slice this build does not know about survives a load/save cycle', () => {
    const storage = makeMemoryStorage();
    const a = storeOn(storage, fakeTimers());
    a.load();
    a.data().slices.someLaterModule = { keep: 'me', n: 3 };
    a.flush('test');
    const b = storeOn(storage, fakeTimers());
    b.load();
    b.register('economy', { capture: () => ({ wallet: { money: 1 } }), restore: () => {} });
    b.flush('test');
    const c = storeOn(storage, fakeTimers());
    c.load();
    return [c.get('someLaterModule')?.keep === 'me', JSON.stringify(c.get('someLaterModule'))];
  }],

  ['the quarantined bytes are preserved verbatim', () => {
    const raw = '{"v":3,"slices":{"economy":{"wallet":{"money":123}}} TRAILING GARBAGE';
    const storage = makeMemoryStorage({ [KEY]: raw });
    const store = storeOn(storage, fakeTimers());
    store.load();
    return [store.broken() === raw, `${(store.broken() ?? '').slice(0, 24)}…`];
  }],

  // --- writing -------------------------------------------------------------
  ['a dirty save is written 2 s later, not immediately', () => {
    const storage = makeMemoryStorage();
    const timers = fakeTimers();
    const store = storeOn(storage, timers);
    store.load();
    store.markDirty('test');
    const before = storage.getItem(KEY);
    timers.advance(1999);
    const mid = storage.getItem(KEY);
    timers.advance(2);
    const after = storage.getItem(KEY);
    return [before === null && mid === null && after !== null, `before=${before} mid=${mid} after=${!!after}`];
  }],

  ['a constant drip of changes still lands within the ceiling', () => {
    const storage = makeMemoryStorage();
    const timers = fakeTimers();
    const store = storeOn(storage, timers);
    store.load();
    for (let i = 0; i < 20; i++) { store.markDirty('drip'); timers.advance(1000); }
    return [storage.getItem(KEY) !== null && store.info().writes >= 1, `writes=${store.info().writes}`];
  }],

  ['a write that throws (quota) is recorded, never propagated', () => {
    const storage = makeMemoryStorage();
    storage.setItem = () => { throw new Error('QuotaExceededError'); };
    const store = storeOn(storage, fakeTimers());
    store.load();
    const ok = store.flush('test');
    return [ok === false && store.info().writeErrors === 1, `ok=${ok} errors=${store.info().writeErrors}`];
  }],

  ['no storage at all degrades to memory instead of throwing', () => {
    const hostile = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
    const storage = makeStorage(hostile);
    const store = storeOn(storage, fakeTimers());
    store.load();
    const wrote = store.flush('test');
    return [storage.kind === 'memory' && wrote === true, `kind=${storage.kind} wrote=${wrote}`];
  }],

  ['a slice provider that throws loses only its own slice', () => {
    const storage = makeMemoryStorage();
    const store = storeOn(storage, fakeTimers());
    store.load();
    store.register('bad', { capture() { throw new Error('nope'); }, restore: () => {} });
    store.register('good', { capture: () => ({ ok: 1 }), restore: () => {} });
    const wrote = store.flush('test');
    return [wrote === true && store.get('good')?.ok === 1 && store.get('bad') === undefined,
      `wrote=${wrote} good=${JSON.stringify(store.get('good'))}`];
  }],

  ['a slice that cannot be serialised is skipped, and the save still writes', () => {
    const storage = makeMemoryStorage();
    const store = storeOn(storage, fakeTimers());
    store.load();
    const cyclic = { name: 'loop' }; cyclic.self = cyclic;
    store.register('cyclic', { capture: () => cyclic, restore: () => {} });
    store.register('fine', { capture: () => ({ n: 5 }), restore: () => {} });
    const wrote = store.flush('test');
    return [wrote === true && store.get('fine')?.n === 5 && store.get('cyclic') === undefined, `wrote=${wrote}`];
  }],

  ['a restore that throws does not stop the other slices', () => {
    const storage = makeMemoryStorage();
    const a = storeOn(storage, fakeTimers());
    a.load();
    a.register('one', { capture: () => ({ x: 1 }), restore: () => {} });
    a.register('two', { capture: () => ({ y: 2 }), restore: () => {} });
    a.flush('test');
    const b = storeOn(storage, fakeTimers());
    b.load();
    let sawTwo = false;
    b.register('one', { capture: () => ({ x: 1 }), restore() { throw new Error('nope'); } });
    b.register('two', { capture: () => ({ y: 2 }), restore() { sawTwo = true; } });
    const restored = b.hydrate();
    return [sawTwo === true && restored.includes('two'), `restored=${restored.join(',')}`];
  }],

  ['the checksum does not depend on key order', () => {
    const a = hashOf({ v: 3, alpha: 1, beta: { x: 1, y: 2 } });
    const b = hashOf({ beta: { y: 2, x: 1 }, alpha: 1, v: 3 });
    return [a === b && stableStringify({ b: 1, a: 2 }) === '{"a":2,"b":1}', `${a} vs ${b}`];
  }],

  ['flushing moves the last-seen anchor to now', () => {
    const timers = fakeTimers();
    const store = storeOn(makeMemoryStorage(), timers);
    store.load();
    timers.advance(5 * HOUR);
    store.flush('test');
    return [store.lastSeenMs() === T0 + 5 * HOUR, `lastSeen=${store.lastSeenMs() - T0}`];
  }],

  // --- catch-up ------------------------------------------------------------
  ['the first ever launch grants nothing', () => {
    const d = computeCatchUp({ nowMs: T0, lastSeenMs: T0, capS: CAP_S, firstLaunch: true, simulate: stubSimulate });
    return [d.reason === 'first-launch' && d.ok === false && d.gains === null, d.reason];
  }],

  ['a save with no usable anchor grants nothing and repairs the anchor', () => {
    const d = computeCatchUp({ nowMs: T0, lastSeenMs: null, capS: CAP_S, simulate: stubSimulate });
    return [d.reason === 'no-anchor' && d.ok === false && d.repairAnchor === true, d.reason];
  }],

  ['a clock that moved backwards grants nothing and repairs the anchor', () => {
    const d = computeCatchUp({ nowMs: T0, lastSeenMs: T0 + 6 * HOUR, capS: CAP_S, simulate: stubSimulate });
    return [d.reason === 'clock-rewound' && d.ok === false && d.repairAnchor === true && Math.round(d.clockSkewS) === 21600,
      `${d.reason} skew=${d.clockSkewS}`];
  }],

  ['sub-second clock wobble is not treated as a rewind', () => {
    const d = computeCatchUp({ nowMs: T0, lastSeenMs: T0 + 500, capS: CAP_S, simulate: stubSimulate });
    return [d.reason === 'too-short' && d.ok === false, d.reason];
  }],

  ['an absence shorter than the minimum shows no card', () => {
    const d = computeCatchUp({ nowMs: T0 + 30_000, lastSeenMs: T0, capS: CAP_S, simulate: stubSimulate });
    return [d.reason === 'too-short' && d.ok === false && d.gains === null, `${d.reason} away=${d.awayS}`];
  }],

  ['an anchor at the epoch is treated as broken, not as a 55-year absence', () => {
    const d = computeCatchUp({ nowMs: T0, lastSeenMs: 0, capS: CAP_S, simulate: stubSimulate });
    return [d.reason === 'implausible' && d.ok === false && d.repairAnchor === true, `${d.reason} raw=${Math.round(d.rawAwayS)}`];
  }],

  ['three days away is clamped to the twelve-hour cap', () => {
    const d = computeCatchUp({ nowMs: T0 + 72 * HOUR, lastSeenMs: T0, capS: CAP_S, simulate: stubSimulate });
    return [d.ok === true && d.capped === true && d.cappedS === CAP_S && Math.round(d.awayS) === 259200,
      `away=${Math.round(d.awayS)} credited=${d.cappedS}`];
  }],

  ['simulate is called exactly once, with the discounted seconds', () => {
    let calls = 0; let sawElapsed = null;
    const spy = (state, elapsedS, seed) => { calls++; sawElapsed = elapsedS; return stubSimulate(state, elapsedS, seed); };
    const d = computeCatchUp({ nowMs: T0 + 8 * HOUR, lastSeenMs: T0, capS: CAP_S, simulate: spy });
    return [calls === 1 && Math.abs(sawElapsed - d.effectiveS) < 1e-9 && d.effectiveS < d.cappedS,
      `calls=${calls} elapsed=${sawElapsed?.toFixed(1)} credited=${d.cappedS}`];
  }],

  ['the discount is a curve: full rate inside the grace period, decaying after it', () => {
    const c = CURVE_DEFAULTS;
    const atStart = efficiencyAt(0, c), atGrace = efficiencyAt(c.graceS, c);
    const atHalf = efficiencyAt(c.graceS + c.halfLifeS, c), far = efficiencyAt(c.graceS + 40 * c.halfLifeS, c);
    const expectHalf = c.floor + (1 - c.floor) / 2;
    return [atStart === 1 && atGrace === 1 && Math.abs(atHalf - expectHalf) < 1e-9 && Math.abs(far - c.floor) < 1e-6,
      `1→${atHalf.toFixed(3)}→${far.toFixed(3)} floor=${c.floor}`];
  }],

  ['the integrated curve is exact, monotonic and bounded by floor·T ≤ E(T) ≤ T', () => {
    const c = CURVE_DEFAULTS;
    let ok = Math.abs(effectiveSeconds(c.graceS, c) - c.graceS) < 1e-9;
    let last = -1;
    for (let T = 0; T <= 48 * 3600; T += 137) {
      const E = effectiveSeconds(T, c);
      if (!(E >= last) || E > T + 1e-9 || E < c.floor * T - 1e-9) { ok = false; break; }
      last = E;
    }
    // Compared against a fine numeric integration, so the closed form cannot silently drift.
    let numeric = 0;
    const step = 0.5;
    for (let t = 0; t < CAP_S; t += step) numeric += efficiencyAt(t + step / 2, c) * step;
    const exact = effectiveSeconds(CAP_S, c);
    return [ok && Math.abs(numeric - exact) / exact < 1e-6, `exact=${exact.toFixed(2)} numeric=${numeric.toFixed(2)}`];
  }],

  ['the summary bands add up to the credited effective time', () => {
    const c = CURVE_DEFAULTS;
    const T = 9 * 3600;
    const bands = bandsFor(T, c);
    const sum = bands.reduce((a, b) => a + b.effectiveS, 0);
    const span = bands.reduce((a, b) => a + b.seconds, 0);
    return [Math.abs(sum - effectiveSeconds(T, c)) < 1e-6 && Math.abs(span - T) < 1e-6 && bands.length >= 2,
      `${bands.length} bands, ${sum.toFixed(1)}s of ${T}s`];
  }],

  ['the same inputs always produce the same payload', () => {
    const a = computeCatchUp({ nowMs: T0 + 5 * HOUR, lastSeenMs: T0, capS: CAP_S, seed: 1337, simulate: stubSimulate });
    const b = computeCatchUp({ nowMs: T0 + 5 * HOUR, lastSeenMs: T0, capS: CAP_S, seed: 1337, simulate: stubSimulate });
    return [JSON.stringify(a) === JSON.stringify(b) && a.gains.money > 0, `money=${a.gains.money.toFixed(2)}`];
  }],

  ['the card separates what was granted from what is only computed', () => {
    const d = computeCatchUp({ nowMs: T0 + 4 * HOUR, lastSeenMs: T0, capS: CAP_S, simulate: stubSimulate });
    const s = makeSummary(d, { applied: { money: 100 }, pending: { exp: 900 }, notes: ['n'], save: { version: CURRENT_VERSION } });
    const keys = ['awayText', 'creditedText', 'effectiveText', 'efficiency', 'bands', 'gains', 'applied', 'pending', 'notes', 'save'];
    const missing = keys.filter((k) => !(k in s));
    return [missing.length === 0 && s.applied.money === 100 && s.pending.exp === 900 && s.gains.money > 100,
      missing.length ? `missing ${missing.join(',')}` : `${s.awayText} away, ${s.effectiveText} effective`];
  }],

  ['durations read the way a card should', () => {
    const got = [formatDuration(45), formatDuration(600), formatDuration(3600), formatDuration(12300), formatDuration(200000)];
    return [JSON.stringify(got) === JSON.stringify(['45 s', '10 m', '1 h', '3 h 25 m', '2 d 7 h']), got.join(' / ')];
  }],

  ['a fresh document declares the current version', () => {
    const f = freshSave(T0, 1337);
    return [f.v === CURRENT_VERSION && f.meta.seed === 1337 && f.createdMs === T0 && typeof f.slices === 'object',
      `v${f.v}`];
  }],
];

/**
 * Runs everything. `simulate` may be supplied so the page can run the real
 * `idle.simulate` through the same cases; the default stub keeps node runs dependency-free.
 *
 * @returns {{pass:number, fail:number, cases:{name:string,ok:boolean,detail:string}[]}}
 */
export function runSelfTests({ simulate } = {}) {
  const cases = [];
  for (const [name, fn] of CASES) {
    try {
      const [ok, detail] = fn(simulate ?? stubSimulate);
      cases.push({ name, ok: !!ok, detail: String(detail ?? '') });
    } catch (err) {
      cases.push({ name, ok: false, detail: `threw: ${err?.message ?? err}` });
    }
  }
  return {
    pass: cases.filter((c) => c.ok).length,
    fail: cases.filter((c) => !c.ok).length,
    cases,
  };
}

/**
 * A second, independent check: the live `idle.simulate` must agree with itself whether an
 * absence is applied in one call or drained in chunks, which is the property that lets
 * `offline` hand it one big number. Runs only where a real simulate is available.
 */
export function checkAdditivity(simulate, state, seed, totalS = 4 * 3600, chunkS = 30) {
  if (typeof simulate !== 'function') return null;
  const whole = simulate({ ...state, progress: { encounters: 0, seconds: 0 } }, totalS, seed);
  let progress = { encounters: 0, seconds: 0 };
  let money = 0, exp = 0, wholeEncounters = 0;
  for (let t = 0; t < totalS; t += chunkS) {
    const g = simulate({ ...state, progress }, Math.min(chunkS, totalS - t), seed);
    money += g.money ?? 0;
    exp += g.exp ?? 0;
    wholeEncounters += g.wholeEncounters ?? 0;
    progress = g.progress ?? progress;
  }
  const rel = (a, b) => (Math.abs(a) + Math.abs(b) > 0 ? Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) : 0);
  return {
    moneyRel: rel(money, whole.money ?? 0),
    expRel: rel(exp, whole.exp ?? 0),
    encountersMatch: wholeEncounters === (whole.wholeEncounters ?? 0),
    chunkedMoney: money, wholeMoney: whole.money ?? 0,
    chunkedEncounters: wholeEncounters, wholeEncounters: whole.wholeEncounters ?? 0,
  };
}

// `node src/offline/selftest.js`
if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === `file://${process.argv[1]}`) {
  const r = runSelfTests();
  for (const c of r.cases) console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
  console.log(`\n${r.pass}/${r.cases.length} passed`);
  process.exit(r.fail ? 1 : 0);
}
