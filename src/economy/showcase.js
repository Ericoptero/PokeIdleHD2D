/**
 * The economy showcase (src/main.js).
 *
 * A systems module cannot prove itself with a pretty frame, so this one proves itself with
 * *evidence*: every number on screen is produced by calling the live public API, in order,
 * during the showcase — the transcript on the right is the actual call log, and the wallet
 * at the top is what the ledger says after those calls. Nothing is mocked and nothing is
 * typed in.
 *
 * It is deterministic by construction: the scripted session makes the same calls in the
 * same order every time, the daily deal is a hash of `(day, seed)`, and the pacing table
 * comes from a projection with no RNG in it. Same URL, same pixels.
 *
 * Modes (`?showcase=economy&mode=…`):
 *   default    the whole terminal
 *   shop       the Mart shelf and its progression gates, full height
 *   balls      the ball line evaluated against one worked encounter
 *   upgrades   the upgrade tracks and their cost curves
 *   pacing     the projection the prices were tuned against
 */

import { CURRENCIES } from './currencies.js';
import { UPGRADES, costOf } from './upgrades.js';
import { ITEMS } from './items.js';

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const short = (n) => {
  const v = Math.round(n);
  if (Math.abs(v) < 100000) return v.toLocaleString('en-US');
  for (const [scale, s] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) {
    if (Math.abs(v) >= scale) return `${(v / scale).toFixed(v / scale >= 100 ? 0 : 1)}${s}`;
  }
  return String(v);
};

/**
 * The one encounter every conditional ball is judged against, stated on screen. Chosen so
 * the odds column separates the balls instead of pinning them all at 100%: catch rate 45
 * is the common "hard to catch" value, and a target at a third HP is a normal idle battle.
 */
const WORKED_EXAMPLE = {
  label: 'Gengar · lv 34 · cave · 22:00 · turn 1 · 35% HP · already in the dex',
  context: {
    species: { name: 'gengar', types: ['ghost', 'poison'], baseStats: { spe: 110 }, weightKg: 40.5 },
    level: 34, partyLevel: 41, tod: 22, biome: 'cave', turn: 1, caught: true,
  },
  catchRate: 45,
  hpFraction: 0.35,
  status: 'none',
};

