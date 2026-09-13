/**
 * ui — the HUD, the Códice DOM screens and the input seam (src/ui/index.js).
 *
 * **One surface now, not two.** Every screen, every HUD widget and — since this pass —
 * everything that used to be projected against the world every rendered frame with no depth
 * divide (`plates.js`'s nameplates, `callout.js`'s battle balloons, `floaters.js`'s damage
 * numbers, the debug overlay, the walk hint) lives in `#ui-dom` (`dom/layer.js`): the always-on
 * chrome and the screens at the real viewport, and the world-anchored trio in `dom/world.js`'s
 * own sub-layer, positioned every frame with `projectClient()` below (real, viewport CSS
 * pixels through `view.displayRect` — not `screen.js`'s internal, letterboxed buffer). Both
 * still cost **zero draw calls** — a DOM layer is composited by the browser and never reaches
 * `renderer.info.render.calls`, which is the number tools/shots/shoot.js budgets.
 *
 * `screen.js`'s bitmap-font canvas (`#ui-world`) is kept mounted, but nothing in the normal
 * game paints on it any more — only the font specimen showcase
 * (`?showcase=ui&mode=font`, `ui/showcase.js`) still does, straight through `screen.painter`,
 * which is why `draw()` on the currently open panel still receives it as an argument even
 * though every real screen ignores it.
 *
 * Two more decisions shape this module:
 *
 * 1. **Input goes through `simulation.moveIntent` and nowhere else** (`input.js`), so the
 *    walk stays tile-locked and deterministic.
 * 2. **It gets out of the way in someone else's showcase.** `src/main.js` boots `ui` for
 *    every `?showcase=…`, so anything this module draws unprompted lands in another
 *    builder's critic shots. Outside its own showcase and the game itself it draws the
 *    wallet, the clock and toasts — what the seed drew — and nothing else.
 */

import { makeScreen } from './screen.js';
import { makeHud } from './hud.js';
import { makeCallouts } from './callout.js';
import { makeFloaters, CRIT_FLOATER_SCALE, FLOATER_STEPS, STATUS_NAME } from './floaters.js';
import { makePlates, POKEMON_LIFT, TRAINER_LIFT } from './plates.js';
import { makeInput, PANEL_IDS } from './input.js';
import { reportSelfTest } from '../core/log.js';
import { makeMenuDomScreen } from './screens/menu.js';
import { makeTravelDomScreen } from './screens/travel.js';
import { makeOfflineDomScreen } from './screens/offline.js';
import { makeSettingsDomScreen } from './screens/settings.js';
import * as watchlist from './watchlist.js';
import { makeDomLayer } from './dom/layer.js';
import { makeWorldLayer } from './dom/world.js';
import { makeCaptureTooltip } from './dom/capture.js';
import { h, setText } from './dom/el.js';
import { makeDomToasts } from './dom/toasts.js';
import { makeDomHud } from './dom/hud.js';
import { makeChat } from './dom/chat.js';
import { makeEconomyMode } from './screens/economy.js';
import { makeDomPad } from './dom/dpad.js';
import { makeShopDomScreen } from './screens/shop.js';
import { makeBoxesDomScreen } from './screens/boxes.js';
import { makeDexDomScreen } from './screens/dex.js';
import { makeAutomationDomScreen } from './screens/automation.js';
import { makePartyDomScreen } from './screens/party.js';
import { makeInventoryDomScreen } from './screens/inventory.js';
import { makeTrainerDomScreen } from './screens/trainer.js';
import { makeDialogueDomScreen } from './screens/dialogue.js';
import { makeEvolutionOverlay } from './evolution.js';

/**
 * The registry hands out a null-object Proxy for a missing or quarantined module, and it
 * answers `typeof api.anything === 'function'` with true even when the module is dead
 * (`core/registry.js`). The only safe test is the marker.
 */
const isLive = (api) => !!api && api.__missing === undefined;

/**
 * How much higher than its speaker's plate a balloon floats, in world units — clear of the
 * name/level/HP row `plates.js` draws at the same lift, plus a little air. Measured against
 * the plate's own on-screen height (about a third of a world unit at this project's fixed
 * `pixelsPerUnit`), not computed exactly: the plate's own width and whether it carries a bar
 * both vary the row's pixel height by a point or two, and this only has to clear the tallest.
 */
const BALLOON_CLEARANCE = 0.6;

let live = null;

/**
 * Save slice version (src/offline/save.js). `uiScale` is a `config` key, not a save field: it
 * is URL-overridable per session like every other `DEFAULTS` entry, and a save slice would
 * fight that.
 *  - v1: window geometry only.
 *  - v2 (Stage 4): adds `watch`, the species watch-list (`./watchlist.js`) — player state,
 *    not a tunable, so it belongs here and not in `core/config.js`'s own
 *    `localStorage['pokeidle.config']`.
 *  - v3 (Stage 9): drops `windows` — there is no canvas panel left with draggable/resizable
 *    geometry to remember (`panels/common.js`'s `serializeWindows`/`restoreWindows` are gone
 *    with the last panel that called them). `loadState` still tolerates a v1/v2 save that
 *    carries a stale `windows` object; it is simply never read again.
 */
