/**
 * The always-on layer: the wallet, the clock, the party bar and the button strip.
 *
 * Everything here is read through `ctx.get` at paint time and cached in `read()`, so a
 * quarantined `economy` or `pokemon` costs a blank chip rather than a dead HUD, and the
 * painter never calls into another module while it is drawing.
 */

import { C, CURRENCY_COLOUR, panel, pokeball } from './theme.js';
import { fmt, titleCase, clockTime } from './format.js';

const isLive = (api) => !!api && api.__missing === undefined;

/**
 * The four currencies, in the order the wallet shows them — **exported**, and imported by
 * `panels/shop.js` rather than re-listed there. Round 1 had two independent lists and they
 * disagreed: the HUD read money/research/shards/bp and the shop's own strip read
 * money/research/bp/shards, so two currencies swapped places one keypress apart.
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
        name: p?.species?.name ?? '?',
        display: displayName(p?.species),
        level: p?.level ?? 1,
        shiny: !!p?.shiny,
        url: typeof pokemon.spriteUrl === 'function' && p?.species
          ? pokemon.spriteUrl(p.species, { shiny: !!p.shiny }) : null,
      }));
    }

    const tod = isLive(environment) && typeof environment.getTimeOfDay === 'function'
      ? environment.getTimeOfDay() : ctx.config.tod;
    // `tod:changed` only fires when the phase turns over, so a page that booted mid-phase
    // never hears one. The value is asked for directly and the event is only a repaint hint.
    if (isLive(environment) && typeof environment.phase === 'function') phase = environment.phase();
    const player = isLive(sim) && typeof sim.player === 'function' ? sim.player() : null;

    return { wallet, party, tod: Number(tod) || 0, phase, player };
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
    return box;
  }

  /**
   * The party, bottom-left: the lead at full sprite size because it is the Pokemon walking
   * around on screen, and the bench as a row of six Poke Ball marks — filled for a slot in
   * use, hollow for an empty one. That is what the mainline status bar does, and it says
   * "three of six" without truncating three names into "Sniv".
   */
  function drawParty(g, s, { x = 4, bottom = g.height - 4 } = {}) {
    if (!s.party.length) return null;
    const lead = s.party[0];
    const box = { x, y: bottom - 44, w: 108, h: 44 };
    panel(g, box, { paper: C.wallBase });

    const port = { x: box.x + 4, y: box.y + 4, w: 36, h: 36 };
    g.fill(port.x, port.y, port.w, port.h, C.glassDeep);
    g.fill(port.x, port.y, port.w, 1, C.ink);
    g.fill(port.x, port.y, 1, port.h, C.ink);
    g.fill(port.x, port.y + port.h - 1, port.w, 1, C.glassShadow);
    drawIcon(g, lead, port.x + 2, port.y + 2, 32);
    if (lead.shiny) g.text(port.x + port.w - 7, port.y + 1, '★', C.glowLight, { shadow: C.ink });

    const tx = box.x + 44;
    g.text(tx, box.y + 6, lead.display, C.ink, { max: box.w - 48 });
    g.text(tx, box.y + 16, `Lv ${lead.level}`, C.shadowInk);

    // six slots: filled ball for a member, hollow ring for an empty bench slot
    for (let i = 0; i < 6; i++) {
      const bx = tx + i * 9;
      const by = box.y + 28;
      if (i < s.party.length) pokeball(g, bx, by);
      else {
        g.fill(bx + 1, by, 5, 1, C.wallDeep);
        g.fill(bx + 1, by + 6, 5, 1, C.wallDeep);
        g.fill(bx, by + 1, 1, 5, C.wallDeep);
        g.fill(bx + 6, by + 1, 1, 5, C.wallDeep);
      }
    }
    return box;
  }

  /**
   * One overworld sprite, south-facing, first walk frame. The sheets are 2 columns × 4 rows
   * `[north, west, south, east]` (DECISIONS #4) and 61 of them are 64 px frames rather than
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
    // own pixel grid (DECISIONS #58), one surface along, and the fix is the same — refuse a
    // fraction and take the next whole ratio down.
    const raw = Math.min(scale, size / fw, size / fh);
    const k = raw >= 1 ? Math.floor(raw) : 1 / Math.ceil(1 / raw);
    const dw = Math.max(1, Math.round(fw * k));
    const dh = Math.max(1, Math.round(fh * k));
    g.sprite(img, 0, fh * 2, fw, fh, x + Math.round((size - dw) / 2), y + size - dh, dw, dh);
  }

  return { read, onPhase, drawWallet, drawClock, drawParty, drawIcon, displayName, fmt };
}
