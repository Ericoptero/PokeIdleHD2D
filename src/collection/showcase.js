/**
 * The collection showcase (src/main.js).
 *
 * A dex and a box system cannot prove themselves with a pretty frame, so this proves itself
 * with a *filled* one: a seeded stream of 260 encounters is played through the real bus
 * before the panel is built, and every number, every bar and every sprite on screen is read
 * back out of the live public API afterwards. Nothing is mocked, nothing is typed in, and
 * the twenty-six invariants at the bottom right are `selfTest()` running against the same
 * collection you are looking at.
 *
 * **The sprites are the shipped art.** The box screen draws each Pokémon's real 32×32
 * south-facing overworld frame out of `assets/overworld/<species>/{normal,shiny}.png`,
 * nearest-neighbour at an integer 2× — the source sprite layout (rows are
 * `[north, west, south, east]`, so south is row 2). A coloured square standing in for a
 * Pokémon would be exactly the untextured placeholder art, so every cell is either the real
 * sheet or an empty slot.
 *
 * **Determinism.** The stream comes from `ctx.rng.fork('collection/showcase')`, the IVs from
 * this module's own per-catch forks, and nothing reads `Date.now()`. Same URL, same pixels.
 *
 * Modes (`?showcase=collection&mode=…`):
 *   default      the whole terminal
 *   boxes        the box screen, full height
 *   dex          completion by generation and by type, full height
 *   duplicates   the piles and what a release rule would do to them
 *   sort         the box screen re-laid by IV total instead of dex number
 */

import { ivPct, IV_KEYS, IV_TOTAL_MAX } from './dex.js';

/** How many encounters the scripted session plays. Enough to fill eight boxes. */
const STREAM = 260;
/** Of those, how many go through the bus one at a time so the event log shows real traffic. */
const ANNOUNCED = 18;
/** Integer sprite scales. Pixel art at a fractional scale is a smear, so these stay whole. */
const BOX_SCALE = 2;
const CHIP_SCALE = 1;
/**
 * A focused mode is not the default panel stretched across 1920 px — it is *more*. The whole
 * storage instead of two boxes, the dex ribbon at double size, every pile instead of six.
 */
const FOCUSED = { boxes: true, sort: true, dex: true, duplicates: true };
const BOXES_SHOWN = (mode) => (FOCUSED[mode] ? 8 : 2);
/** A cap on how many sheets are awaited before the panel is shown, for the 6 s ready budget. */
const PRELOAD_CAP = 200;

const TYPE_COLOUR = {
  normal: '#9aa08d', fire: '#ef7f39', water: '#4d8ce0', electric: '#f0c33c', grass: '#66bb52',
  ice: '#79d3d0', fighting: '#c2453c', poison: '#a05fb0', ground: '#d4b45a', flying: '#8fa6e8',
  psychic: '#ef6f97', bug: '#9dc030', rock: '#b8a44f', ghost: '#6f5b9e', dragon: '#6b53e0',
  dark: '#6b5a4c', steel: '#9aa8b8', fairy: '#e8a0d0',
};

/** Box wallpapers as CSS, so a box screen reads as a box screen and not as a table. */
const WALLPAPER_CSS = {
  meadow: ['#2c4b31', '#1a2f20'], forest: ['#1f3a2c', '#12241b'], cave: ['#3a3040', '#211b28'],
  coast: ['#1f3f52', '#132734'], city: ['#33394a', '#1c1f2b'], volcano: ['#4a2a26', '#2a1614'],
  tundra: ['#2f4550', '#1b2930'], ruins: ['#43402c', '#26241a'],
};

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------------------
// Sprites — the shipped sheets, at an integer scale, nearest neighbour
// ---------------------------------------------------------------------------

const sheetUrl = (species, shiny) => `/assets/overworld/${species}/${shiny ? 'shiny' : 'normal'}.png`;

/**
 * One 32×32 frame out of a 64×128 sheet. Row 2 is the south-facing (front) pose — the
 * layout measured from the shipped art, not a guess.
 */
function spriteStyle(species, shiny, scale) {
  const s = 32 * scale;
  return `--sheet:url('${sheetUrl(species, shiny)}');width:${s}px;height:${s}px;` +
    `background-size:${64 * scale}px ${128 * scale}px;background-position:0 -${64 * scale}px`;
}

/** Awaits the sheets the panel is about to draw, so the screenshot is never half-painted. */
async function preload(urls) {
  const unique = [...new Set(urls)].slice(0, PRELOAD_CAP);
  const one = (url) => new Promise((done) => {
    const img = new Image();
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = url;
  });
  // A sheet that will not load must not hold the boot budget hostage; the cell simply draws
  // as an empty slot and the rest of the panel is unaffected.
  const timeout = new Promise((done) => setTimeout(() => done([]), 4000));
  const loaded = await Promise.race([Promise.all(unique.map(one)), timeout]);
  return Array.isArray(loaded) ? loaded.filter(Boolean).length : 0;
}

// ---------------------------------------------------------------------------
// The scripted session
// ---------------------------------------------------------------------------

