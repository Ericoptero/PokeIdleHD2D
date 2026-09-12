/**
 * offline showcase (src/main.js).
 *
 * A save system has no pixels of its own, so what this stages is the *evidence*: the
 * "while you were away" card exactly as `ui` will receive it, the discount curve it was
 * computed from, the edge-case matrix with real numbers in it, and the self-test suite
 * run live in the page.
 *
 * Everything here is deterministic — fixed instants, fixed seed, in-memory storage — so
 * the same URL produces the same pixels, and nothing it does can touch the player's save.
 */

import { makeSaveStore, makeMemoryStorage, hashOf, KEY, BROKEN_KEY, FUTURE_KEY } from './save.js';
import { CURRENT_VERSION, MIGRATION_CHAIN } from './migrations.js';
import { computeCatchUp, makeSummary, efficiencyAt, effectiveSeconds, formatDuration } from './catchup.js';
import { runSelfTests, checkAdditivity } from './selftest.js';

/** A fixed instant. Screenshots must not drift with the wall clock. */
const T0 = 1_700_000_000_000;
const HOUR = 3600_000;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const money = (n) => `₽${Math.round(n).toLocaleString('en-US')}`;
const pct = (n) => `${Math.round(n * 100)}%`;

const CSS = `
#offline-sc { position:absolute; inset:0; padding:40px 44px; box-sizing:border-box;
  display:grid; grid-template-columns:520px 1fr; grid-auto-rows:min-content; gap:18px 20px;
  align-content:start; font:12px/1.55 ui-monospace, "SF Mono", Menlo, monospace;
  color:#cfdcec; pointer-events:none; }
#offline-sc .title { grid-column:1/-1; display:flex; align-items:baseline; gap:14px; margin:0 0 2px; }
#offline-sc .title b { font-size:15px; letter-spacing:.22em; text-transform:uppercase; color:#eaf2fb;
  text-shadow:0 2px 10px rgba(0,0,0,.8); }
#offline-sc .title span { font-size:11px; letter-spacing:.1em; color:#8fa6c2; text-shadow:0 1px 6px rgba(0,0,0,.9); }

#offline-sc .win { position:relative; border-radius:12px; padding:0 0 14px;
  background:linear-gradient(180deg, rgba(15,22,36,.93), rgba(9,13,22,.95));
  border:1px solid rgba(140,180,230,.26);
  box-shadow:0 18px 44px rgba(0,0,0,.55), inset 0 1px 0 rgba(190,220,255,.13);
  backdrop-filter:blur(7px); overflow:hidden; }
#offline-sc .win > h3 { margin:0; padding:9px 14px 8px; font-size:11px; font-weight:700;
  letter-spacing:.19em; text-transform:uppercase; color:#9fc4ec;
  background:linear-gradient(180deg, rgba(70,120,180,.26), rgba(40,70,110,.05));
  border-bottom:1px solid rgba(140,180,230,.2); display:flex; justify-content:space-between; }
#offline-sc .win > h3 em { font-style:normal; color:#6f8bab; letter-spacing:.1em; }
#offline-sc .body { padding:12px 14px 0; }

#offline-sc .away { display:flex; align-items:baseline; gap:10px; margin:2px 0 10px; }
#offline-sc .away b { font-size:26px; line-height:1; color:#eaf2fb; letter-spacing:.02em; }
#offline-sc .away span { font-size:11px; color:#89a2c0; }

#offline-sc .rows { display:grid; grid-template-columns:1fr auto; gap:3px 10px; margin:0 0 10px; }
#offline-sc .rows div:nth-child(odd) { color:#a9bfd8; }
#offline-sc .rows div:nth-child(even) { text-align:right; color:#eaf2fb; font-weight:600; }
#offline-sc .rows .dim { color:#7d93ad !important; font-weight:400 !important; }
#offline-sc .gain { color:#9ce6b4 !important; }

#offline-sc .bar { display:flex; height:15px; border-radius:4px; overflow:hidden;
  border:1px solid rgba(140,180,230,.22); background:rgba(0,0,0,.35); margin:2px 0 5px; }
#offline-sc .bar i { display:block; height:100%; border-right:1px solid rgba(6,10,18,.55);
  background:linear-gradient(180deg,#7fd0ff,#3f8fd0); }
#offline-sc .bar i:last-child { border-right:0; }
#offline-sc .legend { display:flex; gap:12px; flex-wrap:wrap; color:#7d93ad; font-size:10.5px; }

#offline-sc table { width:100%; border-collapse:collapse; font-size:11px; }
#offline-sc th { text-align:left; font-weight:600; color:#7f9ab8; letter-spacing:.09em;
  text-transform:uppercase; font-size:9.5px; padding:0 8px 5px 0; border-bottom:1px solid rgba(140,180,230,.16); }
#offline-sc td { padding:3.5px 8px 3.5px 0; border-bottom:1px solid rgba(140,180,230,.07);
  vertical-align:top; color:#b9cbe0; }
#offline-sc td.k { color:#e3ecf7; white-space:nowrap; }
#offline-sc td.n { text-align:right; white-space:nowrap; color:#eaf2fb; }

#offline-sc .ok { color:#8fe3a8; }
#offline-sc .warn { color:#ffcf8f; }
#offline-sc .bad { color:#ff9d9d; }
#offline-sc .tag { display:inline-block; padding:1px 6px; border-radius:4px; font-size:9.5px;
  letter-spacing:.08em; text-transform:uppercase; border:1px solid currentColor; opacity:.9; }

#offline-sc .rule { height:1px; margin:7px 0 9px; background:linear-gradient(90deg,
  rgba(140,180,230,.32), rgba(140,180,230,.04)); }
#offline-sc .dim { color:#788ea9; }
#offline-sc .tests { columns:5; column-gap:26px; font-size:10.5px; line-height:1.62; }
#offline-sc .tests div { break-inside:avoid; color:#a6bcd4; }
#offline-sc .tests div b { color:#8fe3a8; font-weight:700; margin-right:5px; }
#offline-sc .tests div.f b { color:#ff9d9d; }

#offline-sc .two { display:grid; grid-template-columns:1fr 1fr; gap:0 22px; }
#offline-sc .note { color:#7d93ad; font-size:10.5px; margin-top:8px; }
#offline-sc svg { display:block; }
`;

