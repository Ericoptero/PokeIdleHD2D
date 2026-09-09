/**
 * The `ui` showcase (ARCHITECTURE §6).
 *
 * Every panel is drawn over the **real lobby**, with real data pulled from the real modules:
 * the shop's prices come from `economy`, the boxes come from `collection` after a scripted
 * intake, the party comes from `pokemon`, and the away card is `offline`'s own catch-up
 * decision for a five-hour absence. Nothing here is mocked, because a UI screenshot of
 * invented numbers proves nothing about the seam it is meant to prove.
 *
 * Determinism (§6.3): the city cast is advanced a fixed number of sim steps and frozen, the
 * seeded catches are a fixed list, toasts do not age in showcase mode, and the away card is
 * asked for a fixed `awayS` rather than a real absence — `offline` is read-only in showcase
 * mode (DECISIONS #15) so nothing is granted or written either way.
 *
 * Modes: `default font hud menu offline shop boxes dex party toasts dialogue input`
 */

import { characters, glyph, HEIGHT, BASELINE, TRACKING } from './font.js';

const isLive = (api) => !!api && api.__missing === undefined;

/** The scripted intake. Fixed list, fixed levels, fixed shinies — same URL, same boxes. */
const SEED_CATCHES = [
  ['bulbasaur', 12, false], ['charmander', 14, false], ['squirtle', 11, false],
  ['pidgey', 7, false], ['rattata', 5, false], ['caterpie', 4, false],
  ['pikachu', 18, true], ['zubat', 9, false], ['geodude', 13, false],
  ['gastly', 16, false], ['onix', 21, false], ['machop', 15, false],
  ['sandshrew', 10, false], ['vulpix', 12, false], ['oddish', 8, false],
  ['psyduck', 14, false], ['growlithe', 17, false], ['abra', 11, false],
  ['magnemite', 13, false], ['eevee', 25, false], ['snorlax', 30, false],
  ['dratini', 19, false], ['ponyta', 16, false], ['tentacool', 9, false],
  ['krabby', 12, false], ['voltorb', 14, false], ['cubone', 15, false],
  ['magikarp', 5, false], ['lapras', 28, false], ['ditto', 20, true],
];

const SEED_ITEMS = [
  ['pokeball', 26], ['greatball', 12], ['potion', 8], ['superpotion', 3],
  ['nugget', 2], ['revive', 2], ['rarecandy', 1],
];

