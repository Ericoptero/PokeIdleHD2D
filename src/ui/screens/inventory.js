/**
 * The Bag (Stage 5) — replaces `panels/inventory.js` one-for-one under the same DOM screen
 * contract `screens/offline.js`/`screens/settings.js` already established (`{id, open, close,
 * key, draw}`, `draw()` a no-op since nothing here paints on the canvas).
 *
 * The row data is untouched: `../models/inventory.js`'s `filterRows`/`CATEGORY_LABEL`, lifted
 * out of the old panel unchanged, still read straight off `economy.bag()`/`stash()`. What is
 * new in this stage is the "use on a monster" action — `economy.useItem()` had zero callers
 * anywhere in the codebase before this file, because no view had ever needed one.
 *
 * **`useItem()` reports what an item means; it does not apply it.** Economy owns the bag,
 * `pokemon` owns the creature, so the effect it hands back is dispatched here to whichever
 * `pokemon` method actually matches it:
 *  - `heal.revive` → `pokemon.revive()` (`instance.js`'s dedicated reviver — `pokemon.heal()`
 *    refuses a fainted target outright and does not know what `revive` even means).
 *  - `heal.pp` → `pokemon.restorePp()`.
 *  - any other `heal` (hp and/or status) → `pokemon.heal()`, with `hp` always passed
 *    explicitly (`effect.hp ?? 0`) — `INST.heal`'s own default is `hp: 'full'`, which would
 *    fire for a Full Heal (`{status:true}`, no `hp` key at all) if the key were ever omitted.
 *  - `exp === 'level'` → `pokemon.levelUp()` (the real growth-curve maths); any other `exp` →
 *    `pokemon.grantExp()`.
 *  - a `buff` (lures) needs no target at all — `useItem(id, null)` already applies it
 *    internally (`state.addBuff`), so there is no picker for these, just a direct use.
 *
 * **Evolution items are deliberately never routed through `useItem()`.** `pokemon.evolve()`
 * already consumes its own stone through `economy.take()` the moment a route is confirmed —
 * spending it here first would either double-consume it or hand the player a stone-shaped
 * item that then couldn't complete the evolution it was bought for. This screen shows a hint
 * pointing at the Party screen instead of a Use button for anything with an `evolution` field.
 *
 * The party picker excludes members a use would be wasted on, mirroring the guards
 * `instance.js` itself enforces: **only** fainted members for a revive, and **no** fainted
 * member for anything else (a plain heal/PP/EXP item on a fainted Pokémon is a no-op there).
 */
import { h } from '../dom/el.js';
import { icon } from '../dom/icons.js';
import { fmt } from '../format.js';
import { filterRows, CATEGORY_LABEL } from '../models/inventory.js';

const isLive = (api) => !!api && api.__missing === undefined;

/** Finer than `def.category`, because three of the game's four consumable categories are all
 *  `medicine` — see `economy/items.js`'s own `purchaseClass` for the identical reasoning. */
function healKind(heal) {
  if (heal.revive != null) return 'revive';
  if (heal.pp != null) return 'pp';
  return 'heal';
}

/** `null` means "nothing to use this on" — a ball, a key item, loot, or a held passive
 *  (permanent the moment it's owned, never "used"). */
function usableKind(def) {
  if (!def) return null;
  if (def.heal) return healKind(def.heal);
  if (def.exp) return 'exp';
  if (def.buff) return 'buff';
  return null;
}

const KIND_VERB = { heal: 'Use', revive: 'Revive', pp: 'Restore PP', exp: 'Give EXP', buff: 'Use' };

