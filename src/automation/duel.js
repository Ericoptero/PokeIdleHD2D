/**
 * duel.js — what the player would have done, decided without them.
 *
 * The brief asks for four decisions inside a fight: heal at a threshold, revive when something
 * falls, put PP back before a move runs dry, and send out the member that can win. All four are
 * **pure functions of configuration and state**, which is not a style preference:
 *
 *   - the visible fight steps `battle.stepper` on a sim cadence and calls these between turns;
 *   - `idle` and `offline` drain the same stepper and call the same functions;
 *
 * so anything that made a different decision in one path than the other would make a replayed
 * fight a different fight (DECISIONS #72). **No function here draws a random number**, reads a
 * clock, or reaches a module. Items are named, never spent — `applyAction` in `battle` changes
 * the combatant and the *caller* debits the bag, which is what lets one implementation serve a
 * live `economy.take()` and an offline carry.
 *
 * Runs under plain Node, and `selftest.js` holds it to literals.
 */

/**
 * The healing ladder, in the order the brief gives it.
 *
 * **Dearest first, and that is the whole point of the ordering.** A Potion at 10 % HP is a
 * Potion wasted: it does not prevent the faint it was spent on, and the faint costs the item
 * *and* the Pokémon. So the rule that fires at the lowest HP hands over the biggest bottle, and
 * the cheap ones only ever fire while there is still room for them to matter.
 *
 * `enabled` is per rule because the brief says so, and because a player who wants to hoard Max
 * Potions should be able to switch one rung off without deleting it and losing its threshold.
 */
export const HEAL_DEFAULTS = Object.freeze([
  { item: 'maxpotion', enabled: true, atPercent: 10 },
  { item: 'hyperpotion', enabled: true, atPercent: 22 },
  { item: 'superpotion', enabled: true, atPercent: 32 },
  { item: 'potion', enabled: true, atPercent: 45 },
]);

/**
 * Revival. `any` raises whoever needs it; `specific` raises only the named member.
 *
 * Revive before Max Revive, because a Revive is half the price for the half of the HP bar the
 * heal ladder above is going to top up anyway.
 */
export const REVIVE_DEFAULTS = Object.freeze({
  mode: 'any', order: Object.freeze(['revive', 'maxrevive']), member: null, enabled: true,
});

/**
 * PP restoration, watching the **highest-priority move** rather than the emptiest.
 *
 * That is the brief's wording and it is the right target: the top move is the one `choose` will
 * reach for every turn, so it is the one whose running out changes how the fight goes. A
 * threshold of 0 % means "when it is actually empty", which is the default because an Ether is
 * dear and a second-choice move is usually fine.
 */
export const ETHER_DEFAULTS = Object.freeze({
  enabled: true, atPercent: 0, order: Object.freeze(['ether', 'maxether']),
});

/** Lead selection. `auto` scores the matchup; `manual` reads the player's own assignment. */
export const LEAD_DEFAULTS = Object.freeze({ mode: 'auto', assign: Object.freeze({}) });

const pct = (n, d) => (d > 0 ? (n / d) * 100 : 0);
const has = (stock, id) => (Number(stock?.[id]) || 0) > 0;

/**
 * The first rung that applies: enabled, at or under its threshold, and in the bag.
 *
 * "And in the bag" is load-bearing rather than defensive. Without it the ladder stops at the
 * first *threshold* it meets and reports nothing when that item has run out — so a party with
 * no Max Potions and a shelf of Potions would sit at 8 % HP and die holding them.
 */
export function healChoice(rules, self, stock, itemOf) {
  if (!self || self.hp <= 0) return null;
  const p = pct(self.hp, self.maxHp);
  for (const r of rules ?? []) {
    if (!r || r.enabled === false) continue;
    if (p > (Number(r.atPercent) || 0)) continue;
    if (!has(stock, r.item)) continue;
    const heal = itemOf?.(r.item)?.heal;
    if (!heal || heal.hp === undefined) continue;
    return { kind: 'heal', item: r.item, hp: heal.hp, status: !!heal.status };
  }
  return null;
}

/** The first revival item in the order that is actually in the bag. */
export function reviveChoice(cfg, self, stock, itemOf) {
  const c = { ...REVIVE_DEFAULTS, ...(cfg ?? {}) };
  if (c.enabled === false) return null;
  if (!self || self.hp > 0) return null;
  if (c.mode === 'specific' && c.member && self.instanceId !== c.member) return null;
  for (const id of c.order ?? []) {
    if (!has(stock, id)) continue;
    const heal = itemOf?.(id)?.heal;
    if (!heal || heal.revive === undefined) continue;
    return { kind: 'revive', item: id, fraction: Number(heal.revive) || 0.5 };
  }
  return null;
}

/**
 * PP for the move the Pokémon would rather be using.
 *
 * The "highest-priority move" is the first slot the player pinned, and its own slot order when
 * they pinned nothing — which is the order `movesFor` built and therefore the order `choose`
 * breaks ties on.
 */
