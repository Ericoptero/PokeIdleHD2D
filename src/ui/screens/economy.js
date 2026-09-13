/**
 * Economy mode (Stage 7) — a render-suppression seam plus a card view, not a panel opened
 * into `../index.js`'s single-`state.panel` slot. The plan's own framing: "the world is
 * paused, watch the numbers" is a **root UI mode**, toggled independently
 * (`app.setEconomyMode`, from Settings' Display category), coexisting with whatever panel the
 * player opens next — Bag, Shop and Automation all still make sense with no 3D view to look
 * at, so this mounts *behind* them (`z-index: 0` in `screens.css`, under the dock/HUD's `3`
 * and a modal's `4`) rather than exclusively.
 *
 * **The render seam**: `ctx.three.view.setPaused(true)` (`core/render.js`) stops the WebGL
 * draw calls and hides the canvas — the simulation is untouched, so `idle`'s accrual, a hunt's
 * clock and every automation keep running exactly as before. Turning it back off is the one
 * way out, alongside a plain "Back to the world" button and Escape.
 *
 * **The event log** is this screen's own, not a reuse of `dom/feed.js`'s recap card: that
 * file correlates three events into one finisher for a single ephemeral HUD card, which is a
 * narrower shape than a scrolling history wants. Here every `encounter:resolved` is a line on
 * its own — the event already carries everything worth showing (species, outcome, catch,
 * rewards) with no correlation needed.
 */
import { h, setText } from '../dom/el.js';
import { icon } from '../dom/icons.js';
import { fmt } from '../format.js';

const isLive = (api) => !!api && api.__missing === undefined;
const CURRENCY_ICON = { money: 'coin', research: 'trending-up', shards: 'gem', bp: 'dot' };
const LOG_CAP = 24;

/** `encounter:resolved` carries a bare species key (`r.species`, e.g. `'lechonk'`), never the
 *  full species record — `dom/feed.js`'s own `speciesName` wraps it in a synthetic `{name}` so
 *  `hud.js`'s `displayName` (which expects `.display ?? .name`) has something to read. */
function logLine(app, r) {
  const display = typeof app.hud?.displayName === 'function' ? app.hud.displayName({ name: r.species }) : r.species;
  const shiny = r.shiny ? '✨ ' : '';
  if (r.caught) return { text: `${shiny}Caught a ${display}`, kind: 'good' };
  if (r.outcome === 'win') return { text: `${shiny}Beat a ${display} — +${fmt(r.rewards?.money ?? 0)} ₽, +${fmt(r.rewards?.exp ?? 0)} XP`, kind: 'good' };
  return { text: `A ${display} got away`, kind: 'info' };
}

