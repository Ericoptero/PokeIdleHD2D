/**
 * The Shop (Stage 5) — replaces `panels/shop.js` under the same DOM screen contract
 * `screens/offline.js`/`screens/settings.js` established (`{id, open, close, key, draw}`).
 *
 * Real shops, not the source design's fictional Ofertas/Itens/Pacotes/Passe tabs: `economy`
 * ships four named shelves (`economy.shops()` — Poké Mart, Department Store, Battle Point
 * Exchange, Shard Stall) plus eleven permanent upgrade tracks, and this screen's own left rail
 * lists exactly those, with "Upgrades" folded in as a fifth entry — the old canvas panel's own
 * framing, kept because from the player's side buying a permanent multiplier is the same kind
 * of decision as buying a stack of balls.
 *
 * **Subscribes to `economy.onChange()`**, which the canvas predecessor did not need to (a
 * canvas panel repaints from live data on every frame regardless); a DOM screen only redraws
 * when told to, so this closes a real gap — an automation module buying balls in the
 * background, or a hunt paying out research, now updates this screen live instead of only on
 * the next click.
 */
import { h } from '../dom/el.js';
import { icon } from '../dom/icons.js';

const isLive = (api) => !!api && api.__missing === undefined;

const CURRENCY_ICON = { money: 'coin', research: 'trending-up', shards: 'gem', bp: 'dot' };

