/**
 * The party (Stage 9) — replaces `panels/party.js` under the same shelf rail/detail shape
 * Stages 5-6 already established, not a new layout invented for it. The one thing worth
 * restating from the panel it replaces: **the active Pokémon leads, and the trainer follows
 * it** — `pokemon.setLead(i)` emits `party:leadChanged`, `simulation` rebuilds the conga line
 * on its own, and this screen never touches the walker directly, same as before.
 *
 * Evolution is unchanged plumbing: `pokemon.evolve(instanceId)` on success emits
 * `pokemon:evolved`, which `../index.js` already listens for and plays the cutscene overlay —
 * this screen calls `evolve()` and nothing else, the same as the canvas panel did.
 */
import { h } from '../dom/el.js';
import { icon } from '../dom/icons.js';

const isLive = (api) => !!api && api.__missing === undefined;
const STAT_KEYS = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];

export function makePartyDomScreen(app, domLayer) {
  let root = null;
  let cursor = 0;
  let view = 'stats';

  const mon = () => app.ctx.get('pokemon');
  const itemLabel = (id) => {
    const eco = app.ctx.get('economy');
    return (isLive(eco) ? eco.item?.(id)?.name : null) ?? id;
  };

  function members() {
    const p = mon();
    if (!isLive(p) || typeof p.party !== 'function') return [];
    return (p.party() ?? []).map((inst, i) => ({
      inst,
      index: i,
      display: app.hud.displayName(inst?.species),
      level: inst?.level ?? 1,
      hp: Math.max(0, Number(inst?.hp) || 0),
      maxHp: Math.max(1, Number(inst?.maxHp) || 1),
      shiny: !!inst?.shiny,
      types: inst?.species?.types ?? [],
      stats: inst?.species?.baseStats ?? {},
      ivs: inst?.ivs ?? {},
      url: typeof p.spriteUrl === 'function' && inst?.species ? p.spriteUrl(inst.species, { shiny: !!inst.shiny }) : null,
    }));
  }

  function evolutionFor(i) {
    const p = mon();
    const inst = members()[i]?.inst;
    if (!isLive(p) || typeof p.canEvolve !== 'function' || !inst) return null;
    return p.canEvolve(inst.instanceId);
  }

  function evolve(i) {
    const p = mon();
    const inst = members()[i]?.inst;
    if (!isLive(p) || typeof p.evolve !== 'function' || !inst) return;
    const res = p.evolve(inst.instanceId);
    if (!res?.ok) app.toast(res?.why ?? 'it cannot evolve yet', 'warn');
    renderRoot();
  }

  function setLead(i) {
    const p = mon();
    if (!isLive(p) || typeof p.setLead !== 'function' || i === 0) return;
    const who = members()[i];
    p.setLead(i);
    cursor = 0;
    app.toast(`${who?.display ?? 'Your Pokémon'} takes the lead`, 'good');
    renderRoot();
  }

  function moveModel(i) {
    const bt = app.ctx.get('battle');
    const inst = members()[i]?.inst;
    if (!isLive(bt) || typeof bt.learnset !== 'function' || !inst?.species) return null;
    const seen = new Set();
    const pool = [];
    for (const row of bt.learnset(inst.species.name)) {
      if (row.level > (inst.level ?? 1)) break;
      if (seen.has(row.move)) continue;
      seen.add(row.move);
      const def = bt.move(row.move);
      if (def) pool.push({ id: row.move, at: row.level, name: def.n, type: def.t, power: def.p, pp: def.pp, cat: def.c });
    }
    const raw = typeof bt.priority === 'function' ? bt.priority(inst.instanceId) : (inst.priority ?? []);
    return {
      inst,
      pool,
      pinned: raw.filter((id) => seen.has(id)),
      slots: (inst.moves ?? []).map((slot) => ({ ...slot, def: bt.move(slot.id) })),
    };
  }

  function togglePin(i, id) {
    const model = moveModel(i);
    const p = mon();
    if (!model || !isLive(p) || typeof p.setPriority !== 'function') return;
    const next = model.pinned.includes(id) ? model.pinned.filter((x) => x !== id) : [...model.pinned, id];
    if (next.length > 4) { app.toast('Four moves is the whole of it — unpin one first', 'warn'); return; }
    p.setPriority(model.inst.instanceId, next);
    renderRoot();
  }

  function portrait(m, size) {
    const box = h('div', { class: 'ci-party-screen-portrait', style: { width: `${size}px`, height: `${size}px` } });
    if (m?.url) {
      box.style.backgroundImage = `url(${m.url})`;
      box.style.backgroundSize = '200% 400%';
      box.style.backgroundPosition = '0% 66.6667%';
    }
    return box;
  }

  function railRow(m, i) {
    const lead = i === 0;
    // The "leading" mark is a corner badge on the portrait, not a text pill beside the name —
    // the rail is 148px wide (`.ci-shelf-rail`, shared with every other shelf screen) and a
    // wide pill fighting the name/type text for that width was squeezing `.ci-shelf-row__body`
    // to near zero, wrapping "Lv 5 · water" one word per line (caught in this stage's own
    // screenshot review, not by eye on the DOM alone — the markup looked correct).
    const port = portrait(m, 32);
    if (lead) port.appendChild(h('span', { class: 'ci-party-screen-lead-badge' }, icon('map', { size: 10 })));
    return h('button', {
      type: 'button',
      class: `ci-shelf-row ci-party-screen-row${i === cursor ? ' ci-shelf-row--active' : ''}`,
      'data-ui': `party-row-${i}`,
      onClick: () => { cursor = i; renderRoot(); },
    }, [
      port,
      h('div', { class: 'ci-shelf-row__body' }, [
        h('span', { class: 'ci-shelf-row__name' }, [m.display, m.shiny ? ' ✨' : '']),
        h('span', { class: 'ci-shelf-row__sub' }, `Lv ${m.level}${lead ? ' · Leading' : ''}`),
        h('div', { class: 'ci-hp-meter' }, (() => {
          const fill = h('div', { class: 'ci-hp-meter__fill' });
          const frac = Math.max(0, Math.min(1, m.hp / m.maxHp));
          fill.style.width = `${frac * 100}%`;
          fill.dataset.band = frac <= 0.2 ? 'low' : frac <= 0.5 ? 'mid' : 'high';
          return fill;
        })()),
      ]),
    ]);
  }

  function emptyRow() {
    return h('div', { class: 'ci-shelf-row ci-shelf-row--locked ci-party-screen-row' }, [
      h('div', { class: 'ci-party-screen-portrait ci-party-screen-portrait--empty' }, icon('backpack', { size: 16 })),
      h('span', { class: 'ci-shelf-row__sub' }, 'Empty slot'),
    ]);
  }

  function statsPane(m) {
    const rows = STAT_KEYS.map(([key, label]) => {
      const base = Number(m.stats?.[key] ?? 0);
      const iv = Number(m.ivs?.[key] ?? 0);
      const fill = h('div', { class: 'ci-meter__fill' });
      fill.style.width = `${Math.min(100, (base / 180) * 100)}%`;
      const tick = h('div', { class: 'ci-party-screen-iv-tick' });
      tick.style.left = `${Math.min(100, (iv / 31) * 100)}%`;
      if (iv >= 28) tick.classList.add('ci-party-screen-iv-tick--good');
      return h('div', { class: 'ci-party-screen-stat-row' }, [
        h('span', { class: 'ci-party-screen-stat-row__label' }, label),
        h('div', { class: 'ci-meter ci-party-screen-stat-row__meter' }, [fill, tick]),
        h('span', { class: 'ci-party-screen-stat-row__value' }, String(base)),
      ]);
    });
    const ivTotal = STAT_KEYS.reduce((a, [k]) => a + Number(m.ivs?.[k] ?? 0), 0);
    const bst = STAT_KEYS.reduce((a, [k]) => a + Number(m.stats?.[k] ?? 0), 0);
    const evo = evolutionFor(cursor);

    const evoBlock = evo ? h('div', { class: 'ci-settings-section' }, [
      h('h3', { class: 'ci-settings-section__title' }, `Evolves into ${evo.display ?? evo.to}`),
      h('div', { class: 'ci-shelf-detail__row' }, [
        h('span', { class: 'ci-shelf-detail__row-label' }, 'Level'),
        h('span', { class: 'ci-shelf-detail__row-value' }, evo.have >= evo.level ? `${evo.have} ✓` : String(evo.have)),
      ]),
      ...(evo.materials ?? []).map((mat) => h('div', { class: 'ci-shelf-detail__row' }, [
        h('span', { class: 'ci-shelf-detail__row-label' }, itemLabel(mat.id)),
        h('span', { class: 'ci-shelf-detail__row-value' }, `${mat.have}/${mat.n}${mat.have >= mat.n ? ' ✓' : ''}`),
      ])),
    ]) : h('p', { class: 'ci-shelf-detail__desc' },
      'The lead walks the city and the trainer follows it, so this is also the sprite you see on screen.');

    return h('div', {}, [
      h('div', { class: 'ci-party-screen-stats' }, rows),
      h('p', { class: 'ci-shelf-detail__desc', style: { marginTop: '2px' } }, 'The tick on each bar is that stat’s IV.'),
      h('div', { class: 'ci-shelf-detail__row' }, [
        h('span', { class: 'ci-shelf-detail__row-label' }, 'IV total'), h('span', { class: 'ci-shelf-detail__row-value' }, `${ivTotal} / 186`),
      ]),
      h('div', { class: 'ci-shelf-detail__row' }, [
        h('span', { class: 'ci-shelf-detail__row-label' }, 'Base stat total'), h('span', { class: 'ci-shelf-detail__row-value' }, String(bst)),
      ]),
      h('div', { class: 'ci-shelf-detail__row' }, [
        h('span', { class: 'ci-shelf-detail__row-label' }, 'Slot'), h('span', { class: 'ci-shelf-detail__row-value' }, cursor === 0 ? 'Leading' : `Bench ${cursor + 1}`),
      ]),
      evoBlock,
    ]);
  }

  function movesPane() {
    const model = moveModel(cursor);
    if (!model) return h('div', { class: 'ci-shelf-empty' }, 'Move data is not loaded — the battle module is unavailable.');
    const slotRows = [0, 1, 2, 3].map((i) => {
      const slot = model.slots[i];
      if (!slot) return h('div', { class: 'ci-shelf-detail__row' }, [h('span', { class: 'ci-shelf-detail__row-label' }, '—')]);
      const pinned = model.pinned.includes(slot.id);
      return h('div', { class: 'ci-shelf-detail__row' }, [
        h('span', { class: 'ci-shelf-detail__row-label' }, [pinned ? '★ ' : '', slot.def?.n ?? slot.id]),
        h('span', { class: `ci-shelf-detail__row-value${slot.pp === 0 ? ' ci-party-screen-pp-empty' : ''}` }, `${slot.pp}/${slot.maxPp}`),
      ]);
    });
    const poolRows = model.pool.map((move) => {
      const pinned = model.pinned.includes(move.id);
      return h('button', {
        type: 'button', class: `ci-shelf-row${pinned ? ' ci-shelf-row--active' : ''}`, 'data-ui': `party-move-${move.id}`,
        onClick: () => togglePin(cursor, move.id),
      }, [
        h('span', {}, pinned ? '★' : '·'),
        h('span', { class: 'ci-shelf-row__name', style: { flex: '1' } }, move.name),
        h('span', { class: 'ci-shelf-row__value' }, `${move.type.slice(0, 3).toUpperCase()} ${move.power || '—'}`),
      ]);
    });
    return h('div', {}, [
      h('h3', { class: 'ci-settings-section__title' }, 'In battle'),
      ...slotRows,
      h('h3', { class: 'ci-settings-section__title' }, `Learned — ${model.pinned.length}/4 pinned`),
      h('div', { class: 'ci-automation-list' }, poolRows.length ? poolRows : [h('div', { class: 'ci-shelf-empty' }, 'Nothing learned yet.')]),
      h('p', { class: 'ci-shelf-detail__desc' }, 'Two slots always hold attacks, whatever is pinned.'),
    ]);
  }

  function render() {
    const list = members();
    cursor = Math.max(0, Math.min(list.length - 1, cursor));
    const m = list[cursor];

    const railRows = [
      ...list.map((mm, i) => railRow(mm, i)),
      ...Array.from({ length: Math.max(0, 6 - list.length) }, (_, i) => emptyRow(list.length + i)),
    ];

    const evo = m ? evolutionFor(cursor) : null;
    const actions = m ? h('div', { class: 'ci-shelf-detail__actions' }, [
      evo ? h('button', {
        type: 'button', class: 'ci-shelf-btn ci-shelf-btn--primary', 'data-ui': 'party-evolve', disabled: !evo.ready,
        onClick: () => evolve(cursor),
      }, [h('span', {}, evo.ready ? 'Evolve' : 'Cannot evolve yet')]) : null,
      h('button', {
        type: 'button', class: 'ci-shelf-btn', 'data-ui': 'party-set-lead', disabled: cursor === 0,
        onClick: () => setLead(cursor),
      }, [h('span', {}, cursor === 0 ? 'Already leading' : 'Make it lead')]),
    ].filter(Boolean)) : null;

    const detail = !m ? h('div', { class: 'ci-shelf-empty' }, 'No Pokémon yet.') : h('div', { class: 'ci-shelf-detail', 'data-ui': 'party-detail' }, [
      h('div', { class: 'ci-party-screen-head' }, [
        portrait(m, 44),
        h('div', {}, [
          h('h3', { class: 'ci-shelf-detail__name' }, [m.display, m.shiny ? ' ✨' : '']),
          h('span', { class: 'ci-shelf-detail__row-label' }, `Lv ${m.level} · ${m.types.join(' / ') || '—'}`),
        ]),
      ]),
      h('div', { class: 'ci-shelf-tabs' }, [
        h('button', {
          type: 'button', class: `ci-shelf-tab${view === 'stats' ? ' ci-shelf-tab--active' : ''}`, 'data-ui': 'party-tab-stats',
          onClick: () => { view = 'stats'; renderRoot(); },
        }, 'Stats'),
        h('button', {
          type: 'button', class: `ci-shelf-tab${view === 'moves' ? ' ci-shelf-tab--active' : ''}`, 'data-ui': 'party-tab-moves',
          onClick: () => { view = 'moves'; renderRoot(); },
        }, 'Moves'),
      ]),
      h('div', { class: 'ci-automation-body' }, [view === 'stats' ? statsPane(m) : movesPane()]),
      actions,
    ].filter(Boolean));

    return h('div', { class: 'ci-offline-scrim', 'data-ui': 'party-scrim' }, [
      h('div', { class: 'ci-shelf-card' }, [
        h('div', { class: 'ci-shelf-head' }, [
          h('h2', { class: 'ci-shelf-head__title' }, 'Party'),
          h('button', { type: 'button', class: 'ci-icon-btn', 'data-ui': 'party-close', onClick: () => app.close() }, icon('close', { size: 18 })),
        ]),
        h('div', { class: 'ci-shelf-body' }, [
          h('nav', { class: 'ci-shelf-rail', 'data-ui': 'party-rail' }, railRows),
          detail,
        ]),
      ]),
    ]);
  }

  function renderRoot() {
    if (!root) return;
    const next = render();
    root.replaceWith(next);
    root = next;
  }

  return {
    id: 'party',
    model: () => ({ cursor, view, members: members() }),
    open(opts) {
      cursor = Number.isInteger(opts?.select) ? opts.select : 0;
      view = opts?.view === 'moves' ? 'moves' : 'stats';
      root = render();
      domLayer.host.appendChild(root);
    },
    close() { root?.remove(); root = null; },
    key(ev) {
      if (ev.code === 'Escape') { app.close(); return true; }
      if (ev.code === 'KeyM') { view = view === 'moves' ? 'stats' : 'moves'; renderRoot(); return true; }
      if (ev.code === 'KeyE') { evolve(cursor); return true; }
      return false;
    },
    draw() { return null; },
  };
}
