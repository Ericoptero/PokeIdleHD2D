/**
 * panel.js — the idle showcase's face.
 *
 * `idle` is a systems module: its output is numbers, not pixels. That is not an excuse for
 * a debug dump. This draws the same information a player would see in a progression HUD —
 * where the income comes from, which Pokemon is pulling its weight, what the multipliers
 * are doing — in the game's own dark-glass language, at full DOM resolution over the pixel
 * scene, the way src/ui/index.js describes the overlay.
 *
 * It is deliberately dumb: `showcase.js` measures, this draws what it is handed.
 */

const TYPE_COLOURS = {
  normal: '#9fa19f', fire: '#e2721f', water: '#3b8cd6', electric: '#e6c22a', grass: '#4aa03c',
  ice: '#5fc7d1', fighting: '#b03b2e', poison: '#8b3f8b', ground: '#c8a844', flying: '#7f9fd6',
  psychic: '#d4487f', bug: '#8fa829', rock: '#a08a3a', ghost: '#6a5a9c', dragon: '#5a48c9',
  dark: '#5a4a42', steel: '#7d8a99', fairy: '#d98fbf',
};

const CSS = `
#idlesc { position:fixed; inset:0; pointer-events:none; z-index:20;
  font: 12px/1.45 ui-monospace, "SF Mono", Menlo, monospace; color:#dce8f6;
  -webkit-font-smoothing:antialiased; }
#idlesc .col { position:absolute; bottom:20px; display:flex; flex-direction:column; gap:12px; }
/* The left column starts below the game's own HUD chips so the live money counter, which
   this module is the one feeding, stays visible next to the numbers that explain it. */
#idlesc .col.l { left:20px; width:700px; top:58px; }
#idlesc .col.r { right:20px; width:600px; top:20px; }
#idlesc .card { overflow:hidden; background:linear-gradient(180deg, rgba(10,15,24,.90), rgba(8,11,18,.86));
  border:1px solid rgba(140,180,230,.16); border-radius:10px; padding:12px 15px 12px;
  box-shadow:0 10px 30px rgba(0,0,0,.45), inset 0 1px 0 rgba(180,210,245,.07);
  backdrop-filter:blur(9px); }
#idlesc .card.grow { flex:1 1 auto; overflow:hidden; }
#idlesc h2 { margin:0 0 10px; font:600 10px/1 ui-monospace, Menlo, monospace; letter-spacing:.20em;
  text-transform:uppercase; color:#7f9cbb; display:flex; align-items:center; gap:10px; }
#idlesc h2::after { content:''; flex:1; height:1px; background:linear-gradient(90deg, rgba(140,180,230,.22), transparent); }
#idlesc h2 .tag { letter-spacing:.08em; color:#5e7b9a; text-transform:none; font-weight:400; }

#idlesc .title { display:flex; align-items:baseline; gap:12px; margin:-2px 0 12px; }
#idlesc .title b { font:700 17px/1 ui-monospace, Menlo, monospace; letter-spacing:.10em; color:#f2f7fd; }
#idlesc .title span { color:#7f9cbb; letter-spacing:.04em; }
#idlesc .pill { display:inline-block; padding:2px 7px; border-radius:999px; font-size:10px;
  letter-spacing:.08em; border:1px solid rgba(140,180,230,.22); color:#b9d0e8; background:rgba(90,140,200,.12); }
#idlesc .pill.gold { color:#ffd479; border-color:rgba(255,212,121,.32); background:rgba(255,190,80,.10); }
#idlesc .pill.ok { color:#7ee787; border-color:rgba(126,231,135,.30); background:rgba(126,231,135,.10); }
#idlesc .pill.bad { color:#ff9a9a; border-color:rgba(255,140,140,.34); background:rgba(255,120,120,.12); }

#idlesc .tiles { display:grid; grid-template-columns:repeat(4, 1fr); gap:9px; }
#idlesc .tile { background:rgba(20,29,44,.62); border:1px solid rgba(140,180,230,.12);
  border-radius:8px; padding:9px 10px 10px; }
#idlesc .tile .k { font-size:9.5px; letter-spacing:.14em; text-transform:uppercase; color:#7f9cbb; }
#idlesc .tile .v { font:700 21px/1.1 ui-monospace, Menlo, monospace; margin-top:5px; color:#f2f7fd;
  font-variant-numeric:tabular-nums; }
#idlesc .tile .v em { font-style:normal; font-size:11px; color:#8fa8c4; font-weight:400; margin-left:3px; }
#idlesc .tile .s { font-size:10px; color:#7c93ad; margin-top:3px; }
#idlesc .tile.gold .v { color:#ffd479; }
#idlesc .tile.teal .v { color:#6fe3d0; }

#idlesc table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
#idlesc th { font:600 9.5px/1 ui-monospace, Menlo, monospace; letter-spacing:.12em; text-transform:uppercase;
  color:#6b87a6; text-align:right; padding:0 0 7px 14px; font-weight:600; }
#idlesc td { padding-left:14px; }
#idlesc th.l, #idlesc td.l { text-align:left; }
#idlesc td { padding:4px 0; border-top:1px solid rgba(140,180,230,.08); text-align:right; color:#c6d8ea; }
#idlesc tr.lead td { color:#f2f7fd; }
#idlesc .name { display:flex; align-items:center; gap:10px; }
#idlesc .sprite { width:44px; height:44px; flex:none; image-rendering:pixelated;
  background-repeat:no-repeat; background-size:88px 176px; background-position:0 -88px;
  filter:drop-shadow(0 2px 3px rgba(0,0,0,.55)); }
#idlesc .who b { font-weight:600; letter-spacing:.03em; text-transform:capitalize; }
#idlesc .who .sub { font-size:10px; color:#7c93ad; }
#idlesc .chip { display:inline-block; padding:1px 5px; border-radius:3px; font-size:9px;
  letter-spacing:.06em; text-transform:uppercase; color:#0d1219; font-weight:700; margin-right:3px; }

#idlesc .bar { position:relative; height:5px; border-radius:3px; background:rgba(140,180,230,.10); overflow:hidden; }
#idlesc .bar i { position:absolute; inset:0 auto 0 0; border-radius:3px;
  background:linear-gradient(90deg, #5aa0e0, #6fe3d0); }
#idlesc .bar.gold i { background:linear-gradient(90deg, #d99a3a, #ffd479); }

#idlesc .rows { display:flex; flex-direction:column; gap:6px; }
#idlesc .row { display:grid; grid-template-columns:96px 1fr 84px; align-items:center; gap:10px; }
#idlesc .row .lbl { color:#a9c1da; letter-spacing:.03em; }
#idlesc .row .num { text-align:right; font-variant-numeric:tabular-nums; color:#e6eef8; }
#idlesc .row.dim .lbl, #idlesc .row.dim .num { color:#6f88a3; }

#idlesc .kv { display:grid; grid-template-columns:auto 1fr; gap:3px 14px; }
#idlesc .kv dt { color:#7f9cbb; letter-spacing:.04em; }
#idlesc .kv dd { margin:0; text-align:right; font-variant-numeric:tabular-nums; color:#e6eef8; }

#idlesc .chain { display:flex; flex-wrap:wrap; gap:5px; margin-top:9px; }
#idlesc .chain .m { font-size:10px; padding:2px 7px; border-radius:5px; background:rgba(90,140,200,.13);
  border:1px solid rgba(140,180,230,.16); color:#bcd3ea; }
#idlesc .chain .m b { color:#ffd479; font-weight:700; }
#idlesc .chain .m.off { opacity:.42; }

#idlesc .checks { display:flex; flex-direction:column; }
#idlesc .check { display:grid; grid-template-columns:13px 1fr auto; gap:8px; align-items:baseline;
  padding:0.5px 0; border-top:1px solid rgba(140,180,230,.06); font-size:10.5px; line-height:1.3; }
#idlesc .check:first-child { border-top:0; }
#idlesc .check .m { color:#7ee787; font-weight:700; }
#idlesc .check.bad .m { color:#ff8f8f; }
#idlesc .check .n { color:#cfe0f0; white-space:nowrap; }
#idlesc .check .d { color:#7c93ad; font-size:10px; text-align:right; white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; max-width:250px; }

#idlesc .api { display:grid; grid-template-columns:repeat(3, 1fr); gap:2px 14px; font-size:10.5px; }
#idlesc .api div { display:flex; align-items:baseline; gap:7px; white-space:nowrap; }
#idlesc .api .m { color:#7ee787; font-weight:700; }
#idlesc .api code { color:#e6eef8; font-family:inherit; }
#idlesc .api .t { color:#6b87a6; font-size:10px; }

#idlesc .trace { width:100%; font-size:10.5px; }
#idlesc .trace td { padding:2.5px 0; }
#idlesc .note { color:#7c93ad; font-size:10.5px; margin-top:9px; line-height:1.5; }
#idlesc .note b { color:#b9d0e8; font-weight:600; }
#idlesc .spark { display:block; width:100%; height:34px; margin-top:2px; }
#idlesc .foot { position:absolute; left:20px; bottom:-1px; }
`;

