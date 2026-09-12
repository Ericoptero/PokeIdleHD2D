/**
 * plates.js — the name, level and HP bar every trainer, Pokémon and wild carries above its
 * own head, MMORPG-style.
 *
 * Two halves, the same split `hud.js` already draws: `read()` gathers the world through
 * published APIs at paint time (a quarantined `hunts` or `encounter` costs this file its
 * wild plates, never a crash), and `draw()` projects and paints what it found. Drawn on the
 * 2-D HUD canvas, like `callout.js` — a plate in the 3-D scene would be one more draw call
 * per entity and its own filtering story; this one costs nothing the renderer's own stats
 * count (ARCHITECTURE §2.7).
 *
 * **What gets a level and a bar, and what gets only a name** (the user's own call, not a
 * guess): the trainer, the party's lead and every wild Pokémon in a hunt carry a level; only
 * the two Pokémon carry an HP bar (a trainer has no HP in this game — no field to draw one
 * from, and no mainline game draws one either). Every other NPC — a city local, Nurse Joy — is
 * scenery with nothing to fight, so it gets a name and nothing else.
 */

import { C, meter, hpInk } from './theme.js';
import { titleCase } from './format.js';
import { HEIGHT } from './font.js';

const isLive = (api) => !!api && api.__missing === undefined;

/**
 * How high above a Pokémon's feet its plate floats, in world units.
 *
 * A measured constant, not a computed one — `callout.js`'s own `LIFT` (3.1) is the same
 * measurement for the same purpose (something hung over a creature's head) and the sprite
 * sheets it was measured against are the same ones this file draws over. Sprite frames vary
 * in texel size per species (ARCHITECTURE §5.5), so no single constant is exact for all of
 * them; 3.1 clears the tallest ones with air to spare and does not float over the shortest.
 */
const POKEMON_LIFT = 3.1;
/**
 * How high above the trainer's feet its plate floats.
 *
 * Trainer sheets are one fixed size (32×768, 32-texel frames) — 16 texels/unit stretched by
 * `1/cos(45°)` (DECISIONS #18) is 2 world units tall — so a constant here is exact rather than
 * measured-to-fit, unlike `POKEMON_LIFT`. A quarter-tile of air above the crown, matching
 * `callout.js`'s own margin.
 */
const TRAINER_LIFT = 2 * (1 / Math.cos((45 * Math.PI) / 180)) + 0.3;

/** Vertical gap between the name row and the HP bar, and the bar's own height, in px. */
const ROW_GAP = 1;
const BAR_H = 3;
/** The narrowest a bar is ever drawn, so a one-letter name does not leave a sliver. */
const BAR_MIN_W = 26;
/** No session has this many entities on screen; a paint cost ceiling in case one ever did. */
const MAX_PLATES = 48;
/**
 * How far from the trainer a wild or an NPC still earns a plate, in tiles (Chebyshev).
 *
 * Not a perf guard — `MAX_PLATES` is that — a **composition** one. A wide hunt framing can
 * put most of a lap's nine slots on screen at once, and a plate for every one of them crowds
 * into the same few rows near the horizon and reads as a smear rather than nine labels. Real
 * MMORPGs draw the same line for the same reason: a nameplate is for something you could
 * plausibly walk up to next, not an inventory of everything the camera can see. 14 keeps the
 * whole of a slot's tether radius plus the two cells `hunts` stages it at (§5.14) comfortably
 * inside it, so nothing already worth walking toward disappears.
 */
const MAX_PLATE_TILES = 14;

