/**
 * The automation showcase (ARCHITECTURE §6).
 *
 * A systems module cannot prove itself with a pretty frame, so this one proves itself with
 * *evidence*. Every number on screen was produced by calling the live public API during
 * the showcase, in the order the transcript on the right lists them. The box the release
 * preview is planning against was really filled, the balls in the table were really scored
 * by `economy`'s own capture maths, and the audit log is the log the automations actually
 * wrote while this page was building.
 *
 * Deterministic by construction: the scripted session makes the same calls in the same
 * order every time, the box is built from a fixed integer hash rather than an RNG stream,
 * and nothing here reads a wall clock. Same URL, same pixels.
 *
 * Modes (`?showcase=automation&mode=…`):
 *   default   the whole console
 *   rules     the rule engine: schema, ruleset, and the per-leaf trace behind one decision
 *   balls     the ball optimiser against a worked encounter, tier by tier
 *   release   the release preview, full height
 *   hunt      the bridge into `idle`: flags, catches materialised, what the seam costs
 */

import { AUTOMATIONS } from './automations.js';
import { FIELD_SETS } from './fields.js';

const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const pct = (n) => `${((Number(n) || 0) * 100).toFixed(1)}%`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * The box the release preview plans against. A fixed integer hash, never an RNG stream:
 * this is a stage set, and a stage set that changed between two screenshots would make a
 * diff between rounds meaningless.
 */
const BOX_SPECIES = [
  'zubat', 'geodude', 'rattata', 'pidgey', 'magikarp', 'caterpie', 'weedle', 'psyduck',
  'machop', 'tentacool', 'gastly', 'onix', 'sandshrew', 'growlithe', 'abra', 'eevee',
];

function buildBox(count = 210) {
  const specs = [];
  for (let i = 0; i < count; i++) {
    const key = BOX_SPECIES[i % BOX_SPECIES.length];
    const h = ((i * 2654435761) >>> 0) / 4294967296;
    const g = ((i * 40503 + 12345) >>> 0) / 4294967296;
    const iv = (k) => Math.floor((((i * 2246822519 + k * 3266489917) >>> 0) / 4294967296) * 32);
    specs.push({
      species: key,
      level: 3 + Math.floor(h * 34),
      shiny: i % 53 === 0,
      ivs: { hp: iv(1), atk: iv(2), def: iv(3), spa: iv(4), spd: iv(5), spe: iv(6) },
      biome: ['forest', 'cave', 'meadow', 'coast'][i % 4],
      ball: 'pokeball',
      origin: 'wild',
      favourite: i % 71 === 0,
      // Well past the two-minute grace period, so the preview is about the rules and not
      // about the clock.
      simTime: -(900 + i),
    });
    if (g > 0.94) specs[specs.length - 1].level += 30;   // a few trained ones, to be protected
  }
  return specs;
}

/** The encounter every ball is judged against, stated on screen. */
const WORKED = {
  label: 'Gengar · lv 34 · cave · 22:00 · 35% HP · new to the dex',
  species: 'gengar', level: 34, shiny: false,
};

