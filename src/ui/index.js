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
import { makeCallouts } from './callout.js';
import { makeInput, PANEL_IDS } from './input.js';
import { reportSelfTest } from '../core/log.js';
import { makeMenu } from './panels/menu.js';
import { makeTravel } from './panels/travel.js';
import { makeOfflineCard } from './panels/offline.js';
import { makeShop } from './panels/shop.js';
import { makeBoxes } from './panels/boxes.js';
import { makeBattle } from './panels/battle.js';
import { makeDex } from './panels/dex.js';
import { makeAutomation } from './panels/automation.js';
import { makeParty } from './panels/party.js';
import { makeInventory } from './panels/inventory.js';
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

let live = null;

/** Save slice version — window geometry only (§10). `uiScale` is a `config` key, not a save
 *  field: it is URL-overridable per session like every other `DEFAULTS` entry, and a save slice
 *  would fight that (DECISIONS #85). */
const SAVE_VERSION = 1;

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
    const hud = makeHud(ctx);
    const toasts = makeToasts({ frozen: !!config.showcase });
    /** The lines shouted over a fight — `battle:strike` puts them there. */
    const callouts = makeCallouts();

    /**
     * A world point on the HUD canvas, in internal pixels.
     *
     * The UI canvas is exactly the renderer's internal buffer (`screen.js`) and the camera is
     * orthographic (§2.7), so this is a straight NDC map with **no depth divide** — which is
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

    const state = {
      /** @type {object|null} */ panel: null,
      /** @type {object|null} */ lastSummary: null,
      debug: !!config.debug,
      hud: hud.read(),
      /** Set by `draw` each frame; read by the menu so it never lands on the clock. */
      clockBox: null,
      stripBox: null,
      partyBox: null,
      /** Set by `draw` each frame; the only consumer today is `hudReserved()` below. */
      walletBox: null,
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
      /** Where the party bar landed. It moves when the touch pad is out, so it is measured. */
      partyBox: () => state.partyBox,
      /**
       * How many pixels at the top and bottom of the buffer are already spoken for by the
       * wallet/clock (top) and the party bar/button strip (bottom) *this frame* — every
       * `windowFrame` call passes this straight through so a window can never open, default,
       * or be dragged/resized on top of them (the bug slice 016's own review caught: at
       * `uiScale: 2` a `full` panel's authored size covers nearly the whole halved buffer,
       * including the bars it was supposed to leave visible).
       *
       * Measured from the boxes `draw()` already computed this frame, not from a hard-coded
       * constant — `bars` being false (`hidesHud`) reads back as `{top:0, bottom:0}`, and a
       * future, taller party bar (slice 017) is reserved for correctly with no change here.
       */
      hudReserved() {
        const top = Math.max(
          state.walletBox ? state.walletBox.y + state.walletBox.h : 0,
          state.clockBox ? state.clockBox.y + state.clockBox.h : 0,
        );
        const bottomEdge = Math.min(
          state.partyBox ? state.partyBox.y : Infinity,
          state.stripBox ? state.stripBox.y : Infinity,
        );
        const bottom = Number.isFinite(bottomEdge) ? Math.max(0, screen.height - bottomEdge) : 0;
        return { top: top ? top + 2 : 0, bottom: bottom ? bottom + 2 : 0 };
      },
      toggleDebug() {
        state.debug = !state.debug;
        config.set({ debug: state.debug });
        screen.markDirty();
      },
      toast: (text, kind) => bus.emit('ui:toast', { text, kind }),
    };

    const PANELS = {
      menu: makeMenu(app),
      travel: makeTravel(app),
      offline: makeOfflineCard(app),
      shop: makeShop(app),
      boxes: makeBoxes(app),
      dex: makeDex(app),
      automation: makeAutomation(app),
      party: makeParty(app),
      inventory: makeInventory(app),
      battle: makeBattle(app),
      dialogue: makeDialogue(app),
    };

    /**
     * The evolution cutscene.
     *
     * Not a panel: it takes no input, dismisses itself, and has to sit over whatever is
     * already open — the button that starts it is IN the party panel, and the previous
     * attempt at this animated the overworld sprite behind that panel where nobody could see
     * it (DECISIONS #64).
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
      bus.on('ui:toast', ({ text, kind }) => { toasts.push(text, kind); screen.markDirty(); }),
      /**
       * **The trainer calls the move out, and the wild answers.**
       *
       * One balloon per side, replaced rather than stacked. The ally's line hangs over the
       * **trainer** and not over the Pokemon, which is what the brief asks for in as many words
       * — and it is also what makes the picture work: in a hunt the Pokemon leads and the
       * trainer follows two cells behind, so a balloon over the Pokemon lands across the
       * trainer's face and a balloon over the trainer has clear sky above it. The wild's goes
       * over the cell `encounter` staged it on.
       */
      bus.on('battle:strike', (s2) => {
        if (minimal || config.showcase) return;
        if (!s2?.name && !s2?.struggle) return;
        const enc = ctx.get('encounter');
        const sim = ctx.get('simulation');
        const at = s2.attacker === 'b'
          ? (isLive(enc) ? enc.scene?.()?.at : null)
          : (isLive(sim) ? sim.player?.() : null);
        if (!at) return;
        const text = s2.struggle ? `${s2.attackerSpecies}: Struggle!` : `${s2.attackerSpecies}: ${s2.name}!`;
        callouts.say({
          text, side: s2.attacker ?? 'a',
          x: at.cx + 0.5, z: at.cz + 0.5,
          y: at.y ?? (isLive(sim) ? sim.surfaceAt?.(at.cx, at.cz) ?? 0 : 0),
        });
        screen.markDirty();
      }),
      bus.on('encounter:resolved', () => { callouts.clear(); screen.markDirty(); }),
      bus.on('economy:changed', () => screen.markDirty()),
      bus.on('collection:added', () => screen.markDirty()),
      bus.on('party:leadChanged', () => screen.markDirty()),
      /**
       * The cutscene. Never in a showcase: it is five seconds long and the harness spins
       * ninety frames between `__READY__` and the shutter, so a running one would give a
       * different capture every time (§6.3). `?showcase=ui&mode=evolution` freezes it instead.
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
       * The battle card (§5.12).
       *
       * `encounter:started` and not `battle:started`: the engine's event fires from inside
       * `fight()`, *before* `encounter` has assembled the record the card reads, so a card
       * opened on it would find nothing. By `encounter:started` the fight is resolved and its
       * transcript is on `encounter.active()`.
       *
       * Three guards, and each one is a bug that would otherwise be invisible:
       *  - `minimal || config.showcase` — this module is a passenger in every other module's
       *    showcase, and a card painted over `encounter_12` moves a frame in the regression
       *    gate that nobody asked to move (§6.3).
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
    // Two pairs, because the controls are not the same in both kinds of scene: a walkable
    // map is driven, a hunt is watched. `input.canWalk()` picks the pair.
    const HINTS = {
      walk: ['↑←↓→ or WASD  walk    T  travel    X  menu', 'WASD walk · T travel · X menu'],
      auto: ['Your Pokémon hunts on its own    T  travel    X  menu', 'T travel · X menu'],
    };

    function drawStrip(g) {
      const items = [
        // Travel goes first so it sits leftmost; the four data panels keep their order.
        ...(isLive(ctx.get('travel')) ? [{ id: 'travel', label: 'TRAVEL', key: 'T' }] : []),
        { id: 'party', label: 'PARTY', key: 'P' },
        { id: 'shop', label: 'SHOP', key: 'B' },
        { id: 'boxes', label: 'BOX', key: 'C' },
        { id: 'inventory', label: 'BAG', key: 'I' },
        { id: 'dex', label: 'DEX', key: '4' },
        // Only when there is an `automation` to configure: a chip that opens an empty window is
        // worse than no chip, and the strip is already the widest thing on the bottom bar.
        ...(isLive(ctx.get('automation')) ? [{ id: 'automation', label: 'AUTO', key: 'A' }] : []),
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
      // **Who is stepping the hunt**, drawn rather than asserted. `encounter` and `idle` were
      // both running the loop at once and nothing said so; a line in the overlay is a claim the
      // harness photographs on every `?debug=1` capture (DECISIONS #72).
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
      // clock and the party bar along with it (DECISIONS #85). It is inert data now — nothing
      // reads `panel.full` any more, kept on the descriptor only as a note of which panels
      // used to behave this way; `hudReserved()` (below) is what actually keeps a window from
      // covering the bars it no longer stands down. A message box is the one thing that still
      // stands the bottom bars down — it occupies the same strip of screen they do, and in
      // the mainline a message is the only thing on that strip.
      const bars = !state.panel?.hidesHud;
      state.clockBox = null;
      state.stripBox = null;
      state.partyBox = null;
      state.walletBox = null;
      if (bars) {
        state.walletBox = hud.drawWallet(g, s);
        state.clockBox = hud.drawClock(g, s);
      }
      if (!minimal && bars) {
        // The touch pad owns the bottom-left corner when it is up, so the party bar sits
        // above it rather than under it.
        const partyBox = hud.drawParty(g, s, { bottom: input.touch() ? g.height - 76 : g.height - 4, app });
        state.partyBox = partyBox;
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
          const [long, short] = HINTS[input.canWalk() ? 'walk' : 'auto'];
          let text = long;
          let w = g.measure(text);
          if (Math.round(g.width / 2 + w / 2) + 8 > busyRight) { text = short; w = g.measure(text); }
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
      // The one moment `panels/common.js`'s `windowFrame` — called from deep inside whichever
      // panel draws next — can see the live gesture `screen.js` is holding, without every one
      // of its six call sites threading `screen.drag()` through `opts` by hand (slice 016).
      setActiveDrag(screen.drag());
      if (state.panel) state.panel.draw(g, app);
      // The away card is the one moment the wallet is the *subject*: it is telling the player
      // what they earned. Round 1 dimmed the wallet under the card's own scrim at exactly
      // that moment, so it is repainted on top of it here.
      if (state.panel?.id === 'offline') hud.drawWallet(g, s);
      // A menu opens over the bottom-right corner the toasts stack in; they step aside.
      const toastRight = state.panel?.id === 'menu' ? g.width - 150 : g.width - 6;
      // Under the toasts and over the world: a callout belongs to a creature, not to the HUD.
      callouts.draw(g, project);
      toasts.draw(g, { bottom: g.height - (minimal ? 6 : 22), right: toastRight });
      if (state.debug) drawDebug(g);
      // The drag ghost, last of all: whatever is held follows the pointer over the top of
      // every panel, every toast, the debug overlay — everything this frame just drew. A held
      // drag is `screen.drag()` (`gesture.js`'s state, kept alive across the `paint()` that
      // just reset every hit region), not anything this module owns.
      // A window's own move/resize drag (slice 016) carries an *object* payload
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
      if (toasts.step(dt)) screen.markDirty();

      acc += dt;
      if (acc >= 0.2) {
        acc = 0;
        const next = hud.read();
        const prev = state.hud;
        // The party is compared on everything the bar draws, not on the lead's name: a
        // level-up or a second Pokemon of the same species would otherwise leave the HUD
        // stale until something unrelated dirtied it. `hp`/`maxHp`/`status` (slice 017) are in
        // this list for the same reason — a bar that only redrew on name/level/shiny would
        // hold a fainted member's HP bar full until an unrelated event dirtied the screen.
        const party = (p) => JSON.stringify(p.party.map((m) => [m.instanceId, m.name, m.level, m.shiny, m.hp, m.maxHp, m.status]));
        if (next.tod !== prev.tod
          || JSON.stringify(next.wallet) !== JSON.stringify(prev.wallet)
          || party(next) !== party(prev)
          // The marked slot (slice 017): mid-fight this swaps the instant `nextAlly` sends a
          // new member in, on the same 0.2s poll everything else in this snapshot uses.
          || next.activeId !== prev.activeId
          // The badge is drawn from `trainer`, so a level-up has to dirty the screen on its
          // own account: nothing else in this comparison moves when a battle is won.
          || next.trainer?.level !== prev.trainer?.level
          || next.trainer?.into !== prev.trainer?.into
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

      /**
       * The checks a Node run cannot make, because this module needs a canvas to exist.
       *
       * It reports through `reportSelfTest`, which `console.error`s on failure — §7 budgets zero
       * console errors, and that is what turns a red invariant into a failed capture rather than
       * red text in a screenshot nobody reads (§8.1).
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
       * This is the seam §5.12 asks for — nothing publishes NPC lines yet, so it is offered
       * rather than consumed.
       */
      say(text, opts = {}) { return app.open('dialogue', { ...opts, text }); },
      close: () => app.close(),
      /** The cutscene, exposed so a showcase can freeze it at an exact beat. */
      evolution,
      isOpen: () => !!state.panel,
      openPanel: () => state.panel?.id ?? null,
      /** The away card, on demand — the menu's REPORT entry and the showcase both use it. */
      showReport: () => app.openReport(),
      /** What the HUD is currently reading, for a probe or a test. */
      snapshot: () => ({ ...state.hud, panel: state.panel?.id ?? null, toasts: toasts.count() }),
      /** Screen geometry, so a caller can reason about the UI grid. */
      metrics: () => ({ width: screen.width, height: screen.height, drawCalls: 0 }),
      /**
       * Every window a player has actually dragged or resized (§10, DECISIONS #85) — a panel
       * never touched has no entry and keeps opening at its authored default. `restore()`
       * pushes `loadState`'s own value straight into `panels/common.js`'s module-scope Map;
       * there is no per-window validation beyond `restoreWindows`'s own numeric-field check,
       * because a bad entry only ever mis-clamps a window on its next open, never crashes one.
       */
      saveState: () => ({ v: SAVE_VERSION, windows: serializeWindows() }),
      loadState(value) { restoreWindows(value?.windows); screen.markDirty(); },
      input,
      _screen: screen,
      _toasts: toasts,
      _callouts: callouts,
      _tick() { if (callouts.count() && callouts.tick(1)) screen.markDirty(); },
      /** A world point on the HUD canvas, in internal pixels. Exact under the ortho camera. */
      project,
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

    /**
     * Hands the save seam to `offline` directly, the same self-registration `travel` uses and
     * for the identical reason: `offline` discovers its native providers once, during its own
     * `init`, and `ui` inits after it in the real boot order (`… simulation, idle, offline,
     * travel, ui` — slice 014's derived order) — so the ordinary discovery pass never sees it.
     * `order: 55`: after `travel`'s self-registered 45 and the default 50 every adapter and
     * every other native slice takes, since window geometry depends on nothing else restoring
     * first and nothing else depends on it (DECISIONS #85).
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
   * exactly this reason (DECISIONS #14, #72).
   */
  tick() { live?._tick?.(); },

  frame(dt) { live?._frame(dt); },

  dispose() { live?.dispose?.(); },

  async showcase(mode, ctx) {
    const { showcaseUi } = await import('./showcase.js');
    return showcaseUi(mode, ctx);
  },
};