export function makePlates(ctx) {
  const displayName = (species) => titleCase(species?.display ?? species?.name ?? '');

  /** The trainer's and the lead's own plates — always at most two entries. */
  function partyPlates() {
    const sim = ctx.get('simulation');
    if (!isLive(sim) || typeof sim.lineup !== 'function') return [];
    if (typeof sim.debug === 'function' && !sim.debug().placed) return [];

    const economy = ctx.get('economy');
    const pokemon = ctx.get('pokemon');
    const enc = ctx.get('encounter');
    const active = isLive(enc) && typeof enc.active === 'function' ? enc.active() : null;
    // **The live fight, not the party record** — the same reason `panels/battle.js` reads
    // `active.duel.run.state` instead of `pokemon.lead()` mid-duel: HP is written back to the
    // instance only when the fight ends (DECISIONS #72), so a plate reading `pokemon.lead()`
    // while a fight is running shows a full bar over a Pokémon that is about to faint.
    const fighting = !!active?.battle && active.battle.win === null;
    const st = fighting && active.duel?.engine ? active.duel.run?.state : null;

    const out = [];
    for (const m of sim.lineup()) {
      if (m.role === 'trainer') {
        const t = isLive(economy) && typeof economy.trainer === 'function' ? economy.trainer() : null;
        out.push({
          x: m.x, y: m.y, z: m.z, lift: TRAINER_LIFT,
          name: 'Trainer', level: Number.isFinite(t?.level) ? t.level : null, bar: null,
        });
      } else if (m.role === 'pokemon') {
        const lead = isLive(pokemon) && typeof pokemon.lead === 'function' ? pokemon.lead() : null;
        if (!lead) continue;
        const side = st?.a ?? null;
        const hp = Math.max(0, (side ?? lead)?.hp ?? 0);
        const maxHp = Math.max(1, (side ?? lead)?.maxHp ?? 1);
        out.push({
          x: m.x, y: m.y, z: m.z, lift: POKEMON_LIFT,
          name: displayName(lead.species), level: side?.level ?? lead.level ?? null,
          shiny: !!lead.shiny, bar: { hp, maxHp },
        });
      }
    }
    return out;
  }

  /** Every wild still wandering an occupied slot — not the one being fought, see below. */
  function wanderingPlates(slots, npcs) {
    const out = [];
    for (const s of slots) {
      if (!s.occupied) continue;
      const live = npcs.find((n) => n.id === s.npcId);
      if (!live) continue; // a slot can report occupied for one tick after its npc is gone
      out.push({
        x: live.x, y: live.y, z: live.z, lift: POKEMON_LIFT,
        name: s.display ?? titleCase(s.species ?? ''), level: s.level ?? null,
        shiny: !!s.shiny, bar: { hp: 1, maxHp: 1 }, // full — nothing has struck it yet
      });
    }
    return out;
  }

  /**
   * The wild currently being fought, if any — not gated on `hunts.current()`. Engaging a slot
   * hands the creature to `encounter` (DECISIONS #84), which retires the map NPC the moment
   * its own actor exists, so a slot mid-fight is simply not in `hunts.slots()`'s occupied list
   * any more; this reads `encounter.scene()`/`active()` instead, with the live duel HP
   * `panels/battle.js` already reads. Checked independently of the wandering slots above so a
   * fight in progress never loses its plate to `hunts.current()` going stale mid-transition
   * (`hunts`'s own `currentId` is not reset on `world:unloaded`, only on the next `enter()`).
   */
  function fightingWildPlate() {
    const enc = ctx.get('encounter');
    const active = isLive(enc) && typeof enc.active === 'function' ? enc.active() : null;
    const scene = isLive(enc) && typeof enc.scene === 'function' ? enc.scene() : null;
    if (!active?.battle || !scene?.at) return null;
    const st = active.duel?.engine ? active.duel.run?.state : null;
    const side = st?.b ?? null;
    const hp = st ? Math.max(0, side.hp) : Math.round((Number(active.hpFraction) || 0) * 100);
    const maxHp = st ? Math.max(1, side.maxHp) : 100;
    return {
      x: scene.at.cx + 0.5, y: scene.at.y, z: scene.at.cz + 0.5, lift: scene.headLift ?? POKEMON_LIFT,
      name: active.display ?? titleCase(active.species ?? ''), level: active.level ?? null,
      shiny: !!active.shiny, bar: { hp, maxHp },
    };
  }

  /** Everyone else standing around: a name, and nothing a fight would need. */
  function npcPlates(npcs, skipIds) {
    const pokemon = ctx.get('pokemon');
    const out = [];
    for (const n of npcs) {
      if (skipIds.has(n.id)) continue;
      let name = n.display;
      if (!name && n.species) {
        const rec = isLive(pokemon) && typeof pokemon.species === 'function' ? pokemon.species(n.species) : null;
        name = displayName(rec) || titleCase(n.species);
      }
      if (!name) name = titleCase(String(n.name ?? '').split('/').pop() ?? '');
      if (!name) continue;
      out.push({
        x: n.x, y: n.y, z: n.z, lift: n.species ? POKEMON_LIFT : TRAINER_LIFT,
        name, level: null, bar: null,
      });
    }
    return out;
  }

  return {
    /** Everything a plate is drawn for, this paint. Capped, sorted back-to-front. */
    read() {
      const party = partyPlates();

      // `sim.npcs()` and `hunts.slots()` are each read exactly once per paint and shared
      // between `wildPlates`/`npcPlates` — both used to fetch their own copy, which meant a
      // `poseWalker` pass over every spawned NPC (up to 32) twice a frame for nothing.
      const sim = ctx.get('simulation');
      const npcs = isLive(sim) && typeof sim.npcs === 'function' ? sim.npcs() : [];
      const hunts = ctx.get('hunts');
      const hunting = isLive(hunts) && typeof hunts.current === 'function' && typeof hunts.slots === 'function' && hunts.current();
      const slots = hunting ? hunts.slots() : [];

      const wildIds = new Set();
      for (const s of slots) if (s.occupied && s.npcId) wildIds.add(s.npcId);

      let wild = hunting ? wanderingPlates(slots, npcs) : [];
      const fighting = fightingWildPlate();
      if (fighting) wild.push(fighting);
      let rest = npcPlates(npcs, wildIds);

      // The distance cutoff (`MAX_PLATE_TILES`) — never on the party's own two, which are
      // always near the camera's focus anyway and are the two entries a player least wants to
      // lose.
      const at = isLive(sim) && typeof sim.player === 'function' ? sim.player() : null;
      if (at) {
        const near = (p) => Math.max(Math.abs(Math.floor(p.x) - at.cx), Math.abs(Math.floor(p.z) - at.cz)) <= MAX_PLATE_TILES;
        wild = wild.filter(near);
        rest = rest.filter(near);
      }

      const list = [...party, ...wild, ...rest];
      return list.length > MAX_PLATES ? list.slice(0, MAX_PLATES) : list;
    },

    /**
     * Paints every plate, projecting each world anchor through the camera — same discipline
     * as `callout.js`: `project` is handed in rather than imported, so this file stays free of
     * `three`.
     *
     * `opts.bottomLimit` keeps a plate off the party bar and the button strip; `opts.avoid` (a
     * `{x,y,w,h}` box, from the battle card's own `draw()` return — `ui/index.js`) is a plate
     * a card is already sitting on top of, and a plate that landed under a docked card, rather
     * than behind a full-screen scrim, would otherwise print half-legible across it. A plate
     * that would overlap it is skipped for the frame rather than nudged: repositioning it risks
     * landing on a *different* plate, and one missing label for one frame reads better than two
     * overlapping ones.
     */
    draw(g, project, list, opts = {}) {
      const { bottomLimit = g.height, avoid = null } = opts;
      if (!list?.length || typeof project !== 'function') return;
      // Back-to-front by the screen row the head sits on, so two plates close enough to
      // overlap stack the way the creatures behind them would.
      const ordered = [...list].sort((a, b) => {
        const pa = project(a.x, a.y, a.z);
        const pb = project(b.x, b.y, b.z);
        return (pa?.y ?? 0) - (pb?.y ?? 0);
      });
      // The bottom strip (the party bar, the button chips) owns the last row of the buffer —
      // a plate over a wild standing far off, near the horizon, projects low on screen and
      // would otherwise sit on top of them.
      const floor = Math.max(2, Math.min(g.height, bottomLimit) - 2);
      const overlaps = (r1, r2) => r1.x < r2.x + r2.w && r1.x + r1.w > r2.x && r1.y < r2.y + r2.h && r1.y + r1.h > r2.y;
      // The padding the background strip below adds beyond the logical `x,y,w,h` — collision
      // has to test against the **painted** footprint, not the tighter box text is laid out
      // in, or two backgrounds can still touch by exactly this many pixels even when their
      // logical boxes do not (measured: a 1 px vertical seam between two stacked plates,
      // `PAD_Y` short).
      const PAD_X = 2, PAD_Y = 1;
      const painted = (r) => ({ x: r.x - PAD_X, y: r.y - PAD_Y, w: r.w + PAD_X * 2, h: r.h + PAD_Y * 2 });
      /** Already-drawn plates this paint (painted footprints), so two creatures standing close
       *  together stack their labels instead of printing one over the other. */
      const placed = [];
      for (const p of ordered) {
        const at = project(p.x, p.y + p.lift, p.z);
        if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
        const lvl = Number.isFinite(p.level) ? `Lv ${p.level}` : '';
        const nameW = g.measure(p.name);
        const lvlW = lvl ? g.measure(lvl) : 0;
        const starW = p.shiny ? g.measure('★') + 2 : 0;
        const rowW = nameW + starW + (lvlW ? lvlW + 6 : 0);
        const w = Math.max(rowW, p.bar ? BAR_MIN_W : 0);
        const h = HEIGHT + (p.bar ? ROW_GAP + BAR_H : 0);
        const x = Math.round(Math.max(2, Math.min(g.width - w - 2, at.x - w / 2)));
        let y = Math.round(Math.max(2, Math.min(floor - h, at.y - h)));

        if (avoid && overlaps(painted({ x, y, w, h }), avoid)) continue;
        // Nudged below whatever it lands on, a bounded number of times. Two plates squeezed
        // against the floor with nowhere left to go are **skipped**, not forced back onto the
        // spot they were just pushed off of — snapping a losing nudge back to `floor - h`
        // landed it right on top of the very plate it was trying to clear, which read as one
        // plate with two names stitched together rather than as two.
        let blocked = false;
        for (let tries = 0; tries < 6; tries++) {
          const hit = placed.find((r) => overlaps(painted({ x, y, w, h }), r));
          if (!hit) break;
          // `hit` is already a painted rect; push the new plate's logical top just past its
          // painted bottom, plus one clear pixel and this plate's own top padding.
          y = hit.y + hit.h + 1 + PAD_Y;
          if (y + h + PAD_Y > floor) { blocked = true; break; }
        }
        if (blocked || placed.some((r) => overlaps(painted({ x, y, w, h }), r))) continue;
        placed.push(painted({ x, y, w, h }));

        // A dark strip under the text, not a full panel: a plate is a label, not a window,
        // and grass under a bright name is otherwise unreadable at every time of day.
        g.fill(x - PAD_X, y - PAD_Y, w + PAD_X * 2, HEIGHT + PAD_Y * 2, 'rgba(10,9,14,0.55)');
        const afterName = g.text(x, y, p.name, C.wallHi, { max: nameW });
        if (p.shiny) g.text(afterName + 2, y, '★', C.glowDeep);
        if (lvl) g.textRight(x + w, y, lvl, C.deepDim);

        if (p.bar) {
          const frac = p.bar.maxHp > 0 ? p.bar.hp / p.bar.maxHp : 0;
          meter(g, { x, y: y + HEIGHT + ROW_GAP, w, h: BAR_H }, frac, hpInk(frac));
        }
      }
    },
  };
}
