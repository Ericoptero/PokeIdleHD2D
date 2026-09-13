/**
 * The always-on layer: the wallet, the clock, the party bar and the button strip.
 *
 * Everything here is read through `ctx.get` at paint time and cached in `read()`, so a
 * quarantined `economy` or `pokemon` costs a blank chip rather than a dead HUD, and the
 * painter never calls into another module while it is drawing.
 */

import { C, CURRENCY_COLOUR, panel, meter, hpRamp } from './theme.js';
import { fmt, titleCase, clockTime } from './format.js';
import { STATUS_NAME } from './panels/battle.js';

const isLive = (api) => !!api && api.__missing === undefined;

/**
 * The four currencies, in the order `read()`'s own wallet loop (below) uses them and
 * `drawWallet` falls back to. Round 1 had two independent lists and they disagreed: the HUD
 * read money/research/shards/bp and the shop's own strip read money/research/bp/shards, so two
 * currencies swapped places one keypress apart — the reason this stayed exported even after
 * every Códice DOM screen that used to import it (`screens/shop.js`, `models/trainer.js`)
 * moved to reading `economy.currencies()` directly instead: one canonical order, now living in
 * `economy` itself rather than in a second table here for `ui` to keep in sync by hand.
 */
export const WALLET = [
  { id: 'money', symbol: '₽', before: true },
  { id: 'research', symbol: '◈', before: false },
  { id: 'shards', symbol: '◆', before: false },
  { id: 'bp', symbol: 'BP', before: false },
];

/** `environment.phaseOf` names its own phases; these are their labels. */
const PHASE_NAME = {
  night: 'NIGHT', dawn: 'DAWN', morning: 'MORNING', day: 'DAY',
  goldenHour: 'GOLDEN HOUR', dusk: 'DUSK',
};

