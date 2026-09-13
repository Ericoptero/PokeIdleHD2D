/**
 * plates.js — the name, level and HP bar every trainer, Pokémon and wild carries above its
 * own head, MMORPG-style.
 *
 * Two halves, the same split `hud.js` already draws: `read()` gathers the world through
 * published APIs at paint time (a quarantined `hunts` or `encounter` costs this file its
 * wild plates, never a crash), and `draw()` syncs a `.ci-nameplate` DOM node per entry into
 * `dom/world.js`'s world-anchor layer, positioned every frame off `ui/index.js`'s
 * `projectClient()`. Moved off the bitmap-font HUD canvas onto the design system — see that
 * file's own header for why nothing here needs `three` or a canvas painter.
 *
 * **What gets a level and a bar, and what gets only a name** (the user's own call, not a
 * guess): the trainer, the party's lead and every wild Pokémon in a hunt carry a level; only
 * the two Pokémon carry an HP bar (a trainer has no HP in this game — no field to draw one
 * from, and no mainline game draws one either). Every other NPC — a city local, Nurse Joy — is
 * scenery with nothing to fight, so it gets a name and nothing else.
 */

import { titleCase } from './format.js';
import { h, setText, syncList } from './dom/el.js';

const isLive = (api) => !!api && api.__missing === undefined;

/**
 * How high above a Pokémon's feet its plate floats, in world units — the **fallback** now,
 * not the primary source. Every entry `simulation.lineup()`/`simulation.npcs()` hands back
 * carries its own `headLift`, measured off the live actor's quad
 * (`pokemon/sprites.js`'s `headLiftOf`), and `partyPlates()`/`wanderingPlates()`/`npcPlates()`
 * below prefer that; this constant only steps in when a headLift is not available — a
 * quarantined `pokemon`, or a slot that has not spawned its sprite yet. Kept a touch generous
 * (clears the tallest sheets rather than being exact for any one of them) because a fallback
 * that came in short would clip the plate into the sprite's own head. Exported: `ui/index.js`
 * reuses it as the same fallback for a balloon anchored *above* the plate.
 */
export const POKEMON_LIFT = 3.1;
/**
 * How high above the trainer's feet its plate floats — the fallback, for the same reason and
 * the same callers as `POKEMON_LIFT`. The trainer sheet is one fixed size (32×768, 32-texel
 * frames) — 16 texels/unit stretched by `1/cos(45°)` is 2 world units tall — so this constant
 * happens to be exact rather than merely generous, but it is still only reached when a
 * `headLift` measured off the live actor is not available.
 */
