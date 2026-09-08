/**
 * ui — the HUD, the panels and the input seam (ARCHITECTURE §5.12).
 *
 * Three decisions shape this module, and all three are visible in every screenshot:
 *
 * 1. **It is one 2-D canvas at the renderer's own internal resolution**, upscaled with
 *    NEAREST, not a DOM overlay at full resolution. See `screen.js` — the short version is
 *    that a crisp 12 px web panel over a 640×360 world upscaled ×3 is the one thing on
 *    screen not on the pixel grid, and it reads as a debug overlay instead of as the game.
 *    It costs **zero draw calls**: a 2-D canvas is composited by the browser and never
 *    reaches `renderer.info.render.calls`, which is the number §7 budgets.
 * 2. **Input goes through `simulation.moveIntent` and nowhere else** (`input.js`), so the
 *    walk stays tile-locked and deterministic.
 * 3. **It gets out of the way in someone else's showcase.** `src/main.js` boots `ui` for
 *    every `?showcase=…`, so anything this module draws unprompted lands in another
 *    builder's critic shots. Outside its own showcase and the game itself it draws the
 *    wallet, the clock and toasts — what the seed drew — and nothing else.
 */

import { makeScreen } from './screen.js';
import { makeHud } from './hud.js';
import { makeToasts } from './toasts.js';
import { makeInput } from './input.js';
import { makeMenu } from './panels/menu.js';
import { makeOfflineCard } from './panels/offline.js';
import { makeShop } from './panels/shop.js';
import { makeBoxes } from './panels/boxes.js';
import { makeDex } from './panels/dex.js';
import { makeParty } from './panels/party.js';
import { makeDialogue } from './panels/dialogue.js';
import { C, panel, applyLight } from './theme.js';

/**
 * The registry hands out a null-object Proxy for a missing or quarantined module, and it
 * answers `typeof api.anything === 'function'` with true even when the module is dead
 * (`core/registry.js`). The only safe test is the marker.
 */
const isLive = (api) => !!api && api.__missing === undefined;

let live = null;

