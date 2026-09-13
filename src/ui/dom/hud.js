/**
 * The always-on HUD chrome, Stage 3a — the trainer card and party list (top-left), the
 * wallet/clock/settings row (top-right), and the dock (bottom-right). Toasts (Stage 2) are
 * the sibling piece already in `dom/toasts.js`; the event feed card and chat (3b/3c) mount
 * beside this later in the same stage.
 *
 * Reads through the exact same snapshot `../hud.js`'s `read()` already builds for the canvas
 * version — nothing here calls `ctx.get` on its own account, so there is no second copy of
 * "how do I ask `economy` for the wallet" to drift from the first. `../hud.js` itself is
 * untouched: `displayName`/`drawIcon` are still load-bearing for every panel that has not
 * converted (`panels/battle.js`, `boxes.js`, `trainer.js`, `party.js`), and `read()`/
 * `onPhase()` still feed `../index.js`'s own `state.hud` poll — only the three canvas paint
 * functions (`drawWallet`/`drawClock`/`drawParty`) and the button strip (`drawStrip`, folded
 * into this file's dock) stop being called.
 *
 * **The dock is five buttons, not the old strip's nine.** The source design's own dock has
 * four (Auto/Bag/Shop/Routes); the fifth, Menu, is new here and is what keeps this a
 * strict superset rather than a narrowing — `panels/menu.js` already lists Party, Trainer,
 * Boxes, Dex and the away report, so nothing the old nine-chip strip reached is out of reach
 * now, it just costs one extra click for the less-frequent ones. That trade is the source
 * design's own stated principle ("nothing in the HUD that doesn't change a decision").
 */
import { h, setText, syncList } from './el.js';
import { icon } from './icons.js';
import { fmt, clockTime } from '../format.js';
import { makeDragReorder } from './dnd.js';
import { makeEncounterFeed } from './feed.js';

const isLive = (api) => !!api && api.__missing === undefined;

const CURRENCY_ICON = {
  money: 'coin', research: 'trending-up', shards: 'gem', bp: 'dot',
};
const PHASE_LABEL = {
  night: 'Night', dawn: 'Dawn', morning: 'Morning', day: 'Day', goldenHour: 'Golden hour', dusk: 'Dusk',
};

/** The dock's own five destinations, in the order they sit on screen. `menu` is the one
 *  addition over the source design's four — see this file's own header. */
const DOCK_ITEMS = [
  { id: 'automation', icon: 'auto-mode', label: 'Auto' },
  { id: 'inventory', icon: 'backpack', label: 'Bag' },
  { id: 'shop', icon: 'shop', label: 'Shop' },
  { id: 'travel', icon: 'map', label: 'Routes' },
  { id: 'menu', icon: 'menu', label: 'Menu' },
];

/** Mirrors `theme.js`'s `hpRamp` thresholds (1/2 and 1/5) so a bar means the same thing here
 *  as it does on every canvas panel that still draws one. */
function hpBand(frac) {
  if (frac <= 0.2) return 'low';
  if (frac <= 0.5) return 'mid';
  return 'high';
}