export const TRAINER_LIFT = 2 * (1 / Math.cos((45 * Math.PI) / 180)) + 0.3;

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
 * whole of a slot's tether radius plus the two cells `hunts` stages it at (src/hunts/index.js) comfortably
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
    // instance only when the fight ends, so a plate reading `pokemon.lead()`
    // while a fight is running shows a full bar over a Pokémon that is about to faint.
    const fighting = !!active?.battle && active.battle.win === null;
    const st = fighting && active.duel?.engine ? active.duel.run?.state : null;

    const out = [];
    for (const m of sim.lineup()) {
      if (m.role === 'trainer') {
        const t = isLive(economy) && typeof economy.trainer === 'function' ? economy.trainer() : null;
        out.push({
          key: 'trainer', x: m.x, y: m.y, z: m.z, lift: m.headLift ?? TRAINER_LIFT,
          name: 'Trainer', level: Number.isFinite(t?.level) ? t.level : null, bar: null,
        });
      } else if (m.role === 'pokemon') {
        const lead = isLive(pokemon) && typeof pokemon.lead === 'function' ? pokemon.lead() : null;
        if (!lead) continue;
        const side = st?.a ?? null;
        // **Identity comes from the live combatant while one is fighting, not just its HP.**
        // `encounter`'s `nextAlly` calls `pokemon.setLead()` the instant a swap happens
        // (`encounter/index.js`), so `pokemon.lead()` itself now tracks a mid-duel swap too —
        // but the two can still disagree for exactly one tick around the swap (the bus event
        // that moves `lead` and the engine's own `state.a` are not the same write), and `side`
        // (the engine's own combatant, cloned fresh every turn — `battle/engine.js`) is the
        // one both the sprite and the moves actually agree with at every instant. Falling back
        // to `lead` only when nothing is fighting.
        const name = side ? (side.display ?? side.species) : displayName(lead.species);
        const hp = Math.max(0, (side ?? lead)?.hp ?? 0);
        const maxHp = Math.max(1, (side ?? lead)?.maxHp ?? 1);
        out.push({
          key: 'party-pokemon', x: m.x, y: m.y, z: m.z, lift: m.headLift ?? POKEMON_LIFT,
          name, level: side?.level ?? lead.level ?? null,
          shiny: side ? !!side.shiny : !!lead.shiny, bar: { hp, maxHp },
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
        key: `wild:${s.npcId}`, x: live.x, y: live.y, z: live.z, lift: live.headLift ?? POKEMON_LIFT,
        name: s.display ?? titleCase(s.species ?? ''), level: s.level ?? null,
        shiny: !!s.shiny, bar: { hp: 1, maxHp: 1 }, // full — nothing has struck it yet
      });
    }
    return out;
  }

  /**
   * The wild currently being fought, if any — not gated on `hunts.current()`. Engaging a slot
   * hands the creature to `encounter`, which retires the map NPC the moment
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
      key: 'wild:fighting', x: scene.at.cx + 0.5, y: scene.at.y, z: scene.at.cz + 0.5, lift: scene.headLift ?? POKEMON_LIFT,
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
        key: `npc:${n.id}`, x: n.x, y: n.y, z: n.z,
        lift: n.headLift ?? (n.species ? POKEMON_LIFT : TRAINER_LIFT),
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
     * Syncs `container`'s children to `list`, one `.ci-nameplate` per entry, positioned with
     * `left`/`top` off `projectClient` (real, viewport CSS pixels — `ui/index.js`'s own
     * bridge, replacing the internal-buffer `project()` the canvas version used).
     *
     * Reconciled by `p.key` (`syncList`, `dom/el.js`) rather than rebuilt every frame: a
     * plate's DOM node is real work for the browser's layout/paint, and most plates are the
     * same handful of creatures frame to frame.
     *
     * **What this deliberately drops from the canvas version**: the pixel-perfect
     * overlap-avoidance/nudge system (`ui/plates.js`'s previous `draw()` — measuring painted
     * footprints and nudging a plate below whatever it collided with). That measured against a
     * fixed-width bitmap font on a fixed low-res buffer; DOM text is proportional and would
     * need a `getBoundingClientRect()` read per plate per frame to reproduce, which is a
     * layout thrash this project's own render budget (`tools/shots/shoot.js`) does not have
     * room for. `MAX_PLATE_TILES`/`MAX_PLATES` (`read()`, above) already keep the crowd small
     * enough that the occasional overlap between two DOM labels — which still each render
     * legibly on their own background, unlike two labels sharing one bitmap atlas — is a minor
     * cosmetic case rather than the illegible smear it would have been on canvas.
     */
    draw(container, projectClient, list) {
      if (!container) return;
      if (!list?.length || typeof projectClient !== 'function') { container.replaceChildren(); return; }
      syncList(container, list, (p) => p.key,
        () => {
          const row = h('div', { class: 'ci-nameplate__row' }, [
            h('span', { class: 'ci-nameplate__name' }),
            h('span', { class: 'ci-nameplate__star', hidden: true }, '★'),
            h('span', { class: 'ci-nameplate__level' }),
          ]);
          const fill = h('div', { class: 'ci-nameplate__hp-fill' });
          const bar = h('div', { class: 'ci-nameplate__hp', hidden: true }, fill);
          return h('div', { class: 'ci-nameplate' }, [row, bar]);
        },
        (el, p) => {
          const at = projectClient(p.x, p.y + p.lift, p.z);
          el.hidden = !at || !Number.isFinite(at.x) || !Number.isFinite(at.y);
          if (el.hidden) return;
          el.style.left = `${at.x}px`;
          el.style.top = `${at.y}px`;
          const [row, bar] = el.children;
          const [nameEl, starEl, lvlEl] = row.children;
          setText(nameEl, p.name);
          starEl.hidden = !p.shiny;
          const lvl = Number.isFinite(p.level) ? `Lv ${p.level}` : '';
          setText(lvlEl, lvl);
          lvlEl.hidden = !lvl;
          bar.hidden = !p.bar;
          if (p.bar) {
            const frac = p.bar.maxHp > 0 ? p.bar.hp / p.bar.maxHp : 0;
            const fill = bar.firstChild;
            fill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
            fill.dataset.band = frac <= 0.2 ? 'low' : frac <= 0.5 ? 'mid' : 'high';
          }
        });
    },
  };
}