export async function showcaseUi(mode = 'default', ctx) {
  const { config, log } = ctx;
  const ui = ctx.get('ui');
  const eco = ctx.get('economy');
  const col = ctx.get('collection');
  const offline = ctx.get('offline');

  // --- the scene behind the glass ------------------------------------------
  try {
    const city = ctx.get('city');
    await city.enter?.();
    city.preset?.(mode === 'shop' ? 'mart' : mode === 'boxes' || mode === 'dex' ? 'pokecenter' : 'plaza');
    // The cast is walked to a fixed point and stopped there, exactly as `city.showcase`
    // does, so the backdrop is the same picture in every capture (DECISIONS #26d).
    const sim = ctx.get('simulation');
    if (isLive(sim) && typeof sim.advanceSteps === 'function' && config.timeFrozen) {
      sim.advanceSteps(47);
      sim.freeze?.(true);
    }
  } catch (err) { log.warn('ui showcase: the lobby did not load; panels are drawn over an empty scene', err); }
  ctx.get('environment').setTimeOfDay?.(config.tod);

  // --- the data the panels read --------------------------------------------
  if (isLive(eco) && typeof eco.add === 'function') {
    eco.add('money', 640000, 'grant:showcase');
    eco.add('research', 4200, 'grant:showcase');
    eco.add('bp', 180, 'grant:showcase');
    eco.add('shards', 96, 'grant:showcase');
    for (const [id, n] of SEED_ITEMS) eco.give?.(id, n, 'grant:showcase');
    eco.buyUpgrade?.('payday', 3);
    eco.buyUpgrade?.('expedition', 2);
  }

  if (isLive(col) && typeof col.deposit === 'function') {
    col.setQuiet?.(true);
    for (const [species, level, shiny] of SEED_CATCHES) {
      col.sight?.(species, { shiny });
      col.deposit({ species, level, shiny, origin: 'wild', ball: shiny ? 'greatball' : 'pokeball', biome: 'city' });
    }
    col.sort?.('species');
    col.setQuiet?.(false);
  }

  // Nothing that ran above should leave a toast on screen: each mode stages its own.
  ui._toasts?.clear?.();

  // --- the panel ------------------------------------------------------------
  const wanted = String(mode || 'default').toLowerCase();
  switch (wanted) {
    case 'menu': ui.open('menu'); break;
    case 'shop': ui.open('shop'); break;
    case 'boxes': ui.open('boxes'); break;
    case 'dex': ui.open('dex'); break;
    case 'party': ui.open('party'); break;
    case 'evolution': case 'evolution-burst': case 'evolution-reveal': {
      // The cutscene, HELD. It is 5.75 s long and the harness spins ninety frames between
      // `__READY__` and the shutter, so a running one is a different picture every time —
      // `freeze(t)` gives the browser's own timeline a negative delay and pauses it, which is
      // the real animation sampled rather than a second drawing of it (ARCHITECTURE §6.3).
      const pk = ctx.get('pokemon');
      const at = wanted === 'evolution-burst' ? 3.42 : wanted === 'evolution-reveal' ? 4.35 : 1.70;
      ui.evolution?.freeze({ from: pk.species('oshawott'), to: pk.species('dewott') }, at);
      break;
    }
    case 'evolve': {
      // The state a fresh save cannot show: a Pokemon at the level, with the materials in the
      // bag, and the button live. Everything here goes through the published API — the level
      // through `grantExp`, the materials through `economy.give` — so the picture is the game
      // and not a mock-up of it.
      const pk = ctx.get('pokemon');
      const eco = ctx.get('economy');
      const lead = pk.party?.()?.[0];
      if (lead && typeof pk.grantExp === 'function') {
        // Enough for the level, granted as a hunt would grant it. It still does not evolve:
        // that is the point of the mode (DECISIONS #62).
        pk.grantExp(lead.instanceId, 60000, { source: 'hunt' });
        const need = pk.canEvolve?.(lead.instanceId);
        for (const m of need?.materials ?? []) eco.give?.(m.id, m.n, 'showcase:drop');
      }
      ui.open('party');
      break;
    }
    case 'offline': ui.open('offline', { summary: previewSummary(offline, ctx) }); break;
    case 'toasts':
      ui.toast('★ Shiny Ditto caught!', 'good');
      ui.toast('Boxes are full — Magikarp had nowhere to go', 'warn');
      ui.toast('Welcome back — 5 h away, ₽18,420', 'offline');
      ui.toast('Auto-sell released 6 duplicates — ₽3,120', 'info');
      break;
    case 'dialogue':
      ui.say([
        'Welcome to the Pokémon Center! We can heal your Pokémon back to perfect health.',
        'We hope to see you again!',
      ], { speaker: 'Nurse Joy' });
      break;
    case 'input':
      ui.input?.setTouch?.(true);
      ui.input?.press?.(2);
      break;
    case 'font':
    case 'hud':
    case 'default':
    default:
      ui.toast('Route 4 unlocked', 'good');
      break;
  }

  // A panel full of species icons is a panel full of `<img>` loads. `registry.showcase` is
  // awaited before `__READY__` is set, so waiting here is what makes the capture complete
  // rather than a race against the network.
  await ui._screen?.imagesSettled?.();
  ui._screen?.markDirty?.();

  if (wanted === 'font') installSpecimen(ui);
  return true;
}

/**
 * The away card's payload for a fixed five-hour absence. `offline.preview()` is pure — it
 * grants nothing and writes nothing — and returns the *decision*; the split into banked and
 * held mirrors what `offline` itself banks (money and research) versus what it records as
 * pending because nothing accepts experience or a background catch yet.
 */
