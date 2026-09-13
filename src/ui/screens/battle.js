/**
 * The battle readout (Stage 9) — replaces `panels/battle.js`. Still a **docked card, not a
 * modal**: a fight is started by the world, not asked for by the player, and happens every
 * few seconds in a hunt — a full-screen window on that trigger would black out the loop the
 * player is watching, dozens of times a lap. No scrim, the world stays visible, the HUD stays
 * up (`hidesHud` is not set, same as before). It still goes through `PANELS`/`state.panel` —
 * `../index.js`'s own auto-open-on-`encounter:started`/auto-close-on-`encounter:resolved`
 * wiring, and the "never steals a panel the player opened" guard, are untouched.
 *
 * **Reads the live fight, not the party record** — `read()`, unchanged from the canvas panel:
 * a duel is stepped one turn at a time, and `pokemon`'s own HP is only written back when the
 * last blow lands, so mid-fight this reads the duel's own `run.state` instead. Because of that
 * this is the one screen in the whole DOM layer that needs a **live subscription while a fight
 * is in progress** — `battle:strike` (already emitted, already what the callout/floater system
 * listens to) triggers a re-render each exchange, on top of the render `open()`/
 * `encounter:started` already does at the top of the fight.
 *
 * `encounter.attempt()`'s first real player-facing caller — see the throw button below.
 */
import { h } from '../dom/el.js';
import { titleCase, fmt } from '../format.js';

const isLive = (api) => !!api && api.__missing === undefined;

export const STATUS_NAME = {
  brn: 'BRN', psn: 'PSN', tox: 'TOX', par: 'PAR', slp: 'SLP', frz: 'FRZ',
};

/** One transcript event as one line — unchanged from `panels/battle.js`'s own `lineFor`, the
 *  kinds a player would notice, folded down from the full turn-by-turn engine transcript. */
export function lineFor(ev, names) {
  const who = titleCase(ev.species ?? '') || names[ev.actor] || '';
  const foe = titleCase(ev.species ?? '') || (ev.actor === 'a' ? names.b : names.a) || '';
  switch (ev.kind) {
    case 'move': return { text: `${who} used ${ev.name}`, kind: 'move' };
    case 'damage': {
      const tag = ev.effectiveness !== 1 ? `  ×${ev.effectiveness}` : '';
      const crit = ev.crit ? '  crit' : '';
      return { text: `  −${ev.damage} HP${tag}${crit}`, kind: ev.effectiveness > 1 ? 'bad' : 'plain' };
    }
    case 'miss': return { text: `  ${foe} avoided it`, kind: 'plain' };
    case 'immune': return { text: `  it doesn't affect ${foe}`, kind: 'plain' };
    case 'status': return { text: `  ${titleCase(ev.species)} is ${STATUS_NAME[ev.status] ?? ev.status}`, kind: 'plain' };
    case 'confused': return { text: `  ${titleCase(ev.species)} is confused`, kind: 'plain' };
    case 'confused-hit': return { text: `${who} hurt itself −${ev.damage}`, kind: 'bad' };
    case 'flinch': return { text: `${who} flinched`, kind: 'plain' };
    case 'asleep': return { text: `${who} is fast asleep`, kind: 'plain' };
    case 'frozen': return { text: `${who} is frozen solid`, kind: 'plain' };
    case 'paralysed': return { text: `${who} is paralysed`, kind: 'plain' };
    case 'recoil': return { text: `  recoil −${ev.damage}`, kind: 'plain' };
    case 'faint': return { text: `${titleCase(ev.species)} fainted`, kind: 'bad' };
    default: return null;
  }
}