const SAVE_VERSION = 3;

export default {
  id: 'ui',
  needs: [],
  /**
   * The showcase draws real panels over the real lobby, so it needs the lobby and its data.
   * `battle` and `encounter` are named rather than left to the closure: `mode=battle` stages a
   * real fight from a real roll, and `encounter.needs` does not list `battle` (a quarantined
   * engine costs the game its fights, not its grass).
   */
  showcaseNeeds: ['city', 'economy', 'collection', 'offline', 'idle', 'automation', 'hunts',
    'travel', 'battle', 'encounter'],

  init(ctx) {
    const { bus, config, log } = ctx;
    const root = document.getElementById('ui') ?? document.body;

    // In another module's showcase this module is a passenger: wallet, clock, toasts.
    const minimal = !!config.showcase && config.showcase !== 'ui';

    // Kept for the font specimen showcase (`?showcase=ui&mode=font`, `ui/showcase.js`) and its
    // own `_screen.imagesSettled()`/`markDirty()` — nothing in the normal game paints on it any
    // more (plates, balloons, floaters, the debug overlay and the walk hint are all `#ui-dom`
    // now; see this file's own header).
    const screen = makeScreen({ root, view: ctx.three?.view, log, config });
    // The Códice DOM layer (`dom/layer.js`) — every screen and every HUD widget lives here now;
    // see that file's header for the stacking order and why it exists at all.
    const domLayer = makeDomLayer({ root, config });
    // The world-anchor sub-layer (`dom/world.js`) — plates, balloons and floaters mount here,
    // positioned every frame off `projectClient()` below.
    const worldLayer = makeWorldLayer(domLayer);
    // The post-battle capture control (`dom/capture.js`) — its own container
    // (`worldLayer.capture`), never one of the other three: each of those is fully owned by a
    // `syncList` caller that wipes its container's whole content on an empty frame
    // (`dom/world.js`'s own header on why sharing one broke this the first time).
    const captureTooltip = makeCaptureTooltip(ctx);
    worldLayer.capture.appendChild(captureTooltip.el);
    const hud = makeHud(ctx);
    const toasts = makeDomToasts(domLayer, { frozen: !!config.showcase });
    /** The lines shouted over a fight — `battle:strike` puts them there. */
    const callouts = makeCallouts();
    const floaters = makeFloaters();
    const plates = makePlates(ctx);

    /**
     * A world point on the HUD canvas, in internal pixels.
     *
     * The UI canvas is exactly the renderer's internal buffer (`screen.js`) and the camera is
     * orthographic (src/core/render.js), so this is a straight NDC map with **no depth divide** — which is
     * what makes a balloon land on the same pixel grid as the sprite it is above rather than
     * drifting a fraction of a pixel per frame the way a perspective projection would.
     * Returns `null` for a point behind the camera, so a caller says nothing rather than
     * clamping something to an edge it does not belong to.
     */
    function project(x, y, z) {
      const three = ctx.three;
      const cam = three?.camera;
      if (!cam || typeof ctx.THREE?.Vector3 !== 'function') return null;
      const v = new ctx.THREE.Vector3(x, y, z);
      v.project(cam);
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || v.z > 1) return null;
      const [w, h] = three.view?.internalSize ?? [screen.width, screen.height];
      return { x: (v.x * 0.5 + 0.5) * w, y: (1 - (v.y * 0.5 + 0.5)) * h };
    }

    /**
     * A world point in real, viewport CSS pixels — `project()`'s own NDC math, mapped through
     * `view.displayRect` (`src/core/render.js`, already the CSS-pixel rect the scene canvas
     * itself sits at) instead of `internalSize`. This is what a `#ui-dom` child needs: that
     * layer sits at the real viewport (`inset: 0`, `dom/layer.js`) rather than on `#ui-world`'s
     * letterboxed, internal-resolution buffer, so a plate/balloon/floater built as a DOM node
     * (`dom/world.js`) positions itself with this, not with `project()`. Same contract:
     * `null` behind the camera or before the view has a size.
     */
    function projectClient(x, y, z) {
      const three = ctx.three;
      const cam = three?.camera;
      const rect = three?.view?.displayRect;
      if (!cam || !rect || !rect.w || typeof ctx.THREE?.Vector3 !== 'function') return null;
      const v = new ctx.THREE.Vector3(x, y, z);
      v.project(cam);
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || v.z > 1) return null;
      return { x: rect.left + (v.x * 0.5 + 0.5) * rect.w, y: rect.top + (1 - (v.y * 0.5 + 0.5)) * rect.h };
    }

    const state = {
      /** @type {object|null} */ panel: null,
      /** @type {object|null} */ lastSummary: null,
      debug: !!config.debug,
      hud: hud.read(),
      /** This frame's nameplates, gathered once in `lateFrame` and synced into the DOM. */
      plates: [],
      /** Economy mode (`screens/economy.js`, Stage 7) — a root mode, not a panel; see
       *  `app.setEconomyMode`. */
      economyMode: false,
    };

    const app = {
      ctx,
      markDirty: () => screen.markDirty(),
      hud,
      panelOpen: () => !!state.panel,
      panelId: () => state.panel?.id ?? null,
      panelKey: (ev) => (state.panel?.key ? !!state.panel.key(ev) : false),
      /** `Z`/`Space` throws at a beaten wild while the capture tooltip is up — `ui/input.js`
       *  checks this before anything else consumes the key, mirroring `panelKey` but for a
       *  control that is not a panel (`dom/capture.js`'s own header on why). */
      captureKey: (ev) => !!captureTooltip.key(ev),
      open(id, opts) {
        const p = PANELS[id];
        if (!p) return false;
        if (state.panel && state.panel !== p) state.panel.close?.();
        state.panel = p;
        p.open?.(opts);
        // The menu column (canvas, until Stage 9) shares the toast stack's own bottom-right
        // corner — `dom/toasts.js`'s own comment on `setAside`.
        toasts.setAside(id === 'menu');
        app.syncDpad();
        app.syncBars();
        screen.markDirty();
        return true;
      },
      close() {
        if (!state.panel) return false;
        state.panel.close?.();
        state.panel = null;
        toasts.setAside(false);
        app.syncDpad();
        app.syncBars();
        screen.markDirty();
        return true;
      },
      /**
       * The DOM d-pad's (`dom/dpad.js`, Stage 8) own visibility condition —
       * `!minimal && !state.economyMode && !state.panel` (a `bars`-style check simplifies to
       * exactly this: `!state.panel` alone already implies `bars` is true, since `hidesHud`
       * can only ever be a property of a panel that IS open). Called synchronously from every
       * place one of those three changes, not only from `draw()` — the pad is a real DOM
       * element, not a canvas region `screen.paint()` redraws every frame regardless, so
       * nothing else keeps it in sync on its own.
       */
      syncDpad() { dpad.setContext(!minimal && !state.economyMode && !state.panel); },
      /**
       * `bars` — `!state.panel?.hidesHud` — drives the DOM HUD chrome (`domHud`/`chat`) and,
       * in `draw()` below, the canvas plates/hint/scroll clamps. Called synchronously here for
       * the same reason `syncDpad` is: `dialogue` (Stage 9's DOM message box) is the one panel
       * that still sets `hidesHud`, and without this the dock/wallet/party bar would only
       * catch up on the next canvas repaint rather than the instant the message box opens.
       * `draw()` still recomputes it every frame too — redundant while `state.panel` only ever
       * changes through `open()`/`close()`, and cheap insurance if that ever stops being true.
       */
      syncBars() {
        const bars = !state.panel?.hidesHud;
        domHud.setBarsVisible(bars);
        chat.setBarsVisible(bars);
      },
      /** Re-opens the last while-you-were-away card from the menu. */
      openReport() {
        const summary = state.lastSummary ?? pullSummary();
        if (!summary) { toasts.push('No away report yet — close the tab and come back', 'info'); return false; }
        return app.open('offline', { summary });
      },
      toggleDebug() {
        state.debug = !state.debug;
        config.set({ debug: state.debug });
        screen.markDirty();
      },
      toast: (text, kind) => bus.emit('ui:toast', { text, kind }),
      /** `Enter`, from `input.js`'s global handler — `chat` is declared just below, but this
       *  closure only ever runs on a later real keypress, by which time it exists (the same
       *  lazy-reference pattern `open()`'s own `PANELS` lookup already relies on). */
      toggleChat: () => chat.toggle(),
      /**
       * Economy mode (`screens/economy.js`, Stage 7) — a root mode, not a panel opened into
       * `state.panel`'s single slot: the render-suppression seam (`core/render.js`'s
       * `setPaused`) and the board's own mount/unmount both live here so a save-slice, a
       * showcase or a test can flip it from one place. `economyMode` is declared below, the
       * same lazy-reference pattern `toggleChat`/`chat` already use.
       */
      setEconomyMode(on) {
        on = !!on;
        if (on === state.economyMode) return;
        state.economyMode = on;
        ctx.three?.view?.setPaused?.(on);
        economyMode.setActive(on);
        app.syncDpad();
        screen.markDirty();
      },
      economyModeActive: () => state.economyMode,
      /** The real screen Y just below the HUD's trainer/party/wallet chrome
       *  (`dom/hud.js`'s own `topBottom()`, already real DOM pixels — no `toBufferY`
       *  conversion needed since every screen lives in the same real-pixel `#ui-dom` layer)
       *  — `null` while that chrome is hidden. Any screen anchored to the top clears its own
       *  content of this (`screens/economy.js`, `screens/menu.js`, `screens/battle.js`). */
      hudTopBottom: () => domHud.topBottom(),
    };

    // The always-on HUD chrome (Stage 3a) — mounted once, updated off the same `state.hud`
    // poll `frame()` already drives (below), never rebuilt per open/close the way a panel is.
    const domHud = makeDomHud(domLayer, app);
    domHud.update(state.hud, { minimal });
    // The chat mockup (Stage 3c) — see dom/chat.js's own header for what is real in it and
    // what is placeholder for a backend that does not exist yet.
    const chat = makeChat(domLayer, app, { minimal });
    // Economy mode's own board (Stage 7) — mounted/unmounted through `app.setEconomyMode`
    // above, never through `PANELS`/`state.panel`.
    const economyMode = makeEconomyMode(app, domLayer);

    const PANELS = {
      menu: makeMenuDomScreen(app, domLayer),
      travel: makeTravelDomScreen(app, domLayer),
      offline: makeOfflineDomScreen(app, domLayer),
      settings: makeSettingsDomScreen(app, domLayer),
      shop: makeShopDomScreen(app, domLayer),
      boxes: makeBoxesDomScreen(app, domLayer),
      dex: makeDexDomScreen(app, domLayer),
      automation: makeAutomationDomScreen(app, domLayer),
      party: makePartyDomScreen(app, domLayer),
      inventory: makeInventoryDomScreen(app, domLayer),
      trainer: makeTrainerDomScreen(app, domLayer),
      dialogue: makeDialogueDomScreen(app, domLayer),
    };

    /**
     * The evolution cutscene.
     *
     * Not a panel: it takes no input, dismisses itself, and has to sit over whatever is
     * already open — the button that starts it is IN the party panel, and the previous
     * attempt at this animated the overworld sprite behind that panel where nobody could see
     * it.
     */
    const evolution = makeEvolutionOverlay(app);

    const input = makeInput({ ctx, app });
    // The touch d-pad (Stage 8) — a real DOM control now, not drawn on the canvas; see
    // `dom/dpad.js`'s own header for why it reads `input.press`/`release` directly.
    const dpad = makeDomPad(domLayer, input);
    app.syncDpad();
    app.syncBars();

    /** The payload `offline` publishes, if it has one and it has not been dismissed. */
    function pullSummary() {
      const offline = ctx.get('offline');
      if (!isLive(offline) || typeof offline.summary !== 'function') return null;
      const s = offline.summary();
      return s && s.ok !== false && (s.reason === 'ok' || Object.keys(s.applied ?? {}).length) ? s : null;
    }

    // ----------------------------------------------------------------- events
    const off = [
      bus.on('ui:toast', ({ text, kind }) => toasts.push(text, kind)),
      /** The species watch-list (`./watchlist.js`, Stage 4's Settings screen) — the one real
       *  feature behind that screen's "Alerts" section, wired here rather than in
       *  `dom/feed.js` since it fires on *appearance*, not on the encounter's resolution. */
      bus.on('encounter:started', ({ species }) => {
        if (!watchlist.has(species)) return;
        const pk = ctx.get('pokemon');
        const display = isLive(pk) && typeof pk.species === 'function'
          ? (pk.species(species)?.display ?? species) : species;
        toasts.push(`${display} appeared!`, 'good');
      }),
      /**
       * **The trainer calls the move out, and the wild answers.**
       *
       * One balloon per side, replaced rather than stacked. The ally's line hangs over the
       * **trainer** and not over the Pokemon, which is what the brief asks for in as many words
       * — and it is also what makes the picture work: in a hunt the Pokemon leads and the
       * trainer follows two cells behind, so a balloon over the Pokemon lands across the
       * trainer's face and a balloon over the trainer has clear sky above it. The wild's goes
       * over the cell `encounter` staged it on, lifted by the exact head height its own plate
       * already measured (`encounter.scene().headLift`) rather than a second guess at the same
       * sprite.
       *
       * The move's name is coloured by its type (`s2.type`) — never the
       * balloon itself, which stays the same paper every other panel here uses; a bright type
       * painted over the whole box would be unreadable for exactly the types `battle/types.js`'s
       * `TYPE_INK` had to darken to make legible as text in the first place.
       */
      bus.on('battle:strike', (s2) => {
        if (minimal || config.showcase) return;
        // A swap has no `name`/`struggle` of its own (`strike.js`'s `OPENERS.swap` sets
        // neither) but does carry `cause: 'swap'` and the switched-in Pokemon's own species on
        // `attackerSpecies` — the one event this guard used to drop on the floor, so the swap
        // that fixed the sprite/moves desync (`encounter/index.js`'s `nextAlly`) was invisible
        // on screen too.
        const isSwap = s2?.cause === 'swap';
        if (!s2?.name && !s2?.struggle && !isSwap) return;
        const enc = ctx.get('encounter');
        const sim = ctx.get('simulation');
        const bt = ctx.get('battle');

        // Where the two live: the trainer speaks (the brief's own words — the balloon belongs
        // to whoever "calls the move out"), but a *hit* lands on the creature, not on the
        // trainer standing behind it — so a floater and a balloon read a side differently.
        const wildAt = isLive(enc) ? enc.scene?.()?.at : null;
        const speakerAt = s2.attacker === 'b' ? wildAt : (isLive(sim) ? sim.player?.() : null);
        const targetAt = s2.target === 'b' ? wildAt : (isLive(sim) ? sim.follower?.() : null);
        const groundY = (at) => at?.y ?? (isLive(sim) ? sim.surfaceAt?.(at?.cx, at?.cz) ?? 0 : 0);

        if (speakerAt) {
          const wild = s2.attacker === 'b';
          const lift = (wild ? enc.scene?.()?.headLift : null) ?? (wild ? POKEMON_LIFT : TRAINER_LIFT);
          const ink = !s2.struggle && isLive(bt) && typeof bt.typeColour === 'function'
            ? bt.typeColour(s2.type)?.ink ?? null : null;
          // The player's own Pokemon "use"s a move; the wild "use"s it too, but takes the "s" —
          // the brief's own two verbs. A swap never happens on the wild's side (nothing here
          // voluntarily switches out a wild), so it is always the player's own send-out line.
          callouts.say(isSwap
            ? { name: `${s2.attackerSpecies}, I choose you!`, side: s2.attacker ?? 'a',
              x: speakerAt.cx + 0.5, z: speakerAt.cz + 0.5, y: groundY(speakerAt) + lift + BALLOON_CLEARANCE }
            : {
              name: s2.attackerSpecies, verb: wild ? 'uses' : 'use', move: s2.struggle ? 'Struggle' : s2.name, ink,
              side: s2.attacker ?? 'a',
              x: speakerAt.cx + 0.5, z: speakerAt.cz + 0.5,
              y: groundY(speakerAt) + lift + BALLOON_CLEARANCE,
            });
        }
        if (isSwap) return;

        if (targetAt) {
          // Both possible targets are Pokémon (the wild, or the ally the trainer sends out) —
          // never the trainer itself, so this is always `POKEMON_LIFT`, precisely
          // `scene.headLift` when the target is the wild being fought. Cleared above the
          // plate by the same margin the balloon uses — the first cut spawned a floater right
          // on the plate's own lift and it printed straight across the HP bar.
          const lift = ((s2.target === 'b' ? enc.scene?.()?.headLift : null) ?? POKEMON_LIFT) + BALLOON_CLEARANCE;
          const at3 = { x: targetAt.cx + 0.5, y: groundY(targetAt) + lift, z: targetAt.cz + 0.5 };
          if (s2.damage > 0) {
            floaters.push({
              text: `-${s2.damage}`, ...at3, scale: s2.crit ? CRIT_FLOATER_SCALE : 1,
              tone: s2.crit ? 'crit' : null,
            });
            // A second, shorter-lived floater just for the effectiveness callout
            // ("Super Effective!"/"Not very effective…") — kept separate from the damage
            // number itself so the number stays the thing a player reads first and fastest.
            if (s2.effectiveness > 1) {
              floaters.push({
                text: 'Super Effective!', x: at3.x, y: at3.y + 0.35, z: at3.z,
                tone: 'super effectiveness', life: Math.round(FLOATER_STEPS * 0.75),
              });
            } else if (s2.effectiveness > 0 && s2.effectiveness < 1) {
              floaters.push({
                text: 'Not very effective…', x: at3.x, y: at3.y + 0.35, z: at3.z,
                tone: 'weak effectiveness', life: Math.round(FLOATER_STEPS * 0.75),
              });
            }
          } else if (s2.miss) {
            floaters.push({ text: 'MISS', ...at3, tone: 'miss' });
          } else if (s2.immune) {
            floaters.push({ text: 'IMMUNE', ...at3, tone: 'miss' });
          } else if (s2.status) {
            floaters.push({ text: STATUS_NAME[s2.status] ?? s2.status.toUpperCase(), ...at3, tone: 'status' });
          }
        }
      }),
      bus.on('encounter:resolved', () => { callouts.clear(); floaters.clear(); screen.markDirty(); }),
      bus.on('economy:changed', () => screen.markDirty()),
      bus.on('collection:added', () => screen.markDirty()),
      bus.on('party:leadChanged', () => screen.markDirty()),
      /**
       * The cutscene. Never in a showcase: it is five seconds long and the harness spins
       * ninety frames between `__READY__` and the shutter, so a running one would give a
       * different capture every time (tools/shots/shoot.js). `?showcase=ui&mode=evolution` freezes it instead.
       */
      bus.on('pokemon:evolved', ({ from, to, shiny }) => {
        if (config.showcase) return;
        const pk = ctx.get('pokemon');
        if (!isLive(pk) || typeof pk.species !== 'function') return;
        const a = pk.species(from);
        const b = pk.species(to);
        if (a && b) evolution.play({ from: a, to: b, shiny: !!shiny });
        screen.markDirty();
      }),
      bus.on('tod:changed', ({ phase }) => { hud.onPhase(phase); screen.markDirty(); }),
      // The event, never `summary() != null`: in showcase mode `offline` builds a summary
      // and deliberately does not emit, and a card driven by the getter
      // would then cover every other module's showcase.
      bus.on('offline:applied', () => {
        const summary = pullSummary();
        if (!summary) return;
        state.lastSummary = summary;
        if (!minimal) app.open('offline', { summary });
      }),
    ];

    const onResize = () => { screen.resize(); };
    addEventListener('resize', onResize);
    const offConfig = config.onChange(onResize);

    // ------------------------------------------------------------------ HUD chrome that is
    // screen-anchored rather than world-anchored: no `projectClient`, just ordinary fixed-
    // position `#ui-dom` children. Both used to be canvas text (`screen.js`); moved onto the
    // design system along with the world-anchored trio below.

    // Two pairs, because the controls are not the same in both kinds of scene: a walkable
    // map is driven, a hunt is watched. `input.canWalk()` picks the pair.
    const HINTS = {
      walk: '↑←↓→ or WASD  walk    T  travel    X  menu',
      auto: 'Your Pokémon hunts on its own    T  travel    X  menu',
    };
    const hintEl = h('div', { class: 'ci-walk-hint', 'data-ui': 'walk-hint', hidden: true });
    domLayer.host.appendChild(hintEl);

    function updateHint(bars) {
      const show = !minimal && bars && !state.economyMode && !state.panel && !input.hasMoved();
      hintEl.hidden = !show;
      if (show) setText(hintEl, HINTS[input.canWalk() ? 'walk' : 'auto']);
    }

    const debugLines = Array.from({ length: 7 }, () => h('div', { class: 'ci-debug-line' }));
    const debugEl = h('div', { class: 'ci-debug-overlay', 'data-ui': 'debug-overlay', hidden: true }, debugLines);
    domLayer.host.appendChild(debugEl);

    function updateDebug() {
      debugEl.hidden = !state.debug;
      if (!state.debug) return;
      const m = window.__HOOKS__?.metrics?.();
      if (!m) return;
      const down = (m.modules ?? []).filter((s) => s.status === 'failed' || s.status === 'blocked');
      // **Who is stepping the hunt**, shown rather than asserted. `encounter` and `idle` were
      // both running the loop at once and nothing said so; a line in the overlay is a claim the
      // harness photographs on every `?debug=1` capture.
      const idle = ctx.get('idle');
      const driver = isLive(idle) && typeof idle.driver === 'function' ? idle.driver() : null;
      const enc = ctx.get('encounter');
      const fight = isLive(enc) && typeof enc.scene === 'function' ? enc.scene() : null;
      const lines = [
        `${m.fps?.mean ?? 0} fps   p95 ${m.fps?.p95ms ?? 0}ms`,
        `draws ${m.drawCalls}   tris ${Math.round((m.triangles ?? 0) / 1000)}k`,
        `${(m.internal ?? []).join('x')} -> ${(m.output ?? []).join('x')}`,
        `tod ${(m.tod ?? 0).toFixed(2)}   seed ${m.seed}`,
        `driver ${driver ?? '-'}${fight?.fighting ? `   fighting t${fight.turns}` : ''}`,
        down.length ? `down: ${down.map((d) => d.id).join(' ')}` : `${(m.modules ?? []).length} modules ok`,
        (m.consoleErrors ?? []).length ? `${m.consoleErrors.length} console errors` : 'no console errors',
      ];
      lines.forEach((l, i) => {
        const bad = (i === 5 && down.length) || (i === 6 && (m.consoleErrors ?? []).length);
        setText(debugLines[i], l);
        debugLines[i].classList.toggle('ci-debug-line--bad', !!bad);
      });
    }

    /**
     * Syncs the world-anchored trio — plates, balloons, floaters — into `worldLayer`'s three
     * containers, and the screen-anchored debug overlay/walk hint alongside them. Runs every
     * `lateFrame` (after the camera rig updates, same reason `plates.read()` already waited for
     * it), unconditionally rather than gated behind a canvas-style dirty flag: a DOM sync of a
     * handful of nodes is not the render-budget cost a canvas repaint was, and `syncList`
     * (`dom/el.js`) already no-ops on anything that has not actually changed.
     */
    function drawWorld() {
      const bars = !state.panel?.hidesHud;
      domHud.setBarsVisible(bars);
      chat.setBarsVisible(bars);
      updateHint(bars);
      // Every real screen's `draw()` takes no arguments and uses it as a "the world just moved
      // on" refresh hook (`screens/trainer.js`) — `screen.painter` is still passed through for
      // the one exception, the font specimen (`ui/showcase.js`'s `installSpecimen`), which
      // bypasses the normal panel registry to paint straight on the canvas `screen.js` still
      // owns; every other `draw()` ignores the extra argument harmlessly.
      state.panel?.draw(screen.painter, app);
      // Suppressed entirely under a `hidesHud` panel, exactly like `bars` above — but `bars`
      // alone is not the right test here: every other panel is an opaque DOM card stacked
      // above the world layer already (`dom/world.js`'s own comment on why it mounts first),
      // and a plate under one would float over a dimmed background like a lit sign in a
      // blackout. `menu` is the only one that draws no scrim at all (a column that says
      // outright "the city stays readable behind it"), so it is the only one a plate may
      // still show around. A hunt fight itself opens no panel any more — the battle card is
      // gone (balloons/floaters/the capture tooltip are the whole on-screen account now) — so
      // plates stay up through a fight exactly the way they do through ordinary walking.
      const platesShow = !minimal && bars && !state.economyMode
        && (!state.panel || state.panel.id === 'menu');
      plates.draw(worldLayer.plates, projectClient, platesShow ? state.plates : []);
      callouts.draw(worldLayer.balloons, projectClient);
      floaters.draw(worldLayer.floaters, projectClient);
      // Only when nothing else is open — a panel or economy mode covers the world anyway,
      // and the throw window's own timing (`encounter/index.js`'s `leaveSteps()`) does not
      // care whether this happened to be visible for all of it.
      captureTooltip.update(!minimal && bars && !state.economyMode && !state.panel ? projectClient : null);
      updateDebug();
    }

    // ------------------------------------------------------------------ frame
    let acc = 0;
    function frame(dt) {
      screen.resize();
      input.frame();
      // Ages and expires the DOM stack directly (`dom/toasts.js`).
      toasts.step(dt);
      // Ages the encounter feed card the same way (`dom/hud.js`'s own `step`, Stage 3b).
      domHud.step(dt);

      acc += dt;
      if (acc >= 0.2) {
        acc = 0;
        // The wallet and the per-hour figures on the economy board, ticked at the same 0.2s
        // cadence as every other HUD poll here — a no-op while the board is not mounted.
        economyMode.step();
        // `domHud.update()` runs unconditionally, not diffed against the previous read — it is
        // cheap DOM writes (`dom/el.js`'s `syncList`/`setText`, never a rebuild), and there is
        // no canvas-dirty flag left for a diff to gate any more.
        state.hud = hud.read();
        domHud.update(state.hud, { minimal });
      }
    }

    /**
     * The world-anchor DOM sync, moved out of `frame` and run after the camera rig updates
     * (`core/registry.js`'s `lateFrame`, `src/main.js`'s frame loop) — the same reason
     * `pokemon/field.js` poses its sprites there rather than in `frame`: a plate positioned
     * against last frame's camera trails a moving sprite by exactly one frame of motion, a
     * different sub-pixel offset every time, which reads as the plate swimming.
     */
    function lateFrame() {
      state.plates = minimal ? [] : plates.read();
      drawWorld();
    }

    live = {
      /** src/core/bus.js: anything may toast; this is the shorthand `offline` and `idle` already call. */
      toast: (text, kind = 'info') => { bus.emit('ui:toast', { text, kind }); return true; },

      /**
       * The checks a Node run cannot make, because this module needs a canvas to exist.
       *
       * It reports through `reportSelfTest`, which `console.error`s on failure — tools/shots/shoot.js budgets zero
       * console errors, and that is what turns a red invariant into a failed capture rather than
       * red text in a screenshot nobody reads.
       */
      selfTest() {
        const results = [];
        const chk = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
        const ids = Object.keys(PANELS);
        // `selftest.js` checks every shortcut names a panel that exists, against `PANEL_IDS`.
        // This is the other half: that `PANEL_IDS` is what this module actually ships. Without
        // it the Node check would pass against a list that had quietly stopped being true.
        chk('every shipped panel is in PANEL_IDS', ids.every((id) => PANEL_IDS.includes(id)),
          ids.filter((id) => !PANEL_IDS.includes(id)).join(' '));
        chk('…and PANEL_IDS names nothing that does not exist',
          PANEL_IDS.every((id) => ids.includes(id)),
          PANEL_IDS.filter((id) => !ids.includes(id)).join(' '));
        chk('every panel answers the shape ui drives it through',
          ids.every((id) => typeof PANELS[id].draw === 'function' && typeof PANELS[id].key === 'function'));
        reportSelfTest('ui', results);
        return { ok: results.every((r) => r.ok), results };
      },
      open: (id, opts) => app.open(id, opts),
      /**
       * The message box. `text` is a string or an array of pages; the player advances it.
       * This is the seam src/ui/index.js asks for — nothing publishes NPC lines yet, so it is offered
       * rather than consumed.
       */
      say(text, opts = {}) { return app.open('dialogue', { ...opts, text }); },
      close: () => app.close(),
      /** The cutscene, exposed so a showcase can freeze it at an exact beat. */
      evolution,
      isOpen: () => !!state.panel,
      openPanel: () => state.panel?.id ?? null,
      /** Economy mode (`screens/economy.js`, Stage 7) — a Settings toggle and a showcase both
       *  need this from outside `app`. */
      setEconomyMode: (on) => app.setEconomyMode(on),
      isEconomyMode: () => state.economyMode,
      /** The away card, on demand — the menu's REPORT entry and the showcase both use it. */
      showReport: () => app.openReport(),
      /** What the HUD is currently reading, for a probe or a test. */
      snapshot: () => ({ ...state.hud, panel: state.panel?.id ?? null, toasts: toasts.count() }),
      /** Screen geometry, so a caller can reason about the UI grid. */
      metrics: () => ({ width: screen.width, height: screen.height, drawCalls: 0 }),
      /** The species watch-list (`./watchlist.js`, Stage 4's Settings screen) — the one piece
       *  of player state this save slice still carries (v3, Stage 9: dropped `windows`, the
       *  last canvas panel's own dragged/resized geometry — there is no canvas panel left to
       *  remember it for). */
      saveState: () => ({ v: SAVE_VERSION, watch: watchlist.list() }),
      // `watchlist.restore` tolerates `undefined` — a v1 save (no `watch` field at all)
      // restores to an empty watch-list, exactly what a save with no `ui` slice at all
      // already did before this field existed. A v1/v2 save's own stale `windows` object is
      // simply never read.
      loadState(value) {
        watchlist.restore(value?.watch);
        screen.markDirty();
      },
      input,
      _screen: screen,
      _domLayer: domLayer,
      _domHud: domHud,
      /** Every `[data-ui]` element and its real geometry — `dom/layer.js`'s own comment on
       *  why a flow test needs this ("a button drawn under another panel looks identical in a
       *  screenshot to one that works" is equally true in DOM). */
      probe: () => domLayer.probe(),
      /** `document.fonts.ready`, awaited by `showcase.js` before `__READY__` the same way
       *  `_screen.imagesSettled()` already is — a self-hosted face that hasn't decoded yet
       *  must never be the difference between two captures of the same URL. */
      fontsReady: () => domLayer.fontsReady(),
      _toasts: toasts,
      _callouts: callouts,
      _floaters: floaters,
      _tick() {
        if (callouts.count() && callouts.tick(1)) screen.markDirty();
        if (floaters.count() && floaters.tick(1)) screen.markDirty();
      },
      /** A world point on the HUD canvas, in internal pixels. Exact under the ortho camera. */
      project,
      _frame: frame,
      _lateFrame: lateFrame,
      _draw: drawWorld,
      _state: state,
      _minimal: minimal,
      dispose() {
        for (const o of off) o();
        offConfig?.();
        removeEventListener('resize', onResize);
        input.dispose();
        screen.dispose();
        // Before `domLayer.dispose()`, which only removes the DOM subtree — `domHud`'s own
        // drag-reorder (`dom/dnd.js`) holds `window`-level pointer listeners that a removed
        // node does not take with it.
        domHud.dispose();
        chat.dispose();
        economyMode.dispose();
        dpad.dispose();
        domLayer.dispose();
        live = null;
      },
    };

    /**
     * Hands the save seam to `offline` directly, the same self-registration `travel` uses and
     * for the identical reason: `offline` discovers its native providers once, during its own
     * `init`, and `ui` inits after it in the real boot order (`… simulation, idle, offline,
     * travel, ui` — the derived initialization order) — so the ordinary discovery pass never sees it.
     * `order: 55`: after `travel`'s self-registered 45 and the default 50 every adapter and
     * every other native slice takes, since window geometry depends on nothing else restoring
     * first and nothing else depends on it.
     */
    const offline = ctx.get('offline');
    if (isLive(offline) && typeof offline.store?.register === 'function') {
      offline.store.register('ui', {
        capture: () => live.saveState(),
        restore: (v) => live.loadState(v),
        source: 'native',
        order: 55,
      });
      const saved = offline.store.get?.('ui');
      if (saved !== undefined) live.loadState(saved);
    }

    return live;
  },

  /**
   * A callout's life is counted in **sim steps**, so it is spent here and not in `frame`.
   *
   * Counted at render rate it would expire in wall-clock time — a fight stepped by the harness
   * would lose its balloons between two `__HOOKS__.step()` calls even though no simulated time
   * had passed, and a screenshot of turn three would be a different picture on a fast machine
   * than on a slow one. Every other beat `encounter` owns is a count of `tick()` calls for
   * exactly this reason.
   */
  tick() { live?._tick?.(); },

  frame(dt) { live?._frame(dt); },

  lateFrame() { live?._lateFrame(); },

  dispose() { live?.dispose?.(); },

  async showcase(mode, ctx) {
    const { showcaseUi } = await import('./showcase.js');
    return showcaseUi(mode, ctx);
  },
};