export async function showcaseEconomy(mode = 'default', ctx) {
  const eco = ctx.get('economy');

  // The scene behind the glass. The city is the lobby and the Mart lives in it, so this is
  // the right room to be standing in — but a failure to enter must not take the panel down.
  try {
    await ctx.get('city').enter?.();
    ctx.get('city').preset?.('mart-door') || ctx.get('city').preset?.('plaza');
  } catch { /* the panel is the point; the scene is the backdrop */ }
  ctx.get('environment').setTimeOfDay?.(ctx.config.tod);

  const log = [];
  const record = (call, result) => log.push({ call, result });

  // ── the scripted session ───────────────────────────────────────────────────
  // Ordinary play, compressed: stock up, resell loot, invest, and let the gates open as
  // the dex fills. Every line here is a real call on the module's public API.
  record('balance("money")', `₽${fmt(eco.balance('money'))}`);
  record('buy("pokeball", 10)', `${eco.buy('pokeball', 10)} → bag ${eco.count('pokeball')}, +1 Premier`);
  record('buy("greatball", 1)', `${eco.buy('greatball', 1)} — gated on 5 caught`);

  // Six catches on the bus: `collection` counts them, the Mart's gates open, and this
  // module's own shard faucet fires. Nothing here reaches into another module to do it.
  for (const species of ['zubat', 'geodude', 'gastly', 'onix', 'machop', 'sandshrew']) {
    ctx.bus.emit('catch:succeeded', { instanceId: `showcase-${species}`, species, shiny: false });
  }
  record('6 × catch:succeeded', `dex ${eco.progress().dexCaught} → Great Ball unlocked, +${eco.balance('shards')}◆`);

  eco.give('nugget', 3, 'showcase:loot');
  eco.give('starpiece', 1, 'showcase:loot');
  record('sell("nugget", 3)', `${eco.sell('nugget', 3)} → +₽${fmt(eco.sellValue('nugget') * 3)}`);
  record('sell("starpiece", 1)', `${eco.sell('starpiece', 1)} → +₽${fmt(eco.sellValue('starpiece'))}`);
  const greatball = eco.source('greatball');
  record('buy("greatball", 5)', `${eco.buy('greatball', 5)} → −₽${fmt((greatball?.price ?? 0) * 5)}, bag ${eco.count('greatball')}`);

  eco.add('money', 600000, 'grant:showcase');
  record('add("money", 600k, "grant")', `not income → ₽${fmt(eco.balance('money'))}`);
  record('buyUpgrade("payday", 4)', `${eco.buyUpgrade('payday', 4)} levels → money ×${eco.multipliers().moneyGain.toFixed(2)}`);
  const before = eco.balance('money');
  eco.add('money', 10000, 'idle');
  record('add("money", 10k, "idle")', `×${eco.multipliers().moneyGain.toFixed(2)} on the way in → +₽${fmt(eco.balance('money') - before)}`);
  record('buyUpgrade("market_licence", 2)', `${eco.buyUpgrade('market_licence', 2)} levels → sell ×${eco.multipliers().sellValue.toFixed(2)}`);
  eco.add('research', 2500, 'grant:showcase');
  record('buyUpgrade("expedition", 6)', `${eco.buyUpgrade('expedition', 6)} levels → enc ×${eco.multipliers().encounterRate.toFixed(2)}`);

  // The idle path's faucet, through the real listener: 40 wins mint BP, 12 catches mint shards.
  ctx.bus.emit('idle:tick', { elapsedS: 3600, gains: { wins: 40, catches: 12 } });
  record('idle:tick {wins:40}', `+${eco.balance('bp')} BP, +${eco.balance('shards')}◆ total`);

  const throwResult = eco.throwBall('greatball', WORKED_EXAMPLE.context, WORKED_EXAMPLE);
  record('throwBall("greatball", …)', throwResult.thrown
    ? `${throwResult.multiplier}× → ${(throwResult.odds * 100).toFixed(1)}% (economy never rolls)`
    : throwResult.reason);
  const appraisal = eco.release({ level: 34, shiny: true, species: { name: 'gengar', baseStats: { hp: 60, atk: 65, def: 60, spa: 130, spd: 75, spe: 110 } } });
  record('release(shiny gengar lv34)', `₽${fmt(appraisal.money)} + ${appraisal.shards}◆`);
  const voucher = eco.vouchers();
  record('vouchers()', `#${voucher.bought + 1} costs ₽${short(voucher.price)}, +15% each`);

  const test = eco.selfTest();
  const projection = eco.project({ hours: 720, marks: [0.25, 1, 8, 24, 168, 720] });

  // ── the panel ──────────────────────────────────────────────────────────────
  const root = document.getElementById('ui') ?? document.body;
  document.getElementById('eco-showcase')?.remove();
  document.getElementById('eco-style')?.remove();

  const style = document.createElement('style');
  style.id = 'eco-style';
  style.textContent = CSS;
  document.head.appendChild(style);

  const wrap = document.createElement('div');
  wrap.id = 'eco-showcase';
  wrap.dataset.mode = mode;
  wrap.innerHTML = `
    <header class="eco-head">
      <span class="eco-ball" aria-hidden="true"></span>
      <h1>Economy<span>currency · items · shop</span></h1>
      <div class="eco-wallet">${walletHtml(eco)}</div>
    </header>
    <div class="eco-body">
      ${panel('shop', 'Poké Mart', martHtml(eco), 'stock, prices and the gate on every shelf')}
      ${panel('balls', 'The ball line', ballsHtml(eco), WORKED_EXAMPLE.label)}
      ${panel('upgrades', 'Upgrade tracks', upgradesHtml(eco), 'geometric cost, additive effect')}
      ${panel('pacing', 'Projected pacing', pacingHtml(projection, eco), 'continuous play, greedy spending, no RNG')}
      ${panel('log', 'Session transcript', logHtml(log, test), 'every line is a live API call')}
    </div>`;
  root.appendChild(wrap);
  return { ok: test.ok, calls: log.length };
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

const panel = (id, title, inner, sub = '') => `
  <section class="eco-panel" data-panel="${id}">
    <h2>${title}${sub ? `<small>${sub}</small>` : ''}</h2>
    <div class="eco-scroll">${inner}</div>
  </section>`;

function walletHtml(eco) {
  const mult = eco.multipliers();
  return CURRENCIES.map((c) => `
    <div class="eco-coin" style="--coin:${c.colour}">
      <b>${c.symbol}</b>
      <span class="v">${short(eco.balance(c.id))}</span>
      <span class="n">${c.short}</span>
    </div>`).join('') + `
    <div class="eco-mults">
      <span>money ×${mult.moneyGain.toFixed(2)}</span>
      <span>sell ×${mult.sellValue.toFixed(2)}</span>
      <span>enc ×${mult.encounterRate.toFixed(2)}</span>
      <span>catch ×${mult.catchRate.toFixed(2)}</span>
      <span>balls −${Math.round((1 - mult.ballDiscount) * 100)}%</span>
    </div>`;
}

function martHtml(eco) {
  const deal = eco.deal();
  const rows = eco.stock('mart').map((e) => `
    <tr class="${e.unlocked ? '' : 'locked'}${e.onDeal ? ' deal' : ''}">
      <td class="name">${e.name}${e.onDeal ? '<i class="tag">deal −25%</i>' : ''}
        <small>${e.desc}</small></td>
      <td class="num">${e.unlocked ? `₽${fmt(e.price)}` : '—'}</td>
      <td class="num dim">₽${fmt(e.sell)}</td>
      <td class="req">${e.unlocked ? `<span class="have">${e.owned ? `held ×${e.owned}` : ''}</span>` : `🔒 ${e.requires}`}</td>
    </tr>`).join('');
  const others = eco.shops().filter((s) => s.id !== 'mart').map((s) => `
    <li class="${s.unlocked ? 'open' : 'shut'}"><b>${s.name}</b>
      <span>${s.unlocked ? `${s.size} lines open` : `🔒 ${s.requires}`}</span></li>`).join('');
  return `
    <table class="eco-table eco-mart">
      <colgroup><col><col width="74"><col width="74"><col width="118"></colgroup>
      <thead><tr><th>item</th><th class="num">buy</th><th class="num">sell</th><th class="num">gate</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="eco-note">Today's deal is <b>${eco.item(deal.itemId)?.name ?? deal.itemId}</b> —
      hashed from in-game day ${deal.day} and the world seed, so it is the same on every machine.</p>
    <ul class="eco-shops">${others}</ul>`;
}

function ballsHtml(eco) {
  const balls = ITEMS.filter((i) => i.category === 'ball');
  const rows = balls.map((b) => {
    const m = eco.catchMultiplier(b.id, WORKED_EXAMPLE.context);
    const odds = eco.catchOdds({
      ball: b.id, catchRate: WORKED_EXAMPLE.catchRate, hpFraction: WORKED_EXAMPLE.hpFraction,
      status: WORKED_EXAMPLE.status, context: WORKED_EXAMPLE.context,
    });
    return { b, m, odds };
  }).sort((a, x) => x.m - a.m || a.b.tier - x.b.tier);
  const best = rows[0];
  const body = rows.map(({ b, m, odds }) => `
    <tr class="${b.id === best.b.id ? 'best' : ''}">
      <td class="name">${b.name}${b.when ? `<em>· ${b.when}</em>` : ''}</td>
      <td class="num mult">${m >= 255 ? '∞' : `${m.toFixed(m % 1 ? 1 : 0)}×`}</td>
      <td class="num">${(odds * 100).toFixed(1)}%</td>
      <td class="num dim">${b.price == null ? '—' : b.currency === 'bp' ? `${b.price} BP` : `₽${fmt(b.price)}`}</td>
      <td class="bar"><i style="width:${Math.min(100, odds * 100).toFixed(1)}%"></i></td>
    </tr>`).join('');
  return `
    <table class="eco-table eco-balls">
      <colgroup><col><col width="60"><col width="64"><col width="86"><col width="110"></colgroup>
      <thead><tr><th>ball</th><th class="num">mult</th><th class="num">odds</th><th class="num">price</th><th></th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="eco-note">Mainline Gen 8/9 multipliers against the encounter above; Gen 3/4 odds at
      catch rate ${WORKED_EXAMPLE.catchRate}. <b>economy hands out the odds — encounter rolls them.</b></p>`;
}

function upgradesHtml(eco) {
  const rows = eco.upgrades().map((u) => {
    const def = UPGRADES.find((d) => d.id === u.id);
    const points = [];
    for (let i = 0; i < def.max; i++) points.push(costOf(def, i));
    const maxCost = Math.log(points[points.length - 1]);
    const minCost = Math.log(points[0]);
    const path = points.map((c, i) => {
      const x = (i / (points.length - 1)) * 44;
      const y = 14 - ((Math.log(c) - minCost) / Math.max(1e-9, maxCost - minCost)) * 12;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const sym = { money: '₽', research: '◈', bp: 'BP', shards: '◆' }[u.currency];
    return `
      <tr class="${u.unlocked ? '' : 'locked'}">
        <td class="name">${u.name}<small>${u.desc}</small></td>
        <td class="num">${u.level}<span class="dim">/${u.max}</span></td>
        <td class="num">${u.currency === 'money' ? `₽${short(u.cost)}` : `${short(u.cost)} ${sym}`}</td>
        <td class="num">${u.mode === 'flat' ? `+${u.value}` : `×${u.value.toFixed(2)}`}</td>
        <td class="spark"><svg viewBox="0 0 44 16" preserveAspectRatio="none"><polyline points="${path}"/></svg></td>
      </tr>`;
  }).join('');
  const sinks = eco.sinks();
  const totalMoney = Object.values(sinks).filter((s) => s.currency === 'money').reduce((a, b) => a + b.total, 0);
  return `
    <table class="eco-table eco-upgrades">
      <colgroup><col><col width="52"><col width="92"><col width="56"><col width="60"></colgroup>
      <thead><tr><th>track</th><th class="num">lvl</th><th class="num">next</th><th class="num">now</th><th>curve</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="eco-note">Capped tracks absorb <b>₽${short(totalMoney)}</b>; income therefore cannot run
      away. The sink that never caps is the Wonder Trade voucher — ₽${short(eco.vouchers().price)}, +15% each.</p>`;
}

function pacingHtml(projection, eco) {
  const rows = projection.timeline.map((r) => `
    <tr>
      <td class="name">${r.hours < 1 ? `${Math.round(r.hours * 60)} min` : r.hours < 48 ? `${r.hours} h` : `${Math.round(r.hours / 24)} d`}</td>
      <td class="num">lv ${r.partyLevel}</td>
      <td class="num">₽${short(r.moneyPerHour)}/h</td>
      <td class="num">${r.upgradeLevels}</td>
      <td class="num">×${r.moneyGain.toFixed(2)}</td>
      <td class="num dim">₽${short(r.banked)}</td>
    </tr>`).join('');
  const m = eco.incomeModel();
  return `
    <table class="eco-table">
      <thead><tr><th>played</th><th class="num">party</th><th class="num">income</th>
        <th class="num">upgrades</th><th class="num">money ×</th><th class="num">banked</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="eco-note">Projected with the income model mirrored from <code>${m.mirroredFrom}</code>
      (money ${m.BASE_MONEY}·power^${m.MONEY_POWER_EXP}, exp ${m.BASE_EXP}·power, ${m.BASE_ENCOUNTERS} encounters/s),
      a six-member party from level 5 in the meadow, and a greedy buyer. No RNG: this table is
      the same on every machine. Run it yourself with <code>economy.project({hours:720})</code>.</p>`;
}

function logHtml(log, test) {
  const lines = log.map((l) => `
    <li><code>${l.call}</code><span>${l.result}</span></li>`).join('');
  const checks = test.results.map((r) => `
    <li class="${r.ok ? 'pass' : 'fail'}"><b>${r.ok ? '✓' : '✗'}</b> ${r.name}<span>${r.detail}</span></li>`).join('');
  return `
    <ol class="eco-log">${lines}</ol>
    <h3>Invariants <small>${test.results.filter((r) => r.ok).length}/${test.results.length}</small></h3>
    <ul class="eco-checks">${checks}</ul>`;
}

// ---------------------------------------------------------------------------
// Style. A DS-era terminal: dark glass, one accent per currency, tabular numerals.
// ---------------------------------------------------------------------------

const CSS = `
#eco-showcase {
  position: absolute; inset: 18px;
  display: flex; flex-direction: column; gap: 10px;
  font: 12px/1.45 ui-monospace, "SF Mono", Menlo, monospace;
  color: #dbe6f4; pointer-events: auto;
}
#eco-showcase .eco-head {
  display: flex; align-items: center; gap: 14px;
  padding: 10px 16px; border-radius: 10px;
  background: linear-gradient(180deg, rgba(20,28,42,.94), rgba(10,15,24,.92));
  border: 1px solid rgba(150,190,235,.20);
  box-shadow: 0 10px 30px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.06);
}
#eco-showcase .eco-ball {
  width: 20px; height: 20px; border-radius: 50%; flex: none;
  background: linear-gradient(180deg, #e8544a 0 46%, #1a2231 46% 54%, #f2f5f8 54% 100%);
  border: 1.5px solid #0d1119; box-shadow: inset 0 0 0 1px rgba(255,255,255,.12);
  position: relative;
}
#eco-showcase .eco-ball::after {
  content: ''; position: absolute; left: 50%; top: 50%; width: 6px; height: 6px;
  transform: translate(-50%,-50%); border-radius: 50%;
  background: #f2f5f8; border: 1.5px solid #0d1119;
}
#eco-showcase h1 {
  margin: 0; font-size: 13px; letter-spacing: .18em; text-transform: uppercase; font-weight: 700;
}
#eco-showcase h1 span {
  display: block; font-size: 10px; letter-spacing: .12em; color: #7b8fae;
  font-weight: 500; text-transform: none; margin-top: 3px;
}
#eco-showcase .eco-wallet { margin-left: auto; display: flex; align-items: center; gap: 10px; }
#eco-showcase .eco-coin {
  display: flex; align-items: baseline; gap: 6px; padding: 5px 11px; border-radius: 7px;
  background: rgba(255,255,255,.045); border: 1px solid color-mix(in srgb, var(--coin) 34%, transparent);
}
#eco-showcase .eco-coin b { color: var(--coin); font-size: 13px; }
#eco-showcase .eco-coin .v { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
#eco-showcase .eco-coin .n { font-size: 9.5px; letter-spacing: .1em; color: #7b8fae; text-transform: uppercase; }
#eco-showcase .eco-mults {
  display: flex; gap: 8px; padding-left: 12px; margin-left: 4px;
  border-left: 1px solid rgba(150,190,235,.18); color: #93a8c4; font-size: 10.5px;
}
#eco-showcase .eco-mults span { white-space: nowrap; }

#eco-showcase .eco-body {
  flex: 1; min-height: 0; display: grid; gap: 10px;
  grid-template-columns: 1.06fr 1fr 1.06fr;
  grid-template-rows: 1fr 0.88fr;
  grid-template-areas: "shop balls upgrades" "shop pacing log";
}
#eco-showcase [data-panel="shop"] { grid-area: shop; }
#eco-showcase [data-panel="balls"] { grid-area: balls; }
#eco-showcase [data-panel="upgrades"] { grid-area: upgrades; }
#eco-showcase [data-panel="pacing"] { grid-area: pacing; }
#eco-showcase [data-panel="log"] { grid-area: log; }

/* A focus mode shows one panel, sized to its content rather than stretched to the frame. */
#eco-showcase[data-mode="shop"] .eco-body,
#eco-showcase[data-mode="balls"] .eco-body,
#eco-showcase[data-mode="upgrades"] .eco-body,
#eco-showcase[data-mode="pacing"] .eco-body {
  grid-template-columns: 1fr; grid-template-rows: min-content; align-content: start;
}
#eco-showcase[data-mode="shop"] .eco-panel:not([data-panel="shop"]),
#eco-showcase[data-mode="balls"] .eco-panel:not([data-panel="balls"]),
#eco-showcase[data-mode="upgrades"] .eco-panel:not([data-panel="upgrades"]),
#eco-showcase[data-mode="pacing"] .eco-panel:not([data-panel="pacing"]) { display: none; }
#eco-showcase[data-mode="shop"] .eco-panel,
#eco-showcase[data-mode="balls"] .eco-panel,
#eco-showcase[data-mode="upgrades"] .eco-panel,
#eco-showcase[data-mode="pacing"] .eco-panel { grid-area: auto; }

#eco-showcase .eco-panel {
  min-height: 0; display: flex; flex-direction: column; border-radius: 10px;
  background: linear-gradient(180deg, rgba(14,20,31,.93), rgba(9,13,21,.93));
  border: 1px solid rgba(150,190,235,.16);
  box-shadow: 0 10px 30px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.05);
  overflow: hidden;
}
#eco-showcase .eco-panel h2 {
  margin: 0; padding: 8px 13px 7px; font-size: 10.5px; font-weight: 700;
  letter-spacing: .16em; text-transform: uppercase; color: #b9cde6;
  background: linear-gradient(180deg, rgba(108,198,255,.13), rgba(108,198,255,.02));
  border-bottom: 1px solid rgba(150,190,235,.16);
  display: flex; align-items: baseline; gap: 10px;
}
#eco-showcase .eco-panel h2 small {
  font-size: 9.5px; letter-spacing: .06em; text-transform: none; color: #6f86a4; font-weight: 500;
}
#eco-showcase .eco-scroll { flex: 1; min-height: 0; overflow: hidden; padding: 8px 12px 10px; }

#eco-showcase table.eco-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
#eco-showcase .eco-table th {
  text-align: left; font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase;
  color: #6f86a4; font-weight: 600; padding: 2px 6px 5px; border-bottom: 1px solid rgba(150,190,235,.14);
}
#eco-showcase .eco-table th.num, #eco-showcase .eco-table td.num { text-align: right; }
#eco-showcase .eco-table td { padding: 3px 6px; border-bottom: 1px solid rgba(150,190,235,.055); }
#eco-showcase .eco-mart { table-layout: fixed; }
#eco-showcase .eco-balls { table-layout: fixed; }
#eco-showcase .eco-balls td { padding: 1.5px 6px; line-height: 1.4; }
#eco-showcase .eco-balls td.name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#eco-showcase .eco-balls td.name em { font-style: normal; font-weight: 400; color: #7d92af; margin-left: 2px; }
#eco-showcase .eco-balls td.name small { font-size: 9.5px; max-width: 44ch; }
#eco-showcase .eco-upgrades { table-layout: fixed; }
#eco-showcase .eco-upgrades td { padding: 2px 6px; }
#eco-showcase .eco-upgrades td.name small { font-size: 9.5px; max-width: 52ch; }
#eco-showcase .eco-table tr:last-child td { border-bottom: 0; }
#eco-showcase .eco-table td.name { color: #e7eef8; font-weight: 600; }
#eco-showcase .eco-table td.name small {
  display: block; font-weight: 400; color: #7d92af; font-size: 10px; margin-top: 1px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 62ch;
}
#eco-showcase .eco-table td.dim, #eco-showcase .dim { color: #6f86a4; }
#eco-showcase .eco-table tr.locked td { color: #55677f; }
#eco-showcase .eco-table tr.locked td.name { color: #7b8fae; font-weight: 500; }
#eco-showcase .eco-table td.req { font-size: 10px; color: #d8a659; text-align: right; white-space: nowrap; }
#eco-showcase .eco-table td.req .have { color: #6f86a4; }
#eco-showcase .eco-table tr.deal td { background: rgba(255,215,106,.07); }
#eco-showcase .tag {
  font-style: normal; font-size: 9px; letter-spacing: .08em; text-transform: uppercase;
  color: #0d1119; background: #ffd76a; border-radius: 3px; padding: 1px 5px; margin-left: 7px;
}
#eco-showcase .eco-table tr.best td { background: rgba(108,198,255,.09); }
#eco-showcase .eco-table td.mult { color: #8fd2ff; font-weight: 700; }
#eco-showcase .eco-table td.bar { width: 76px; }
#eco-showcase .eco-table td.bar i {
  display: block; height: 5px; border-radius: 3px;
  background: linear-gradient(90deg, #3f7fb5, #8fd2ff);
}
#eco-showcase .spark { width: 50px; }
#eco-showcase .spark svg { width: 44px; height: 16px; display: block; }
#eco-showcase .spark polyline { fill: none; stroke: #7fe6c4; stroke-width: 1.2; vector-effect: non-scaling-stroke; }

#eco-showcase .eco-note {
  margin: 8px 0 0; font-size: 10px; line-height: 1.6; color: #8298b4;
  border-left: 2px solid rgba(108,198,255,.35); padding-left: 9px;
}
#eco-showcase .eco-note b { color: #cfe0f2; }
#eco-showcase .eco-note code { color: #7fe6c4; }

#eco-showcase .eco-shops { list-style: none; margin: 9px 0 0; padding: 0; display: grid; gap: 4px; }
#eco-showcase .eco-shops li {
  display: flex; justify-content: space-between; gap: 10px; font-size: 10.5px;
  padding: 4px 8px; border-radius: 5px; background: rgba(255,255,255,.035);
}
#eco-showcase .eco-shops li b { color: #cfe0f2; font-weight: 600; }
#eco-showcase .eco-shops li.shut span { color: #d8a659; }
#eco-showcase .eco-shops li.open span { color: #7fe6c4; }

#eco-showcase .eco-log { list-style: none; margin: 0; padding: 0; display: grid; gap: 1px; }
#eco-showcase .eco-log li { display: flex; gap: 10px; font-size: 10px; line-height: 1.4; align-items: baseline; }
#eco-showcase .eco-log code { color: #8fd2ff; white-space: nowrap; }
#eco-showcase .eco-log span { color: #93a8c4; margin-left: auto; text-align: right; white-space: nowrap; }
#eco-showcase h3 {
  margin: 7px 0 4px; font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase;
  color: #6f86a4; display: flex; gap: 8px; align-items: baseline;
}
#eco-showcase h3 small { color: #7fe6c4; letter-spacing: 0; }
#eco-showcase .eco-checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 1px; }
#eco-showcase .eco-checks li { display: flex; gap: 8px; font-size: 10px; line-height: 1.4; align-items: baseline; }
#eco-showcase .eco-checks li b { width: 10px; }
#eco-showcase .eco-checks li.pass b { color: #7fe6c4; }
#eco-showcase .eco-checks li.fail { color: #ff9a9a; }
#eco-showcase .eco-checks li span { color: #6f86a4; margin-left: auto; text-align: right; white-space: nowrap; }
`;
