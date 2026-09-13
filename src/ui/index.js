/**
 * ui — the HUD, the panels, the Códice DOM screens and the input seam (src/ui/index.js).
 *
 * **Two surfaces, mid-migration.** Most of the HUD and every panel still paint onto one 2-D
 * canvas at the renderer's own internal resolution, upscaled with NEAREST — see `screen.js`
 * for why: a crisp 12 px web panel over a 640×360 world upscaled ×3 is the one thing on screen
 * not on the pixel grid, and it reads as a debug overlay instead of as the game. That
 * argument still holds for anything projected against the world (`plates.js`, `callout.js`,
 * `floaters.js` — permanently canvas, see their own headers) and for the panels not yet
 * converted (`panels/*.js`). Everything converted so far — `screens/offline.js`, the toast
 * stack (`dom/toasts.js`) — lives instead in `#ui-dom` (`dom/layer.js`), a real-resolution DOM
 * layer mounted beside the canvas rather than instead of it; see that file's own header for
 * the stacking order and why a soft-UI redesign (Códice) does not belong on the world's pixel
 * grid the way a DS-style menu does. The canvas still costs **zero draw calls** — a 2-D
 * canvas is composited by the browser and never reaches `renderer.info.render.calls`, which is
 * the number tools/shots/shoot.js budgets — and so does the DOM layer, for the same reason.
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
import { makeFloaters, CRIT_FLOATER_SCALE } from './floaters.js';
import { makePlates, POKEMON_LIFT, TRAINER_LIFT } from './plates.js';
import { makeInput, PANEL_IDS } from './input.js';
import { reportSelfTest } from '../core/log.js';
import { makeMenu } from './panels/menu.js';
import { makeTravelDomScreen } from './screens/travel.js';
import { makeOfflineDomScreen } from './screens/offline.js';
import { makeSettingsDomScreen } from './screens/settings.js';
import * as watchlist from './watchlist.js';
import { makeDomLayer } from './dom/layer.js';
import { makeDomToasts } from './dom/toasts.js';
import { makeDomHud } from './dom/hud.js';
import { makeChat } from './dom/chat.js';
import { makeEconomyMode } from './screens/economy.js';
import { makeShopDomScreen } from './screens/shop.js';
import { makeBoxes } from './panels/boxes.js';
import { makeBattle, STATUS_NAME } from './panels/battle.js';
import { makeDex } from './panels/dex.js';
import { makeAutomationDomScreen } from './screens/automation.js';
import { makeParty } from './panels/party.js';
import { makeInventoryDomScreen } from './screens/inventory.js';
import { makeTrainerDomScreen } from './screens/trainer.js';
import { makeDialogue } from './panels/dialogue.js';
import { makeEvolutionOverlay } from './evolution.js';
import { C, panel, applyLight } from './theme.js';
import { setActiveDrag, serializeWindows, restoreWindows } from './panels/common.js';

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
 */