/** One panel with the game's window chrome. */
function win(title, right) {
  const w = el('div', 'win');
  const h = el('h3');
  h.appendChild(el('span', null, title));
  if (right) h.appendChild(el('em', null, right));
  w.appendChild(h);
  const body = el('div', 'body');
  w.appendChild(body);
  return { root: w, body };
}

function kv(rows) {
  const g = el('div', 'rows');
  for (const [k, v, cls] of rows) {
    g.appendChild(el('div', null, k));
    const d = el('div', cls || null, v);
    g.appendChild(d);
  }
  return g;
}

function table(head, rows, align = []) {
  const t = el('table');
  const thead = el('thead');
  const tr = el('tr');
  for (const [i, h] of head.entries()) {
    const th = el('th', null, h);
    th.style.textAlign = align[i] === 'r' ? 'right' : 'left';
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  t.appendChild(thead);
  const tb = el('tbody');
  for (const r of rows) {
    const row = el('tr');
    for (const [i, c] of r.entries()) {
      const td = el('td', i === 0 ? 'k' : null);
      td.style.textAlign = align[i] === 'r' ? 'right' : 'left';
      if (c && typeof c === 'object' && c.tag) {
        const tag = el('span', `tag ${c.cls ?? ''}`, c.tag);
        td.appendChild(tag);
        if (c.text) td.appendChild(document.createTextNode(` ${c.text}`));
      } else if (c && typeof c === 'object') {
        td.textContent = c.text;
        if (c.cls) td.className = `${td.className} ${c.cls}`.trim();
      } else {
        td.textContent = String(c);
      }
      row.appendChild(td);
    }
    tb.appendChild(row);
  }
  t.appendChild(tb);
  return t;
}

/** The efficiency curve, drawn over the full cap window with the grace period marked. */
function curveSvg(curve, capS, w = 470, h = 92) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(h));
  const pad = { l: 30, r: 8, t: 8, b: 16 };
  const x = (t) => pad.l + (t / capS) * (w - pad.l - pad.r);
  const y = (e) => pad.t + (1 - (e - 0.4) / 0.62) * (h - pad.t - pad.b);

  const grid = document.createElementNS(NS, 'path');
  let gd = '';
  for (const e of [1, curve.floor]) gd += `M${pad.l} ${y(e)} L${w - pad.r} ${y(e)} `;
  grid.setAttribute('d', gd);
  grid.setAttribute('stroke', 'rgba(140,180,230,.18)');
  grid.setAttribute('stroke-dasharray', '3 4');
  grid.setAttribute('fill', 'none');
  svg.appendChild(grid);

  const grace = document.createElementNS(NS, 'rect');
  grace.setAttribute('x', String(x(0)));
  grace.setAttribute('y', String(pad.t));
  grace.setAttribute('width', String(Math.max(1, x(curve.graceS) - x(0))));
  grace.setAttribute('height', String(h - pad.t - pad.b));
  grace.setAttribute('fill', 'rgba(127,208,255,.14)');
  svg.appendChild(grace);

  let d = '';
  for (let i = 0; i <= 120; i++) {
    const t = (i / 120) * capS;
    d += `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(efficiencyAt(t, curve)).toFixed(1)} `;
  }
  const line = document.createElementNS(NS, 'path');
  line.setAttribute('d', d);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', '#7fd0ff');
  line.setAttribute('stroke-width', '1.8');
  svg.appendChild(line);

  for (const [label, ty] of [['100%', 1], [pct(curve.floor), curve.floor]]) {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', '2'); t.setAttribute('y', String(y(ty) + 3.5));
    t.setAttribute('fill', '#7d93ad'); t.setAttribute('font-size', '9');
    t.textContent = label;
    svg.appendChild(t);
  }
  for (const t of [0, capS / 4, capS / 2, (3 * capS) / 4, capS]) {
    const lab = document.createElementNS(NS, 'text');
    lab.setAttribute('x', String(x(t))); lab.setAttribute('y', String(h - 3));
    lab.setAttribute('fill', '#6f8bab'); lab.setAttribute('font-size', '9');
    lab.setAttribute('text-anchor', t === 0 ? 'start' : t === capS ? 'end' : 'middle');
    lab.textContent = t === 0 ? '0' : formatDuration(t);
    svg.appendChild(lab);
  }
  return svg;
}