export function makeBattleDomScreen(app, domLayer) {
  let root = null;
  let staged = null;
  let offBus = null;

  const get = (id) => app.ctx.get(id);

  function read() {
    if (staged) return staged;
    const enc = get('encounter');
    const active = isLive(enc) && typeof enc.active === 'function' ? enc.active() : null;
    if (!active?.battle) return null;

    const pk = get('pokemon');
    const bt = get('battle');
    const lead = isLive(pk) && typeof pk.lead === 'function' ? pk.lead() : null;

    let wildMax = 0;
    if (isLive(bt) && typeof bt.stats === 'function' && active.sheet?.baseStats) {
      wildMax = bt.stats(active.sheet.baseStats, active.ivs ?? {}, active.level).hp;
    }
    const st = active.duel?.engine ? active.duel.run?.state : null;
    const fighting = active.battle.win === null;
    const side = st?.a ?? null;
    const frac = st ? (st.b.maxHp > 0 ? st.b.hp / st.b.maxHp : 1) : Math.max(0, Math.min(1, Number(active.hpFraction) || 0));

    return {
      won: active.battle.win === null ? null : !!active.battle.win,
      fighting,
      turns: active.battle.turns ?? 0,
      transcript: active.battle.transcript ?? [],
      ally: side ? {
        display: titleCase(side.display ?? side.species), level: side.level ?? 1, shiny: !!side.shiny,
        hp: Math.max(0, side.hp ?? 0), maxHp: Math.max(1, side.maxHp ?? 1), status: side.status ?? null,
      } : (lead ? {
        display: app.hud.displayName(lead.species), level: lead.level ?? 1, shiny: !!lead.shiny,
        hp: Math.max(0, lead.hp ?? 0), maxHp: Math.max(1, lead.maxHp ?? 1), status: lead.status ?? null,
      } : null),
      wild: {
        species: active.species, display: titleCase(active.display ?? active.species), level: active.level ?? 1,
        shiny: !!active.shiny, types: active.sheet?.types ?? [],
        hp: st ? Math.max(0, st.b.hp) : Math.round(wildMax * frac), maxHp: st ? Math.max(1, st.b.maxHp) : wildMax,
        status: st?.b?.status ?? null,
      },
      ball: typeof enc.ball === 'function' ? enc.ball() : null,
      odds: typeof enc.oddsFor === 'function' ? enc.oddsFor(enc.ball?.()) : 0,
      live: true,
    };
  }

  function bestBall() {
    const enc = get('encounter');
    return isLive(enc) && typeof enc.bestBall === 'function' ? (enc.bestBall()?.id ?? null) : null;
  }
  function ballsLeft(id) {
    const eco = get('economy');
    return isLive(eco) && typeof eco.count === 'function' && id ? (Number(eco.count(id)) || 0) : 0;
  }
  const ballName = (id) => {
    const eco = get('economy');
    return (isLive(eco) ? eco.item?.(id)?.name : null) ?? 'Ball';
  };
  function pityOf(species) {
    const eco = get('economy');
    if (!isLive(eco) || typeof eco.pity !== 'function' || !species) return null;
    const m = eco.pity(species);
    return Number.isFinite(m?.price) ? m : null;
  }

  function throwBall() {
    const enc = get('encounter');
    if (!isLive(enc) || typeof enc.attempt !== 'function') return;
    const id = typeof enc.ball === 'function' ? enc.ball() : undefined;
    enc.attempt(ballsLeft(id) > 0 ? id : (bestBall() ?? id));
    renderRoot();
  }
  function run() {
    const enc = get('encounter');
    if (isLive(enc) && typeof enc.flee === 'function') { enc.flee(); renderRoot(); }
  }

  function hpRow(who, wild) {
    const frac = who.maxHp > 0 ? who.hp / who.maxHp : 0;
    const nameEl = h('span', { class: 'ci-battle-name' }, [wild ? h('span', { class: 'ci-battle-wild-tag' }, 'Wild ') : null, who.display, who.shiny ? ' ✨' : ''].filter(Boolean));
    const fill = h('div', { class: 'ci-hp-meter__fill' });
    fill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    fill.dataset.band = frac <= 0.2 ? 'low' : frac <= 0.5 ? 'mid' : 'high';
    return h('div', { class: 'ci-battle-side' }, [
      h('div', { class: 'ci-battle-side__head' }, [nameEl, h('span', { class: 'ci-battle-side__level' }, `Lv ${who.level}`)]),
      h('div', { class: 'ci-hp-meter' }, fill),
      h('div', { class: 'ci-battle-side__foot' }, [
        h('span', {}, `${who.hp}/${who.maxHp}`),
        who.status ? h('span', { class: 'ci-battle-status' }, STATUS_NAME[who.status] ?? who.status) : null,
      ].filter(Boolean)),
      wild && who.types.length ? h('div', { class: 'ci-shelf-detail__row-label' }, who.types.join(' / ')) : null,
    ].filter(Boolean));
  }

  function clearHud() {
    const y = app.hudTopBottom?.();
    if (root) root.style.top = y != null ? `${Math.round(y) + 12}px` : '18px';
  }

  function render() {
    const b = read();
    if (!b) return null;

    const rows = [];
    for (const ev of b.transcript) {
      const line = lineFor(ev, { a: b.ally?.display ?? 'Your Pokémon', b: b.wild.display });
      if (line) rows.push(line);
    }
    let cut = Math.max(0, rows.length - 4);
    while (cut > 0 && rows[cut].kind !== 'move') cut--;
    const shown = rows.slice(cut).slice(-5);
    const pity = pityOf(b.wild.species);
    const buttons = b.won === true;

    const verdict = b.won === null ? `Turn ${Math.max(1, b.turns)}`
      : b.won ? `Won in ${b.turns} turn${b.turns === 1 ? '' : 's'}` : `Lost after ${b.turns}`;

    const children = [
      hpRow(b.wild, true),
      b.ally ? hpRow(b.ally, false) : null,
      h('div', { class: `ci-battle-verdict${b.won === false ? ' ci-battle-verdict--lost' : ''}` }, verdict),
    ];

    if (shown.length) {
      children.push(h('div', { class: 'ci-battle-log' }, shown.map((l) => h('div', { class: `ci-battle-log__line ci-battle-log__line--${l.kind}` }, l.text))));
    }

    if (pity) {
      const shown90 = Math.min(1, pity.ratio / 1.25);
      const fill = h('div', { class: 'ci-meter__fill' });
      fill.style.width = `${shown90 * 100}%`;
      if (pity.t > 0) fill.style.background = 'var(--c-good)';
      children.push(h('div', { class: 'ci-battle-pity' }, [
        h('div', { class: 'ci-battle-side__foot' }, [
          h('span', {}, 'Pity'),
          h('span', {}, pity.t > 0 ? `+${Math.round(pity.t * 100)}%` : `${Math.round(pity.ratio * 100)}%`),
        ]),
        h('div', { class: 'ci-meter' }, fill),
        h('div', { class: 'ci-battle-side__foot' }, [
          h('span', {}, `₽${fmt(Math.round(pity.sum))} / ₽${fmt(pity.price)}`),
          b.won === true && b.odds > 0 ? h('span', {}, `${Math.round(b.odds * 100)}%`) : null,
        ].filter(Boolean)),
      ]));
    }

    if (buttons) {
      const id = ballsLeft(b.ball) > 0 ? b.ball : (bestBall() ?? b.ball);
      const left = ballsLeft(id);
      children.push(h('div', { class: 'ci-shelf-detail__row-group' }, [
        h('button', {
          type: 'button', class: 'ci-shelf-btn ci-shelf-btn--primary', 'data-ui': 'battle-throw',
          disabled: !b.live || left <= 0, onClick: () => throwBall(),
        }, [h('span', {}, left > 0 ? `Throw ×${left}` : 'No balls')]),
        h('button', {
          type: 'button', class: 'ci-shelf-btn', 'data-ui': 'battle-run', disabled: !b.live, onClick: () => run(),
        }, [h('span', {}, 'Run')]),
      ]));
      if (id) children.push(h('p', { class: 'ci-shelf-detail__row-label' }, `Z ${ballName(id)} · R run`));
    }

    return h('div', { class: 'ci-battle-card', 'data-ui': 'battle-card' }, children);
  }

  function renderRoot() {
    const b = read();
    if (!b) { app.close(); return; }
    const next = render();
    if (root) root.replaceWith(next); else domLayer.host.appendChild(next);
    root = next;
    clearHud();
  }

  return {
    id: 'battle',
    full: false,
    open(opts) {
      staged = opts?.fight ?? null;
      root = render();
      if (root) domLayer.host.appendChild(root);
      clearHud();
      offBus = app.ctx.bus.on('battle:strike', () => renderRoot());
    },
    close() {
      staged = null;
      offBus?.(); offBus = null;
      root?.remove(); root = null;
    },
    key(ev) {
      const b = read();
      if (!b?.won || !b.live) return false;
      if (ev.code === 'Enter' || ev.code === 'KeyZ' || ev.code === 'Space') { throwBall(); return true; }
      if (ev.code === 'KeyR') { run(); return true; }
      return false;
    },
    has: () => !!read(),
    draw() { return null; },
  };
}