export function makeInventoryDomScreen(app, domLayer) {
  let root = null;
  let tab = 'bag';
  let category = null;
  let selectedId = null;
  let picking = false;
  let offChange = null;

  const eco = () => app.ctx.get('economy');
  const pk = () => app.ctx.get('pokemon');

  const rows = () => filterRows(app, tab, category);

  function presentCategories() {
    const seen = new Set(filterRows(app, tab, null).map((r) => r.category));
    return Object.keys(CATEGORY_LABEL).filter((c) => seen.has(c));
  }

  function ensureSelection(list) {
    if (!list.length) { selectedId = null; return; }
    if (!list.some((r) => r.id === selectedId)) selectedId = list[0].id;
  }

  /** Party members a use would not be wasted on — see this file's own header. */
  function candidatesFor(kind) {
    const p = pk();
    if (!isLive(p) || typeof p.party !== 'function') return [];
    const party = p.party();
    return kind === 'revive' ? party.filter((m) => m.hp <= 0) : party.filter((m) => m.hp > 0);
  }

  function applyItem(itemId, kind, member) {
    const e = eco();
    const p = pk();
    const display = member.species?.display ?? member.species?.name ?? 'it';
    const effect = e.useItem(itemId, member.instanceId);
    if (!effect) { app.toast(`Could not use that on ${display}`, 'warn'); return; }
    if (effect.kind === 'heal') {
      if (effect.revive != null) p.revive(member.instanceId, { fraction: effect.revive });
      else if (effect.pp != null) p.restorePp(member.instanceId, { amount: effect.pp });
      else p.heal(member.instanceId, { hp: effect.hp ?? 0, status: !!effect.status });
    } else if (effect.kind === 'exp') {
      if (effect.exp === 'level') p.levelUp(member.instanceId);
      else p.grantExp(member.instanceId, effect.exp, { source: 'item' });
    }
    app.toast(`Used on ${display}`, 'good');
    picking = false;
    renderRoot();
  }

  function useDirectly(item) {
    const e = eco();
    const effect = e.useItem(item.id, null);
    if (!effect) { app.toast('Could not use that', 'warn'); return; }
    app.toast(`${item.name} used`, 'good');
    renderRoot();
  }

  function render() {
    const e = eco();
    const list = rows();
    ensureSelection(list);
    const sel = list.find((r) => r.id === selectedId) ?? null;
    const def = sel && isLive(e) && typeof e.item === 'function' ? e.item(sel.id) : null;
    const kind = usableKind(def);

    const switchTab = (next) => {
      if (tab === next) return;
      tab = next; category = null; selectedId = null; picking = false; renderRoot();
    };
    const tabsEl = h('div', { class: 'ci-shelf-tabs' }, [
      h('button', {
        type: 'button', class: `ci-shelf-tab${tab === 'bag' ? ' ci-shelf-tab--active' : ''}`, 'data-ui': 'bag-tab-bag',
        onClick: () => switchTab('bag'),
      }, 'Bag'),
      h('button', {
        type: 'button', class: `ci-shelf-tab${tab === 'stash' ? ' ci-shelf-tab--active' : ''}`, 'data-ui': 'bag-tab-stash',
        onClick: () => switchTab('stash'),
      }, 'Stash'),
    ]);

    const cats = presentCategories();
    const railBtns = [
      h('button', {
        type: 'button', class: `ci-shelf-rail__item${!category ? ' ci-shelf-rail__item--active' : ''}`, 'data-ui': 'bag-cat-all',
        onClick: () => { category = null; selectedId = null; renderRoot(); },
      }, [h('span', { class: 'ci-shelf-rail__item-label' }, 'All')]),
      ...cats.map((c) => h('button', {
        type: 'button', class: `ci-shelf-rail__item${category === c ? ' ci-shelf-rail__item--active' : ''}`, 'data-ui': `bag-cat-${c}`,
        onClick: () => { category = c; selectedId = null; renderRoot(); },
      }, [h('span', { class: 'ci-shelf-rail__item-label' }, CATEGORY_LABEL[c])])),
    ];

    const gridRows = list.length
      ? list.map((r) => h('button', {
        type: 'button', class: `ci-shelf-row${r.id === selectedId ? ' ci-shelf-row--active' : ''}`, 'data-ui': `bag-row-${r.id}`,
        onClick: () => { selectedId = r.id; picking = false; renderRoot(); },
      }, [
        h('div', { class: 'ci-shelf-row__icon' }, (CATEGORY_LABEL[r.category] ?? '?')[0]),
        h('div', { class: 'ci-shelf-row__body' }, [
          h('span', { class: 'ci-shelf-row__name' }, r.name),
          h('span', { class: 'ci-shelf-row__sub' }, r.locked ? 'kept — never auto-sold' : `sells for ${e.format?.('money', r.unitSell) ?? r.unitSell}`),
        ]),
        h('span', { class: 'ci-shelf-row__value' }, `×${fmt(r.n)}`),
      ]))
      : [h('div', { class: 'ci-shelf-empty' },
        tab === 'bag' ? 'Nothing here yet.' : 'Nothing in the stash — sell-only loot lands here.')];

    let detailBody;
    if (!sel) {
      detailBody = [h('p', { class: 'ci-shelf-detail__desc' }, 'Select something on the shelf.')];
    } else if (picking) {
      const targets = candidatesFor(kind);
      detailBody = [
        h('button', {
          type: 'button', class: 'ci-shelf-picker__back', 'data-ui': 'bag-picker-back', onClick: () => { picking = false; renderRoot(); },
        }, [icon('chevron-up', { size: 14 }), h('span', {}, 'Back')]),
        ...(targets.length
          ? targets.map((m) => h('button', {
            type: 'button', class: 'ci-shelf-picker__row', 'data-ui': `bag-picker-${m.instanceId}`,
            onClick: () => applyItem(sel.id, kind, m),
          }, [
            h('div', { class: 'ci-shelf-picker__row-body' }, [
              h('span', { class: 'ci-shelf-picker__row-name' }, m.species?.display ?? m.species?.name ?? m.instanceId),
              h('span', { class: 'ci-shelf-row__sub' }, `Lv ${m.level} · ${m.hp}/${m.maxHp} HP`),
            ]),
          ]))
          : [h('div', { class: 'ci-shelf-empty' },
            kind === 'revive' ? 'Nobody has fainted.' : 'Nobody in the party needs this right now.')]),
      ];
    } else {
      const lines = [
        h('h3', { class: 'ci-shelf-detail__name' }, sel.name),
        h('p', { class: 'ci-shelf-detail__desc' }, sel.desc),
        h('div', { class: 'ci-shelf-detail__row' }, [
          h('span', { class: 'ci-shelf-detail__row-label' }, 'In bag'), h('span', { class: 'ci-shelf-detail__row-value' }, String(sel.n)),
        ]),
        sel.unitSell > 0 ? h('div', { class: 'ci-shelf-detail__row' }, [
          h('span', { class: 'ci-shelf-detail__row-label' }, 'Sells for'), h('span', { class: 'ci-shelf-detail__row-value' }, e.format?.('money', sel.unitSell) ?? String(sel.unitSell)),
        ]) : null,
      ];
      if (def?.evolution) {
        lines.push(h('div', { class: 'ci-shelf-detail__hint' },
          'Evolution items are spent from the Party screen, on the Pokémon evolving — open PARTY and pick this one there.'));
      }
      const actions = [];
      if (kind) {
        const canUse = sel.n > 0 && (kind === 'buff' || candidatesFor(kind).length > 0);
        actions.push(h('button', {
          type: 'button', class: 'ci-shelf-btn ci-shelf-btn--primary', 'data-ui': 'bag-use', disabled: !canUse,
          onClick: () => { if (kind === 'buff') useDirectly(sel); else { picking = true; renderRoot(); } },
        }, [h('span', {}, KIND_VERB[kind])]));
      }
      if (sel.unitSell > 0) {
        // Short labels (`×1`/`×5`/`All`), not `Sell ×1`/`Sell all` — the row is 232px wide
        // split three ways, and the fuller text wrapped onto two lines per button (caught in
        // this stage's own screenshot review, before it ever reached a player).
        const group = [1, 5].filter((n) => n < sel.n).map((n) => h('button', {
          type: 'button', class: 'ci-shelf-btn', 'data-ui': `bag-sell-${n}`,
          onClick: () => { e.sell(sel.id, n); renderRoot(); },
        }, [h('span', {}, `×${n}`)]));
        group.push(h('button', {
          type: 'button', class: 'ci-shelf-btn', 'data-ui': 'bag-sell-all',
          onClick: () => { e.sell(sel.id, sel.n); renderRoot(); },
        }, [h('span', {}, 'All')]));
        actions.push(h('span', { class: 'ci-shelf-detail__group-label' }, 'Sell'));
        actions.push(h('div', { class: 'ci-shelf-detail__row-group' }, group));
        actions.push(h('button', {
          type: 'button', class: 'ci-shelf-btn ci-shelf-btn--ghost', 'data-ui': 'bag-lock', 'data-active': String(!!sel.locked),
          onClick: () => { e.setSellLock(sel.id, !sel.locked); renderRoot(); },
        }, [icon(sel.locked ? 'lock' : 'unlock', { size: 14 }), h('span', {}, sel.locked ? 'Kept — won’t auto-sell' : 'Tap to keep from auto-sell')]));
      }
      detailBody = [...lines.filter(Boolean), h('div', { class: 'ci-shelf-detail__actions' }, actions)];
    }

    return h('div', { class: 'ci-offline-scrim', 'data-ui': 'bag-scrim' }, [
      h('div', { class: 'ci-shelf-card' }, [
        h('div', { class: 'ci-shelf-head' }, [
          h('h2', { class: 'ci-shelf-head__title' }, 'Bag'),
          h('div', { class: 'ci-shelf-head__mid' }, [tabsEl]),
          h('button', {
            type: 'button', class: 'ci-icon-btn', 'data-ui': 'bag-close', onClick: () => app.close(),
          }, icon('close', { size: 18 })),
        ]),
        h('div', { class: 'ci-shelf-body' }, [
          h('nav', { class: 'ci-shelf-rail' }, railBtns),
          h('div', { class: 'ci-shelf-grid', 'data-ui': 'bag-grid' }, gridRows),
          h('div', { class: 'ci-shelf-detail', 'data-ui': 'bag-detail' }, detailBody),
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
    id: 'inventory',
    open() {
      tab = 'bag'; category = null; selectedId = null; picking = false;
      root = render();
      domLayer.host.appendChild(root);
      // `economy` has no bus event for a bare item-count change (`economy:changed` is
      // currency-only) — buying, selling, giving or using something moves a count with no
      // event at all, so this screen marks itself dirty off `economy.onChange(fn)`, a local
      // subscriber set, exactly like the canvas panel this replaces used to.
      const e = eco();
      if (isLive(e) && typeof e.onChange === 'function') offChange = e.onChange(() => renderRoot());
    },
    close() {
      offChange?.();
      offChange = null;
      root?.remove();
      root = null;
    },
    key(ev) {
      if (ev.code === 'Escape') { app.close(); return true; }
      return false;
    },
    draw() { return null; },
  };
}