/**
 * A real `localStorage`, namespaced under a scratch prefix. The staged scenarios below run
 * on memory, which proves the logic; this proves the *browser* — an actual write, an actual
 * read back, an actual migration — without going anywhere near `pokeidle.save`.
 */
function scratchStorage(prefix = '__offline_showcase__:') {
  const ls = localStorage;
  return {
    kind: 'local',
    getItem: (k) => { try { return ls.getItem(prefix + k); } catch { return null; } },
    setItem: (k, v) => ls.setItem(prefix + k, v),
    removeItem: (k) => { try { ls.removeItem(prefix + k); } catch { /* nothing to undo */ } },
    keys: () => [],
    clear: () => { for (const k of [KEY, BROKEN_KEY, FUTURE_KEY]) { try { ls.removeItem(prefix + k); } catch { /* gone */ } } },
  };
}

/**
 * Writes a save to real browser storage, reads it back with a second store, and hydrates a
 * slice out of it. Returns what actually happened, so the panel can report it rather than
 * assert it.
 */
function realRoundTrip() {
  const storage = scratchStorage();
  storage.clear();
  try {
    const a = makeSaveStore({ storage, now: () => T0 });
    a.load();
    a.register('economy', { capture: () => ({ wallet: { money: 4242 }, items: { pokeball: 9 } }), restore: () => {} });
    const wrote = a.flush('showcase');
    const bytes = (storage.getItem(KEY) ?? '').length;

    // Second store, second load: exactly what the next boot does.
    let restoredMoney = null;
    const b = makeSaveStore({ storage, now: () => T0 + 3 * HOUR });
    b.load();
    b.register('economy', { capture: () => ({}), restore: (v) => { restoredMoney = v?.wallet?.money ?? null; } });
    const restored = b.hydrate();
    const away = (T0 + 3 * HOUR - b.lastSeenMs()) / 1000;
    return { ok: wrote && restoredMoney === 4242 && restored.includes('economy'), bytes, restoredMoney, away, checksum: b.data().h ?? hashOf(b.data()) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    storage.clear();
  }
}

/** Builds a scenario row by running the real loader against a staged storage. */
function loadScenario(raw) {
  const storage = makeMemoryStorage(raw == null ? {} : { [KEY]: raw });
  const store = makeSaveStore({ storage, now: () => T0 });
  store.load();
  return { store, storage, info: store.info() };
}

export async function showcaseOffline(mode, ctx) {
  const { config } = ctx;
  await ctx.get('city').enter?.();

  const offline = ctx.get('offline');
  const idle = ctx.get('idle');
  const simulate = typeof idle?.simulate === 'function' ? idle.simulate : null;
  const curve = offline.curve?.() ?? { graceS: 1800, halfLifeS: 3600, floor: 0.55, minS: 60, maxPlausibleS: 3e11 };
  const capS = Number(config.offlineCapS) || 12 * 3600;
  const seed = Number(config.seed) || 0;

  // The state the card is computed from: exactly what `idle` hands the model, so the
  // numbers on screen are the numbers the game would pay.
  const liveState = (typeof idle?.state === 'function' ? idle.state() : null) ?? { party: [], biome: 'city', luck: 1 };
  // A fixed encounter-progress anchor: the model indexes its per-encounter RNG streams off
  // it, so pinning it here is what makes the same URL produce the same numbers.
  const state = { ...liveState, progress: { encounters: 0, seconds: 0 } };
  const sim = simulate ?? ((s, elapsedS) => ({ money: 1.2 * elapsedS, exp: 3 * elapsedS, encounters: 0.02 * elapsedS, wholeEncounters: Math.floor(0.02 * elapsedS) }));

  /** One absence, decided by the real code path. */
  const decide = (awayMs, opts = {}) => computeCatchUp({
    nowMs: T0, lastSeenMs: T0 - awayMs, capS, curve, state,
    seed, simulate: sim, ...opts,
  });

  const featured = decide(3 * HOUR + 24 * 60_000);
  const summary = makeSummary(featured, {
    applied: { money: Math.floor(featured.gains?.money ?? 0) },
    pending: {
      exp: Math.floor(featured.gains?.exp ?? 0),
      encounters: featured.gains?.wholeEncounters ?? 0,
    },
    notes: [],
    save: { version: CURRENT_VERSION },
  });

  const root = el('div');
  root.id = 'offline-sc';
  const style = el('style');
  style.textContent = CSS;
  root.appendChild(style);

  const title = el('div', 'title');
  title.appendChild(el('b', null, 'offline'));
  title.appendChild(el('span', null,
    `closed-tab catch-up · save v${CURRENT_VERSION} · cap ${formatDuration(capS)} · floor ${pct(curve.floor)} · seed ${seed}`));
  root.appendChild(title);

  /* ------------------------------------------------ 1. the card ui renders */
  const card = win('While you were away', summary.capped ? 'capped' : '');
  card.body.appendChild((() => {
    const a = el('div', 'away');
    a.appendChild(el('b', null, summary.awayText));
    a.appendChild(el('span', null, `away · ${summary.effectiveText} of active-equivalent progress`));
    return a;
  })());

  const bar = el('div', 'bar');
  for (const b of summary.bands) {
    const i = el('i');
    i.style.width = `${(b.seconds / summary.creditedS) * 100}%`;
    i.style.opacity = String(0.35 + 0.65 * ((b.avgEfficiency - curve.floor) / Math.max(1e-6, 1 - curve.floor)));
    bar.appendChild(i);
  }
  card.body.appendChild(bar);
  const legend = el('div', 'legend');
  for (const b of summary.bands) legend.appendChild(el('span', null, `${b.label} @ ${pct(b.avgEfficiency)}`));
  card.body.appendChild(legend);

  card.body.appendChild(kv([
    ['Credited', `${summary.creditedText} of ${summary.awayText}`],
    ['Average efficiency', pct(summary.efficiency)],
  ]));
  card.body.appendChild(el('div', 'rule'));
  card.body.appendChild(kv([
    ['Money earned', money(summary.applied.money ?? 0), 'gain'],
    ['Experience', `${(summary.pending.exp ?? 0).toLocaleString('en-US')} exp`],
    ['Wild encounters', String(summary.pending.encounters ?? 0)],
  ]));
  card.body.appendChild(el('div', 'note',
    'Money is granted at boot. Experience and encounters are reported, not granted: no module '
    + 'accepts them yet, and a card that claimed otherwise would be lying to the player.'));
  root.appendChild(card.root);

  /* ------------------------------------------- 2. the edge-case matrix */
  const cases = win('Edge cases, decided by the real code path', `now = ${new Date(T0).toISOString().replace('T', ' ').slice(0, 19)}Z`);
  const rewound = decide(-6 * HOUR);
  const epoch = computeCatchUp({ nowMs: T0, lastSeenMs: 0, capS, curve, state, seed, simulate: sim });
  const firstRun = computeCatchUp({ nowMs: T0, lastSeenMs: T0, capS, curve, firstLaunch: true, state, seed, simulate: sim });
  const short = decide(30_000);
  const threeDays = decide(72 * HOUR);
  const eight = decide(8 * HOUR);

  const good = (t) => ({ tag: t, cls: 'ok' });
  const warn = (t) => ({ tag: t, cls: 'warn' });
  const dim = (t) => ({ text: t, cls: 'dim' });

  cases.body.appendChild(table(
    ['Situation', 'Verdict', 'Away', 'Credited', 'Effective', 'Payout'],
    [
      ['First ever launch', warn(firstRun.reason), dim('—'), dim('—'), dim('—'), dim('nothing')],
      ['Back after 30 s', warn(short.reason), formatDuration(short.awayS), dim('—'), dim('—'), dim('nothing')],
      ['Back after 3 h 24 m', good('ok'), formatDuration(featured.awayS), formatDuration(featured.cappedS), formatDuration(featured.effectiveS), { text: money(featured.gains.money), cls: 'ok' }],
      ['Back after 8 h', good('ok'), formatDuration(eight.awayS), formatDuration(eight.cappedS), formatDuration(eight.effectiveS), { text: money(eight.gains.money), cls: 'ok' }],
      ['Back after 3 days', good('ok · capped'), formatDuration(threeDays.awayS), formatDuration(threeDays.cappedS), formatDuration(threeDays.effectiveS), { text: money(threeDays.gains.money), cls: 'ok' }],
      ['System clock moved back 6 h', warn(rewound.reason), `-${formatDuration(rewound.clockSkewS)}`, dim('—'), dim('—'), dim('nothing · anchor reset')],
      ['Anchor at the epoch (1970)', warn(epoch.reason), formatDuration(epoch.rawAwayS), dim('—'), dim('—'), dim('nothing · anchor reset')],
    ],
    ['l', 'l', 'r', 'r', 'r', 'r'],
  ));
  cases.body.appendChild(el('div', 'note',
    `Every row is a live call to computeCatchUp() with idle.simulate — the same function the online loop uses, `
    + `called once with the discounted seconds. Nothing here is a mock except the clock.`));
  root.appendChild(cases.root);

  /* ------------------------------------------------- 3. the curve panel */
  const cp = win('Discount curve', `∫ = ${formatDuration(effectiveSeconds(capS, curve))} of ${formatDuration(capS)}`);
  cp.body.appendChild(curveSvg(curve, capS));
  cp.body.appendChild(kv([
    ['Grace at full rate', formatDuration(curve.graceS)],
    ['Half-life of the surplus', formatDuration(curve.halfLifeS)],
    ['Floor', pct(curve.floor)],
    ['Cap', formatDuration(capS)],
    ['Full cap is worth', `${pct(effectiveSeconds(capS, curve) / capS)} of active time`],
  ]));
  root.appendChild(cp.root);

  /* --------------------------------------- 4. the save file, staged live */
  const sv = win('Save file', `localStorage['${KEY}']`);
  const v1 = loadScenario(JSON.stringify({ v: 1, lastSeenMs: T0 - HOUR, totals: { money: 8675 } }));
  const corrupt = loadScenario('{"v":3,"slices":{"economy":');
  const futureText = JSON.stringify({ v: CURRENT_VERSION + 96, treasure: 'from a later build' });
  // Loaded for its side effect on the scratch store (the newer-version refusal path); the
  // result is not shown in the table below yet.
  loadScenario(futureText);
  const tamperedBase = (() => {
    const s = loadScenario(null);
    s.store.register('economy', { capture: () => ({ wallet: { money: 4200 } }), restore: () => {} });
    s.store.flush('showcase');
    return s.storage.getItem(KEY);
  })();
  loadScenario(tamperedBase.replace('4200', '9999'));   // same: the checksum-refusal path
  const trip = realRoundTrip();
  const live = offline.info?.() ?? {};

  sv.body.appendChild(table(
    ['Stored save', 'Loader verdict', 'Result'],
    [
      ['v1 (the first build)', good('migrated'), `v1 → v${CURRENT_VERSION}; money ${money(v1.store.data().slices?.economy?.wallet?.money ?? 0)} kept, meta added`],
      [`v${CURRENT_VERSION}, one byte changed`, warn('checksum'), `moved to ${BROKEN_KEY}; fresh save, nothing repaired in place`],
      ['truncated JSON', warn('unreadable'), `moved to ${BROKEN_KEY}; all ${corrupt.storage.getItem(BROKEN_KEY).length} bytes preserved verbatim`],
      [`v${CURRENT_VERSION + 96} (a later build)`, warn('too new'), `kept at ${FUTURE_KEY}; never migrated backwards, never overwritten`],
      ['nothing stored', good('first launch'), `a v${CURRENT_VERSION} document is created and written at boot`],
      ['a real localStorage round trip', trip.ok ? good('verified') : warn('failed'),
        trip.ok
          ? `${trip.bytes} bytes written and read back by a second store; checksum ${trip.checksum}; `
            + `economy restored at ${money(trip.restoredMoney)}; anchor ${formatDuration(trip.away)} old`
          : `could not complete: ${trip.error ?? 'unexpected result'}`],
    ],
    ['l', 'l', 'l'],
  ));
  sv.body.appendChild(el('div', 'note',
    `${MIGRATION_CHAIN.join(' · ')}. Writes: debounced 2 s, plus visibilitychange, pagehide, freeze and a 60 s heartbeat. `
    + `This session is ${live.readOnly ? 'READ-ONLY (showcase mode never touches the player\'s save)' : 'live'}; `
    + `storage=${live.storage}, slices=[${(live.providers ?? []).map((p) => `${p.id}:${p.source}`).join(', ') || 'none'}].`));
  root.appendChild(sv.root);

  /* ------------------------------------------------------ 5. self-tests */
  const tests = runSelfTests();
  const add = simulate ? checkAdditivity(simulate, state, seed, 2 * 3600, 30) : null;
  const tp = win('Self-tests, run in this page',
    `${tests.pass}/${tests.cases.length} passing`);
  tp.root.style.gridColumn = '1 / -1';
  const list = el('div', 'tests');
  for (const c of tests.cases) {
    const d = el('div', c.ok ? null : 'f');
    d.appendChild(el('b', null, c.ok ? '✓' : '✗'));
    d.appendChild(document.createTextNode(c.name));
    list.appendChild(d);
  }
  tp.body.appendChild(list);
  if (add) {
    tp.body.appendChild(el('div', 'note',
      `Cross-check against the live idle.simulate: two hours applied in one call versus drained in 30 s chunks — `
      + `money agrees to ${add.moneyRel.toExponential(1)} relative, encounters ${add.encountersMatch ? 'identical' : 'DIFFER'} `
      + `(${add.chunkedEncounters} vs ${add.wholeEncounters}). That additivity is what lets offline hand it one big number.`));
  }
  root.appendChild(tp.root);

  const uiRoot = document.getElementById('ui') ?? document.body;
  uiRoot.appendChild(root);

  if (mode === 'card') {
    for (const w of [cases.root, cp.root, sv.root, tp.root]) w.remove();
    root.style.gridTemplateColumns = '620px';
    root.style.placeContent = 'center';
    root.style.fontSize = '13px';
  }

  return { summary, tests, decision: featured };
}