export async function showcaseAutomation(mode = 'default', ctx) {
  const auto = ctx.get('automation');
  const eco = ctx.get('economy');
  const col = ctx.get('collection');

  // The scene behind the glass. A failure to enter must not take the panel down.
  try {
    await ctx.get('city').enter?.();
    ctx.get('city').preset?.('plaza');
  } catch { /* the panel is the point; the scene is the backdrop */ }
  ctx.get('environment').setTimeOfDay?.(ctx.config.tod);

  const log = [];
  const record = (call, result) => log.push({ call, result: String(result) });

  // ── the scripted session ───────────────────────────────────────────────────
  auto.reset?.();
  record('reset()', `${AUTOMATIONS.length} automations, all locked`);

  // A save's worth of play, compressed: a full box, a wallet, and a bag of loot.
  const specs = buildBox();
  const imported = col.importBatch?.(specs, { announce: false }) ?? [];
  record(`collection.importBatch(${specs.length})`,
    `${imported.filter((r) => r?.stored).length} stored · ${col.count?.() ?? 0} in the boxes`);

  eco.add?.('research', 1600, 'grant');
  eco.add?.('money', 400000, 'grant');
  record('economy.add("research", 1600)', `◈${fmt(eco.balance?.('research'))} banked`);
  for (const [id, n] of [['nugget', 9], ['stardust', 14], ['starpiece', 3], ['bigmushroom', 6],
    ['pearl', 11], ['expcandy_xs', 24], ['potion', 2], ['pokeball', 7], ['greatball', 4], ['ultraball', 2]]) {
    eco.give?.(id, n, 'showcase:loot');
  }
  record('economy.give(loot ×10 stacks)', `${Object.keys(eco.inventory?.() ?? {}).length} stacks in the bag`);

  // Unlocking is a purchase, and it is refused when the requirement is not met.
  const unlockRows = [];
  for (const def of AUTOMATIONS) {
    const before = eco.balance?.('research') ?? 0;
    const r = auto.unlock(def.id);
    unlockRows.push({ id: def.id, ...r, spent: before - (eco.balance?.('research') ?? 0) });
    record(`unlock("${def.id}")`, r.ok ? `−${def.unlock.cost}◈ → ◈${fmt(eco.balance?.('research'))}` : `refused: ${r.why}`);
  }

  // Unlocked is not enabled (§5.11). Switching on is a second, separate act.
  const activeBefore = auto.list().filter((a) => a.active).length;
  for (const def of AUTOMATIONS) auto.enable(def.id, true);
  record('enable(all)', `${activeBefore} active before → ${auto.list().filter((a) => a.active).length} after`);

  auto.configure('release', { maxPerRun: 24, keepOrder: 'iv' });
  auto.configure('ball', { oddsFloor: 0.9, bpWeight: 2500 });
  record('configure("release", {maxPerRun:24})', `keep order "${auto.settings('release').keepOrder}"`);

  // The bridge: `idle` reports catches as a count plus a sample; this module gives them
  // bodies. Emitted on the bus so the wiring, not a private call, is what is being shown.
  const before = col.count?.() ?? 0;
  ctx.bus.emit('idle:tick', {
    elapsedS: 3600,
    gains: {
      money: 462000, exp: 91000, research: 240, encounters: 44, wholeEncounters: 44,
      wins: 38, catches: 9, shinies: 1, biome: 'forest',
      events: [
        { index: 1, species: 'sprigatito', level: 14, shiny: true, win: true, caught: true },
        { index: 2, species: 'starly', level: 11, shiny: false, win: true, caught: true },
        { index: 3, species: 'bulbasaur', level: 13, shiny: false, win: true, caught: true },
      ],
      perSecond: { money: 128, exp: 25, research: 0.07, encounters: 0.012 },
    },
  });
  record('bus.emit("idle:tick", {catches:9})',
    `${(col.count?.() ?? 0) - before} deposited · ${auto.totals().synthesised} rolled from the biome table`);

  // Previews first — a plan is only interesting before it is applied.
  const releasePlan = auto.preview('release');
  record('preview("release")',
    `${releasePlan.release.length} to release, ₽${fmt(releasePlan.value.money)} · ${releasePlan.keep} kept`
    + (releasePlan.capped ? ` · ${releasePlan.capped} over the cap` : ''));
  const sellPlan = auto.preview('sell');
  record('preview("sell")', `${sellPlan.plan.length} stacks → ₽${fmt(sellPlan.money)}`);
  const restockPlan = auto.preview('restock');
  record('preview("restock")', `${restockPlan.plan.length} lines, ₽${fmt(restockPlan.spend)} of a ₽${fmt(restockPlan.budget)} budget`);

  // Then run them, so the audit log on screen is a real log.
  const sold = auto.run('sell');
  record('run("sell")', `${sold?.applied ?? 0} sold → ₽${fmt(sold?.money ?? 0)}`);
  const bought = auto.run('restock');
  record('run("restock")', `${bought?.applied ?? 0} bought → −₽${fmt(bought?.spend ?? 0)}`);
  const released = auto.run('release');
  record('run("release")', `${released?.applied ?? 0} released → ₽${fmt(released?.value?.money ?? 0)}`);

  // The ball optimiser against one worked encounter, tier by tier.
  const ballTable = auto.ballTable(WORKED);
  const tiers = ['secure', 'value', 'cheap'].map((t) => ({ tier: t, ...auto.chooseBall(WORKED, t) }));
  record('chooseBall(gengar, "secure")', `${tiers[0].ball} · ${pct(tiers[0].odds)}`);
  record('chooseBall(gengar, "value")', `${tiers[1].ball} · ₽${fmt(tiers[1].expected)}/catch`);

  // Two traces: one that is released and one the protections save.
  const entries = col.entries?.() ?? [];
  const traceSubjects = pickTraceSubjects(entries, auto, releasePlan);

  const test = await auto.selfTest();
  record('selfTest()', `${test.results.filter((r) => r.ok).length}/${test.results.length} invariants hold`);

  // ── the panel ──────────────────────────────────────────────────────────────
  render(mode, {
    ctx, auto, eco, col,
    unlockRows, releasePlan, sellPlan, restockPlan, ballTable, tiers, traceSubjects,
    log, test, results: { sold, bought, released },
  });
}

