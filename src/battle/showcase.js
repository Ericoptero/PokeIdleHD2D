/**
 * The battle showcase (ARCHITECTURE §6).
 *
 * A turn engine cannot prove itself with a pretty frame, so — like `economy`'s — this one
 * proves itself with *evidence*: every line on screen is a real transcript produced by calling
 * the live public API. Nothing is mocked and no number is typed in.
 *
 * Deterministic by construction: every fight is `resolve(a, b, 1337, index)` on a fixed pair at
 * fixed IVs, and the engine draws only from `root/battle/<index>/<turn>`. Same URL, same
 * pixels — there is no animation here to freeze, which is one of the nicer consequences of
 * keeping the maths in a module with no clock in it.
 *
 * Modes (`?showcase=battle&mode=…`):
 *   default   the whole bench: a fight, the chart, the slots, the checks
 *   fight     one fight, full height, turn by turn
 *   types     the eighteen-by-eighteen chart
 *   moves     the four slots a species carries at three levels, and why
 *   status    a fight that lands a status, to show the residual ticks
 */

const IVS = { hp: 20, atk: 20, def: 20, spa: 20, spd: 20, spe: 20 };

/** The fights on the bench. Fixed pairs, fixed levels, fixed indices — hence fixed pixels. */
const CARDS = [
  { id: 'starter', index: 12, a: ['oshawott', 12], b: ['caterpie', 8], why: 'the starter against route grass — STAB decides it' },
  { id: 'type', index: 31, a: ['pikachu', 24], b: ['gyarados', 22], why: 'a 4× matchup: Electric into Water/Flying' },
  { id: 'even', index: 77, a: ['machop', 20], b: ['geodude', 20], why: 'evenly matched, so the speed tie and the damage band do the work' },
  { id: 'status', index: 45, a: ['gastly', 26], b: ['zubat', 24], why: 'status and residual damage across several turns' },
];

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const pct = (n) => `${Math.round(n * 100)}%`;

export async function showcaseBattle(mode = 'default', ctx) {
  const battle = ctx.get('battle');
  const pokemon = ctx.get('pokemon');
  const species = (name) => (typeof pokemon.species === 'function' ? pokemon.species(name) : null);

  const fights = [];
  for (const card of CARDS) {
    const sa = species(card.a[0]);
    const sb = species(card.b[0]);
    if (!sa || !sb || !battle.ready()) continue;
    const a = battle.makeCombatant({ species: sa, level: card.a[1], ivs: IVS });
    const b = battle.makeCombatant({ species: sb, level: card.b[1], ivs: IVS });
    fights.push({ ...card, a, b, result: battle.resolve(a, b, ctx.config.seed, card.index) });
  }

  const test = battle.selfTest();

  const root = document.getElementById('ui') ?? document.body;
  document.getElementById('bat-showcase')?.remove();
  document.getElementById('bat-style')?.remove();

  const style = document.createElement('style');
  style.id = 'bat-style';
  style.textContent = CSS;
  document.head.appendChild(style);

  const wrap = document.createElement('div');
  wrap.id = 'bat-showcase';
  wrap.dataset.mode = mode;
  wrap.innerHTML = `
    <header class="bat-head">
      <span class="bat-mark" aria-hidden="true"></span>
      <h1>Battle<span>type chart · moves · the turn engine</span></h1>
      <div class="bat-meta">
        ${battle.moveCount()} moves · seed ${ctx.config.seed} ·
        <b class="${test.ok ? 'ok' : 'bad'}">${test.results.filter((r) => r.ok).length}/${test.results.length} checks</b>
      </div>
    </header>
    <div class="bat-body">
      ${panel('fight', 'Fights', fights.map(fightHtml).join(''), 'every line is a real transcript from resolve()')}
      ${panel('types', 'Type chart', chartHtml(battle), 'authored source, not fetched data')}
      ${panel('moves', 'The four slots', slotsHtml(battle, species), 'the last four learnable, ranked by expected damage')}
      ${panel('status', 'Statuses and residuals', fights.filter((f) => f.id === 'status').map(fightHtml).join('')
        || '<p class="bat-none">no status fight staged</p>', 'burn, poison, sleep, paralysis, freeze, confusion')}
    </div>`;
  root.appendChild(wrap);

  return { ok: test.ok, fights: fights.length, moves: battle.moveCount() };
}

const panel = (id, title, html, sub) => `
  <section class="bat-panel" data-panel="${id}">
    <h2>${esc(title)}<span>${esc(sub)}</span></h2>
    ${html}
  </section>`;

function bar(hp, maxHp) {
  const f = maxHp > 0 ? Math.max(0, hp / maxHp) : 0;
  const tone = f > 0.5 ? 'hi' : f > 0.2 ? 'mid' : 'lo';
  return `<span class="bat-bar"><i class="${tone}" style="width:${(f * 100).toFixed(1)}%"></i></span>
          <span class="bat-hp">${hp}/${maxHp}</span>`;
}