const fmt = (n, dp = 2) => {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const d = abs >= 1000 ? 0 : abs >= 100 ? 1 : dp;
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};

function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
}

function card(title, tag) {
  const c = el('div', 'card');
  c.appendChild(el('h2', null, `${title}${tag ? `<span class="tag">${tag}</span>` : ''}`));
  return c;
}

function tile(k, v, unit, sub, kind = '') {
  return `<div class="tile ${kind}"><div class="k">${k}</div>` +
    `<div class="v">${v}${unit ? `<em>${unit}</em>` : ''}</div>` +
    `${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
}

function typeChips(types) {
  return (types ?? []).map((t) =>
    `<span class="chip" style="background:${TYPE_COLOURS[t] ?? '#63748a'}">${t}</span>`).join('');
}

/** A sparkline of banked money over the recorded history. */
function sparkline(history, width = 566, height = 34) {
  if (!history || history.length < 2) {
    return `<svg class="spark" viewBox="0 0 ${width} ${height}"><text x="4" y="26" fill="#5e7b9a" font-size="11">collecting…</text></svg>`;
  }
  const xs = history.map((h) => h.atMs);
  const ys = history.map((h) => h.money);
  const x0 = xs[0], x1 = Math.max(xs[xs.length - 1], x0 + 1);
  const y1 = Math.max(...ys), y0 = Math.min(...ys);
  const span = Math.max(1e-6, y1 - y0);
  const px = (v) => ((v - x0) / (x1 - x0)) * (width - 2) + 1;
  const py = (v) => height - 4 - ((v - y0) / span) * (height - 10);
  const pts = history.map((h) => `${px(h.atMs).toFixed(1)},${py(h.money).toFixed(1)}`).join(' ');
  const area = `1,${height - 1} ${pts} ${width - 1},${height - 1}`;
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">` +
    `<defs><linearGradient id="idlescg" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#6fe3d0" stop-opacity=".34"/><stop offset="1" stop-color="#6fe3d0" stop-opacity="0"/>` +
    `</linearGradient></defs>` +
    `<polygon points="${area}" fill="url(#idlescg)"/>` +
    `<polyline points="${pts}" fill="none" stroke="#6fe3d0" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

/**
 * Builds the whole overlay from a plain model object.
 * @param {Object} model  see showcase.js — every field is already measured and formatted-ready
 * @returns {HTMLElement} the root, already attached to `document.body`
 */
export function renderPanel(model) {
  document.getElementById('idlesc')?.remove();
  if (!document.getElementById('idlesc-css')) {
    const style = el('style');
    style.id = 'idlesc-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const root = el('div');
  root.id = 'idlesc';
  const left = el('div', 'col l');
  const right = el('div', 'col r');
  root.append(left, right);

  // --- production ----------------------------------------------------------
  const prod = model.production;
  const rateCard = card('Production', `seed ${model.seed} · ${prod.biomeLabel.toLowerCase()} biome`);
  rateCard.insertBefore(
    el('div', 'title',
      `<b>IDLE CORE</b><span>accrual while the tab lives — src/idle/index.js</span>`),
    rateCard.firstChild,
  );
  rateCard.appendChild(el('div', 'tiles',
    tile('Money', fmt(prod.perSecond.money), '/s', `₽${fmt(prod.perSecond.money * 3600, 0)} per hour`, 'gold') +
    tile('Experience', fmt(prod.perSecond.exp), '/s', `${fmt(prod.perSecond.exp * 3600, 0)} per hour`) +
    tile('Research', fmt(prod.perSecond.research, 3), '/s', `${fmt(prod.perSecond.research * 3600, 1)} per hour`, 'teal') +
    tile('Encounters', fmt(prod.perSecond.encounters * 60, 2), '/min', `1 every ${fmt(1 / Math.max(1e-9, prod.perSecond.encounters), 0)}s`)));

  const chain = el('div', 'chain');
  chain.innerHTML =
    `<span class="m">party power <b>${fmt(prod.power)}</b></span>` +
    `<span class="m">${prod.biomeLabel} <b>x${fmt(model.biomeMoneyMult)}</b></span>` +
    prod.applied.map((a) => `<span class="m">${a.name} <b>${a.note}</b></span>`).join('') +
    (prod.applied.length ? '' : '<span class="m off">no unlocks yet</span>');
  rateCard.appendChild(chain);
  rateCard.appendChild(el('div', 'note',
    `Every second is <b>rate(state) x elapsed</b>: a pure function of party, biome and unlocks. ` +
    `These constants are mirrored by <b>economy/pacing.js</b>, which prices its shop against them.`));
  left.appendChild(rateCard);

  // --- party ---------------------------------------------------------------
  const partyCard = card('Party contribution', `${prod.members.length} of 6 slots · lead earns x1.25`);
  const table = el('table');
  table.innerHTML =
    '<thead><tr><th class="l">Pokemon</th><th>Lv</th><th>BST</th><th>Slot</th><th>Biome</th>' +
    '<th>Power</th><th class="l" style="width:150px">Share</th></tr></thead>';
  const tbody = el('tbody');
  for (const m of prod.members) {
    const tr = el('tr', m.lead ? 'lead' : '');
    const sprite = model.sprites[m.name]
      ? `<span class="sprite" style="background-image:url('${model.sprites[m.name]}')"></span>`
      : '<span class="sprite"></span>';
    tr.innerHTML =
      `<td class="l"><div class="name">${sprite}<span class="who"><b>${m.name}</b>` +
      `${m.shiny ? ' <span class="pill gold">shiny</span>' : ''}` +
      `<div class="sub">${typeChips(m.types)}${m.lead ? '<span class="pill">lead</span>' : ''}</div>` +
      `</span></div></td>` +
      `<td>${m.level}</td><td>${m.bst}</td><td>x${fmt(m.slotMult)}</td>` +
      `<td${m.affinity > 1 ? ' style="color:#7ee787"' : ''}>x${fmt(m.affinity)}</td>` +
      `<td>${fmt(m.contribution)}</td>` +
      `<td class="l"><div class="bar gold"><i style="width:${(m.share * 100).toFixed(1)}%"></i></div></td>`;
    tbody.appendChild(tr);
  }
  if (!prod.members.length) {
    tbody.innerHTML = '<tr><td class="l" colspan="7" style="color:#7c93ad">no party — the trainer works the route alone</td></tr>';
  }
  table.appendChild(tbody);
  partyCard.appendChild(table);
  left.appendChild(partyCard);

  // --- biome matrix --------------------------------------------------------
  const biomeCard = card('The same party, every biome', 'why the destination matters');
  const rows = el('div', 'rows');
  const best = Math.max(...model.biomes.map((b) => b.money));
  for (const b of model.biomes) {
    const row = el('div', b.current ? 'row' : 'row dim');
    row.innerHTML =
      `<div class="lbl">${b.label}${b.current ? ' <span class="pill">here</span>' : ''}</div>` +
      `<div class="bar gold"><i style="width:${((b.money / best) * 100).toFixed(1)}%"></i></div>` +
      `<div class="num">₽${fmt(b.money)}/s</div>`;
    rows.appendChild(row);
  }
  biomeCard.appendChild(rows);
  biomeCard.appendChild(el('div', 'note',
    `The same party re-priced by <b>production(state)</b>: each member's best matching type ` +
    `wins, so where you hunt is a real decision.`));
  left.appendChild(biomeCard);

  // --- heartbeat -----------------------------------------------------------
  const hb = model.heartbeat;
  const hbCard = card('Heartbeat', `transport: ${hb.transport}`);
  hbCard.appendChild(el('div', 'tiles',
    tile('Transport', hb.transport === 'worker' ? 'WORKER' : hb.transport.toUpperCase(), '',
      `${hb.intervalMs} ms interval`, hb.transport === 'worker' ? 'teal' : '') +
    tile('Beats', String(hb.beats), '', `${hb.missed} missed`) +
    tile('Drift', fmt(hb.lastDriftMs, 0), 'ms', `peak ${fmt(hb.maxDriftMs, 0)} ms`) +
    tile('Fallbacks', String(hb.fallbacks), '', hb.workerErrors ? `${hb.workerErrors} worker errors` : 'worker healthy')));

  const noFrames = model.noFrameWindow;
  hbCard.appendChild(el('div', 'note',
    `<b>Measured before the first frame was ever drawn:</b> for <b>${fmt(noFrames.wallMs, 0)} ms</b> this ` +
    `module reported itself hidden and its frame hook ran <b>${noFrames.frames}</b> times. ` +
    `The heartbeat delivered <b>${noFrames.beats}</b> beat(s), which credited <b>${fmt(noFrames.creditedS)} s</b> ` +
    `and banked <b>₽${fmt(noFrames.money, 0)}</b>. Accrual does not need the frame loop.`));
  right.appendChild(hbCard);

  // --- background gap ------------------------------------------------------
  const gap = model.gap;
  const gapCard = card('Background gap', `${gap.label} drained in bounded slices`);
  gapCard.appendChild(el('div', 'tiles',
    tile('Gap', gap.label, '', `${fmt(gap.seconds, 0)} s owed`) +
    tile('Drain passes', String(gap.calls), '', `${gap.steps} sim steps`) +
    tile('Worst frame', fmt(gap.worstMs), 'ms', `${gap.budgetMs} ms budget · step ${fmt(gap.worstStepMs)} ms`) +
    tile('Banked', `₽${fmt(gap.money, 0)}`, '', `${gap.encounters} encounters`, 'gold')));

  const trace = el('table', 'trace');
  trace.innerHTML =
    '<thead><tr><th class="l">Frame</th><th>Slice</th><th>Steps</th><th>Step size</th><th>Cost</th><th>Left</th></tr></thead>' +
    `<tbody>${gap.trace.map((t, i) => `<tr><td class="l">${i + 1}</td><td>${fmt(t.appliedS, 0)} s</td>` +
      `<td>${t.steps}</td><td>${fmt(t.stepS)} s</td><td>${fmt(t.ms)} ms</td>` +
      `<td>${t.remainingS > 0 ? `${fmt(t.remainingS, 0)} s` : '<span class="pill ok">done</span>'}</td></tr>`).join('')}</tbody>`;
  gapCard.style.marginTop = '0';
  gapCard.appendChild(trace);
  gapCard.appendChild(el('div', 'note',
    `Identical to the single <b>simulate(state, ${fmt(gap.seconds, 0)}, seed)</b> call <b>offline</b> ` +
    `would make: <b>${gap.invariance.encounters}</b> encounters both ways, money differing by ` +
    `<b>${gap.invariance.moneyRelErr}</b> relative. The loop stops at the first clock read ` +
    `past its budget.`));
  right.appendChild(gapCard);

  // --- the src/idle/index.js surface ----------------------------------------------------
  const apiCard = card('Public API', 'src/idle/index.js — contract, then depth');
  const api = el('div', 'api');
  api.innerHTML = model.api.map((a) =>
    `<div><span class="m">${a.ok ? '✓' : '✗'}</span><code>${a.name}</code><span class="t">${a.note}</span></div>`).join('');
  apiCard.appendChild(api);
  right.appendChild(apiCard);

  // --- checks --------------------------------------------------------------
  const checkCard = card('Contract checks', `${model.selftest.passed}/${model.selftest.total} passing · run in this browser`);
  const checks = el('div', 'checks');
  for (const r of model.selftest.results) {
    checks.appendChild(el('div', `check${r.ok ? '' : ' bad'}`,
      `<span class="m">${r.ok ? '✓' : '✗'}</span><span class="n">${r.name}</span><span class="d">${r.detail}</span>`));
  }
  checkCard.appendChild(checks);
  right.appendChild(checkCard);

  // --- live -----------------------------------------------------------------
  // economy multiplies `add(..., 'idle')` by its own Payday upgrade on the way in, so the
  // wallet can climb faster than the rate above. Said here rather than hidden in a comment.
  const liveCard = card('Banked, live', 'to economy at 1 Hz · fractions carried · Payday applied there');
  liveCard.appendChild(el('div', null, sparkline(model.history)));
  const kv = el('dl', 'kv');
  kv.innerHTML =
    `<dt>lifetime money</dt><dd>₽${fmt(model.totals.money, 0)}</dd>` +
    `<dt>simulated seconds</dt><dd>${fmt(model.totals.seconds, 0)} s</dd>` +
    `<dt>encounters resolved</dt><dd>${model.totals.encounters}</dd>` +
    `<dt>wins / catches / shinies</dt><dd>${model.totals.wins} / ${model.totals.catches} / ${model.totals.shinies}</dd>` +
    `<dt>pending, unclaimed</dt><dd>${fmt(model.pendingS, 2)} s</dd>` +
    `<dt>clock corrections</dt><dd>${model.clock.backwards} backwards · ${model.clock.capped} capped</dd>`;
  liveCard.appendChild(kv);
  left.appendChild(liveCard);

  document.body.appendChild(root);
  return root;
}
