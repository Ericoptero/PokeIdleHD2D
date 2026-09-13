/**
 * The always-on HUD snapshot. `read()` is a pure data gather — the wallet, the party (with the
 * live-combatant override mid-fight), the clock and the trainer level — through published
 * module APIs only, so a quarantined `economy` or `pokemon` costs a blank chip rather than a
 * dead HUD. `dom/hud.js` (the real, always-on chrome) polls this every 0.2s; every DOM screen
 * that needs a display name (`models/trainer.js`, `screens/party.js`, `screens/boxes.js`)
 * reads `displayName` off the object this factory returns.
 *
 * The canvas paint functions this file used to carry (`drawWallet`/`drawClock`/`drawParty`/
 * `drawIcon`) are gone — Stage 9 converted every panel that still called them
 * (`party`/`boxes`/`battle`, the last three), and the wallet/clock/party bar themselves moved
 * to `#ui-dom` back in Stage 3. Nothing calls a canvas paint primitive through this module any
 * more.
 */

import { titleCase } from './format.js';

const isLive = (api) => !!api && api.__missing === undefined;

/**
 * The four currencies, in the order `read()`'s own wallet loop below uses. Local now, not
 * exported — every DOM screen that used to import this for its own currency order
 * (`screens/shop.js`, `models/trainer.js`) reads `economy.currencies()` directly instead, the
 * one canonical order living in `economy` itself.
 */
const WALLET = [
  { id: 'money', symbol: '₽', before: true },
  { id: 'research', symbol: '◈', before: false },
  { id: 'shards', symbol: '◆', before: false },
  { id: 'bp', symbol: 'BP', before: false },
];

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
     * Who the party bar marks: the live combatant `screens/battle.js`'s own `read()` already
     * reads (`st.a` — HP/PP is only written back to `pokemon` when the fight ends, so
     * `pokemon.party()` is stale for exactly the member being hit) for as long as a duel
     * object exists at all; otherwise `party[0]`, the lead. A second reader of the decision
     * the battle card already made, not a new source of truth — which means copying its
     * *whole* rule, not narrowing it: keep reading `duel.run.state.a` for as long as
     * `active.duel?.engine` exists, `win` included — a fight is `resolve()`d, and
     * `pokemon.setLead()` for a swapped-in finisher is a separate and later step (`encounter/
     * index.js`'s own comment: the player gets several seconds to decide whether to throw).
     * A first draft gated this on `win === null` (mid-fight only) and, for those few seconds
     * after every fight a mid-fight swap happened in, the party bar reverted to the original
     * (possibly fainted) lead while the battle card still correctly showed the finisher. The
     * marked slot's own hp/maxHp/status are overwritten with the live combatant's, for the
     * same reason: showing the party record's stale HP under a transcript that says
     * otherwise is the bug this rule exists to avoid.
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
    // in the caller, like everything else in this snapshot.
    let trainer = null;
    if (economy && economy.__missing === undefined && typeof economy.trainer === 'function') {
      const t = economy.trainer();
      if (Number.isFinite(t?.level)) trainer = t;
    }

    return { wallet, party, activeId, tod: Number(tod) || 0, phase, player, trainer };
  }

  function onPhase(p) { phase = p; }

  const displayName = (species) => titleCase(species?.display ?? species?.name ?? '');

  return { read, onPhase, displayName };
}