function fightHtml(f) {
  const r = f.result;
  const line = (e) => {
    if (e.kind === 'move') return `<b>${esc(e.species)}</b> used <b>${esc(e.name)}</b>${e.struggle ? ' (out of PP)' : ''}`;
    if (e.kind === 'damage') {
      const eff = e.effectiveness > 1 ? ' <em class="se">super effective</em>'
        : e.effectiveness < 1 ? ' <em class="nv">not very effective</em>' : '';
      return `${esc(e.species)} took <b>${e.damage}</b>${e.hits > 1 ? ` over ${e.hits} hits` : ''}${e.crit ? ' <em class="cr">critical</em>' : ''}${eff} → ${e.hp}/${e.maxHp}`;
    }
    if (e.kind === 'status') return `${esc(e.species)} is <em class="st">${esc(e.status)}</em>`;
    if (e.kind === 'residual') return `${esc(e.species)} lost <b>${e.damage}</b> to <em class="st">${esc(e.status)}</em> → ${e.hp}`;
    if (e.kind === 'boost') return `${esc(e.species)} ${e.moved.map((m) => `${m.stat} ${m.by > 0 ? '+' : ''}${m.by}`).join(', ')}`;
    if (e.kind === 'drain') return `${esc(e.species)} drained <b>${e.healed}</b> → ${e.hp}`;
    if (e.kind === 'recoil') return `${esc(e.species)} took <b>${e.damage}</b> in recoil → ${e.hp}`;
    if (e.kind === 'faint') return `<b>${esc(e.species)}</b> fainted`;
    return `${esc(e.species ?? '')} ${esc(e.kind)}`;
  };
  let turn = 0;
  const rows = r.transcript.map((e) => {
    const head = e.turn !== turn ? `<td class="t">${(turn = e.turn)}</td>` : '<td class="t"></td>';
    return `<tr class="k-${e.kind}">${head}<td>${line(e)}</td></tr>`;
  }).join('');

  return `
    <article class="bat-fight">
      <header>
        <div class="side"><b>${esc(f.a.display ?? f.a.species)}</b> Lv${f.a.level}
          <small>${f.a.types.join(' / ')}</small> ${bar(r.a.hp, r.a.maxHp)}</div>
        <div class="vs">vs</div>
        <div class="side"><b>${esc(f.b.display ?? f.b.species)}</b> Lv${f.b.level}
          <small>${f.b.types.join(' / ')}</small> ${bar(r.b.hp, r.b.maxHp)}</div>
      </header>
      <p class="why">${esc(f.why)} — <b>${r.winner === 'a' ? esc(f.a.species) : esc(f.b.species)}</b>
        wins in ${r.turns} turn${r.turns === 1 ? '' : 's'}; the wild is left at ${pct(r.hpFraction)} HP,
        which is what <code>economy.catchOdds</code> is handed.</p>
      <table class="bat-log">${rows}</table>
      <p class="slots">${[f.a, f.b].map((c) => `${esc(c.species)}: ${c.moves.map((m) => `${esc(m.id)} <i>${m.pp}</i>`).join(' · ')}`).join(' &nbsp;|&nbsp; ')}</p>
    </article>`;
}

function chartHtml(battle) {
  const types = battle.types();
  const cell = (a, d) => {
    const m = battle.effectiveness(a, [d]);
    const cls = m === 0 ? 'z' : m === 2 ? 'p' : m === 0.5 ? 'm' : '';
    return `<td class="${cls}">${m === 1 ? '' : m === 0.5 ? '½' : m === 0 ? '0' : m}</td>`;
  };
  return `<table class="bat-chart">
    <tr><th></th>${types.map((t) => `<th class="v"><span>${esc(t)}</span></th>`).join('')}</tr>
    ${types.map((a) => `<tr><th>${esc(a)}</th>${types.map((d) => cell(a, d)).join('')}</tr>`).join('')}
  </table>`;
}

function slotsHtml(battle, species) {
  const rows = [];
  for (const name of ['oshawott', 'pikachu', 'gastly']) {
    const s = species(name);
    if (!s) continue;
    for (const level of [8, 24, 44]) {
      const slots = battle.movesFor(name, level);
      rows.push(`<tr><th>${esc(s.display ?? name)} <i>Lv${level}</i></th><td>${slots.map((m) => {
        const def = battle.move(m.id);
        return `<span class="mv"><b>${esc(def?.n ?? m.id)}</b> ${esc(def?.t ?? '')} ${def?.p ? `${def.p}p` : 'status'} <i>${m.pp}pp</i></span>`;
      }).join('')}</td></tr>`);
    }
  }
  return `<table class="bat-slots">${rows.join('')}</table>`;
}