const SAVE_VERSION = 2;

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

    const screen = makeScreen({ root, view: ctx.three?.view, log, config });
    // The Códice DOM layer (`dom/layer.js`) — screens converted so far mount into
    // `domLayer.host`, beside the still-canvas HUD/panels; see that file's header for the
    // stacking order and why it exists at all.
    const domLayer = makeDomLayer({ root, config });
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
     * A real-viewport Y (CSS pixels, as `getBoundingClientRect()` reports) to canvas-buffer
     * Y — the inverse of `screen.js`'s own `toUi()`, and the one bridge left between the DOM
     * HUD chrome's real position (`dom/hud.js`) and the canvas windows/menu that still have
     * to dodge it (`hudReserved()`, below). `null` when there is nothing to convert (the
     * chrome is hidden) or the view is not sized yet.
     */
    function toBufferY(clientY) {
      const rect = ctx.three?.view?.displayRect;
      if (clientY == null || !rect || !rect.h) return null;
      return (clientY - rect.top) * (screen.height / rect.h);
    }

    const state = {
      /** @type {object|null} */ panel: null,
      /** @type {object|null} */ lastSummary: null,
      debug: !!config.debug,
      hud: hud.read(),
      /** Set by `draw` each frame; read by the menu so it never lands on the clock. */
      clockBox: null,
      stripBox: null,
      partyBox: null,
      /** This frame's nameplates, gathered once in `lateFrame` and painted by `draw`. */
      plates: [],
      /** Set by `draw` each frame; the only consumer today is `hudReserved()` below. */
      walletBox: null,
      /** Economy mode (`screens/economy.js`, Stage 7) — a root mode, not a panel; see
       *  `app.setEconomyMode`. */
      economyMode: false,
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
        // The menu column (canvas, until Stage 9) shares the toast stack's own bottom-right
        // corner — `dom/toasts.js`'s own comment on `setAside`.
        toasts.setAside(id === 'menu');
        screen.markDirty();
        return true;
      },
      close() {
        if (!state.panel) return false;
        state.panel.close?.();
        state.panel = null;
        toasts.setAside(false);
        screen.markDirty();
        return true;
      },
      /** Re-opens the last while-you-were-away card from the menu. */
      openReport() {
        const summary = state.lastSummary ?? pullSummary();
        if (!summary) { toasts.push('No away report yet — close the tab and come back', 'info'); return false; }
        return app.open('offline', { summary });
      },
      /**
       * Where the DOM HUD chrome's top union and the dock (`dom/hud.js`, Stage 3) land, in
       * **canvas-buffer** coordinates — `menu.js` anchors above the dock and below this
       * chrome, unchanged since before the migration, so this stays the shape it always
       * read: `{y, h}` for `clockBox`, `{y}` for `stripBox`. Synthesised in `draw()` below
       * from the real DOM measurement; `null` while that chrome is hidden (`minimal`).
       */
      clockBox: () => state.clockBox,
      stripBox: () => state.stripBox,
      /** The party bar lives in `#ui-dom` now (`dom/hud.js`), top-left, not docked above
       *  anything on this canvas — `null` forever. `panels/battle.js`'s own fallback (anchor
       *  to the bottom of the buffer when there is no party bar to sit above) is exactly the
       *  right behaviour with nothing there to avoid any more, so nothing else changes. */
      partyBox: () => state.partyBox,
      /**
       * How many pixels at the top and bottom of the buffer are already spoken for by the
       * wallet/clock (top) and the party bar/button strip (bottom) *this frame* — every
       * `windowFrame` call passes this straight through so a window can never open, default,
       * or be dragged/resized on top of them (at
       * `uiScale: 2` a `full` panel's authored size covers nearly the whole halved buffer,
       * including the bars it was supposed to leave visible).
       *
       * Measured from the boxes `draw()` already computed this frame, not from a hard-coded
       * constant — `bars` being false (`hidesHud`) reads back as `{top:0, bottom:0}`, and a
       * future, taller party bar is reserved for correctly with no change here.
       */
      hudReserved() {
        // The trainer card, party list and wallet/clock (`dom/hud.js`) are one combined
        // chrome now, not two separately-measured boxes — `state.clockBox` still carries the
        // union's bottom edge (shaped `{y, h}` so `menu.js`'s own `.y + .h` read keeps
        // working with no change there), synthesised each frame in `draw()` below from the
        // DOM chrome's real position.
        const top = state.clockBox ? state.clockBox.y + state.clockBox.h : 0;
        const bottomEdge = state.stripBox ? state.stripBox.y : Infinity;
        const bottom = Number.isFinite(bottomEdge) ? Math.max(0, screen.height - bottomEdge) : 0;
        return { top: top ? top + 2 : 0, bottom: bottom ? bottom + 2 : 0 };
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
        screen.markDirty();
      },
      economyModeActive: () => state.economyMode,
      /** The real screen Y just below the HUD's trainer/party/wallet chrome
       *  (`dom/hud.js`'s own `topBottom()`, already real DOM pixels — no `toBufferY`
       *  conversion needed since the economy board lives in the same real-pixel `#ui-dom`
       *  layer) — `null` while that chrome is hidden. `screens/economy.js` clears its own
       *  top content of this, the same reason `hudReserved()` exists for canvas panels. */
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
      menu: makeMenu(app),
      travel: makeTravelDomScreen(app, domLayer),
      offline: makeOfflineDomScreen(app, domLayer),
      settings: makeSettingsDomScreen(app, domLayer),
      shop: makeShopDomScreen(app, domLayer),
      boxes: makeBoxes(app),
      dex: makeDex(app),
      automation: makeAutomationDomScreen(app, domLayer),
      party: makeParty(app),
      inventory: makeInventoryDomScreen(app, domLayer),
      trainer: makeTrainerDomScreen(app, domLayer),
      battle: makeBattle(app),
      dialogue: makeDialogue(app),
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
        if (!s2?.name && !s2?.struggle) return;
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
          callouts.say({
            name: s2.attackerSpecies, move: s2.struggle ? 'Struggle' : s2.name, ink,
            side: s2.attacker ?? 'a',
            x: speakerAt.cx + 0.5, z: speakerAt.cz + 0.5,
            y: groundY(speakerAt) + lift + BALLOON_CLEARANCE,
          });
        }

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
              colour: s2.effectiveness > 1 ? C.roofShadow : s2.effectiveness > 0 && s2.effectiveness < 1 ? C.shadowInk : C.ink,
            });
          } else if (s2.miss) {
            floaters.push({ text: 'MISS', ...at3, colour: C.shadowInk });
          } else if (s2.immune) {
            floaters.push({ text: 'IMMUNE', ...at3, colour: C.shadowInk });
          } else if (s2.status) {
            floaters.push({ text: STATUS_NAME[s2.status] ?? s2.status.toUpperCase(), ...at3, colour: C.roofShadow });
          }
        }

        screen.markDirty();
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
      /**
       * The battle card (src/ui/index.js).
       *
       * `encounter:started` and not `battle:started`: the engine's event fires from inside
       * `fight()`, *before* `encounter` has assembled the record the card reads, so a card
       * opened on it would find nothing. By `encounter:started` the fight is resolved and its
       * transcript is on `encounter.active()`.
       *
       * Three guards, and each one is a bug that would otherwise be invisible:
       *  - `minimal || config.showcase` — this module is a passenger in every other module's
       *    showcase, and a card painted over `encounter_12` moves a frame in the regression
       *    gate that nobody asked to move (tools/shots/shoot.js).
       *  - `state.panel` — a hunt starts a battle every few seconds. One that shut the shop
       *    the player was standing in would be unusable.
       *  - `has()` — an encounter with no battle record (a quarantined `battle`) would open an
       *    empty card that still owns the panel slot and still suppresses the walk hint.
       */
      bus.on('encounter:started', () => {
        if (minimal || config.showcase || state.panel) return;
        if (!PANELS.battle.has?.()) return;
        app.open('battle');
      }),
      // `resolve()` clears `active`, so the card has nothing left to read the moment this
      // fires. Closing it is not a courtesy; it is what stops an empty panel owning the slot.
      bus.on('encounter:resolved', () => {
        if (state.panel?.id === 'battle') app.close();
        else screen.markDirty();
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

    const onResize = () => { if (screen.resize()) screen.markDirty(); };
    addEventListener('resize', onResize);
    const offConfig = config.onChange(() => { onResize(); screen.markDirty(); });

    // ------------------------------------------------------------------ paint
    // Two pairs, because the controls are not the same in both kinds of scene: a walkable
    // map is driven, a hunt is watched. `input.canWalk()` picks the pair.
    const HINTS = {
      walk: ['↑←↓→ or WASD  walk    T  travel    X  menu', 'WASD walk · T travel · X menu'],
      auto: ['Your Pokémon hunts on its own    T  travel    X  menu', 'T travel · X menu'],
    };

    function drawDebug(g) {
      const m = window.__HOOKS__?.metrics?.();
      if (!m) return;
      const down = (m.modules ?? []).filter((s) => s.status === 'failed' || s.status === 'blocked');
      // **Who is stepping the hunt**, drawn rather than asserted. `encounter` and `idle` were
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
      const w = Math.max(...lines.map((l) => g.measure(l))) + 10;
      const box = { x: g.width - w - 4, y: 32, w, h: lines.length * 9 + 6 };
      panel(g, box, { paper: C.wallLight });
      lines.forEach((l, i) => {
        const bad = (i === 5 && down.length) || (i === 6 && (m.consoleErrors ?? []).length);
        g.text(box.x + 4, box.y + 4 + i * 9, l, bad ? C.roofShadow : C.shadowInk);
      });
    }

    function draw(g) {
      const s = state.hud;
      // Before anything is painted: the whole palette is re-lit for the current time of day
      // (theme.js `applyLight`), so the wallet, the panels and the toasts share the world's
      // light instead of sitting on top of it at one fixed brightness.
      if (applyLight(s.tod)) screen.clearTints();
      // `full` used to also stand the whole HUD down while the panel was open, which is what
      // made opening any of `shop`/`boxes`/`dex`/`automation`/`party` hide the wallet, the
      // clock and the party bar along with it. It is inert data now — nothing
      // reads `panel.full` any more, kept on the descriptor only as a note of which panels
      // used to behave this way; `hudReserved()` (below) is what actually keeps a window from
      // covering the bars it no longer stands down. A message box is the one thing that still
      // stands the bottom bars down — it occupies the same strip of screen they do, and in
      // the mainline a message is the only thing on that strip.
      const bars = !state.panel?.hidesHud;
      domHud.setBarsVisible(bars);
      chat.setBarsVisible(bars);
      state.clockBox = null;
      state.stripBox = null;
      state.partyBox = null;
      state.walletBox = null;
      if (bars) {
        // The trainer card, party list, wallet, clock and dock all live in `#ui-dom` now
        // (`dom/hud.js`) — this canvas no longer paints any of them. `clockBox`/`stripBox`
        // are still synthesised, in canvas-buffer coordinates, purely so `menu.js` (still
        // canvas) keeps anchoring above the dock and below this chrome exactly as before;
        // `toBufferY` is the inverse of `screen.js`'s own `toUi()`.
        const topY = toBufferY(domHud.topBottom());
        if (topY != null) state.clockBox = { y: 0, h: topY };
        if (!minimal) {
          const dockY = toBufferY(domHud.dockTop());
          if (dockY != null) state.stripBox = { y: dockY };
        }
      }
      if (!minimal && bars && !state.economyMode) {
        if (!input.hasMoved() && !state.panel) {
          // Centred, with a short fallback for a narrow buffer (426 px at 720p) where the
          // long string would run off either edge. Simpler than it used to be: wallet, clock,
          // party and the button strip all left this canvas for `#ui-dom` (Stage 3), so
          // nothing is left down here for the hint to collide with — the elaborate
          // party-bar/strip avoidance this replaced was earning its keep against controls
          // that no longer live on this layer at all.
          const [long, short] = HINTS[input.canWalk() ? 'walk' : 'auto'];
          let text = long;
          let w = g.measure(text);
          if (w + 16 > g.width) { text = short; w = g.measure(text); }
          const hx = Math.max(4, Math.min(Math.round(g.width / 2 - w / 2), g.width - w - 4));
          const hy = g.height - 13;
          g.fill(hx - 5, hy - 2, w + 10, 11, 'rgba(12,10,16,0.62)');
          g.text(hx, hy, text, C.wallHi);
        }
        input.drawPad(g);
      }
      // The one moment `panels/common.js`'s `windowFrame` — called from deep inside whichever
      // panel draws next — can see the live gesture `screen.js` is holding, without every one
      // of its six call sites threading `screen.drag()` through `opts` by hand.
      setActiveDrag(screen.drag());
      const panelBox = state.panel ? state.panel.draw(g, app) : null;
      // The away card used to be the one moment the wallet was repainted over its own scrim
      // (round 1 dimmed it otherwise); now that `offline` is a DOM screen (`screens/
      // offline.js`) drawing nothing on this canvas at all, there is no canvas scrim left to
      // repaint the wallet over — its own opaque DOM card sits above this whole layer instead.
      // Plates first, callouts over them: a name/level/HP plate names who is standing there,
      // a speech balloon is what that creature just did — the balloon reads as the newer,
      // louder thing precisely because it is drawn on top.
      //
      // Suppressed entirely under a `full`/`hidesHud` panel, exactly like `bars` above — but
      // `bars` alone is not the right test here. `travel` and `offline` are neither `full` nor
      // `hidesHud` (the wallet stays up over them on purpose), yet both cover the *whole*
      // screen themselves — `travel` with `windowFrame`'s `g.scrim`, `offline` with its own
      // DOM scrim in `#ui-dom` (`screens/offline.js`), stacked above this canvas — a plate
      // drawn after either would float over a dimmed background like a lit sign in a
      // blackout, anywhere on screen, not only over the panel's own box. `battle` and `menu`
      // are the only two panels that draw no scrim at all
      // (a docked card and a column that says outright "the city stays readable behind it"),
      // so they are the only two a plate may still show around — clipped to the box each
      // panel's own `draw()` just handed back, the same discipline `partyBox`/`stripBox` use.
      const platesShow = !minimal && bars && !state.economyMode
        && (!state.panel || state.panel.id === 'battle' || state.panel.id === 'menu');
      if (platesShow) {
        const plateFloor = Math.min(
          state.partyBox ? state.partyBox.y : g.height,
          state.stripBox ? state.stripBox.y : g.height,
        );
        plates.draw(g, project, state.plates, { bottomLimit: plateFloor, avoid: panelBox ?? null });
      }
      // Over the world: a callout belongs to a creature, not to the HUD. Toasts (`dom/
      // toasts.js`) are no longer part of this stacking order at all — their own DOM layer
      // sits above this whole canvas.
      callouts.draw(g, project);
      // Floaters last: the most transient thing on screen, over a balloon if the two ever
      // land on the same spot.
      floaters.draw(g, project);
      if (state.debug) drawDebug(g);
      // The drag ghost, last of all: whatever is held follows the pointer over the top of
      // every panel, every toast, the debug overlay — everything this frame just drew. A held
      // drag is `screen.drag()` (`gesture.js`'s state, kept alive across the `paint()` that
      // just reset every hit region), not anything this module owns.
      // A window's own move/resize drag carries an *object* payload
      // (`{kind, id}`) and needs no floating tag — the window itself is already following the
      // pointer, drawn above, in real time. The tag is only for a payload meant to be read as
      // a label, which today means a plain string; `typeof` is the whole test.
      const drag = screen.drag();
      if (drag && typeof drag.payload === 'string') {
        const label = drag.payload;
        const w = g.measure(label) + 10;
        g.fill(drag.x + 8, drag.y - 6, w, 11, 'rgba(20,18,26,0.85)');
        g.text(drag.x + 13, drag.y - 5, label, C.wallHi);
      }
    }

    // ------------------------------------------------------------------ frame
    let acc = 0;
    function frame(dt) {
      if (screen.resize()) screen.markDirty();
      input.frame();
      // Ages and expires the DOM stack directly (`dom/toasts.js`) — no `screen.markDirty()`
      // needed, since nothing on this canvas depends on toast state any more.
      toasts.step(dt);
      // Ages the encounter feed card the same way (`dom/hud.js`'s own `step`, Stage 3b).
      domHud.step(dt);

      acc += dt;
      if (acc >= 0.2) {
        acc = 0;
        // The wallet and the per-hour figures on the economy board, ticked at the same 0.2s
        // cadence as every other HUD poll here — a no-op while the board is not mounted.
        economyMode.step();
        const next = hud.read();
        const prev = state.hud;
        // The party is compared on everything the bar draws, not on the lead's name: a
        // level-up or a second Pokemon of the same species would otherwise leave the HUD
        // stale until something unrelated dirtied it. `hp`/`maxHp`/`status` are in
        // this list for the same reason — a bar that only redrew on name/level/shiny would
        // hold a fainted member's HP bar full until an unrelated event dirtied the screen.
        const party = (p) => JSON.stringify(p.party.map((m) => [m.instanceId, m.name, m.level, m.shiny, m.hp, m.maxHp, m.status]));
        // `domHud.update()` runs on every tick of this poll, diff or not — it is cheap DOM
        // writes (`dom/el.js`'s `syncList`/`setText`, never a rebuild), and it reflects state
        // this diff was never written to know about (automation's own on/off, `dom/hud.js`'s
        // own dock highlight). The diff below still gates `screen.markDirty()` — that one is
        // still worth it, a canvas repaint being real GPU/CPU work `state.hud` alone doesn't
        // capture the cost of.
        state.hud = next;
        domHud.update(next, { minimal });
        if (next.tod !== prev.tod
          || JSON.stringify(next.wallet) !== JSON.stringify(prev.wallet)
          || party(next) !== party(prev)
          // The marked slot: mid-fight this swaps the instant `nextAlly` sends a
          // new member in, on the same 0.2s poll everything else in this snapshot uses.
          || next.activeId !== prev.activeId
          // The badge is drawn from `trainer`, so a level-up has to dirty the screen on its
          // own account: nothing else in this comparison moves when a battle is won.
          || next.trainer?.level !== prev.trainer?.level
          || next.trainer?.into !== prev.trainer?.into
          || state.debug) {
          screen.markDirty();
        }
      }
    }

    /**
     * The paint, moved out of `frame` and run after the camera rig updates
     * (`core/registry.js`'s `lateFrame`, `src/main.js`'s frame loop) — the same reason
     * `pokemon/field.js` poses its sprites there rather than in `frame`: a plate projected
     * against last frame's camera trails a moving sprite by exactly one frame of motion, a
     * different sub-pixel offset every time, which reads as the plate swimming.
     *
     * A plate follows a sprite that moves every rendered frame, not merely every sim tick, so
     * `screen.dirty`'s tick-driven model does not fit it — this marks the screen dirty
     * whenever there is a plate to draw, which is most of the time a scene has anyone standing
     * in it. Measured against the render budget (tools/shots/shoot.js) rather than assumed: `npm run gate`'s
     * `boot`/`coldboot`/`regress` stages all read `fps`/`p95` off exactly this cost.
     */
    function lateFrame() {
      state.plates = minimal ? [] : plates.read();
      if (state.plates.length) screen.markDirty();
      if (screen.dirty) screen.paint(draw);
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
      /**
       * Every window a player has actually dragged or resized (src/offline/save.js) — a panel
       * never touched has no entry and keeps opening at its authored default. `restore()`
       * pushes `loadState`'s own value straight into `panels/common.js`'s module-scope Map;
       * there is no per-window validation beyond `restoreWindows`'s own numeric-field check,
       * because a bad entry only ever mis-clamps a window on its next open, never crashes one.
       */
      saveState: () => ({ v: SAVE_VERSION, windows: serializeWindows(), watch: watchlist.list() }),
      // `restoreWindows`/`watchlist.restore` both tolerate `undefined` — a v1 save (no
      // `watch` field at all) restores to an empty watch-list, exactly what a save with no
      // `ui` slice at all already did before this field existed.
      loadState(value) {
        restoreWindows(value?.windows);
        watchlist.restore(value?.watch);
        screen.markDirty();
      },
      input,
      _screen: screen,
      _domLayer: domLayer,
      _domHud: domHud,
      /** The DOM successor to `_screen.regions()` — `dom/layer.js`'s own comment explains why
       *  a flow test needs this the same way it needs the canvas one. */
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
      _draw: draw,
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