export function makeHud(ctx) {
  let phase = null;

  /** One snapshot per repaint. Called outside the painter, never during it. */
  function read() {
    const economy = ctx.get('economy');
    const pokemon = ctx.get('pokemon');
    const environment = ctx.get('environment');
    const sim = ctx.get('simulation');

    // `null` when the ledger is not there at all — four zeroes would be a claim about the
    // player's wallet rather than a report of it, and every other module's showcase boots
    // `ui` without booting `economy`.
    let wallet = null;
    if (isLive(economy) && typeof economy.balance === 'function') {
      wallet = {};
      for (const c of WALLET) wallet[c.id] = economy.balance(c.id) ?? 0;
    }

    let party = [];
    if (isLive(pokemon) && typeof pokemon.party === 'function') {
      party = (pokemon.party() ?? []).map((p) => ({
        instanceId: p?.instanceId ?? null,
        name: p?.species?.name ?? '?',
        display: displayName(p?.species),
        level: p?.level ?? 1,
        shiny: !!p?.shiny,
        hp: Math.max(0, Number(p?.hp) || 0),
        maxHp: Math.max(1, Number(p?.maxHp) || 1),
        status: p?.status ?? null,
        url: typeof pokemon.spriteUrl === 'function' && p?.species
          ? pokemon.spriteUrl(p.species, { shiny: !!p.shiny }) : null,
      }));
    }

    /**
     * Who the party bar marks: the live combatant `panels/battle.js`'s own `read()` already
     * reads (`st.a` — HP/PP is only written back to `pokemon` when the fight
     * ends, so `pokemon.party()` is stale for exactly the member being hit) for as long as a
     * duel object exists at all; otherwise `party[0]`, the lead. A second reader of the
     * decision the battle card already made, not a new source of truth — which means copying
     * its *whole* rule, not narrowing it: `battle.js:125-127` keeps reading `duel.run.state.a`
     * for as long as `active.duel?.engine` exists, `win` included — a fight is `resolve()`d,
     * and `pokemon.setLead()` for a swapped-in finisher, a separate and later step (`encounter/
     * index.js`'s own comment: the player gets several seconds to decide whether to throw).
     * A first draft gated this on `win === null` (mid-fight only) and, for those few seconds
     * after every fight a mid-fight swap happened in, the party bar reverted to the original
     * (possibly fainted) lead while the battle card still correctly showed the finisher. The marked slot's own hp/maxHp/status are overwritten with
     * the live combatant's, for the same reason: showing the party record's stale HP under a
     * transcript that says otherwise is the bug this rule exists to avoid.
     */
    let activeId = party[0]?.instanceId ?? null;
    const encounter = ctx.get('encounter');
    if (isLive(encounter) && typeof encounter.active === 'function') {
      const active = encounter.active();
      const side = active?.duel?.engine ? active.duel.run?.state?.a : null;
      if (side?.instanceId != null) {
        activeId = side.instanceId;
        const i = party.findIndex((m) => m.instanceId === side.instanceId);
        if (i >= 0) {
          party[i] = {
            ...party[i],
            hp: Math.max(0, Number(side.hp) || 0),
            maxHp: Math.max(1, Number(side.maxHp) || 1),
            status: side.status ?? null,
          };
        }
      }
    }

    const tod = isLive(environment) && typeof environment.getTimeOfDay === 'function'
      ? environment.getTimeOfDay() : ctx.config.tod;
    // `tod:changed` only fires when the phase turns over, so a page that booted mid-phase
    // never hears one. The value is asked for directly and the event is only a repaint hint.
    if (isLive(environment) && typeof environment.phase === 'function') phase = environment.phase();
    const player = isLive(sim) && typeof sim.player === 'function' ? sim.player() : null;

    // The trainer's own level — the number `travel` gates on (src/travel/index.js). Read here rather than
    // in the painter, like everything else in this snapshot.
    let trainer = null;
    if (economy && economy.__missing === undefined && typeof economy.trainer === 'function') {
      const t = economy.trainer();
      if (Number.isFinite(t?.level)) trainer = t;
    }

    return { wallet, party, activeId, tod: Number(tod) || 0, phase, player, trainer };
  }

  function onPhase(p) { phase = p; }

  const displayName = (species) => titleCase(species?.display ?? species?.name ?? '');

  // ------------------------------------------------------------------ paint

  /** The wallet box. Returns its own rect so the clock can align to it. */
  function drawWallet(g, s, { x = 4, y = 4, currencies = WALLET } = {}) {
    if (!s.wallet) return null;
    const parts = currencies.map((c) => ({
      c, text: c.before ? `${c.symbol}${fmt(s.wallet[c.id])}` : `${fmt(s.wallet[c.id])} ${c.symbol}`,
    }));
    const w = parts.reduce((a, p) => a + g.measure(p.text) + 9, 0) + 3;
    const box = { x, y, w, h: 15 };
    panel(g, box, { paper: C.wallLight });
    let cx = x + 6;
    for (const p of parts) {
      const symbolAt = p.c.before ? cx : cx + g.measure(p.text) - g.measure(p.c.symbol);
      g.text(cx, y + 4, p.text, C.ink);
      // the symbol carries the currency's own colour, so the eye finds the right number
      g.text(symbolAt, y + 4, p.c.symbol, CURRENCY_COLOUR[p.c.id] ?? C.ink, {});
      cx += g.measure(p.text) + 9;
    }
    return box;
  }

  function drawClock(g, s, { right = g.width - 4, y = 4 } = {}) {
    const time = clockTime(s.tod);
    const name = PHASE_NAME[s.phase] ?? '';
    const w = Math.max(g.measure(time), g.measure(name)) + 12;
    const box = { x: right - w, y, w, h: name ? 24 : 15 };
    panel(g, box, { paper: C.wallLight });
    g.textCentre(box.x + box.w / 2, y + 4, time, C.ink);
    if (name) g.textCentre(box.x + box.w / 2, y + 13, name, C.stoneShadow);

    // **The trainer's level, under the clock.** It is the number that decides where the party
    // may go (src/travel/index.js), so it belongs where the player can see it without opening anything —
    // and the progress to the next one is what makes a locked destination read as a schedule
    // rather than as a wall. Drawn only when there is one: a quarantined `economy` reports
    // none and the HUD simply does not have a badge.
    if (s.trainer) {
      const label = `TRAINER ${s.trainer.level}`;
      const tw = Math.max(g.measure(label), 46) + 10;
      const tb = { x: right - tw, y: box.y + box.h + 3, w: tw, h: 15 };
      panel(g, tb, { paper: C.wallLight });
      g.textCentre(tb.x + tb.w / 2, tb.y + 4, label, C.ink);
      // A two-pixel bar rather than a number: it is a hint, not a statistic.
      const frac = s.trainer.need > 0 ? Math.max(0, Math.min(1, s.trainer.into / s.trainer.need)) : 0;
      g.fill(tb.x + 3, tb.y + tb.h - 3, tb.w - 6, 1, C.wallDeep);
      if (frac > 0) g.fill(tb.x + 3, tb.y + tb.h - 3, Math.round((tb.w - 6) * frac), 1, C.martBase);
      return { ...box, h: box.h + 18 };
    }
    return box;
  }

  /** One slot's own footprint, and the gap between two of them — used both to lay the six
   *  out and to size the panel around them. */
  const SLOT_W = 42;
  const SLOT_H = 48;
  const SLOT_GAP = 2;
  const BAR_PAD = 3;

  /**
   * The party bar, bottom-left: all six slots, always, in `pokemon.party()`'s own order —
   * which already **is** "the order in use" (`simulation` walks it, `encounter.nextAlly`
   * falls back to it), so this reads one rather than inventing one. Each filled slot carries
   * a sprite, a short name, a level, an HP bar and a status abbreviation; a slot beyond the
   * party's actual size draws as an empty plate with a hollow ring, the way the mainline
   * status bar shows "three of six" without truncating three names into "Sniv".
   *
   * The slot at `s.activeId` (mid-fight: the live combatant; otherwise the lead — the same
   * rule `panels/battle.js`'s own card applies) is marked with a glow border,
   * and the mark moves the instant a mid-fight swap changes who is out, because `s.activeId`
   * is computed in `read()` off the same live duel state the card reads, not off the party's
   * own resting record.
   *
   * `app` wires two interactions — a click opens the party panel already
   * selected on that slot, and a drag reorders the party — through `g.hit(box, {drag,
   * drop}, tag)` primitives, exactly as `panels/common.js`'s window drag/resize already do; a
   * plate has no `drag` at all when it has nothing in it, so an empty bench slot cannot be
   * picked up or dropped on.
   */
  function drawParty(g, s, { x = 4, bottom = g.height - 4, app } = {}) {
    const pokemon = app?.ctx?.get?.('pokemon');
    const contentW = SLOT_W * 6 + SLOT_GAP * 5;
    const box = { x, y: bottom - (SLOT_H + BAR_PAD * 2), w: contentW + BAR_PAD * 2, h: SLOT_H + BAR_PAD * 2 };
    panel(g, box, { paper: C.wallBase });

    for (let i = 0; i < 6; i++) {
      const sx = box.x + BAR_PAD + i * (SLOT_W + SLOT_GAP);
      const sy = box.y + BAR_PAD;
      const m = s.party[i];
      const active = !!m && m.instanceId != null && m.instanceId === s.activeId;

      if (!m) {
        // An empty bench slot: a hollow plate with a hollow ring, no sprite, no text, and no
        // hit region — nothing to click, nothing to pick up.
        g.fill(sx, sy, SLOT_W, SLOT_H, C.wallDeep);
        g.fill(sx, sy, SLOT_W, 1, C.wallShadow);
        g.fill(sx, sy + SLOT_H - 1, SLOT_W, 1, C.stoneDeep);
        const cx = sx + SLOT_W / 2 - 4;
        const cy = sy + SLOT_H / 2 - 4;
        g.fill(cx + 1, cy, 6, 1, C.stoneShadow);
        g.fill(cx + 1, cy + 7, 6, 1, C.stoneShadow);
        g.fill(cx, cy + 1, 1, 6, C.stoneShadow);
        g.fill(cx + 7, cy + 1, 1, 6, C.stoneShadow);
        continue;
      }

      // The plate is the same light paper every filled slot gets, active or not — the HP
      // ramp (`theme.js` `hpRamp`) already spends `C.martBase` on a healthy bar, and an earlier version painted the active slot's own background in that exact blue: a full
      // bar on the active slot then blended straight into the plate behind it, invisible at
      // the one moment (healthy and in front) a player looks at it most. The glow ring below
      // is the only thing that changes, so it never competes with a bar it sits beside.
      g.fill(sx, sy, SLOT_W, SLOT_H, C.wallLight);
      g.fill(sx, sy, SLOT_W, 1, C.wallHi);
      g.fill(sx, sy + SLOT_H - 1, SLOT_W, 1, C.wallDeep);
      if (active) {
        // The mark: a glow ring around the whole slot, so the eye finds who is out without
        // reading a label — the accent this palette reserves for "the one right now"
        // (`theme.js` `C.glowBase`/`C.glowLight`), spent nowhere else in this widget.
        g.fill(sx - 1, sy - 1, SLOT_W + 2, 1, C.glowLight);
        g.fill(sx - 1, sy + SLOT_H, SLOT_W + 2, 1, C.glowLight);
        g.fill(sx - 1, sy - 1, 1, SLOT_H + 2, C.glowLight);
        g.fill(sx + SLOT_W, sy - 1, 1, SLOT_H + 2, C.glowLight);
      }

      const iconSize = 24;
      drawIcon(g, m, sx + Math.round((SLOT_W - iconSize) / 2), sy + 1, iconSize);
      // The level as a corner badge on the portrait rather than inline beside the name: a
      // second text row would leave "short name" living up to its name for real (three
      // letters and an ellipsis) once `Lv` and the number ate a third of a 42 px slot. The
      // icon is bottom-aligned (`drawIcon`'s own convention), so its top-left corner is empty
      // for every sprite this ever draws.
      g.text(sx + 1, sy + 1, String(m.level), C.shadowInk);
      if (m.shiny) g.text(sx + SLOT_W - 7, sy + 1, '★', C.glowDeep);

      g.text(sx + 2, sy + 26, m.display, C.ink, { max: SLOT_W - 4 });

      const frac = m.maxHp > 0 ? Math.max(0, Math.min(1, m.hp / m.maxHp)) : 0;
      meter(g, { x: sx + 2, y: sy + 35, w: SLOT_W - 4, h: 4 }, frac, { ...hpRamp(frac), back: C.wallDeep });

      if (m.status) {
        g.text(sx + 2, sy + 40, STATUS_NAME[m.status] ?? String(m.status).toUpperCase(), C.roofShadow);
      }

      const slotBox = { x: sx, y: sy, w: SLOT_W, h: SLOT_H };
      // One region does both jobs: `pointerdown` always starts a drag (`gesture.js`), and a
      // release with no movement lands back on this same slot's own `drop`, which reads
      // `payload.index === i` as "that was a click" and opens the panel instead of reordering
      // — the same box, the same gesture, no second hit region racing the first for the
      // pointerdown that `screen.js`'s `pick()` can only ever hand to one of them.
      g.hit(slotBox, {
        drag: { payload: { kind: 'party-slot', index: i } },
        drop: {
          accepts: (payload) => payload?.kind === 'party-slot',
          on: (payload) => {
            if (payload.index === i) app?.open?.('party', { select: i });
            else pokemon?.reorder?.(payload.index, i);
            app?.markDirty?.();
          },
        },
      }, `party-slot-${i}`);
    }
    return box;
  }

  /**
   * One overworld sprite, south-facing, first walk frame. The sheets are 2 columns × 4 rows
   * `[north, west, south, east]` and 61 of them are 64 px frames rather than
   * 32, so the frame size is measured off the image instead of assumed.
   */
  function drawIcon(g, entry, x, y, size = 32, scale = 1) {
    const img = entry?.url ? g.image(entry.url) : null;
    if (!img) {
      g.fill(x + 4, y + 8, size - 8, size - 12, C.wallDeep);
      return;
    }
    const fw = img.width / 2;
    const fh = img.height / 4;
    // The frame is clamped into the cell rather than trusted to fit it. 61 species ship
    // 64 px frames, and at `scale` 1 in a 32 px cell the old arithmetic put the sprite at
    // `y + 32 - 64` — thirty-two pixels *above* its own slot, in the row overhead. The same
    // clamp is what lets a box cell shrink with the window (a 29 px cell at 720p).
    // Whole ratios only — 1/3, 1/2, 1, 2, 3 — never 0.906.
    //
    // `drawImage` with smoothing off does not *blend* a fractional scale, it drops rows and
    // columns: at the 29 px cell a 720p buffer gives, k came out 0.906 and every eleventh row
    // of the source frame simply vanished. That is the same class of defect as the world's
    // own pixel grid, one surface along, and the fix is the same — refuse a
    // fraction and take the next whole ratio down.
    const raw = Math.min(scale, size / fw, size / fh);
    const k = raw >= 1 ? Math.floor(raw) : 1 / Math.ceil(1 / raw);
    const dw = Math.max(1, Math.round(fw * k));
    const dh = Math.max(1, Math.round(fh * k));
    g.sprite(img, 0, fh * 2, fw, fh, x + Math.round((size - dw) / 2), y + size - dh, dw, dh);
  }

  return { read, onPhase, drawWallet, drawClock, drawParty, drawIcon, displayName, fmt };
}