export function makeEconomyMode(app, domLayer) {
  let root = null;
  let active = false;
  let log = [];
  let offBus = null;
  let statEls = null;
  let logHost = null;

  const idle = () => app.ctx.get('idle');
  const eco = () => app.ctx.get('economy');

  function render() {
    const walletHost = h('div', { class: 'ci-economy-wallet' });
    statEls = {
      money: h('span', { class: 'ci-economy-stat__value' }, ''),
      exp: h('span', { class: 'ci-economy-stat__value' }, ''),
      research: h('span', { class: 'ci-economy-stat__value' }, ''),
      encounters: h('span', { class: 'ci-economy-stat__value' }, ''),
    };
    logHost = h('div', { class: 'ci-economy-log', 'data-ui': 'economy-log' });

    return h('div', { class: 'ci-economy-board', 'data-ui': 'economy-board' }, [
      h('div', { class: 'ci-economy-inner' }, [
        h('div', { class: 'ci-economy-head' }, [
          h('div', {}, [
            h('h2', { class: 'ci-shelf-head__title', style: { fontSize: '24px' } }, 'Economy mode'),
            h('p', { class: 'ci-shelf-detail__desc' }, 'The world is paused. Here’s what it’s doing.'),
          ]),
          h('button', {
            type: 'button', class: 'ci-btn', 'data-ui': 'economy-exit', onClick: () => app.setEconomyMode(false),
          }, [icon('close', { size: 16 }), h('span', {}, 'Back to the world')]),
        ]),
        walletHost,
        h('div', { class: 'ci-economy-stats' }, [
          h('div', { class: 'ci-economy-stat' }, [icon('coin', { size: 20 }), h('div', {}, [statEls.money, h('span', { class: 'ci-economy-stat__label' }, 'per hour')])]),
          h('div', { class: 'ci-economy-stat' }, [icon('trending-up', { size: 20 }), h('div', {}, [statEls.exp, h('span', { class: 'ci-economy-stat__label' }, 'EXP / hour')])]),
          h('div', { class: 'ci-economy-stat' }, [icon('trending-up', { size: 20 }), h('div', {}, [statEls.research, h('span', { class: 'ci-economy-stat__label' }, 'research / hour')])]),
          h('div', { class: 'ci-economy-stat' }, [icon('eye', { size: 20 }), h('div', {}, [statEls.encounters, h('span', { class: 'ci-economy-stat__label' }, 'encounters / hour')])]),
        ]),
        h('h3', { class: 'ci-settings-section__title' }, 'Recent'),
        logHost,
      ]),
    ]);
  }

  function renderLog() {
    logHost.replaceChildren(...(log.length
      ? log.map((l) => h('div', { class: `ci-economy-log-row ci-economy-log-row--${l.kind}` }, l.text))
      : [h('div', { class: 'ci-shelf-empty' }, 'Nothing yet — the party hasn’t met anything.')]));
  }

  /** Clears the HUD's own trainer/party/wallet chrome, which sits above this board
   *  (`z-index: 3` over `0`) and can run taller than any one fixed padding would safely
   *  clear — a full six-member party list is not a fixed height. */
  function clearHud() {
    const y = app.hudTopBottom?.();
    root.style.paddingTop = y != null ? `${Math.round(y) + 16}px` : '';
  }

  function updateStats() {
    clearHud();
    const i = idle();
    const rate = isLive(i) && typeof i.rate === 'function' ? i.rate() : null;
    setText(statEls.money, rate ? `₽${fmt(rate.money * 3600)}` : '—');
    setText(statEls.exp, rate ? fmt(rate.exp * 3600) : '—');
    setText(statEls.research, rate ? fmt(rate.research * 3600) : '—');
    setText(statEls.encounters, rate ? (rate.encounters * 3600).toFixed(1) : '—');

    const e = eco();
    const currencies = isLive(e) && typeof e.currencies === 'function' ? e.currencies() : [];
    root.querySelector('.ci-economy-wallet')?.replaceChildren(...currencies.map((c) => h('div', {
      class: 'ci-chip', 'data-currency': c.id, 'data-ui': `economy-wallet-${c.id}`,
    }, [icon(CURRENCY_ICON[c.id] ?? 'dot', { size: 15 }), h('span', {}, e.format(c.id, c.balance))])));
  }

  return {
    isActive: () => active,
    setActive(on) {
      on = !!on;
      if (on === active) return;
      active = on;
      if (on) {
        log = [];
        root = render();
        domLayer.host.appendChild(root);
        updateStats();
        renderLog();
        offBus = app.ctx.bus.on('encounter:resolved', (r) => {
          log.unshift(logLine(app, r));
          if (log.length > LOG_CAP) log.length = LOG_CAP;
          if (active) renderLog();
        });
      } else {
        offBus?.();
        offBus = null;
        root?.remove();
        root = null;
      }
    },
    /** Ticked from `../index.js`'s own `frame(dt)`, on the same 0.2s cadence `dom/hud.js`'s
     *  own poll rides — the wallet and the per-hour figures are worth refreshing on a clock,
     *  not only when an encounter resolves. A no-op while the board is not mounted. */
    step() {
      if (active && root) updateStats();
    },
    dispose() {
      offBus?.();
      root?.remove();
      root = null;
      active = false;
    },
  };
}