const CSS = `
#bat-showcase{position:absolute;inset:0;overflow:auto;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;
  color:#e8e4dc;background:linear-gradient(180deg,#12131a 0%,#0d0e13 100%);padding:14px 16px 40px}
#bat-showcase *{box-sizing:border-box}
.bat-head{display:flex;align-items:center;gap:12px;border-bottom:1px solid #2b2d3a;padding-bottom:10px;margin-bottom:14px}
.bat-mark{width:18px;height:18px;border-radius:50%;background:linear-gradient(180deg,#e0503c 50%,#f2efe6 50%);
  border:2px solid #16171d;box-shadow:0 0 0 1px #4a4c5c}
.bat-head h1{margin:0;font-size:15px;letter-spacing:.06em;text-transform:uppercase}
.bat-head h1 span{display:block;font-size:10px;color:#8b8fa3;letter-spacing:.02em;text-transform:none}
.bat-meta{margin-left:auto;color:#8b8fa3}
.bat-meta .ok{color:#7fd48a}.bat-meta .bad{color:#e8746a}
.bat-body{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
#bat-showcase[data-mode="fight"] .bat-body,#bat-showcase[data-mode="types"] .bat-body,
#bat-showcase[data-mode="moves"] .bat-body,#bat-showcase[data-mode="status"] .bat-body{grid-template-columns:1fr}
#bat-showcase[data-mode="fight"] .bat-panel:not([data-panel="fight"]),
#bat-showcase[data-mode="types"] .bat-panel:not([data-panel="types"]),
#bat-showcase[data-mode="moves"] .bat-panel:not([data-panel="moves"]),
#bat-showcase[data-mode="status"] .bat-panel:not([data-panel="status"]){display:none}
.bat-panel{background:#171923;border:1px solid #2b2d3a;border-radius:6px;padding:10px 12px 12px}
.bat-panel h2{margin:0 0 8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#c9c4b8}
.bat-panel h2 span{display:block;font-size:10px;color:#7c8095;letter-spacing:0;text-transform:none}
.bat-fight{border-top:1px solid #23252f;padding-top:9px;margin-top:9px}
.bat-fight:first-of-type{border-top:0;margin-top:0;padding-top:0}
.bat-fight header{display:flex;align-items:center;gap:8px}
.bat-fight .side{flex:1}.bat-fight .side small{color:#7c8095;margin-left:4px}
.bat-fight .vs{color:#6a6e82}
.bat-bar{display:inline-block;width:74px;height:6px;background:#2b2d3a;border-radius:3px;overflow:hidden;vertical-align:middle;margin-left:6px}
.bat-bar i{display:block;height:100%}.bat-bar .hi{background:#6cc27a}.bat-bar .mid{background:#e0b24c}.bat-bar .lo{background:#e0604c}
.bat-hp{color:#8b8fa3;margin-left:5px}
.why{color:#9aa0b4;margin:6px 0}.why code{color:#c9c4b8}
.bat-log{width:100%;border-collapse:collapse}
.bat-log td{padding:1px 4px;vertical-align:top;color:#cfd2de}
.bat-log td.t{width:18px;color:#5f6376;text-align:right}
.bat-log tr.k-faint td{color:#e8746a}
.bat-log em.se{color:#7fd48a;font-style:normal}.bat-log em.nv{color:#8b8fa3;font-style:normal}
.bat-log em.cr{color:#e0b24c;font-style:normal}.bat-log em.st{color:#b98ce0;font-style:normal}
.slots{color:#7c8095;margin:6px 0 0}.slots i{color:#5f6376;font-style:normal}
.bat-chart{border-collapse:collapse;font-size:10px}
.bat-chart th{color:#8b8fa3;font-weight:400;text-align:right;padding:0 4px;white-space:nowrap}
.bat-chart th.v{height:58px;text-align:left;vertical-align:bottom;padding:0}
.bat-chart th.v span{display:block;transform:rotate(-90deg) translateX(-2px);transform-origin:left bottom;width:14px}
.bat-chart td{width:15px;height:15px;text-align:center;border:1px solid #22242e;color:#e8e4dc}
.bat-chart td.p{background:#2f5c39}.bat-chart td.m{background:#5c2f2f}.bat-chart td.z{background:#1d1f27;color:#6a6e82}
.bat-slots{width:100%;border-collapse:collapse}
.bat-slots th{text-align:left;color:#c9c4b8;font-weight:400;white-space:nowrap;padding:3px 8px 3px 0;vertical-align:top}
.bat-slots th i{color:#7c8095;font-style:normal}
.bat-slots td{padding:3px 0}
.mv{display:inline-block;background:#1f2230;border:1px solid #2b2d3a;border-radius:3px;padding:1px 5px;margin:0 4px 3px 0;color:#9aa0b4}
.mv b{color:#e8e4dc;font-weight:400}.mv i{color:#5f6376;font-style:normal}
.bat-none{color:#7c8095}
`;