/**
 * Ordinary play, compressed. A hunt meets the same handful of species over and over, which
 * is what makes duplicates a real problem and the release rules worth having — so the pool
 * is deliberately skewed rather than uniform over 995 species.
 */
function playStream(ctx, col) {
  const rng = ctx.rng.fork('collection/showcase');
  // Toasts are wall-clock timed and would still be fading when the harness captures, which
  // would make the same URL give different pixels (tools/shots/shoot.js). The bus events still fire.
  col.setQuiet?.(true);
  const pokemon = ctx.get('pokemon');
  const table = (typeof pokemon.all === 'function' ? pokemon.all() : []).filter((s) => !s.form);
  if (!table.length) return { announced: 0, bulk: 0 };

  const biomes = ['meadow', 'forest', 'cave', 'coast', 'city'];
  const pool = [];
  for (let i = 0; i < 90; i++) pool.push(table[rng.int(0, table.length - 1)]);

  const bulk = [];
  let announced = 0;
  for (let i = 0; i < STREAM; i++) {
    const s = i % 7 === 0 ? table[rng.int(0, table.length - 1)] : pool[rng.int(0, pool.length - 1)];
    const shiny = rng.next() < 0.035;
    const level = rng.int(3, 62);
    const biome = biomes[rng.int(0, biomes.length - 1)];
    const caught = rng.next() < 0.86;

    if (i < ANNOUNCED) {
      // Real traffic, one event at a time, so the harness's event log shows the wiring this
      // module actually depends on rather than a bulk import.
      ctx.bus.emit('encounter:started', { species: s.name, level, shiny, biome });
      if (caught) ctx.bus.emit('catch:succeeded', { instanceId: String(s.id), species: s.name, shiny });
      announced++;
    } else {
      // The bus spy keeps 256 events (src/core/bus.js); 500 more would push every other module's
      // events out of the screenshot log, so the rest goes in through importBatch.
      col.sight?.(s.name, { shiny });
      if (caught) bulk.push({ species: s.name, level, shiny, biome, instanceId: String(s.id) });
    }
  }
  col.importBatch?.(bulk);
  col.setQuiet?.(false);
  return { announced, bulk: bulk.length };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function showcaseCollection(mode = 'default', ctx) {
  const col = ctx.get('collection');

  // The scene behind the glass. A failure in someone else's module must not take the panel
  // down — the panel is the point, the city is the backdrop.
  try {
    await ctx.get('city').enter?.();
    ctx.get('city').preset?.('plaza');
  } catch { /* backdrop only */ }
  try { ctx.get('environment').setTimeOfDay?.(ctx.config.tod); } catch { /* ditto */ }

  const log = [];
  const record = (call, result) => log.push({ call, result });

  const stream = playStream(ctx, col);
  record(`${STREAM} × encounter:started`, `${stream.announced} on the bus, ${stream.bulk} bulk-imported`);
  record('stats().seen / .caught', `${col.stats().seen} seen, ${col.stats().caught} caught`);
  record('count() / free()', `${col.count()} stored, ${col.free()} slots free of ${col.totalSlots()}`);

  col.sort('iv');
  record('sort("iv")', `best first — ${col.entries()[0]?.display ?? '—'} ${col.entries()[0]?.ivTotal ?? 0}/186`);
  col.sort('species');
  record('sort("species")', `national order — #${col.entries()[0]?.dexId ?? '—'} ${col.entries()[0]?.display ?? '—'}`);

  const dupes = col.duplicates();
  record('duplicates()', `${dupes.length} species held more than once`);

  const plan = col.planRelease({ keep: 'iv', protectShiny: true, protectFavourite: true });
  record('planRelease({keep:"iv"})', `${plan.count} would go for ₽${fmt(plan.value.money)} + ${fmt(plan.value.shards)}◆`);

  const best = col.bestIvs(8);
  record('bestIvs(8)', best[0] ? `${best[0].display} ${best[0].total}/186 — ${best[0].grade}` : '—');

  const moved = col.entries()[0];
  if (moved) {
    col.move(moved.uid, 0, 5);
    record('move(first, box 1, slot 6)', `${moved.display} → ${moved.box + 1}:${moved.slot + 1} (swapped)`);
    col.sort('species');
  }

  if (mode === 'sort') col.sort('iv');

  const stats = col.stats();
  const completion = col.completion();
  const test = await col.selfTest();
  record('selfTest()', `${test.passed}/${test.results.length} invariants hold`);

  // --- what the panel is about to draw --------------------------------------
  const boxes = col.boxes();
  const shown = boxes.slice(0, BOXES_SHOWN(mode)).filter((b) => b.count > 0 || b.index < 2);
  // Every species this save has met, in national order — the dex as a dex, not a summary.
  const ribbon = col.records().filter((r) => r.seen > 0 && r.known)
    .sort((a, b) => (a.id ?? 1e9) - (b.id ?? 1e9)).slice(0, 132);

  const sheets = await preload([
    ...shown.flatMap((b) => b.filter(Boolean).map((e) => sheetUrl(e.species, e.shiny))),
    ...ribbon.map((r) => sheetUrl(r.key, false)),
    ...dupes.slice(0, mode === 'duplicates' ? 60 : 6).map((g) => sheetUrl(g.species, g.best.shiny)),
    ...best.map((b) => sheetUrl(b.species, b.shiny)),
  ]);
  record('preload(sheets)', `${sheets} overworld sheets decoded before paint`);

  // --- the panel -------------------------------------------------------------
  const root = document.getElementById('ui') ?? document.body;
  document.getElementById('col-showcase')?.remove();
  document.getElementById('col-style')?.remove();

  const style = document.createElement('style');
  style.id = 'col-style';
  style.textContent = CSS;
  document.head.appendChild(style);

  const wrap = document.createElement('div');
  wrap.id = 'col-showcase';
  wrap.dataset.mode = mode;
  wrap.innerHTML = `
    <header class="col-head">
      <span class="col-ball" aria-hidden="true"></span>
      <h1>Collection<span>dex · boxes · organisation</span></h1>
      <div class="col-chips">${chipsHtml(stats)}</div>
    </header>
    <div class="col-body">
      ${panel('box', 'Boxes', boxesHtml(shown, stats, mode),
    mode === 'sort' ? 'laid out by IV total — sort("iv")' : 'laid out by dex number — sort("species")')}
      ${panel('dex', 'Pokédex', dexHtml(completion, ribbon, mode), `${completion.caught} of ${completion.total} species`)}
      ${panel('dupes', 'Duplicates', dupesHtml(dupes, plan, mode), 'and what an auto-release rule would take')}
      ${panel('best', 'Best rolls held', bestHtml(best), 'per species, out of 186')}
      ${panel('log', 'Session transcript', logHtml(log, test), 'every line is a live API call')}
    </div>`;
  root.appendChild(wrap);

  return { ok: test.ok, stored: stats.stored, caught: stats.caught, checks: test.results.length };
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

const panel = (id, title, inner, sub = '') => `
  <section class="col-panel" data-panel="${id}">
    <h2>${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</h2>
    <div class="col-scroll">${inner}</div>
  </section>`;

function chipsHtml(s) {
  const chips = [
    { v: `${s.caught}/${s.total}`, n: 'dex', c: '#7fe6c4', sub: `${s.dexPct}%` },
    { v: `${s.stored}/${s.boxes.total}`, n: 'stored', c: '#8fd2ff', sub: `${s.boxes.boxesInUse} boxes` },
    { v: String(s.shiny), n: 'shiny', c: '#ffd76a', sub: `${s.shinySpecies} species` },
    { v: String(s.duplicates), n: 'dupes', c: '#f0a8a0', sub: `${s.duplicateSpecies} piles` },
    { v: `${s.averageIvPct}%`, n: 'avg iv', c: '#c0a8f0', sub: `lv ${s.averageLevel} avg` },
  ];
  return chips.map((c) => `
    <div class="col-chip" style="--accent:${c.c}">
      <span class="v">${esc(c.v)}</span>
      <span class="n">${esc(c.n)}</span>
      <span class="s">${esc(c.sub)}</span>
    </div>`).join('');
}

// --- the box screen --------------------------------------------------------

function slotHtml(e, scale = BOX_SCALE) {
  if (!e) return '<div class="slot empty"></div>';
  const pct = ivPct(e.ivTotal);
  const tone = pct >= 80 ? 'high' : pct >= 55 ? 'mid' : 'low';
  return `
    <div class="slot${e.shiny ? ' shiny' : ''}" title="${esc(e.display)} lv${e.level} — ${e.ivTotal}/186">
      <i class="mon" style="${spriteStyle(e.species, e.shiny, scale)}"></i>
      <b class="lv">${e.level}</b>
      ${e.shiny ? '<b class="star">★</b>' : ''}
      <span class="iv ${tone}"><i style="width:${pct.toFixed(0)}%"></i></span>
      <span class="nm">${esc(e.display)}</span>
    </div>`;
}

function oneBoxHtml(box) {
  const wall = WALLPAPER_CSS[box.wallpaper] ?? WALLPAPER_CSS.meadow;
  const slots = [];
  for (let i = 0; i < (box.capacity ?? 30); i++) slots.push(slotHtml(box[i]));
  return `
    <div class="boxwrap">
      <div class="boxhead">
        <b>${esc(box.name)}</b>
        <span class="tag">${esc(box.wallpaper)}</span>
        <span class="dim">${box.count}/${box.capacity}</span>
      </div>
      <div class="box" style="--w1:${wall[0]};--w2:${wall[1]}">
        <div class="grid">${slots.join('')}</div>
      </div>
    </div>`;
}

function boxesHtml(shown, stats, mode) {
  const meter = stats.boxes.perBox.map((n, i) => `
    <i class="cell${n ? ' on' : ''}${i < shown.length ? ' here' : ''}" style="--fill:${Math.round((n / stats.boxes.capacity) * 100)}%"
       title="${esc(`Box ${i + 1}: ${n}/${stats.boxes.capacity}`)}"></i>`).join('');
  return `
    <div class="boxwraps">${shown.map(oneBoxHtml).join('')}</div>
    <h3>All ${stats.boxes.count} boxes <small>${stats.boxes.used} of ${stats.boxes.total} slots · ${stats.boxes.pct}% · ${mode === 'sort' ? 'IV order' : 'dex order'}</small></h3>
    <div class="meter">${meter}</div>
    <p class="col-note">Storage is finite — <b>${stats.boxes.count} boxes of ${stats.boxes.capacity}</b>, and the reason
      the release rules exist. ${stats.overflow > 0
    ? `<b>${stats.overflow}</b> catches were turned away.`
    : 'A catch with nowhere to go still enters the dex; nothing owns it.'}</p>`;
}

// --- the dex ---------------------------------------------------------------

function dexHtml(c, ribbon, mode = 'default') {
  const cells = ribbon.map((r) => {
    const caught = r.caught > 0;
    const shiny = r.shinyCaught > 0;
    return `<i class="dexcell${caught ? '' : ' unseen'}${shiny ? ' shiny' : ''}"
      style="${spriteStyle(r.key, shiny, mode === 'dex' ? 2 : CHIP_SCALE)}" title="${esc(`#${r.id} ${r.display} — ${caught ? `caught ×${r.caught}` : 'seen only'}`)}"></i>`;
  }).join('');

  const gens = c.byGen.map((g) => `
    <div class="row">
      <span class="k">Gen ${g.gen}</span>
      <span class="bar"><i style="width:${(g.total ? (g.caught / g.total) * 100 : 0).toFixed(1)}%"></i>
        <em style="width:${(g.total ? (g.seen / g.total) * 100 : 0).toFixed(1)}%"></em></span>
      <span class="v">${g.caught}<span class="dim">/${g.total}</span></span>
    </div>`).join('');

  const types = c.byType.map((t) => `
    <div class="trow" style="--t:${TYPE_COLOUR[t.type] ?? '#8fa0b4'}">
      <span class="k">${esc(t.type)}</span>
      <span class="bar"><i style="width:${(t.total ? (t.caught / t.total) * 100 : 0).toFixed(1)}%"></i></span>
      <span class="v">${t.caught}<span class="dim">/${t.total}</span></span>
    </div>`).join('');

  return `
    <div class="dexhead">
      <div class="big"><b>${c.caught}</b><span>caught</span></div>
      <div class="big dim"><b>${c.seen}</b><span>seen</span></div>
      <div class="big dim"><b>${c.livingPct}%</b><span>living dex</span></div>
      <div class="big dim"><b>${c.forms.caught}</b><span>of ${c.forms.total} forms</span></div>
    </div>
    <div class="ribbon">${cells}</div>
    <p class="col-note">Every species this save has met, in national order — <b>full sprites are caught</b>,
      silhouettes have only been seen. Completion counts the <b>${c.total} base species</b> in the shipped
      snapshot and not its 1253 sheets: an Alolan Rattata shares Rattata's dex number and must not fill a
      second slot.</p>
    <h3>By generation <small>caught, with seen behind it</small></h3>
    <div class="rows">${gens}</div>
    <h3>By type <small>a species counts under both of its types</small></h3>
    <div class="types">${types}</div>`;
}

// --- duplicates ------------------------------------------------------------

function dupesHtml(dupes, plan, mode = 'default') {
  if (!dupes.length) return '<p class="col-note">Nothing is held more than once yet.</p>';
  const piles = dupes.slice(0, mode === 'duplicates' ? 60 : 6).map((g) => `
    <div class="pile">
      <i class="mon" style="${spriteStyle(g.species, g.best.shiny, CHIP_SCALE)}"></i>
      <span class="nm">${esc(g.display)}</span>
      <span class="ct">×${g.count}</span>
      <span class="bar"><i style="width:${Math.min(100, g.count * 12)}%"></i></span>
      <span class="dim">best ${g.best.ivTotal}</span>
    </div>`).join('');

  const r = plan.reasons;
  const rules = [
    ['kept — one of each species', `${r.quota}`, 'the best IVs of its pile'],
    ['kept — shiny', `${r.shiny}`, 'a rule never releases one'],
    ['kept — favourite', `${r.favourite}`, 'starred by hand'],
    ['kept — in the party', `${r.protected}`, 'not in a box to begin with'],
  ].map(([k, v, why]) => `<li><b>${esc(v)}</b><span>${esc(k)}</span><em>${esc(why)}</em></li>`).join('');

  return `
    <div class="piles">${piles}</div>
    <h3>Auto-release rule <small>planRelease({ keep: "iv" }) — pure, nothing moves</small></h3>
    <div class="plan">
      <div class="big"><b>${plan.count}</b><span>would go</span></div>
      <div class="big pay"><b>₽${fmt(plan.value.money)}</b><span>+ ${fmt(plan.value.shards)} ◆</span></div>
    </div>
    <ul class="rules">${rules}</ul>
    <p class="col-note">The plan is a <b>pure function of storage</b>, so <code>automation</code> can show a
      player exactly what a rule will take before it takes it. Appraisal comes from
      <code>economy.appraise()</code> — this module never prices a Pokémon itself.</p>`;
}

// --- best IVs --------------------------------------------------------------

function bestHtml(best) {
  if (!best.length) return '<p class="col-note">Nothing held yet.</p>';
  const rows = best.map((b) => {
    const spread = IV_KEYS.map((k) => `
      <i class="iv${b.ivs[k] === 31 ? ' max' : ''}" style="height:${Math.max(8, (b.ivs[k] / 31) * 100)}%"
         title="${esc(`${k} ${b.ivs[k]}`)}"></i>`).join('');
    return `
      <tr class="${b.shiny ? 'shiny' : ''}">
        <td class="mon"><i style="${spriteStyle(b.species, b.shiny, CHIP_SCALE)}"></i></td>
        <td class="name">${esc(b.display)}${b.shiny ? ' <b class="star">★</b>' : ''}<small>lv ${b.level} · ${esc(b.grade)}</small></td>
        <td class="spread"><span>${spread}</span></td>
        <td class="num">${b.total}<span class="dim">/${IV_TOTAL_MAX}</span></td>
        <td class="num pct">${b.pct}%</td>
      </tr>`;
  }).join('');
  return `
    <table class="col-table">
      <colgroup><col width="34"><col><col width="66"><col width="62"><col width="46"></colgroup>
      <thead><tr><th></th><th>species</th><th>hp atk def spa spd spe</th><th class="num">iv</th><th class="num">%</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="col-note">Two numbers per species: the best still held — rebuilt on release — and the
      best <b>ever</b> rolled, which survives it.</p>`;
}

// --- transcript ------------------------------------------------------------

function logHtml(log, test) {
  const lines = log.map((l) => `<li><code>${esc(l.call)}</code><span>${esc(l.result)}</span></li>`).join('');
  const checks = test.results.map((r) => `
    <li class="${r.ok ? 'pass' : 'fail'}"><b>${r.ok ? '✓' : '✗'}</b> ${esc(r.name)}<span>${esc(r.detail)}</span></li>`).join('');
  return `
    <ol class="col-log">${lines}</ol>
    <h3>Invariants <small>${test.results.filter((r) => r.ok).length}/${test.results.length}</small></h3>
    <ul class="col-checks">${checks}</ul>`;
}

// ---------------------------------------------------------------------------
// Style. The same dark glass as the economy terminal — one game, one language —
// with teal for the dex, gold for shiny and the type chart's own colours.
// ---------------------------------------------------------------------------

const CSS = `
#col-showcase {
  position: absolute; inset: 16px;
  display: flex; flex-direction: column; gap: 9px;
  font: 12px/1.45 ui-monospace, "SF Mono", Menlo, monospace;
  color: #dbe6f4; pointer-events: auto;
}
#col-showcase .col-head {
  display: flex; align-items: center; gap: 14px;
  padding: 9px 15px; border-radius: 10px;
  background: linear-gradient(180deg, rgba(20,28,42,.94), rgba(10,15,24,.92));
  border: 1px solid rgba(150,190,235,.20);
  box-shadow: 0 10px 30px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.06);
}
#col-showcase .col-ball {
  width: 20px; height: 20px; border-radius: 50%; flex: none; position: relative;
  background: linear-gradient(180deg, #e8544a 0 46%, #1a2231 46% 54%, #f2f5f8 54% 100%);
  border: 1.5px solid #0d1119; box-shadow: inset 0 0 0 1px rgba(255,255,255,.12);
}
#col-showcase .col-ball::after {
  content: ''; position: absolute; left: 50%; top: 50%; width: 6px; height: 6px;
  transform: translate(-50%,-50%); border-radius: 50%;
  background: #f2f5f8; border: 1.5px solid #0d1119;
}
#col-showcase h1 { margin: 0; font-size: 13px; letter-spacing: .18em; text-transform: uppercase; font-weight: 700; }
#col-showcase h1 span {
  display: block; font-size: 10px; letter-spacing: .12em; color: #7b8fae;
  font-weight: 500; text-transform: none; margin-top: 3px;
}
#col-showcase .col-chips { margin-left: auto; display: flex; gap: 8px; }
#col-showcase .col-chip {
  display: grid; grid-template-columns: auto auto; align-items: baseline; column-gap: 6px;
  padding: 5px 12px; border-radius: 7px; background: rgba(255,255,255,.045);
  border: 1px solid color-mix(in srgb, var(--accent) 34%, transparent);
}
#col-showcase .col-chip .v { font-size: 14px; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; }
#col-showcase .col-chip .n { font-size: 9.5px; letter-spacing: .1em; color: #7b8fae; text-transform: uppercase; }
#col-showcase .col-chip .s { grid-column: 1 / -1; font-size: 9.5px; color: #64789a; margin-top: 1px; }

#col-showcase .col-body {
  flex: 1; min-height: 0; display: grid; gap: 9px;
  grid-template-columns: 494px 1fr 1fr 1.02fr;
  grid-template-rows: 1.16fr 1fr;
  grid-template-areas: "box dex dupes log" "box dex best log";
}
#col-showcase [data-panel="box"] { grid-area: box; }
#col-showcase [data-panel="dex"] { grid-area: dex; }
#col-showcase [data-panel="dupes"] { grid-area: dupes; }
#col-showcase [data-panel="best"] { grid-area: best; }
#col-showcase [data-panel="log"] { grid-area: log; }

#col-showcase[data-mode="boxes"] .col-body, #col-showcase[data-mode="sort"] .col-body,
#col-showcase[data-mode="dex"] .col-body, #col-showcase[data-mode="duplicates"] .col-body {
  grid-template-columns: 1fr; grid-template-rows: 1fr;
}
#col-showcase[data-mode="boxes"] .col-panel:not([data-panel="box"]),
#col-showcase[data-mode="sort"] .col-panel:not([data-panel="box"]),
#col-showcase[data-mode="dex"] .col-panel:not([data-panel="dex"]),
#col-showcase[data-mode="duplicates"] .col-panel:not([data-panel="dupes"]) { display: none; }
#col-showcase[data-mode="boxes"] .col-panel, #col-showcase[data-mode="sort"] .col-panel,
#col-showcase[data-mode="dex"] .col-panel, #col-showcase[data-mode="duplicates"] .col-panel { grid-area: auto; }

#col-showcase .col-panel {
  min-height: 0; display: flex; flex-direction: column; border-radius: 10px;
  background: linear-gradient(180deg, rgba(14,20,31,.93), rgba(9,13,21,.93));
  border: 1px solid rgba(150,190,235,.16);
  box-shadow: 0 10px 30px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.05);
  overflow: hidden;
}
#col-showcase .col-panel h2 {
  margin: 0; padding: 8px 13px 7px; font-size: 10.5px; font-weight: 700;
  letter-spacing: .16em; text-transform: uppercase; color: #b9cde6;
  background: linear-gradient(180deg, rgba(127,230,196,.13), rgba(127,230,196,.02));
  border-bottom: 1px solid rgba(150,190,235,.16);
  display: flex; align-items: baseline; gap: 10px;
}
#col-showcase .col-panel h2 small {
  font-size: 9.5px; letter-spacing: .06em; text-transform: none; color: #6f86a4; font-weight: 500;
}
#col-showcase .col-scroll { flex: 1; min-height: 0; overflow: hidden; padding: 9px 12px 10px; }
#col-showcase h3 {
  margin: 9px 0 4px; font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase;
  color: #6f86a4; display: flex; gap: 8px; align-items: baseline;
}
#col-showcase h3 small { color: #7fe6c4; letter-spacing: 0; text-transform: none; font-size: 9.5px; }
#col-showcase .dim { color: #6f86a4; }
#col-showcase .col-note {
  margin: 8px 0 0; font-size: 10px; line-height: 1.6; color: #8298b4;
  border-left: 2px solid rgba(127,230,196,.35); padding-left: 9px;
}
#col-showcase .col-note b { color: #cfe0f2; }
#col-showcase .col-note code { color: #7fe6c4; }

/* --- the box screen ----------------------------------------------------- */
#col-showcase .box {
  border-radius: 8px; padding: 8px;
  background:
    repeating-linear-gradient(135deg, rgba(255,255,255,.030) 0 3px, rgba(0,0,0,0) 3px 9px),
    linear-gradient(180deg, var(--w1), var(--w2));
  border: 1px solid rgba(255,255,255,.10);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.10), inset 0 -12px 26px rgba(0,0,0,.30);
}
#col-showcase .grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; }
#col-showcase .slot {
  position: relative; aspect-ratio: 1; border-radius: 6px;
  background: rgba(6,10,16,.34); border: 1px solid rgba(255,255,255,.09);
  display: flex; align-items: center; justify-content: center;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.07);
}
#col-showcase .slot.empty { background: rgba(6,10,16,.16); border-style: dashed; border-color: rgba(255,255,255,.06); }
#col-showcase .slot.shiny { border-color: rgba(255,215,106,.55); box-shadow: inset 0 0 12px rgba(255,215,106,.20); }
#col-showcase .mon, #col-showcase .dexcell {
  display: block; background-image: var(--sheet); background-repeat: no-repeat;
  image-rendering: pixelated; -webkit-user-drag: none;
}
#col-showcase .slot .mon { filter: drop-shadow(0 2px 2px rgba(0,0,0,.55)); margin-top: -3px; }
#col-showcase .slot .lv {
  position: absolute; top: 2px; left: 4px; font-size: 9px; font-weight: 700; color: #e6f0fb;
  text-shadow: 0 1px 2px #000, 0 0 3px #000;
}
#col-showcase .slot .star { position: absolute; top: 1px; right: 3px; font-size: 10px; color: #ffd76a; text-shadow: 0 0 4px rgba(255,215,106,.8); }
#col-showcase .slot .nm {
  position: absolute; left: 3px; right: 3px; bottom: 8px; text-align: center;
  font-size: 8px; letter-spacing: .01em; color: #c9d8ea; text-shadow: 0 1px 2px #000;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#col-showcase .slot .iv {
  position: absolute; left: 5px; right: 5px; bottom: 3px; height: 3px; border-radius: 2px;
  background: rgba(0,0,0,.45); overflow: hidden;
}
#col-showcase .slot .iv i { display: block; height: 100%; background: #6f9ec4; }
#col-showcase .slot .iv.mid i { background: #7fe6c4; }
#col-showcase .slot .iv.high i { background: #ffd76a; }

#col-showcase .boxhead {
  display: flex; gap: 9px; align-items: baseline; margin: 0 2px 4px;
  font-size: 10.5px; color: #93a8c4;
}
#col-showcase .boxwraps { display: grid; gap: 7px; }
#col-showcase .boxwrap { min-width: 0; }
#col-showcase .boxhead b { color: #e7eef8; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
#col-showcase .boxhead .dim { margin-left: auto; font-variant-numeric: tabular-nums; }
#col-showcase .boxhead .tag {
  font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: #0d1119;
  background: #7fe6c4; border-radius: 3px; padding: 1px 6px; font-weight: 700;
}
#col-showcase .meter { display: grid; grid-template-columns: repeat(16, 1fr); gap: 3px; margin-top: 2px; }
#col-showcase .meter .cell {
  display: block; height: 11px; border-radius: 2px; position: relative; overflow: hidden;
  background: rgba(255,255,255,.05); border: 1px solid rgba(150,190,235,.12);
}
#col-showcase .meter .cell::after {
  content: ''; position: absolute; left: 0; bottom: 0; width: 100%; height: var(--fill);
  background: linear-gradient(180deg, #7fe6c4, #3f9e88);
}
#col-showcase .meter .cell.here { border-color: rgba(255,215,106,.75); }

/* --- the dex ------------------------------------------------------------- */
#col-showcase .dexhead { display: flex; gap: 16px; margin-bottom: 8px; }
#col-showcase .big { display: flex; flex-direction: column; }
#col-showcase .big b { font-size: 20px; line-height: 1; color: #7fe6c4; font-variant-numeric: tabular-nums; }
#col-showcase .big span { font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; color: #6f86a4; margin-top: 4px; }
#col-showcase .big.dim b { color: #b9cde6; font-size: 17px; }
#col-showcase .big.pay b { color: #ffd76a; font-size: 16px; }
#col-showcase .ribbon {
  display: grid; grid-template-columns: repeat(12, 32px); gap: 2px; justify-content: center;
  padding: 7px 6px; border-radius: 7px; background: rgba(6,10,16,.35);
  border: 1px solid rgba(150,190,235,.10);
}
#col-showcase .dexcell { width: 32px; height: 32px; justify-self: center; }
#col-showcase .dexcell.unseen { filter: brightness(0) saturate(0) invert(38%); opacity: .5; }
#col-showcase .dexcell.shiny { filter: drop-shadow(0 0 3px rgba(255,215,106,.9)); }

#col-showcase .rows, #col-showcase .types { display: grid; gap: 2px; }
#col-showcase .types { grid-template-columns: 1fr 1fr; column-gap: 14px; }
#col-showcase .row, #col-showcase .trow {
  display: grid; grid-template-columns: 46px 1fr 56px; align-items: center; gap: 8px;
  font-size: 10px; color: #a9bdd6;
}
#col-showcase .trow { grid-template-columns: 54px 1fr 50px; }
#col-showcase .row .k, #col-showcase .trow .k { color: #8ea4c0; }
#col-showcase .trow .k { color: var(--t); font-weight: 600; }
#col-showcase .row .v, #col-showcase .trow .v { text-align: right; font-variant-numeric: tabular-nums; color: #dbe6f4; }
#col-showcase .row .bar, #col-showcase .trow .bar {
  position: relative; height: 7px; border-radius: 4px; background: rgba(255,255,255,.06); overflow: hidden;
}
#col-showcase .row .bar i, #col-showcase .trow .bar i {
  position: absolute; left: 0; top: 0; height: 100%; border-radius: 4px; z-index: 2;
  background: linear-gradient(90deg, #3f9e88, #7fe6c4);
}
#col-showcase .trow .bar i { background: linear-gradient(90deg, color-mix(in srgb, var(--t) 55%, #0b1018), var(--t)); }
#col-showcase .row .bar em { position: absolute; left: 0; top: 0; height: 100%; background: rgba(127,230,196,.22); z-index: 1; }

/* --- duplicates ---------------------------------------------------------- */
#col-showcase .piles { display: grid; gap: 3px; }
#col-showcase .pile {
  display: grid; grid-template-columns: 34px 1fr 30px 70px 56px; align-items: center; gap: 7px;
  font-size: 10.5px; padding: 2px 4px; border-radius: 5px; background: rgba(255,255,255,.032);
}
#col-showcase .pile .nm { color: #e7eef8; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#col-showcase .pile .ct { color: #f0a8a0; font-weight: 700; text-align: right; }
#col-showcase .pile .bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,.06); overflow: hidden; }
#col-showcase .pile .bar i { display: block; height: 100%; background: linear-gradient(90deg, #a4574f, #f0a8a0); }
#col-showcase .pile .dim { font-size: 9.5px; text-align: right; }
#col-showcase .plan { display: flex; gap: 22px; margin: 2px 0 7px; }
#col-showcase .rules { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
#col-showcase .rules li { display: flex; gap: 8px; align-items: baseline; font-size: 10px; }
#col-showcase .rules li b { color: #7fe6c4; min-width: 22px; text-align: right; font-variant-numeric: tabular-nums; }
#col-showcase .rules li span { color: #c3d3e6; }
#col-showcase .rules li em { font-style: normal; color: #64789a; margin-left: auto; font-size: 9.5px; }

/* --- best IVs ------------------------------------------------------------ */
#col-showcase .col-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; table-layout: fixed; }
#col-showcase .col-table th {
  text-align: left; font-size: 9px; letter-spacing: .08em; text-transform: uppercase;
  color: #6f86a4; font-weight: 600; padding: 2px 5px 5px; border-bottom: 1px solid rgba(150,190,235,.14);
}
#col-showcase .col-table th.num, #col-showcase .col-table td.num { text-align: right; }
#col-showcase .col-table td { padding: 2px 5px; border-bottom: 1px solid rgba(150,190,235,.055); }
#col-showcase .col-table tr:last-child td { border-bottom: 0; }
#col-showcase .col-table tr.shiny td.name { color: #ffd76a; }
#col-showcase .col-table td.name { color: #e7eef8; font-weight: 600; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#col-showcase .col-table td.name small { display: block; font-weight: 400; color: #7d92af; font-size: 9.5px; }
#col-showcase .col-table td.name .star { color: #ffd76a; }
#col-showcase .col-table td.mon i { display: block; }
#col-showcase .col-table td.pct { color: #7fe6c4; }
#col-showcase .spread span { display: flex; align-items: flex-end; gap: 2px; height: 22px; }
#col-showcase .spread .iv { display: block; width: 7px; border-radius: 1px; background: #4d6f8e; }
#col-showcase .spread .iv.max { background: #ffd76a; }

/* --- transcript ---------------------------------------------------------- */
#col-showcase .col-log { list-style: none; margin: 0; padding: 0; display: grid; gap: 1px; }
#col-showcase .col-log li { display: flex; gap: 10px; font-size: 10px; line-height: 1.45; align-items: baseline; }
#col-showcase .col-log code { color: #8fd2ff; white-space: nowrap; }
#col-showcase .col-log span { color: #93a8c4; margin-left: auto; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#col-showcase .col-checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; }
#col-showcase .col-checks li { display: flex; gap: 7px; font-size: 9.5px; line-height: 1.5; align-items: baseline; }
#col-showcase .col-checks li b { width: 9px; }
#col-showcase .col-checks li.pass b { color: #7fe6c4; }
#col-showcase .col-checks li.fail { color: #ff9a9a; }
#col-showcase .col-checks li span { color: #64789a; margin-left: auto; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46%; }

/* --- focused modes: more content, not the same content stretched --------- */
#col-showcase[data-mode="boxes"] .boxwraps,
#col-showcase[data-mode="sort"] .boxwraps { grid-template-columns: repeat(4, 1fr); gap: 8px 11px; }
#col-showcase[data-mode="boxes"] .meter,
#col-showcase[data-mode="sort"] .meter { grid-template-columns: repeat(32, 1fr); }
#col-showcase[data-mode="boxes"] .slot .nm,
#col-showcase[data-mode="sort"] .slot .nm { font-size: 9px; bottom: 7px; }
#col-showcase[data-mode="boxes"] .slot .lv,
#col-showcase[data-mode="sort"] .slot .lv { font-size: 10px; }

#col-showcase[data-mode="dex"] .ribbon { grid-template-columns: repeat(auto-fill, 64px); gap: 3px; }
#col-showcase[data-mode="dex"] .dexcell { width: 64px; height: 64px; }
#col-showcase[data-mode="dex"] .dexhead { gap: 34px; }
#col-showcase[data-mode="dex"] .big b { font-size: 26px; }
#col-showcase[data-mode="dex"] .rows { grid-template-columns: 1fr 1fr 1fr; column-gap: 34px; }
#col-showcase[data-mode="dex"] .types { grid-template-columns: repeat(3, 1fr); column-gap: 34px; }
#col-showcase[data-mode="dex"] .row, #col-showcase[data-mode="dex"] .trow { font-size: 11.5px; height: 21px; }
#col-showcase[data-mode="dex"] .row .bar, #col-showcase[data-mode="dex"] .trow .bar { height: 9px; }
#col-showcase[data-mode="dex"] .col-note { max-width: 150ch; }

#col-showcase[data-mode="duplicates"] .piles { grid-template-columns: 1fr 1fr; column-gap: 26px; }
#col-showcase[data-mode="duplicates"] .pile { grid-template-columns: 34px 1fr 34px 1fr 60px; font-size: 11px; padding: 3px 6px; }
#col-showcase[data-mode="duplicates"] .plan { gap: 40px; }
#col-showcase[data-mode="duplicates"] .rules { grid-template-columns: 1fr 1fr; column-gap: 40px; }
`;