export default {
  id: 'ui',
  needs: [],
  /** The showcase draws real panels over the real lobby, so it needs the lobby and its data. */
  showcaseNeeds: ['city', 'economy', 'collection', 'offline', 'idle', 'automation'],

  init(ctx) {
    const { bus, config, log } = ctx;
    const root = document.getElementById('ui') ?? document.body;

    // In another module's showcase this module is a passenger: wallet, clock, toasts.
    const minimal = !!config.showcase && config.showcase !== 'ui';

    const screen = makeScreen({ root, view: ctx.three?.view, log });
    const hud = makeHud(ctx);
    const toasts = makeToasts({ frozen: !!config.showcase });

    const state = {
      /** @type {object|null} */ panel: null,
      /** @type {object|null} */ lastSummary: null,
      debug: !!config.debug,
      hud: hud.read(),
      /** Set by `draw` each frame; read by the menu so it never lands on the clock. */
      clockBox: null,
      stripBox: null,
    };

    const app = {
      ctx,
      markDirty: () => screen.markDirty(),
      hovered: () => screen.painter.hovered(),
      hud,
      panelOpen: () => !!state.panel,
      panelId: () => state.panel?.id ?? null,
      panelKey: (ev) => (state.panel?.key ? !!state.panel.key(ev) : false),
      open(id, opts) {
        const p = PANELS[id];
        if (!p) return false;
        if (state.panel && state.panel !== p) state.panel.close?.();
        state.panel = p;
        p.open?.(opts);
        screen.markDirty();
        return true;
      },
      close() {
        if (!state.panel) return false;
        state.panel.close?.();
        state.panel = null;
        screen.markDirty();
        return true;
      },
      /** Re-opens the last while-you-were-away card from the menu. */
      openReport() {
        const summary = state.lastSummary ?? pullSummary();
        if (!summary) { toasts.push('No away report yet — close the tab and come back', 'info'); screen.markDirty(); return false; }
        return app.open('offline', { summary });
      },
      /** Where the clock and the button strip landed this frame, so a panel can dodge them. */
      clockBox: () => state.clockBox,
      stripBox: () => state.stripBox,
      toggleDebug() {
        state.debug = !state.debug;
        config.set({ debug: state.debug });
        screen.markDirty();
      },
      toast: (text, kind) => bus.emit('ui:toast', { text, kind }),
    };

    const PANELS = {
      menu: makeMenu(app),
      offline: makeOfflineCard(app),
      shop: makeShop(app),
      boxes: makeBoxes(app),
      dex: makeDex(app),
      party: makeParty(app),
      dialogue: makeDialogue(app),
    };

    const input = makeInput({ ctx, app });

    /** The payload `offline` publishes, if it has one and it has not been dismissed. */
    function pullSummary() {
      const offline = ctx.get('offline');
      if (!isLive(offline) || typeof offline.summary !== 'function') return null;
      const s = offline.summary();
      return s && s.ok !== false && (s.reason === 'ok' || Object.keys(s.applied ?? {}).length) ? s : null;
    }

    // ----------------------------------------------------------------- events
    const off = [
      bus.on('ui:toast', ({ text, kind }) => { toasts.push(text, kind); screen.markDirty(); }),
      bus.on('economy:changed', () => screen.markDirty()),
      bus.on('collection:added', () => screen.markDirty()),
      bus.on('party:leadChanged', () => screen.markDirty()),
      bus.on('tod:changed', ({ phase }) => { hud.onPhase(phase); screen.markDirty(); }),
      // The event, never `summary() != null`: in showcase mode `offline` builds a summary
      // and deliberately does not emit (DECISIONS #15), and a card driven by the getter
      // would then cover every other module's showcase.
      bus.on('offline:applied', () => {
        const summary = pullSummary();
        if (!summary) return;
        state.lastSummary = summary;
        if (!minimal) app.open('offline', { summary });
      }),
    ];

    const onResize = () => { if (screen.resize()) screen.markDirty(); };
    addEventListener('resize', onResize);
    const offConfig = config.onChange(() => { onResize(); screen.markDirty(); });

    // ------------------------------------------------------------------ paint
    const KEY_HINT = '↑←↓→ or WASD  walk    SHIFT  run    X  menu';
    const KEY_HINT_SHORT = 'WASD walk · SHIFT run · X menu';

    function drawStrip(g) {
      const items = [
        { id: 'party', label: 'PARTY', key: 'P' },
        { id: 'shop', label: 'SHOP', key: 'B' },
        { id: 'boxes', label: 'BOX', key: 'C' },
        { id: 'dex', label: 'DEX', key: '4' },
        { id: 'menu', label: 'MENU', key: 'X' },
      ];
      const h = 13;
      // The chip is sized around *both* the label and its key, so the key sits inside the
      // plate. Round 1 drew it at `x + bw - 3, y + 8` on a chip cut to the label alone, and
      // every one of the five keys hung off the bottom-right corner into the scene.
      const widths = items.map((it) => g.measure(it.label) + g.measure(it.key) + 14);
      const w = widths.reduce((a, b) => a + b, 0) + (items.length - 1) * 2;
      let x = g.width - 4 - w;
      const y = g.height - h - 4;
      items.forEach((it, i) => {
        const bw = widths[i];
        const box = { x, y, w: bw, h };
        const on = app.panelId() === it.id || screen.painter.hovered() === `strip-${it.id}`;
        panel(g, box, { paper: on ? C.martBase : C.wallLight, drop: false });
        g.text(x + 5, y + 3, it.label, on ? C.white : C.ink);
        g.textRight(x + bw - 4, y + 3, it.key, on ? C.glassLight : C.stoneShadow);
        g.hit(box, () => (app.panelId() === it.id ? app.close() : app.open(it.id)), `strip-${it.id}`);
        x += bw + 2;
      });
      return { x: g.width - 4 - w, y, w, h };
    }

    function drawDebug(g) {
      const m = window.__HOOKS__?.metrics?.();
      if (!m) return;
      const down = (m.modules ?? []).filter((s) => s.status === 'failed' || s.status === 'blocked');
      const lines = [
        `${m.fps?.mean ?? 0} fps   p95 ${m.fps?.p95ms ?? 0}ms`,
        `draws ${m.drawCalls}   tris ${Math.round((m.triangles ?? 0) / 1000)}k`,
        `${(m.internal ?? []).join('x')} -> ${(m.output ?? []).join('x')}`,
        `tod ${(m.tod ?? 0).toFixed(2)}   seed ${m.seed}`,
        down.length ? `down: ${down.map((d) => d.id).join(' ')}` : `${(m.modules ?? []).length} modules ok`,
        (m.consoleErrors ?? []).length ? `${m.consoleErrors.length} console errors` : 'no console errors',
      ];
      const w = Math.max(...lines.map((l) => g.measure(l))) + 10;
      const box = { x: g.width - w - 4, y: 32, w, h: lines.length * 9 + 6 };
      panel(g, box, { paper: C.wallLight });
      lines.forEach((l, i) => {
        const bad = (i === 4 && down.length) || (i === 5 && (m.consoleErrors ?? []).length);
        g.text(box.x + 4, box.y + 4 + i * 9, l, bad ? C.roofShadow : C.shadowInk);
      });
    }

    function draw(g) {
      const s = state.hud;
      // Before anything is painted: the whole palette is re-lit for the current time of day
      // (theme.js `applyLight`), so the wallet, the panels and the toasts share the world's
      // light instead of sitting on top of it at one fixed brightness.
      if (applyLight(s.tod)) screen.clearTints();
      // A full-frame panel replaces the HUD rather than sitting on top of it: the wallet is
      // repeated inside the shop, and a party bar half-hidden behind a window is clutter.
      const full = !!state.panel?.full;
      // A message box keeps the wallet and the clock but stands the bottom bars down: it
      // occupies the same strip of screen they do, and in the mainline a message is the
      // only thing on that strip.
      const bars = !full && !state.panel?.hidesHud;
      state.clockBox = null;
      state.stripBox = null;
      if (!full) {
        hud.drawWallet(g, s);
        state.clockBox = hud.drawClock(g, s);
      }
      if (!minimal && bars) {
        // The touch pad owns the bottom-left corner when it is up, so the party bar sits
        // above it rather than under it.
        const partyBox = hud.drawParty(g, s, { bottom: input.touch() ? g.height - 76 : g.height - 4 });
        const stripBox = drawStrip(g);
        state.stripBox = stripBox;
        drawStrip.lastX = stripBox.x;
        if (!input.hasMoved() && !state.panel) {
          // Three steps, not two. The strip is right-aligned and the hint is centred, so on
          // a narrow buffer the two meet — and round 1 had exactly one fallback string, so at
          // 426 px (1280x720) the short hint still overprinted the PARTY chip. This is the
          // very first screen a new player sees, so the third step is to move the hint up a
          // row rather than to let it collide or to suppress it.
          const strip = drawStrip.lastX ?? g.width;
          const party = partyBox;
          // Everything that already owns the bottom strip: the button chips, the party bar,
          // and the toast stack — which is the one round 1 missed even after it was told to
          // measure. At 426 internal px the short hint still ran into a toast.
          const toastLeft = toasts.count() ? g.width - 6 - 168 : g.width;
          const busyRight = Math.min(strip, toastLeft);
          let text = KEY_HINT;
          let w = g.measure(text);
          if (Math.round(g.width / 2 + w / 2) + 8 > busyRight) { text = KEY_HINT_SHORT; w = g.measure(text); }
          const centred = Math.round(g.width / 2 - w / 2);
          const partyRight = party ? party.x + party.w + 8 : 4;
          // Four steps, and the last one always works. Centred if it fits between the party
          // bar and whatever owns the right of the strip; otherwise pushed left against the
          // party bar, still on the strip where a control hint belongs; otherwise moved to
          // the top of the screen under the wallet. It may not overprint and it may not
          // vanish: it is the first thing a new player ever sees.
          let hx = centred;
          let hy = g.height - 13;
          if (centred + w + 8 > busyRight || centred - 5 < partyRight) {
            if (partyRight + w + 8 <= busyRight) hx = partyRight;
            else { hy = 21; hx = Math.max(4, Math.min(centred, g.width - w - 6)); }
          }
          g.fill(hx - 5, hy - 2, w + 10, 11, 'rgba(12,10,16,0.62)');
          g.text(hx, hy, text, C.wallHi);
        }
        input.drawPad(g);
      }
      if (state.panel) state.panel.draw(g, app);
      // The away card is the one moment the wallet is the *subject*: it is telling the player
      // what they earned. Round 1 dimmed the wallet under the card's own scrim at exactly
      // that moment, so it is repainted on top of it here.
      if (state.panel?.id === 'offline') hud.drawWallet(g, s);
      // A menu opens over the bottom-right corner the toasts stack in; they step aside.
      const toastRight = state.panel?.id === 'menu' ? g.width - 150 : g.width - 6;
      toasts.draw(g, { bottom: g.height - (minimal ? 6 : 22), right: toastRight });
      if (state.debug) drawDebug(g);
    }

    // ------------------------------------------------------------------ frame
    let acc = 0;
    function frame(dt) {
      if (screen.resize()) screen.markDirty();
      input.frame();
      if (toasts.step(dt)) screen.markDirty();
      acc += dt;
      if (acc >= 0.2) {
        acc = 0;
        const next = hud.read();
        const prev = state.hud;
        // The party is compared on everything the bar draws, not on the lead's name: a
        // level-up or a second Pokemon of the same species would otherwise leave the HUD
        // stale until something unrelated dirtied it.
        const party = (p) => JSON.stringify(p.party.map((m) => [m.name, m.level, m.shiny]));
        if (next.tod !== prev.tod
          || JSON.stringify(next.wallet) !== JSON.stringify(prev.wallet)
          || party(next) !== party(prev)
          || state.debug) {
          state.hud = next;
          screen.markDirty();
        }
      }
      if (screen.dirty) screen.paint(draw);
    }

    live = {
      /** §4: anything may toast; this is the shorthand `offline` and `idle` already call. */
      toast: (text, kind = 'info') => { bus.emit('ui:toast', { text, kind }); return true; },
      open: (id, opts) => app.open(id, opts),
      /**
       * The message box. `text` is a string or an array of pages; the player advances it.
       * This is the seam §5.12 asks for — nothing publishes NPC lines yet, so it is offered
       * rather than consumed.
       */
      say(text, opts = {}) { return app.open('dialogue', { ...opts, text }); },
      close: () => app.close(),
      isOpen: () => !!state.panel,
      openPanel: () => state.panel?.id ?? null,
      /** The away card, on demand — the menu's REPORT entry and the showcase both use it. */
      showReport: () => app.openReport(),
      /** What the HUD is currently reading, for a probe or a test. */
      snapshot: () => ({ ...state.hud, panel: state.panel?.id ?? null, toasts: toasts.count() }),
      /** Screen geometry, so a caller can reason about the UI grid. */
      metrics: () => ({ width: screen.width, height: screen.height, drawCalls: 0 }),
      input,
      _screen: screen,
      _toasts: toasts,
      _frame: frame,
      _draw: draw,
      _state: state,
      _minimal: minimal,
      dispose() {
        for (const o of off) o();
        offConfig?.();
        removeEventListener('resize', onResize);
        input.dispose();
        screen.dispose();
        live = null;
      },
    };
    return live;
  },

  frame(dt) { live?._frame(dt); },

  dispose() { live?.dispose?.(); },

  async showcase(mode, ctx) {
    const { showcaseUi } = await import('./showcase.js');
    return showcaseUi(mode, ctx);
  },
};