/** One Pokémon the rules released and one they protected, with the trace behind each. */
function pickTraceSubjects(entries, auto, plan) {
  const out = [];
  const releasedUid = plan.release[0]?.entry?.uid ?? null;
  const shiny = entries.find((e) => e.shiny);
  const fromPlan = plan.release[0]?.entry ?? null;
  const candidates = [
    fromPlan ? { label: 'released', entry: fromPlan, extra: { copies: plan.release[0].copies, rank: plan.release[0].rank, value: plan.release[0].value.money, ageS: 900 } } : null,
    shiny ? { label: 'protected', entry: shiny, extra: { copies: 14, rank: 5, value: 3200, ageS: 900 } } : null,
  ].filter(Boolean);
  for (const c of candidates) {
    const subject = { ...c.entry, __extra: c.extra };
    out.push({ ...c, uid: c.entry.uid, releasedUid, trace: auto.explain('release', subject) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(mode, s) {
  const root = document.getElementById('ui');
  document.getElementById('auto-showcase')?.remove();
  document.getElementById('auto-style')?.remove();

  const style = document.createElement('style');
  style.id = 'auto-style';
  style.textContent = CSS;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.id = 'auto-showcase';
  el.className = `mode-${mode}`;
  el.innerHTML = head(s) + body(mode, s);
  root.appendChild(el);
}

function head(s) {
  const list = s.auto.list();
  const unlocked = list.filter((a) => a.unlocked).length;
  const active = list.filter((a) => a.active).length;
  const diag = s.auto.diagnostics();
  const flags = (diag.idle?.has ?? []).map((f) =>
    `<span class="${f.on ? 'on' : 'off'}">${esc(f.id)}</span>`).join('');
  const coins = [
    ['◈', 'research', s.eco.balance?.('research'), '#7fe6c4'],
    ['₽', 'money', s.eco.balance?.('money'), '#ffd76a'],
    ['◆', 'shards', s.eco.balance?.('shards'), '#c6a8ff'],
  ].map(([sym, name, v, c]) => `
    <div class="coin" style="--coin:${c}"><b>${sym}</b><span class="v">${fmt(v)}</span><span class="n">${name}</span></div>`).join('');

  return `
  <div class="head">
    <div class="ball"></div>
    <h1>Automation<span>rule engine · unlockables · auto-hunt, ball, release, sell, restock</span></h1>
    <div class="wallet">${coins}
      <div class="mults">
        <span>${unlocked}/${list.length} unlocked</span>
        <span>${active} active</span>
        <span class="flags">idle: ${flags || '—'}</span>
      </div>
    </div>
  </div>`;
}

function body(mode, s) {
  if (mode === 'rules') return `<div class="grid two">${panelRules(s, true)}${panelTrace(s)}${panelSchema(s)}</div>`;
  if (mode === 'balls') return `<div class="grid two">${panelBalls(s, true)}${panelBallLog(s)}${panelTiers(s)}</div>`;
  if (mode === 'release') return `<div class="grid two">${panelPreview(s, true)}${panelRules(s, true)}</div>`;
  if (mode === 'hunt') return `<div class="grid two">${panelAutomations(s)}${panelBridge(s)}${panelLog(s)}</div>`;
  return `
  <div class="grid">
    <div class="col">${panelAutomations(s)}${panelSchema(s)}</div>
    <div class="col">${panelRules(s)}${panelPreview(s)}</div>
    <div class="col">${panelBalls(s)}${panelTrade(s)}</div>
    <div class="col">${panelLog(s)}</div>
  </div>`;
}

// --- panels ----------------------------------------------------------------

function panelAutomations(s) {
  const rows = s.auto.list().map((a) => {
    const state = !a.unlocked ? (a.unlock.met ? 'locked' : 'gated')
      : a.active ? (a.paused ? 'paused' : 'on') : 'off';
    const stat = a.stats.actions ? `${fmt(a.stats.actions)} acts` : `${a.rules.length} rules`;
    return `
    <tr class="s-${state}">
      <td class="name"><b>${esc(a.name)}</b><em>${esc(a.blurb)}</em></td>
      <td class="num">${a.unlock.cost}<i>◈</i></td>
      <td class="num">${a.everyS ? `${a.everyS}s` : 'event'}</td>
      <td class="num">${stat}</td>
      <td><span class="pill ${state}">${state}</span></td>
    </tr>`;
  }).join('');
  const gated = s.auto.list().filter((a) => !a.unlock.met);
  return `
  <section class="panel">
    <h2>The six automations <small>research buys them; a second switch turns them on</small></h2>
    <table class="autos">
      <thead><tr><th>automation</th><th class="num">cost</th><th class="num">every</th><th class="num">activity</th><th>state</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="note">Unlocking spends <b>research</b> — the currency <code>idle</code> mints and nothing else
      spends — and never enables. ${gated.length
    ? `${gated.map((g) => `<b>${esc(g.name)}</b> still needs ${esc(g.unlock.text)}`).join('; ')}.`
    : 'Every gate is open on this save.'}
      Auto-Hunt and Auto-Catch grant <code>idle</code>'s <code>auto-battler</code> and <code>auto-catch</code> flags;
      nothing else in the tree ever does, so this module is what turns idle income into a hunt.</p>
  </section>`;
}

function panelSchema(s) {
  const schema = s.auto.schema();
  const kinds = schema.kinds.map((k) => {
    const byType = {};
    for (const f of k.fields) byType[f.type] = (byType[f.type] ?? 0) + 1;
    return `<tr><td class="name"><b>${esc(k.kind)}</b></td><td class="num">${k.fields.length}</td>
      <td>${Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(' · ')}</td></tr>`;
  }).join('');
  const sample = FIELD_SETS.stored.slice(7, 13).map((f) => `
    <li><b>${esc(f.label)}</b> <em>${esc(f.type)}${f.unit ? ` ${esc(f.unit)}` : ''}</em>
      <span>${(f.values ?? []).length ? esc(f.values.slice(0, 4).join(', ')) : `${f.min ?? '—'}…${f.max ?? '—'}`}</span></li>`).join('');
  return `
  <section class="panel">
    <h2>What <code>ui</code> renders from <small>schema(), not a list of checkboxes</small></h2>
    <table class="schema">
      <thead><tr><th>subject kind</th><th class="num">fields</th><th>by type</th></tr></thead>
      <tbody>${kinds}</tbody>
    </table>
    <ul class="fields">${sample}</ul>
    <p class="note">${schema.operators.length} operators, each declaring its arity and the field types it
      accepts, so an editor filters the operator list from the field the player picked and draws the right
      value control — a number box, a multi-select, or nothing at all for a boolean. Limits:
      ${schema.limits.maxRules} rules, ${schema.limits.maxConditions} conditions each.</p>
  </section>`;
}

function panelRules(s, full = false) {
  const a = s.auto.get('release');
  const releasedBy = {};
  for (const r of s.releasePlan.release) releasedBy[r.rule] = (releasedBy[r.rule] ?? 0) + 1;
  const rows = a.rules.map((r, i) => {
    const kept = s.releasePlan.reasons[r.id] ?? 0;
    const rel = releasedBy[r.id] ?? 0;
    return `
    <tr class="${r.then === 'release' ? 'act-release' : 'act-keep'}${r.enabled ? '' : ' off'}">
      <td class="num idx">${i + 1}</td>
      <td class="name"><b>${esc(r.name)}</b><em>${esc(s.auto.describeRule('release', r))}</em></td>
      <td><span class="act ${r.then}">${esc(r.then)}</span></td>
      <td class="num">${rel ? `<b>${rel}</b>` : kept ? kept : '—'}</td>
    </tr>`;
  }).join('');
  return `
  <section class="panel${full ? ' tall' : ''}">
    <h2>Auto-Release, rule by rule <small>first match wins, top to bottom</small></h2>
    <table class="rules">
      <thead><tr><th class="num">#</th><th>rule</th><th>action</th><th class="num">hit</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="note">The seven protections sit <b>above</b> the rule that releases anything, so they cannot be
      outvoted — only reordered, deliberately, by the player. The grace period is a rule too
      (<code>ageS &lt; 120</code>), not a hidden constant, which is the whole test of whether the engine is
      really general: the same mechanism that says "never a shiny" says "never a Dragon under level 40".
      ${a.errors.length ? `<b class="bad">${a.errors.length} rule errors</b>` : 'All rules validate.'}</p>
  </section>`;
}

function panelTrace(s) {
  const blocks = s.traceSubjects.map((t) => {
    const leaves = t.trace.trace.filter((r) => r.state === 'matched' || r.state === 'no').slice(0, 6).map((r) => `
      <li class="${r.state === 'matched' ? 'hit' : 'miss'}">
        <b>${esc(r.name)}</b>
        <span>${r.leaves.map((l) => `<i class="${l.ok ? 'y' : 'n'}">${esc(l.text)} <em>(${esc(l.got)})</em></i>`).join(' ')}</span>
      </li>`).join('');
    return `
    <div class="trace">
      <h3>${esc(t.entry.display ?? t.entry.species)} lv${t.entry.level}${t.entry.shiny ? ' ★' : ''}
        <span class="act ${t.trace.action}">${esc(t.trace.action)}</span>
        <small>by ${esc(t.trace.ruleName ?? 'default')}</small></h3>
      <ul>${leaves}</ul>
    </div>`;
  }).join('');
  return `
  <section class="panel tall">
    <h2>Why <small>explain() returns the per-leaf trace behind every decision</small></h2>
    ${blocks}
    <p class="note">An automation nobody dares switch on is worth nothing. Every decision names one rule,
      and every leaf of that rule shows the value it read, so a player who finds a Pokémon missing can read
      the line that released it.</p>
  </section>`;
}

function panelPreview(s, full = false) {
  const p = s.releasePlan;
  const rows = p.release.slice(0, full ? 26 : 11).map((r) => `
    <tr>
      <td class="name"><b>${esc(r.entry.display ?? r.entry.species)}</b><em>lv ${r.entry.level} · ${((r.entry.ivTotal / 186) * 100).toFixed(0)}% IV</em></td>
      <td class="num">#${r.rank}/${r.copies}</td>
      <td class="num">₽${fmt(r.value.money)}</td>
      <td class="rule">${esc(r.ruleName ?? '')}</td>
    </tr>`).join('');
  const keeps = Object.entries(p.reasons).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([id, n]) => `<span>${esc(id)} <b>${n}</b></span>`).join('');
  return `
  <section class="panel${full ? ' tall' : ''}">
    <h2>The release preview <small>dry run — nothing moved to produce this</small></h2>
    <div class="summary">
      <div><b>${p.release.length}</b><span>to release</span></div>
      <div><b>₽${fmt(p.value.money)}</b><span>appraised</span></div>
      <div><b>◆${fmt(p.value.shards)}</b><span>shards</span></div>
      <div><b>${fmt(p.keep)}</b><span>protected</span></div>
      <div><b>${p.capped}</b><span>over the cap</span></div>
    </div>
    <table class="plan">
      <thead><tr><th>pokémon</th><th class="num">rank</th><th class="num">value</th><th>rule</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="note">Kept by: ${keeps || '—'}. Worst-ranked first, so a capped pass gives up the least;
      ties break on the storage uid, so two runs of the same save release the same Pokémon.
      ${s.results.released ? `<b>Applied:</b> ${s.results.released.applied} released for ₽${fmt(s.results.released.value?.money ?? 0)}.` : ''}</p>
  </section>`;
}

function panelBalls(s, full = false) {
  const pick = s.tiers.find((t) => t.tier === 'value');
  const rows = [...s.ballTable]
    .sort((a, b) => (a.expected === b.expected ? b.odds - a.odds : a.expected - b.expected))
    .slice(0, full ? 18 : 12)
    .map((r) => `
    <tr class="${r.id === pick?.ball ? 'picked' : ''}${r.usable ? '' : ' dim'}">
      <td class="name"><b>${esc(r.name)}</b>${r.when ? `<em>${esc(r.when)}</em>` : ''}</td>
      <td class="num">${r.multiplier >= 255 ? '∞' : `${r.multiplier}×`}</td>
      <td class="num">${pct(r.odds)}</td>
      <td class="num">${r.cost === 0 ? 'free' : `₽${fmt(r.cost)}`}</td>
      <td class="num strong">${Number.isFinite(r.expected) ? `₽${fmt(r.expected)}` : '—'}</td>
      <td class="bar"><i style="width:${Math.min(100, r.odds * 100).toFixed(1)}%"></i></td>
    </tr>`).join('');
  return `
  <section class="panel${full ? ' tall' : ''}">
    <h2>The ball line, optimised <small>${esc(WORKED.label)}</small></h2>
    <table class="balls">
      <thead><tr><th>ball</th><th class="num">mult</th><th class="num">odds</th><th class="num">price</th>
        <th class="num">₽/catch</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="note">Sorted by <b>money-equivalent cost per Pokémon actually caught</b>, which is not the
      multiplier order: the capture curve saturates, so a better ball at a saturated target buys three
      percent for several times the price. BP is converted at ₽${fmt(s.auto.settings('ball').bpWeight)} a
      point, because BP only comes from battles won. The Master Ball is held out of every comparison and
      re-enters only for a secured target nothing else can reach ${pct(s.auto.settings('ball').masterFloor)}.</p>
  </section>`;
}

function panelTiers(s) {
  const rows = s.tiers.map((t) => `
    <tr><td class="name"><b>${esc(t.tier)}</b></td>
      <td>${esc(t.name ?? t.ball ?? 'none')}</td>
      <td class="num">${pct(t.odds)}</td>
      <td class="num">${Number.isFinite(t.expected) ? `₽${fmt(t.expected)}` : '—'}</td>
      <td class="why">${esc(t.why)}</td></tr>`).join('');
  const ruleRows = s.auto.get('ball').rules.map((r, i) => `
    <tr><td class="num idx">${i + 1}</td><td class="name"><b>${esc(r.name)}</b><em>${esc(s.auto.describeRule('ball', r))}</em></td>
      <td><span class="act ${r.then}">${esc(r.then)}</span></td></tr>`).join('');
  return `
  <section class="panel">
    <h2>Tier by tier <small>the rules sort the target; the optimiser picks the ball</small></h2>
    <table class="tiers">
      <thead><tr><th>tier</th><th>ball</th><th class="num">odds</th><th class="num">₽/catch</th><th>why</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <table class="rules">
      <thead><tr><th class="num">#</th><th>rule</th><th>tier</th></tr></thead>
      <tbody>${ruleRows}</tbody>
    </table>
  </section>`;
}

function panelBallLog(s) {
  const rows = s.auto.ballLog().slice(-16).map((b) => `
    <li><code>${esc(b.species)} lv${b.level}${b.shiny ? ' ★' : ''}</code>
      <span>${esc(b.ball ?? 'none')} · ${pct(b.odds)} · <em>${esc(b.tier)}</em></span></li>`).join('');
  return `
  <section class="panel">
    <h2>Every ball this session chose <small>one line per catch that arrived from <code>idle</code></small></h2>
    <ol class="log">${rows || '<li><span>no catches yet</span></li>'}</ol>
    <p class="note">On the idle path the choice is <b>advisory</b> and is honest about it:
      <code>idle/accrual.js</code> resolves a catch from a fixed chance that never reads the bag, so a better
      ball cannot change an outcome already decided. The ball is recorded on the box entry as provenance and
      no capsule is spent twice. Closing the gap needs one field in <code>IdleState</code>; it is a
      cross-module request, not a fiction.</p>
  </section>`;
}

function panelTrade(s) {
  const sell = s.sellPlan.plan.slice(0, 7).map((r) => `
    <tr><td class="name"><b>${esc(r.name)}</b><em>${esc(r.ruleName)}</em></td>
      <td class="num">${r.qty}${r.keep ? ` <i>keep ${r.keep}</i>` : ''}</td>
      <td class="num strong">₽${fmt(r.money)}</td></tr>`).join('');
  const buy = s.restockPlan.plan.slice(0, 6).map((r) => `
    <tr><td class="name"><b>${esc(r.name)}</b><em>${esc(r.ruleName)}</em></td>
      <td class="num">${r.qty}${r.partial ? ' <i>budget</i>' : ''}</td>
      <td class="num strong">₽${fmt(r.cost)}</td></tr>`).join('');
  return `
  <section class="panel">
    <h2>Auto-Sell and Auto-Restock <small>the bag half of the loop</small></h2>
    <table class="plan">
      <thead><tr><th>sell</th><th class="num">qty</th><th class="num">₽</th></tr></thead>
      <tbody>${sell || '<tr><td colspan="3" class="empty">nothing matches</td></tr>'}</tbody>
    </table>
    <table class="plan">
      <thead><tr><th>restock</th><th class="num">qty</th><th class="num">₽</th></tr></thead>
      <tbody>${buy || '<tr><td colspan="3" class="empty">nothing to buy</td></tr>'}</tbody>
    </table>
    <p class="note">Restock spends at most ${(s.auto.settings('restock').budgetFraction * 100).toFixed(0)}% of
      the wallet in a pass and never below ₽${fmt(s.auto.settings('restock').floor)}: budget
      ₽${fmt(s.restockPlan.budget)} of ₽${fmt(s.restockPlan.money)}. Rule order is the priority, so a thin
      wallet buys balls before potions, and a line that does not fit is bought partially rather than skipped.
      Only money purchases are automated — spending someone's Battle Points unasked is exactly the surprise
      an automation must not spring.</p>
  </section>`;
}

function panelBridge(s) {
  const t = s.auto.totals();
  const d = s.auto.diagnostics();
  return `
  <section class="panel">
    <h2>The bridge into <code>idle</code> <small>where a catch gets a body</small></h2>
    <div class="summary">
      <div><b>${fmt(t.deposited)}</b><span>deposited</span></div>
      <div><b>${fmt(t.synthesised)}</b><span>rolled</span></div>
      <div><b>${fmt(t.ballsChosen)}</b><span>balls chosen</span></div>
      <div><b>${fmt(t.wouldHaveSkipped)}</b><span>rules would have skipped</span></div>
      <div><b>${d.catchOrdinal}</b><span>stream ordinal</span></div>
    </div>
    <p class="note"><code>idle</code> reports <code>gains.catches</code> as a count plus at most eight sample
      events, and never creates a Pokémon — §4 reserves <code>catch:succeeded</code> for
      <code>encounter</code>. So this module deposits them through <code>collection.deposit()</code>, the same
      intake path a wild catch takes, and rolls the surplus from
      <code>ctx.rng.fork('automation/catch/&lt;n&gt;')</code> against the biome's encounter table. The ordinal
      lives in this module's save slice, so a reload cannot renumber the stream.
      <b>${fmt(t.wouldHaveSkipped)}</b> of the catches that arrived are ones the catch rules would have
      declined — the number that says what the missing seam costs.</p>
  </section>`;
}

function panelLog(s) {
  const lines = s.log.map((l) => `<li><code>${esc(l.call)}</code><span>${esc(l.result)}</span></li>`).join('');
  const audit = s.auto.history(16).map((a) => `
    <li><code>${a.at.toFixed(1)}s ${esc(a.automation)}·${esc(a.action)}</code>
      <span>${esc(a.subject)}${a.rule ? ` — ${esc(a.rule)}` : ''} ${esc(a.detail)}</span></li>`).join('');
  const checks = s.test.results.map((r) => `
    <li class="${r.ok ? 'pass' : 'fail'}"><b>${r.ok ? '✓' : '✗'}</b> ${esc(r.name)}<span>${esc(r.detail)}</span></li>`).join('');
  return `
  <section class="panel tall">
    <h2>Session transcript <small>every line is a live API call</small></h2>
    <ol class="log">${lines}</ol>
    <h3>Audit log <small>${s.auto.history().length} entries · simulated time, never a wall clock</small></h3>
    <ol class="log audit">${audit || '<li><span>nothing acted yet</span></li>'}</ol>
    <h3>Invariants <small>${s.test.results.filter((r) => r.ok).length}/${s.test.results.length}</small></h3>
    <ul class="checks">${checks}</ul>
  </section>`;
}

// ---------------------------------------------------------------------------
// Style. The same dark glass as the economy console, one accent shifted to teal.
// ---------------------------------------------------------------------------

const CSS = `
#auto-showcase {
  position: absolute; inset: 16px;
  display: flex; flex-direction: column; gap: 9px;
  font: 12px/1.45 ui-monospace, "SF Mono", Menlo, monospace;
  color: #dbe6f4; pointer-events: auto;
}
#auto-showcase .head {
  display: flex; align-items: center; gap: 14px;
  padding: 9px 15px; border-radius: 10px;
  background: linear-gradient(180deg, rgba(20,28,42,.94), rgba(10,15,24,.92));
  border: 1px solid rgba(150,190,235,.20);
  box-shadow: 0 10px 30px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.06);
}
#auto-showcase .ball {
  width: 20px; height: 20px; border-radius: 50%; flex: none; position: relative;
  background: linear-gradient(180deg, #e8544a 0 46%, #1a2231 46% 54%, #f2f5f8 54% 100%);
  border: 1.5px solid #0d1119; box-shadow: inset 0 0 0 1px rgba(255,255,255,.12);
}
#auto-showcase .ball::after {
  content: ''; position: absolute; left: 50%; top: 50%; width: 6px; height: 6px;
  transform: translate(-50%,-50%); border-radius: 50%;
  background: #f2f5f8; border: 1.5px solid #0d1119;
}
#auto-showcase h1 { margin: 0; font-size: 13px; letter-spacing: .18em; text-transform: uppercase; font-weight: 700; }
#auto-showcase h1 span {
  display: block; font-size: 10px; letter-spacing: .1em; color: #7b8fae;
  font-weight: 500; text-transform: none; margin-top: 3px;
}
#auto-showcase .wallet { margin-left: auto; display: flex; align-items: center; gap: 9px; }
#auto-showcase .coin {
  display: flex; align-items: baseline; gap: 6px; padding: 5px 11px; border-radius: 7px;
  background: rgba(255,255,255,.045); border: 1px solid color-mix(in srgb, var(--coin) 34%, transparent);
}
#auto-showcase .coin b { color: var(--coin); font-size: 13px; }
#auto-showcase .coin .v { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
#auto-showcase .coin .n { font-size: 9.5px; letter-spacing: .1em; color: #7b8fae; text-transform: uppercase; }
#auto-showcase .mults {
  display: flex; gap: 9px; padding-left: 12px; margin-left: 3px;
  border-left: 1px solid rgba(150,190,235,.18); color: #93a8c4; font-size: 10.5px;
}
#auto-showcase .flags span { margin-left: 5px; padding: 1px 5px; border-radius: 3px; font-size: 9.5px; }
#auto-showcase .flags .on { background: rgba(127,230,196,.18); color: #7fe6c4; }
#auto-showcase .flags .off { background: rgba(255,255,255,.06); color: #64768f; }

#auto-showcase .grid { flex: 1; display: grid; grid-template-columns: repeat(4, 1fr); gap: 9px; min-height: 0; }
#auto-showcase .grid.two { grid-template-columns: repeat(2, 1fr); }
#auto-showcase .col { display: flex; flex-direction: column; gap: 9px; min-height: 0; }
#auto-showcase .panel {
  background: linear-gradient(180deg, rgba(17,24,36,.93), rgba(9,13,21,.93));
  border: 1px solid rgba(150,190,235,.16); border-radius: 9px;
  padding: 10px 13px 11px; overflow: hidden; min-height: 0;
  box-shadow: 0 8px 24px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.05);
  display: flex; flex-direction: column;
}
#auto-showcase .panel.tall { flex: 1; }
#auto-showcase h2 {
  margin: 0 0 8px; font-size: 10.5px; letter-spacing: .15em; text-transform: uppercase;
  color: #eaf2fb; font-weight: 700; flex: none;
}
#auto-showcase h2 small, #auto-showcase h3 small {
  margin-left: 8px; font-size: 9.5px; letter-spacing: .05em; color: #6d819c;
  text-transform: none; font-weight: 500;
}
#auto-showcase h3 {
  margin: 11px 0 6px; font-size: 10px; letter-spacing: .13em; text-transform: uppercase;
  color: #c3d3e6; font-weight: 700;
}
#auto-showcase table { width: 100%; border-collapse: collapse; font-size: 11px; }
#auto-showcase th {
  text-align: left; font-weight: 600; font-size: 9px; letter-spacing: .1em; text-transform: uppercase;
  color: #6d819c; padding: 0 6px 5px 0; border-bottom: 1px solid rgba(150,190,235,.14);
}
#auto-showcase td { padding: 3px 6px 3px 0; border-bottom: 1px solid rgba(150,190,235,.055); vertical-align: top; }
#auto-showcase .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
#auto-showcase td.num { color: #b7c8dd; }
#auto-showcase td.num.strong { color: #7fe6c4; font-weight: 700; }
#auto-showcase td.idx { color: #56698a; width: 16px; }
#auto-showcase td.name b { font-weight: 600; color: #eaf2fb; }
#auto-showcase td.name em {
  display: block; font-style: normal; font-size: 10px; color: #7b8fae; margin-top: 1px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 34ch;
}
#auto-showcase td.rule, #auto-showcase td.why { color: #8fa4c0; font-size: 10px; max-width: 24ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#auto-showcase td.empty { color: #5d6f8c; }
#auto-showcase .autos td.num i { color: #7fe6c4; font-style: normal; margin-left: 2px; }
#auto-showcase .pill {
  display: inline-block; font-size: 9px; letter-spacing: .08em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 4px; font-weight: 700;
}
#auto-showcase .pill.on { background: #7fe6c4; color: #08131b; }
#auto-showcase .pill.off { background: rgba(255,255,255,.09); color: #93a8c4; }
#auto-showcase .pill.paused { background: #ffd76a; color: #1b1405; }
#auto-showcase .pill.locked { background: rgba(150,190,235,.13); color: #8fa4c0; }
#auto-showcase .pill.gated { background: rgba(232,84,74,.2); color: #ff9a92; }
#auto-showcase tr.s-gated td.name b { color: #a9bacf; }
#auto-showcase .act {
  display: inline-block; font-size: 9px; letter-spacing: .07em; text-transform: uppercase;
  padding: 1px 6px; border-radius: 3px; font-weight: 700;
  background: rgba(255,255,255,.07); color: #a9bed6;
}
#auto-showcase .act.release, #auto-showcase .act.sell, #auto-showcase .act.secure { background: rgba(232,84,74,.22); color: #ff9a92; }
#auto-showcase .act.keep, #auto-showcase .act.skip, #auto-showcase .act.flee { background: rgba(150,190,235,.12); color: #9fb4cd; }
#auto-showcase .act.catch, #auto-showcase .act.buy, #auto-showcase .act.fight, #auto-showcase .act.value { background: rgba(127,230,196,.2); color: #7fe6c4; }
#auto-showcase tr.off { opacity: .45; }
#auto-showcase tr.dim { opacity: .5; }
#auto-showcase tr.picked td { background: rgba(127,230,196,.10); }
#auto-showcase tr.picked td.name b { color: #7fe6c4; }
#auto-showcase td.bar { width: 74px; padding-right: 0; }
#auto-showcase td.bar i { display: block; height: 5px; border-radius: 3px; background: linear-gradient(90deg, #3d6f8f, #7fe6c4); margin-top: 4px; }
#auto-showcase .summary { display: flex; gap: 7px; margin: 0 0 9px; flex-wrap: wrap; }
#auto-showcase .summary div {
  flex: 1 1 0; min-width: 62px; background: rgba(255,255,255,.045); border-radius: 6px; padding: 6px 8px;
  border: 1px solid rgba(150,190,235,.13);
}
#auto-showcase .summary b { display: block; font-size: 14px; color: #eaf2fb; font-variant-numeric: tabular-nums; }
#auto-showcase .summary span { font-size: 9px; letter-spacing: .07em; text-transform: uppercase; color: #7b8fae; }
#auto-showcase .fields { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 2px; }
#auto-showcase .fields li { display: flex; gap: 7px; font-size: 10.5px; }
#auto-showcase .fields b { color: #dbe6f4; font-weight: 600; min-width: 12ch; }
#auto-showcase .fields em { font-style: normal; color: #7fe6c4; min-width: 8ch; }
#auto-showcase .fields span { color: #7b8fae; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#auto-showcase .note {
  margin: 8px 0 0; font-size: 10px; line-height: 1.55; color: #8194ae;
  border-top: 1px solid rgba(150,190,235,.1); padding-top: 7px;
}
#auto-showcase .note b { color: #c3d3e6; }
#auto-showcase .note b.bad { color: #ff9a92; }
#auto-showcase code { font: inherit; color: #9fd8ff; }
#auto-showcase .log { list-style: none; margin: 0; padding: 0; display: grid; gap: 1px; overflow: hidden; }
#auto-showcase .log li { display: flex; gap: 10px; font-size: 10.5px; align-items: baseline; }
#auto-showcase .log code { color: #cfe0f2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 30ch; }
#auto-showcase .log span { margin-left: auto; color: #7fe6c4; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#auto-showcase .log.audit span { color: #93a8c4; }
#auto-showcase .log.audit code { color: #8fa4c0; }
#auto-showcase .checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 1px; }
#auto-showcase .checks li { display: flex; gap: 7px; font-size: 10.5px; align-items: baseline; }
#auto-showcase .checks b { color: #7fe6c4; }
#auto-showcase .checks.fail b, #auto-showcase .checks li.fail b { color: #ff8f8f; }
#auto-showcase .checks span { margin-left: auto; color: #7b8fae; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46ch; }
#auto-showcase .trace { margin-bottom: 10px; }
#auto-showcase .trace h3 { display: flex; align-items: center; gap: 8px; margin-top: 0; }
#auto-showcase .trace ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
#auto-showcase .trace li { font-size: 10.5px; display: flex; gap: 8px; }
#auto-showcase .trace li b { min-width: 22ch; color: #b7c8dd; font-weight: 600; }
#auto-showcase .trace li.hit b { color: #7fe6c4; }
#auto-showcase .trace i { font-style: normal; margin-right: 8px; }
#auto-showcase .trace i.y { color: #9fd8ff; }
#auto-showcase .trace i.n { color: #64768f; }
#auto-showcase .trace i em { font-style: normal; color: #56698a; }
`;