export function etherChoice(cfg, self, stock, itemOf) {
  const c = { ...ETHER_DEFAULTS, ...(cfg ?? {}) };
  if (c.enabled === false || !self || self.hp <= 0) return null;
  const slots = self.moves ?? [];
  if (!slots.length) return null;
  const priority = Array.isArray(self.priority) ? self.priority : [];
  const top = slots.find((m) => m.id === priority[0]) ?? slots[0];
  if (!top || !top.maxPp) return null;
  if (pct(top.pp, top.maxPp) > (Number(c.atPercent) || 0)) return null;
  for (const id of c.order ?? []) {
    if (!has(stock, id)) continue;
    const heal = itemOf?.(id)?.heal;
    if (!heal || heal.pp === undefined) continue;
    return { kind: 'pp', item: id, moveId: top.id, amount: heal.pp };
  }
  return null;
}

/**
 * The party member to send at this wild.
 *
 * The brief's weighting, in its own order: **offence first**, then how well it survives what
 * the wild throws back, then current HP as a tiebreak. Fainted members are never eligible —
 * which is the rule a Potion used to be able to break (DECISIONS #72).
 *
 * Everything it needs is injected: `effectiveness(atkType, defTypes)` and `movesOf(member)` come
 * from `battle` through `ctx.get`, so this file stays importable under Node with two stubs and
 * `automation` does not grow a dependency on the engine.
 *
 * @param {object[]} party
 * @param {{types:string[], moves?:{id:string}[]}} wild
 * @param {{effectiveness:Function, typesOf:Function, movesOf:Function}} deps
 */
export function leadChoice(party, wild, deps = {}, cfg = null) {
  const c = { ...LEAD_DEFAULTS, ...(cfg ?? {}) };
  const alive = (party ?? []).filter((m) => m && m.hp > 0);
  if (!alive.length) return null;

  if (c.mode === 'manual') {
    const wanted = c.assign?.[wild?.species ?? wild?.name];
    const pick = alive.find((m) => m.instanceId === wanted);
    // A manual assignment that names a fainted member falls through to the party's own order
    // rather than refusing to fight: the brief says manual lead may only pick a conscious one.
    return (pick ?? alive[0]).instanceId;
  }

  const eff = deps.effectiveness ?? (() => 1);
  const typesOf = deps.typesOf ?? ((m) => m?.species?.types ?? []);
  const movesOf = deps.movesOf ?? ((m) => m?.moves ?? []);
  const wildTypes = (wild?.types ?? []).map((t) => String(t).toLowerCase());

  let best = null;
  for (const m of alive) {
    // Offence: the best multiplier any move it can still pay for reaches against the wild.
    let offence = 0;
    for (const slot of movesOf(m)) {
      if ((slot.pp ?? 1) <= 0) continue;
      const t = slot.type ?? slot.t;
      if (!t) continue;
      offence = Math.max(offence, eff(t, wildTypes));
    }
    if (offence === 0) offence = 0.25;              // Struggle is typeless, and it is not nothing

    // Defence: the worst the wild's own moves would do back. Unknown moves fall back to its
    // types, which is what a player reads off the sprite anyway.
    const incoming = (wild?.moves ?? []).map((x) => x.type ?? x.t).filter(Boolean);
    const against = incoming.length ? incoming : wildTypes;
    const mine = (typesOf(m) ?? []).map((t) => String(t).toLowerCase());
    let worst = 0;
    for (const t of against) worst = Math.max(worst, eff(t, mine));
    const defence = worst > 0 ? 1 / worst : 4;

    const health = m.maxHp > 0 ? m.hp / m.maxHp : 0;
    // Offence dominates, defence breaks its ties, health breaks those. The weights are spread
    // far enough apart that the order is the order rather than a blend that can invert it.
    const score = offence * 1000 + defence * 10 + health;
    if (!best || score > best.score) best = { score, id: m.instanceId };
  }
  return best?.id ?? alive[0].instanceId;
}

/**
 * The `between` hook `battle.stepper` calls before every turn.
 *
 * Composed in the brief's own order — **revive, then heal, then ether** — and it returns at most
 * one action per call, because each one is a turn's worth of pause and stacking them would let a
 * single gap swallow three items. The stepper calls it again next turn.
 *
 * `stock` is a plain `{id: count}` snapshot the caller keeps in step with whatever it is
 * spending from, so this function never learns what a bag is.
 */
export function betweenFor(cfg, stock, itemOf) {
  const heal = cfg?.heal ?? HEAL_DEFAULTS;
  return (state) => {
    const self = state?.a;
    if (!self) return [];
    const act = reviveChoice(cfg?.revive, self, stock, itemOf)
      ?? healChoice(heal, self, stock, itemOf)
      ?? etherChoice(cfg?.ether, self, stock, itemOf);
    return act ? [act] : [];
  };
}