function previewSummary(offline, ctx) {
  if (!isLive(offline) || typeof offline.preview !== 'function') return null;
  const d = offline.preview(5 * 3600, 1758000000000);
  const g = d?.gains ?? {};
  const money = Math.floor(g.money ?? 0);
  const research = Math.floor(g.research ?? 0);
  return {
    reason: d.reason,
    awayS: d.awayS, capped: d.capped, capS: d.capS, creditedS: d.cappedS,
    effectiveS: d.effectiveS, efficiency: d.efficiencyAvg, bands: d.bands ?? [],
    gains: { money, exp: g.exp ?? 0, encounters: g.encounters ?? 0, wholeEncounters: g.wholeEncounters ?? 0 },
    applied: { money, ...(research > 0 ? { tokens: research } : {}) },
    pending: {
      exp: Math.floor(g.exp ?? 0),
      encounters: g.wholeEncounters ?? 0,
      catches: g.catches ?? 0,
      shinies: g.shinies ?? 0,
    },
    notes: [
      `seed ${ctx.config.seed} · idle rate ${(g.money ? (g.money / (d.effectiveS || 1)).toFixed(2) : '0')} ₽/s`,
      'preview: offline is read-only in showcase mode',
    ],
  };
}

/**
 * The type specimen.
 *
 * It exists so the font can be **verified** rather than asserted, and round 1's did neither:
 * it was not `full`, so it drew *over* the live HUD instead of replacing it (row 1 of the
 * alphabet overprinted the wallet chip); and its own label said "at 3x" while the code drew
 * the same 1x string three times with a one-pixel stagger and three tints. Both are fixed
 * here — the panel stands the HUD down, and the 3x block is filled cell by cell out of
 * `font.js`'s own rows with the glyph grid drawn under it, so a wrong pixel is visible.
 */
function installSpecimen(ui) {
  const state = ui._state;
  state.panel = {
    id: 'font',
    /** The specimen replaces the HUD; it does not sit on top of it. */
    full: true,
    draw(g) {
      g.fill(0, 0, g.width, g.height, '#141118');
      g.scrim(0, 0, g.width, g.height, 0.35);

      // --- every glyph the font defines, one per cell, at 1x ------------------
      const chars = characters();
      const cellW = 8;
      const cellH = 11;
      const cols = Math.max(8, Math.floor((g.width - 16) / cellW));
      g.text(8, 6, `${chars.length} glyphs, ${HEIGHT} rows, baseline ${BASELINE}`, '#8C8C80');
      let gx = 8;
      let gy = 18;
      for (const ch of chars) {
        if (gx + cellW > g.width - 8) { gx = 8; gy += cellH; }
        g.fill(gx, gy - 1, cellW - 1, cellH - 2, '#20202A');
        g.text(gx, gy, ch, '#FFF8E6');
        gx += cellW;
      }
      gy += cellH + 4;

      // --- the strings the other modules actually emit ------------------------
      for (const row of [
        'Pokémon Center · ₽12,400 · 4,200 ◈ · 96 ◆ · 180 BP',
        '★ Shiny Ditto caught!   12:00   ₽598,099   the zero is not slashed: O0O0',
        'While you were away — 5 h 12 m, worth 62%',
      ]) {
        g.text(8, gy, row, '#E8E2D2');
        gy += 10;
      }
      gy += 4;

      // --- and the same face at 3x, actually at 3x ---------------------------
      const s = 3;
      g.text(8, gy, `at ${s}x, cell by cell, with the glyph grid and the baseline under it:`, '#8C8C80');
      gy += 11;
      for (const sample of ['Pokémon 0123', 'gjpqy AWMil1', '★ ₽ ◆ ◈ ✓ ×']) {
        let px = 8;
        for (const ch of sample) {
          const gl = glyph(ch);
          // the grid: one faint block per glyph cell, so a stray pixel has somewhere to be seen
          g.fill(px, gy, gl.w * s, HEIGHT * s, '#242432');
          for (let j = 0; j < gl.rows.length; j++) {
            for (let i = 0; i < gl.rows[j].length; i++) {
              if (gl.rows[j][i] !== '#') continue;
              g.fill(px + i * s, gy + (gl.top + j) * s, s, s, '#FFF8E6');
            }
          }
          // the baseline, so a glyph that sits crooked or a descender that is too shallow is
          // obvious rather than a matter of opinion
          g.fill(px, gy + (BASELINE + 1) * s, gl.w * s, 1, '#C93B38');
          px += (gl.w + TRACKING) * s;
          if (px > g.width - 20) break;
        }
        gy += HEIGHT * s + 6;
      }
    },
  };
  ui._screen.markDirty();
}