export function makeShopDomScreen(app, domLayer) {
  let root = null;
  let shopId = null;
  let selectedId = null;
  let bulk = 1;
  let offChange = null;

  const eco = () => app.ctx.get('economy');

  function shopList() {
    const e = eco();
    if (!isLive(e) || typeof e.shops !== 'function') return [];
    const upgrades = isLive(e) && typeof e.upgrades === 'function' ? e.upgrades() : [];
    return [...(e.shops() ?? []), {
      id: 'upgrades', name: 'Upgrades', blurb: 'Permanent multipliers', unlocked: true, requires: '', size: upgrades.length,
    }];
  }

  function stockRows() {
    const e = eco();
    if (!isLive(e)) return [];
    if (shopId === 'upgrades') {
      return (e.upgrades?.() ?? []).map((u) => ({
        kind: 'upgrade', id: u.id, name: u.name, desc: u.desc, currency: u.currency,
        price: u.cost, level: u.level, max: u.max, value: u.value, mode: u.mode,
        unlocked: u.unlocked, affordable: u.affordable,
        maxed: Number.isFinite(u.max) && u.level >= u.max,
      }));
    }
    return (e.stock?.(shopId) ?? []).map((s) => ({
      kind: 'item', id: s.id, name: s.name, desc: s.desc, currency: s.currency,
      price: s.price, discount: s.discount, onDeal: s.onDeal,
      owned: s.owned, sell: s.sell, limit: s.limit, limitLeft: s.limitLeft,
      unlocked: s.unlocked, requires: s.requires, category: s.category, when: s.when,
      affordable: (e.balance?.(s.currency) ?? 0) >= (s.price ?? Infinity),
    }));
  }

  function ensureShop() {
    const all = shopList();
    if (shopId && all.some((s) => s.id === shopId)) return;
    shopId = (all.find((s) => s.unlocked) ?? all[0])?.id ?? null;
  }

  function buy(item, n) {
    const e = eco();
    if (!item) return;
    if (item.kind === 'upgrade') {
      const got = e.buyUpgrade?.(item.id, n) ?? 0;
      app.toast(got ? `${item.name} → level ${item.level + got}` : `Not enough ${item.currency}`, got ? 'good' : 'warn');
    } else {
      const ok = e.buy?.(item.id, n, { shopId });
      app.toast(ok ? `Bought ${n}× ${item.name}` : `Cannot buy ${item.name}`, ok ? 'good' : 'warn');
    }
    renderRoot();
  }

  function render() {
    const e = eco();
    ensureShop();
    const all = shopList();
    const list = stockRows();
    if (!list.some((r) => r.id === selectedId)) selectedId = list[0]?.id ?? null;
    const sel = list.find((r) => r.id === selectedId) ?? null;
    const deal = isLive(e) && typeof e.deal === 'function' ? e.deal() : null;
    const dealItem = deal?.itemId && isLive(e) ? e.item?.(deal.itemId) : null;

    const currencies = isLive(e) && typeof e.currencies === 'function' ? e.currencies() : [];
    const wallet = h('div', { class: 'ci-shelf-head__mid' }, [
      ...currencies.map((c) => h('div', { class: 'ci-chip', 'data-currency': c.id, 'data-ui': `shop-wallet-${c.id}` }, [
        icon(CURRENCY_ICON[c.id] ?? 'dot', { size: 15 }),
        h('span', {}, e.format(c.id, c.balance)),
      ])),
      dealItem ? h('div', { class: 'ci-shelf-deal' }, [
        icon('trending-up', { size: 13 }), h('span', {}, `Deal: ${dealItem.name} −${Math.round((deal.discount ?? 0) * 100)}%`),
      ]) : null,
    ].filter(Boolean));

    const railBtns = all.map((s) => h('button', {
      type: 'button', class: `ci-shelf-rail__item${s.id === shopId ? ' ci-shelf-rail__item--active' : ''}${!s.unlocked ? ' ci-shelf-rail__item--locked' : ''}`,
      'data-ui': `shop-shop-${s.id}`,
      onClick: () => { shopId = s.id; selectedId = null; renderRoot(); },
    }, [
      h('span', { class: 'ci-shelf-rail__item-label' }, s.name),
      h('span', { class: 'ci-shelf-rail__item-sub' }, s.unlocked ? s.blurb : s.requires),
    ]));

    const gridRows = list.length ? list.map((item) => {
      const priceText = item.maxed ? 'MAX'
        : item.unlocked ? e.format(item.currency, item.price)
          : (item.requires || 'locked');
      return h('button', {
        type: 'button', class: `ci-shelf-row${item.id === selectedId ? ' ci-shelf-row--active' : ''}${!item.unlocked ? ' ci-shelf-row--locked' : ''}`,
        'data-ui': `shop-row-${item.id}`,
        onClick: () => { selectedId = item.id; renderRoot(); },
      }, [
        h('div', { class: 'ci-shelf-row__body' }, [
          h('span', { class: 'ci-shelf-row__name' }, item.name),
          h('span', { class: 'ci-shelf-row__sub' },
            item.kind === 'upgrade' ? `Level ${item.level}${Number.isFinite(item.max) ? ` / ${item.max}` : ''}`
              : (item.owned ? `own ×${item.owned}` : (item.unlocked ? (item.category ?? '') : ''))),
        ]),
        item.onDeal ? h('span', { class: 'ci-shelf-row__badge' }, 'DEAL') : null,
        h('span', { class: `ci-shelf-row__value${!item.unlocked || item.maxed ? ' ci-shelf-row__value--dim' : ''}` }, priceText),
      ].filter(Boolean));
    }) : [h('div', { class: 'ci-shelf-empty' }, 'Nothing on this shelf.')];

    let detailBody;
    if (!sel) {
      detailBody = [h('p', { class: 'ci-shelf-detail__desc' }, 'Select something on the shelf.')];
    } else {
      const lines = [
        h('h3', { class: 'ci-shelf-detail__name' }, sel.name),
        h('p', { class: 'ci-shelf-detail__desc' }, sel.desc),
      ];
      if (sel.kind === 'upgrade') {
        lines.push(h('div', { class: 'ci-shelf-detail__row' }, [
          h('span', { class: 'ci-shelf-detail__row-label' }, 'Now'),
          h('span', { class: 'ci-shelf-detail__row-value' }, sel.mode === 'flat' ? `+${sel.value}` : `×${Number(sel.value).toFixed(2)}`),
        ]));
        if (!sel.maxed) {
          lines.push(h('div', { class: 'ci-shelf-detail__row' }, [
            h('span', { class: 'ci-shelf-detail__row-label' }, 'Next level'),
            h('span', { class: 'ci-shelf-detail__row-value' }, e.format(sel.currency, sel.price)),
          ]));
        }
      } else {
        if (!sel.unlocked) {
          lines.push(h('div', { class: 'ci-shelf-detail__hint' }, sel.requires || 'Locked.'));
        } else {
          lines.push(h('div', { class: 'ci-shelf-detail__row' }, [
            h('span', { class: 'ci-shelf-detail__row-label' }, 'Price'),
            h('span', { class: 'ci-shelf-detail__row-value' }, e.format(sel.currency, sel.price)),
          ]));
          if (sel.owned) lines.push(h('div', { class: 'ci-shelf-detail__row' }, [
            h('span', { class: 'ci-shelf-detail__row-label' }, 'In bag'), h('span', { class: 'ci-shelf-detail__row-value' }, String(sel.owned)),
          ]));
          if (sel.sell) lines.push(h('div', { class: 'ci-shelf-detail__row' }, [
            h('span', { class: 'ci-shelf-detail__row-label' }, 'Resells for'), h('span', { class: 'ci-shelf-detail__row-value' }, e.format('money', sel.sell)),
          ]));
          if (sel.limit != null) lines.push(h('div', { class: 'ci-shelf-detail__row' }, [
            h('span', { class: 'ci-shelf-detail__row-label' }, 'Left today'), h('span', { class: 'ci-shelf-detail__row-value' }, String(sel.limitLeft)),
          ]));
          if (sel.when) lines.push(h('p', { class: 'ci-shelf-detail__desc' }, sel.when));
        }
      }

      const actions = [];
      const buyable = sel.unlocked && !sel.maxed;
      if (buyable) {
        const amounts = sel.kind === 'upgrade' ? [1, 5] : [1, 5, 10];
        actions.push(h('div', { class: 'ci-shelf-detail__row-group' }, amounts.map((n) => h('button', {
          type: 'button', class: 'ci-shelf-btn', 'data-active': String(bulk === n), 'data-ui': `shop-bulk-${n}`,
          onClick: () => { bulk = n; renderRoot(); },
        }, [h('span', {}, `×${n}`)]))));
      }
      actions.push(h('button', {
        type: 'button', class: 'ci-shelf-btn ci-shelf-btn--primary', 'data-ui': 'shop-buy',
        disabled: !buyable || !sel.affordable,
        onClick: () => buy(sel, bulk),
      }, [h('span', {}, sel.maxed ? 'MAXED' : (sel.unlocked ? `Buy ×${bulk}` : 'LOCKED'))]));
      detailBody = [...lines, h('div', { class: 'ci-shelf-detail__actions' }, actions)];
    }

    return h('div', { class: 'ci-offline-scrim', 'data-ui': 'shop-scrim' }, [
      h('div', { class: 'ci-shelf-card' }, [
        h('div', { class: 'ci-shelf-head' }, [
          h('h2', { class: 'ci-shelf-head__title' }, 'Shop'),
          wallet,
          h('button', {
            type: 'button', class: 'ci-icon-btn', 'data-ui': 'shop-close', onClick: () => app.close(),
          }, icon('close', { size: 18 })),
        ]),
        h('div', { class: 'ci-shelf-body' }, [
          h('nav', { class: 'ci-shelf-rail' }, railBtns),
          h('div', { class: 'ci-shelf-grid', 'data-ui': 'shop-grid' }, gridRows),
          h('div', { class: 'ci-shelf-detail', 'data-ui': 'shop-detail' }, detailBody),
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
    id: 'shop',
    open() {
      shopId = null; selectedId = null; bulk = 1;
      root = render();
      domLayer.host.appendChild(root);
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