export function makeDomHud(domLayer, app) {
  const top = h('div', { class: 'ci-hud-top', 'data-ui': 'hud-top' });
  const left = h('div', { class: 'ci-hud-left' });
  const right = h('div', { class: 'ci-hud-right' });
  top.append(left, right);

  // --- the trainer card --------------------------------------------------------------
  const xpFill = h('div', { class: 'ci-meter__fill' });
  const levelText = h('span', { class: 'ci-trainer-card__level' }, '');
  const trainerCard = h('div', { class: 'ci-trainer-card', 'data-ui': 'hud-trainer' }, [
    h('div', { class: 'ci-trainer-card__portrait' }, icon('person', { size: 22 })),
    h('div', { class: 'ci-trainer-card__body' }, [
      h('span', { class: 'ci-trainer-card__name' }, 'Trainer'),
      h('div', { class: 'ci-trainer-card__xp-row' }, [
        h('div', { class: 'ci-meter' }, xpFill),
        levelText,
      ]),
    ]),
  ]);
  left.appendChild(trainerCard);

  // --- the party list, drag-to-reorder ------------------------------------------------
  const partyList = h('div', { class: 'ci-party-list', 'data-ui': 'hud-party' });
  left.appendChild(partyList);
  const dnd = makeDragReorder({
    elements: () => [...partyList.children],
    onReorder: (from, to) => {
      const pokemon = app.ctx.get('pokemon');
      if (isLive(pokemon) && typeof pokemon.reorder === 'function') pokemon.reorder(from, to);
    },
    onClick: (index) => app.open('party', { select: index }),
  });

  // --- the wallet / clock / settings row ----------------------------------------------
  const walletHost = h('div', { class: 'ci-hud-right__wallet', style: { display: 'flex', gap: '8px' } });
  const clockTimeEl = h('span', { class: 'ci-chip__time' }, '');
  const clockPhaseEl = h('span', { class: 'ci-chip__phase' }, '');
  const clockChip = h('div', { class: 'ci-chip ci-chip--clock', 'data-ui': 'hud-clock' }, [clockTimeEl, clockPhaseEl]);
  const settingsBtn = h('button', {
    type: 'button', class: 'ci-icon-btn', 'data-ui': 'hud-settings', title: 'Settings',
    // No-op until Stage 4 lands a `settings` screen (`PANELS` has no such id yet, so
    // `app.open` returns `false` and nothing happens) — already written as the toggle it
    // should be, matching the dock buttons above, so nothing here needs revisiting then.
    onClick: () => (app.panelId() === 'settings' ? app.close() : app.open('settings')),
  }, icon('gear', { size: 20 }));
  const rightRow = h('div', { class: 'ci-hud-right__row' }, [walletHost, clockChip, settingsBtn]);
  right.appendChild(rightRow);

  // --- the encounter feed card, Stage 3b (below the wallet row) -----------------------
  const feed = makeEncounterFeed(app);
  right.appendChild(feed.el);

  // --- the dock ------------------------------------------------------------------------
  const dock = h('div', { class: 'ci-hud-dock', 'data-ui': 'hud-dock' });
  const dockButtons = new Map();
  for (const item of DOCK_ITEMS) {
    const btn = h('button', {
      type: 'button', class: 'ci-dock-btn', 'data-ui': `dock-${item.id}`,
      // Toggles, matching the old canvas strip's own rule exactly (`app.panelId() === it.id
      // ? app.close() : app.open(it.id)`) — without this, clicking the dock button for the
      // panel already open just re-opens it, which is not a close.
      onClick: () => (app.panelId() === item.id ? app.close() : app.open(item.id)),
    }, [
      h('div', { class: 'ci-dock-btn__icon' }, icon(item.icon, { size: 26 })),
      h('span', { class: 'ci-dock-btn__label' }, item.label),
    ]);
    dockButtons.set(item.id, btn);
    dock.appendChild(btn);
  }

  domLayer.host.append(top, dock);

  // Two independent reasons this chrome hides, composed rather than conflated: `bars`
  // (`../index.js`'s own flag, true unless the open panel sets `hidesHud` — today only
  // `dialogue`) hides *everything* under `top`, exactly as the canvas version's own
  // `if (bars) { drawWallet; drawClock }` did; `minimal` (another module's showcase) hides
  // only the party list and the dock, keeping the wallet/clock/trainer-level "passenger"
  // chrome the top-of-file comment on `../index.js` describes — the canvas version's own
  // `drawClock` drew the trainer's level badge unconditionally whenever `bars` was true,
  // passenger showcase or not, and only the party bar and button strip were `!minimal`-gated.
  // The trainer *card* stays with that badge rather than with the party list it sits above
  // in the layout, even though they are visually one column, so a `?showcase=hunts` capture
  // keeps exactly the ambient chrome it always had.
  let minimalFlag = false;
  let barsFlag = true;
  function applyVisibility() {
    top.hidden = !barsFlag;
    partyList.hidden = minimalFlag;
    settingsBtn.hidden = minimalFlag;
    dock.hidden = !barsFlag || minimalFlag;
    feed.setMinimal(minimalFlag);
  }

  /**
   * @param s the exact snapshot `../hud.js`'s own `read()` returns
   * @param {{minimal:boolean}} opts
   */
  function update(s, { minimal = false } = {}) {
    minimalFlag = minimal;
    applyVisibility();
    // -- trainer + XP --
    if (s.trainer) {
      const frac = s.trainer.need > 0 ? Math.max(0, Math.min(1, s.trainer.into / s.trainer.need)) : 0;
      xpFill.style.width = `${frac * 100}%`;
      setText(levelText, `Lv ${s.trainer.level}`);
    } else {
      xpFill.style.width = '0%';
      setText(levelText, '');
    }

    // -- party list --
    syncList(
      partyList, s.party, (m) => m.instanceId ?? m.name,
      () => h('div', { class: 'ci-party-row' }, [
        h('div', { class: 'ci-party-row__portrait' }),
        h('div', { class: 'ci-party-row__body' }, [
          h('div', { class: 'ci-party-row__head' }, [
            h('span', { class: 'ci-party-row__name' }, ''),
            h('span', { class: 'ci-party-row__level' }, ''),
          ]),
          h('div', { class: 'ci-hp-meter' }, h('div', { class: 'ci-hp-meter__fill' })),
        ]),
      ]),
      (row, m) => {
        row.dataset.active = String(m.instanceId === s.activeId);
        // `''` removes the inline longhand entirely (rather than setting it to `none`), so
        // the CSS placeholder gradient (`hud.css`'s `.ci-party-row__portrait`) shows through
        // when there is no sprite URL yet, instead of a flat colour.
        row.querySelector('.ci-party-row__portrait').style.backgroundImage = m.url ? `url(${m.url})` : '';
        setText(row.querySelector('.ci-party-row__name'), m.display);
        setText(row.querySelector('.ci-party-row__level'), `Lv ${m.level}`);
        const frac = m.maxHp > 0 ? Math.max(0, Math.min(1, m.hp / m.maxHp)) : 0;
        const fillEl = row.querySelector('.ci-hp-meter__fill');
        fillEl.style.width = `${frac * 100}%`;
        fillEl.dataset.band = hpBand(frac);
      },
    );
    [...partyList.children].forEach((row, i) => {
      dnd.bind(row, i);
      row.setAttribute('data-ui', `hud-party-${i}`);
    });

    // -- wallet --
    if (s.wallet) {
      syncList(
        walletHost, Object.entries(s.wallet), ([id]) => id,
        ([id]) => h('div', { class: 'ci-chip', 'data-currency': id, 'data-ui': `hud-wallet-${id}` }, [
          icon(CURRENCY_ICON[id] ?? 'dot', { size: 16 }),
          h('span', {}, ''),
        ]),
        (chip, [, value]) => setText(chip.querySelector('span'), fmt(value)),
      );
    } else {
      walletHost.replaceChildren();
    }

    // -- clock --
    setText(clockTimeEl, clockTime(s.tod));
    setText(clockPhaseEl, PHASE_LABEL[s.phase] ?? '');

    // -- dock: highlight Auto only when a real automation is actually running --
    const auto = app.ctx.get('automation');
    const running = isLive(auto) && typeof auto.list === 'function'
      && (auto.list() ?? []).some((d) => d.unlocked && d.enabled);
    // `dataset.active = String(running)`, not `toggleAttribute('data-active', running)` —
    // `toggleAttribute`'s `force: true` sets the attribute to `""`, not the string `"true"`
    // `hud.css`'s own `[data-active='true']` selector matches against (the same explicit-
    // string convention the party rows already use, just above).
    const autoBtn = dockButtons.get('automation');
    if (autoBtn) autoBtn.dataset.active = String(running);
    // Bag has no key of its own on the old strip's chips (`I`), so nothing to mirror there;
    // the rest of the dock has no "on/off" state to reflect.
  }

  return {
    update,
    /** Ages the encounter feed card (`dom/feed.js`) every real frame — called from
     *  `../index.js`'s own `frame(dt)`, the same cadence `dom/toasts.js`'s `step(dt)` rides,
     *  since a 6 s lifetime needs finer resolution than the 0.2s data poll `update()` uses. */
    step(dt) { feed.step(dt); },
    /** `bars` (`../index.js`'s own flag) — called every `draw()`, not just on the 0.2s data
     *  poll `update()` rides, since a panel's `hidesHud` can flip between two data polls
     *  (opening a dialogue message does not wait for one). */
    setBarsVisible(bars) { barsFlag = !!bars; applyVisibility(); },
    /** The real screen Y just below this chrome — `../index.js`'s `hudReserved()` uses it
     *  the way it used to use `walletBox`/`clockBox`, converted to canvas-buffer pixels
     *  there (this file has no reason to know the buffer exists at all). `null` while
     *  hidden — there is then nothing to reserve space for. */
    topBottom: () => (top.hidden ? null : top.getBoundingClientRect().bottom),
    /** The real screen Y just above the dock — the bottom half of the same reservation, or
     *  `null` while the dock is hidden, which is not a reservation at all. */
    dockTop: () => (dock.hidden ? null : dock.getBoundingClientRect().top),
    dispose() {
      dnd.dispose();
      feed.dispose();
      top.remove();
      dock.remove();
    },
  };
}
