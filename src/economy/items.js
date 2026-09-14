/**
 * The item catalog: balls, medicine, evolution items, EXP candy, lures and loot.
 *
 * Two rules the whole module leans on:
 *
 * 1. **Ball multipliers are the mainline numbers.** A Great Ball is 1.5×, an Ultra Ball
 *    2×, a Dusk Ball 3× at night or underground, a Quick Ball 5× on the first turn — the
 *    values Gen 8/9 uses, not invented ones. Conditional balls carry a `mult(context)`
 *    function instead of a constant, so `economy.catchMultiplier(id, context)` is a real
 *    evaluation of the same rule the games use rather than a lookup of an average.
 *    Idle battles resolve in one exchange, which makes the Quick Ball genuinely the best
 *    ball in the game — that is why it is priced in BP and not in money (see `shops.js`).
 *
 * 2. **Every item has an honest sell value.** `sell` is what a shop pays, always ≤ half of
 *    what it charges, so buy-then-sell can never be an income loop. Loot items
 *    (`category: 'treasure'`) have no buy price at all: they exist only to be sold, which
 *    is the mainline's oldest money faucet and the one that keeps hunting worthwhile after
 *    the idle rate has outgrown battle payouts.
 *
 * Prices are Poké Dollars unless the entry says otherwise. Where a mainline price exists
 * it is used verbatim; where our economy needed a different shape (Ultra Balls, EXP candy,
 * lures) the deviation is noted on the entry.
 */

/**
 * @typedef {Object} BallContext
 * @property {{id?:number,name?:string,types?:string[],baseStats?:Object,weightKg?:number}} [species]
 * @property {number} [level]        the wild Pokémon's level
 * @property {number} [partyLevel]   the lead Pokémon's level (Level Ball)
 * @property {number} [tod]          hours 0..24 (Dusk Ball)
 * @property {string} [biome]        the loaded map's gameplay-profile id — informational;
 *                                    no ball keys off it directly (see `tags`)
 * @property {string[]} [tags]       category tags the map declares, e.g. `'cave'`,
 *                                    `'coastal'` (Dusk / Dive Ball) — a category, not an id,
 *                                    because two differently-named maps could both be caves
 * @property {number} [turn]         1-based; idle battles resolve on turn 1 (Quick / Timer)
 * @property {boolean} [caught]      species already in the dex (Repeat Ball)
 * @property {boolean} [asleep]      (Dream Ball)
 * @property {boolean} [fishing]
 */

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

/** Night is the mainline Dusk Ball window: 20:00 → 04:00. */
export const isNight = (tod) => Number.isFinite(tod) && (tod >= 20 || tod < 4);

const hasType = (species, t) => Array.isArray(species?.types) && species.types.includes(t);

/** Species that evolve by Moon Stone, for the Moon Ball. Small on purpose: it is a list. */
const MOON_FAMILY = new Set([
  'nidoran-f', 'nidorina', 'nidoran-m', 'nidorino', 'clefairy', 'cleffa', 'jigglypuff',
  'igglybuff', 'skitty', 'munna', 'nidoranf', 'nidoranm',
]);

/**
 * @typedef {Object} ItemDef
 * @property {string} id
 * @property {string} name
 * @property {'ball'|'medicine'|'evolution'|'candy'|'lure'|'treasure'|'held'|'key'} category
 * @property {string} desc
 * @property {number} tier          1 = starting shelf … 5 = end-game shelf
 * @property {number} [price]       buy price, omitted if not purchasable anywhere
 * @property {'money'|'bp'|'shards'} [currency]  defaults to 'money'
 * @property {number} sell          what a shop pays for one, in Poké Dollars
 * @property {number} [stack]       per-slot cap before bag upgrades (default 99)
 * @property {number} [ball]        constant catch multiplier
 * @property {(c:BallContext)=>number} [ballMult]  conditional catch multiplier
 * @property {string} [when]        human-readable condition, shown in the shop
 * @property {Object} [heal]        { hp:number|'full', fraction?:number, status?:boolean,
 *                                   revive?:number, pp?:number|'full' }
 * @property {Object} [evolution]   { method:'stone'|'trade-item', key:string }
 * @property {number} [exp]         EXP candy payload
 * @property {Object} [buff]        { key:string, mult:number, seconds:number }
 * @property {Object} [passive]     permanent multiplier while owned { key, mult }
 */

/** @type {ItemDef[]} */
export const ITEMS = [
  // ── Balls ────────────────────────────────────────────────────────────────────
  // The spine of the economy. Tier 1–2 are money; the apricorn balls and the Quick Ball
  // are BP, because they are situationally *better* than an Ultra Ball and money is the
  // currency that inflates.
  { id: 'pokeball', name: 'Poké Ball', category: 'ball', tier: 1, price: 200, sell: 100, ball: 1,
    desc: 'The standard capsule. 1× catch rate.' },
  { id: 'greatball', name: 'Great Ball', category: 'ball', tier: 2, price: 600, sell: 300, ball: 1.5,
    desc: '1.5× catch rate. The workhorse of the mid game.' },
  { id: 'ultraball', name: 'Ultra Ball', category: 'ball', tier: 3, price: 1200, sell: 600, ball: 2,
    desc: '2× catch rate. Mainline sells these at ₽800; ours are ₽1,200 so the apricorn balls stay worth their BP.' },
  { id: 'premierball', name: 'Premier Ball', category: 'ball', tier: 1, sell: 100, ball: 1,
    desc: 'A commemorative Poké Ball. One free with every ten Poké Balls bought.' },
  { id: 'netball', name: 'Net Ball', category: 'ball', tier: 3, price: 1000, sell: 500,
    when: 'Water or Bug type', ballMult: (c) => (hasType(c.species, 'water') || hasType(c.species, 'bug') ? 3.5 : 1),
    desc: '3.5× on Water and Bug types, 1× otherwise.' },
  { id: 'nestball', name: 'Nest Ball', category: 'ball', tier: 2, price: 1000, sell: 500,
    when: 'low-level targets',
    ballMult: (c) => clamp((41 - (c.level ?? 20)) / 10, 1, 4),
    desc: 'Up to 4× on a level 1 target, falling to 1× at level 31 and above.' },
  { id: 'diveball', name: 'Dive Ball', category: 'ball', tier: 3, price: 1000, sell: 500,
    when: 'coast / water',
    // P5: was `c.biome === 'coast'`, an identity check against the fixed 5-entry enum. A map
    // now declares this as a category tag instead (`terrain.handle().tags`,
    // `src/hunts/biomes/coast.js`'s own `tags: ['coastal']`) — any map tagged coastal gets
    // the bonus, not only the one shipped map that happened to be named "coast".
    ballMult: (c) => (c.tags?.includes('coastal') || c.fishing ? 3.5 : 1),
    desc: '3.5× while fishing or hunting a coastal map.' },
  { id: 'duskball', name: 'Dusk Ball', category: 'ball', tier: 3, price: 1000, sell: 500,
    when: 'night or cave',
    // Same change as Dive Ball, above: `c.biome === 'cave'` -> `c.tags.includes('cave')`.
    ballMult: (c) => (c.tags?.includes('cave') || isNight(c.tod) ? 3 : 1),
    desc: '3× at night (20:00–04:00) or underground. The reason night hunts pay.' },
  { id: 'timerball', name: 'Timer Ball', category: 'ball', tier: 3, price: 1000, sell: 500,
    when: 'long battles',
    ballMult: (c) => clamp(1 + 0.3 * ((c.turn ?? 1) - 1), 1, 4),
    desc: '+0.3× per turn to a 4× cap. Idle battles resolve on turn one, so this is a manual-play ball.' },
  { id: 'repeatball', name: 'Repeat Ball', category: 'ball', tier: 3, price: 1000, sell: 500,
    when: 'species already in the dex',
    ballMult: (c) => (c.caught ? 3.5 : 1),
    desc: '3.5× on a species you have already caught — the shiny-hunting ball.' },
  { id: 'luxuryball', name: 'Luxury Ball', category: 'ball', tier: 3, price: 3000, sell: 1500, ball: 1,
    desc: '1×, but the catch is friendlier: friendship-based evolutions move twice as fast.' },
  { id: 'healball', name: 'Heal Ball', category: 'ball', tier: 2, price: 1500, sell: 750, ball: 1,
    desc: '1×, and the catch arrives at full HP with no status — saves a Potion each time.' },
  { id: 'quickball', name: 'Quick Ball', category: 'ball', tier: 4, price: 15, currency: 'bp', sell: 500,
    when: 'first turn only',
    ballMult: (c) => ((c.turn ?? 1) <= 1 ? 5 : 1),
    desc: '5× on the first turn. Every idle battle is a first turn, so this is the best ball you can stock.' },
  { id: 'levelball', name: 'Level Ball', category: 'ball', tier: 4, price: 12, currency: 'bp', sell: 400,
    when: 'lead out-levels the target',
    ballMult: (c) => {
      const mine = c.partyLevel ?? 0, theirs = Math.max(1, c.level ?? 1);
      if (mine >= theirs * 4) return 8;
      if (mine >= theirs * 2) return 4;
      if (mine > theirs) return 2;
      return 1;
    },
    desc: '8× / 4× / 2× as your lead out-levels the target by 4×, 2× or any amount.' },
  { id: 'moonball', name: 'Moon Ball', category: 'ball', tier: 4, price: 12, currency: 'bp', sell: 400,
    when: 'Moon Stone family',
    ballMult: (c) => (MOON_FAMILY.has(String(c.species?.name ?? '').toLowerCase()) ? 4 : 1),
    desc: '4× on the Moon Stone evolution family.' },
  { id: 'fastball', name: 'Fast Ball', category: 'ball', tier: 4, price: 12, currency: 'bp', sell: 400,
    when: 'base Speed ≥ 100',
    ballMult: (c) => ((c.species?.baseStats?.speed ?? c.species?.baseStats?.spe ?? 0) >= 100 ? 4 : 1),
    desc: '4× on anything with base Speed 100 or more.' },
  { id: 'heavyball', name: 'Heavy Ball', category: 'ball', tier: 4, price: 10, currency: 'bp', sell: 400,
    when: 'heavy targets',
    ballMult: (c) => {
      const kg = c.species?.weightKg ?? 0;
      if (kg >= 300) return 3.5;
      if (kg >= 200) return 2.5;
      if (kg >= 100) return 1.5;
      return 1;
    },
    desc: 'Scales with weight: 1.5× at 100 kg, 2.5× at 200 kg, 3.5× at 300 kg.' },
  { id: 'masterball', name: 'Master Ball', category: 'ball', tier: 5, price: 500, currency: 'bp', sell: 0,
    stack: 9, ball: 255,
    desc: 'Never fails. One per in-game day at the Exchange, and it cannot be sold.' },

  // ── Medicine ─────────────────────────────────────────────────────────────────
  // Downtime is the idle game's real enemy: a fainted party earns nothing. Medicine is
  // therefore priced per point of healing so that the big bottles are a convenience, not
  // a discount — Hyper Potion is ₽12.5/HP against the Potion's ₽10/HP.
  { id: 'potion', name: 'Potion', category: 'medicine', tier: 1, price: 200, sell: 100,
    heal: { hp: 20 }, desc: 'Restores 20 HP. ₽10 per point.' },
  { id: 'superpotion', name: 'Super Potion', category: 'medicine', tier: 2, price: 700, sell: 350,
    heal: { hp: 60 }, desc: 'Restores 60 HP. ₽11.7 per point.' },
  { id: 'hyperpotion', name: 'Hyper Potion', category: 'medicine', tier: 3, price: 1500, sell: 750,
    heal: { hp: 120 }, desc: 'Restores 120 HP. ₽12.5 per point — you pay for the fewer clicks.' },
  { id: 'maxpotion', name: 'Max Potion', category: 'medicine', tier: 4, price: 2500, sell: 1250,
    heal: { hp: 'full' }, desc: 'Fully restores HP.' },
  { id: 'fullrestore', name: 'Full Restore', category: 'medicine', tier: 4, price: 3000, sell: 1500,
    heal: { hp: 'full', status: true }, desc: 'Fully restores HP and clears status.' },
  { id: 'fullheal', name: 'Full Heal', category: 'medicine', tier: 2, price: 600, sell: 300,
    heal: { status: true }, desc: 'Clears any status condition.' },
  { id: 'revive', name: 'Revive', category: 'medicine', tier: 3, price: 2000, sell: 1000,
    heal: { revive: 0.5 }, desc: 'Revives a fainted Pokémon at half HP.' },
  { id: 'maxrevive', name: 'Max Revive', category: 'medicine', tier: 4, price: 4000, sell: 2000,
    heal: { revive: 1 }, desc: 'Revives a fainted Pokémon at full HP.' },
  // PP restoration. **These are new**: the game has modelled per-move PP since
  // the turn engine landed, and Struggle since with it, and there has never been anything in the
  // shop that put PP back — so a long hunt ended in a Pokemon flailing at 50 power with recoil,
  // with no purchasable answer. Auto-Ether is the automation the brief asks for, and this is
  // what it spends. Priced against the potion line: an Ether is ₽120 per PP against a Potion's
  // ₽10 per HP, because a point of PP is worth several turns of attacking and a point of HP is
  // worth one hit.
  { id: 'ether', name: 'Ether', category: 'medicine', tier: 2, price: 1200, sell: 600,
    heal: { pp: 10 }, desc: 'Restores 10 PP to one move.' },
  { id: 'maxether', name: 'Max Ether', category: 'medicine', tier: 3, price: 2000, sell: 1000,
    heal: { pp: 'full' }, desc: "Fully restores one move's PP." },

  // ── EXP candy ────────────────────────────────────────────────────────────────
  // The late-game money sink that matters. Idle income scales with √(party power) while
  // candy prices scale linearly with EXP, so buying levels always helps and never runs
  // away — 4× the money buys 4× the EXP but only 2× the income.
  { id: 'expcandy_xs', name: 'Exp. Candy XS', category: 'candy', tier: 1, price: 800, sell: 400, exp: 3000,
    desc: '3,000 EXP. ₽0.27 per point.' },
  { id: 'expcandy_s', name: 'Exp. Candy S', category: 'candy', tier: 2, price: 3000, sell: 1500, exp: 10000,
    desc: '10,000 EXP.' },
  { id: 'expcandy_m', name: 'Exp. Candy M', category: 'candy', tier: 3, price: 12000, sell: 6000, exp: 30000,
    desc: '30,000 EXP.' },
  { id: 'expcandy_l', name: 'Exp. Candy L', category: 'candy', tier: 4, price: 50000, sell: 25000, exp: 100000,
    desc: '100,000 EXP.' },
  { id: 'expcandy_xl', name: 'Exp. Candy XL', category: 'candy', tier: 5, price: 200000, sell: 100000, exp: 300000,
    desc: '300,000 EXP. The sink that keeps ₽ meaningful once the upgrade tracks are capped.' },
  { id: 'rarecandy', name: 'Rare Candy', category: 'candy', tier: 4, price: 25, currency: 'bp', sell: 2400,
    exp: 'level', desc: 'One level, whatever the level costs. BP-priced so money cannot buy the cap.' },

  // ── Evolution items ──────────────────────────────────────────────────────────
  // Shard-priced, and shards only come from Pokémon you release. Evolving therefore costs
  // collection, not cash: the one sink money is not allowed to reach.
  ...[
    ['firestone', 'Fire Stone'], ['waterstone', 'Water Stone'], ['thunderstone', 'Thunder Stone'],
    ['leafstone', 'Leaf Stone'], ['moonstone', 'Moon Stone'], ['sunstone', 'Sun Stone'],
    ['shinystone', 'Shiny Stone'], ['duskstone', 'Dusk Stone'], ['dawnstone', 'Dawn Stone'],
    ['icestone', 'Ice Stone'],
  ].map(([id, name]) => ({
    id, name, category: 'evolution', tier: 3, price: 40, currency: 'shards', sell: 1500,
    evolution: { method: 'stone', key: id },
    desc: `Evolves the ${name.split(' ')[0]} Stone family. 40 shards at the Shard Stall.`,
  })),
  ...[
    ['linkcable', 'Link Cable', 30], ['kingsrock', "King's Rock", 25], ['metalcoat', 'Metal Coat', 25],
    ['dragonscale', 'Dragon Scale', 25], ['upgradechip', 'Up-Grade', 30], ['dubiousdisc', 'Dubious Disc', 35],
    ['protector', 'Protector', 30], ['electirizer', 'Electirizer', 30], ['magmarizer', 'Magmarizer', 30],
    ['reapercloth', 'Reaper Cloth', 35], ['razorclaw', 'Razor Claw', 30], ['razorfang', 'Razor Fang', 30],
    ['ovalstone', 'Oval Stone', 20],
  ].map(([id, name, price]) => ({
    id, name, category: 'evolution', tier: 4, price, currency: 'bp', sell: 1000,
    evolution: { method: 'trade-item', key: id },
    desc: `${name}: completes a trade evolution. Battle Points only.`,
  })),

  // ── Lures ────────────────────────────────────────────────────────────────────
  // Timed encounter-rate buffs. They are the only consumable that touches the idle rate,
  // and they are priced so a lure pays for itself only while you are actively hunting a
  // biome that drops something you want.
  { id: 'lure', name: 'Lure', category: 'lure', tier: 2, price: 500, sell: 250,
    buff: { key: 'encounterRate', mult: 1.5, seconds: 600 },
    desc: '+50% encounter rate for 10 minutes.' },
  { id: 'superlure', name: 'Super Lure', category: 'lure', tier: 3, price: 1500, sell: 750,
    buff: { key: 'encounterRate', mult: 2, seconds: 1200 },
    desc: '+100% encounter rate for 20 minutes.' },
  { id: 'maxlure', name: 'Max Lure', category: 'lure', tier: 4, price: 4000, sell: 2000,
    buff: { key: 'encounterRate', mult: 2.5, seconds: 1800 },
    desc: '+150% encounter rate for 30 minutes.' },
  { id: 'goldenlure', name: 'Golden Lure', category: 'lure', tier: 5, price: 20, currency: 'bp', sell: 3000,
    buff: { key: 'shinyOdds', mult: 2, seconds: 1800 },
    desc: 'Doubles shiny odds for 30 minutes.' },

  // ── Held items you keep ──────────────────────────────────────────────────────
  // Owning one is a permanent multiplier, so they are milestone rewards rather than stock,
  // except the Amulet Coin, which the Department Store will sell you once you are rich
  // enough for it to be a real decision rather than an obvious one.
  { id: 'amuletcoin', name: 'Amulet Coin', category: 'held', tier: 4, price: 200000, sell: 0, stack: 1,
    passive: { key: 'moneyGain', mult: 1.5 },
    desc: '+50% money from every source, forever. One only.' },
  { id: 'luckyegg', name: 'Lucky Egg', category: 'held', tier: 4, sell: 0, stack: 1,
    passive: { key: 'expGain', mult: 1.5 },
    desc: '+50% EXP forever. Awarded at 60 species caught.' },
  { id: 'shinycharm', name: 'Shiny Charm', category: 'held', tier: 5, price: 400, currency: 'shards', sell: 0, stack: 1,
    passive: { key: 'shinyOdds', mult: 3 },
    desc: 'Triples shiny odds. 400 shards, and the shards have to come from somewhere.' },
  { id: 'catchingcharm', name: 'Catching Charm', category: 'held', tier: 4, sell: 0, stack: 1,
    passive: { key: 'catchRate', mult: 1.2 },
    desc: '+20% catch rate forever. Awarded at 30 species caught.' },
  { id: 'expcharm', name: 'Exp. Charm', category: 'held', tier: 3, sell: 0, stack: 1,
    passive: { key: 'expGain', mult: 1.25 },
    desc: '+25% EXP forever. Awarded at 10 species caught.' },

  // ── Treasure ─────────────────────────────────────────────────────────────────
  // Sell-only. Mainline sell prices verbatim: these numbers are load-bearing nostalgia and
  // they happen to make a clean five-order-of-magnitude ladder from Tiny Mushroom to
  // Comet Shard, which is exactly the span a hunt-loot table wants.
  { id: 'tinymushroom', name: 'Tiny Mushroom', category: 'treasure', tier: 1, sell: 250, desc: 'Sell-only loot.' },
  { id: 'bigmushroom', name: 'Big Mushroom', category: 'treasure', tier: 2, sell: 2500, desc: 'Sell-only loot.' },
  { id: 'balmmushroom', name: 'Balm Mushroom', category: 'treasure', tier: 4, sell: 25000, desc: 'Sell-only loot.' },
  { id: 'pearl', name: 'Pearl', category: 'treasure', tier: 1, sell: 1400, desc: 'Sell-only loot.' },
  { id: 'bigpearl', name: 'Big Pearl', category: 'treasure', tier: 2, sell: 4000, desc: 'Sell-only loot.' },
  { id: 'pearlstring', name: 'Pearl String', category: 'treasure', tier: 4, sell: 15000, desc: 'Sell-only loot.' },
  { id: 'stardust', name: 'Stardust', category: 'treasure', tier: 1, sell: 2000, desc: 'Sell-only loot.' },
  { id: 'starpiece', name: 'Star Piece', category: 'treasure', tier: 3, sell: 9800, desc: 'Sell-only loot.' },
  { id: 'cometshard', name: 'Comet Shard', category: 'treasure', tier: 5, sell: 60000, desc: 'Sell-only loot.' },
  { id: 'nugget', name: 'Nugget', category: 'treasure', tier: 2, sell: 5000, desc: 'Sell-only loot.' },
  { id: 'bignugget', name: 'Big Nugget', category: 'treasure', tier: 4, sell: 20000, desc: 'Sell-only loot.' },
  { id: 'rarebone', name: 'Rare Bone', category: 'treasure', tier: 3, sell: 5000, desc: 'Sell-only loot.' },
];

const BY_ID = new Map(ITEMS.map((i) => [i.id, Object.freeze(i)]));
Object.freeze(ITEMS);

/**
 * Which categories are **loot** rather than consumables.
 *
 * The whole of the Stash/Bag split, in one set. `treasure` items have no buy
 * price and exist only to be sold; everything else is something a hunt spends.
 */
/**
 * What a consumable is **for**, which is finer than what category it is in.
 *
 * The brief orders automatic buying by *Healing, Revival, PP restoration, Poké Balls* — and
 * three of those four are `category: 'medicine'`, so the category cannot express the order. The
 * payload can: an item that restores HP heals, one that raises a fainted Pokémon revives, one
 * that restores PP is PP. Derived rather than authored, so an item added tomorrow is classed
 * the day it lands.
 */
export function purchaseClass(def) {
  if (!def) return 'other';
  if (def.category === 'ball') return 'ball';
  const h = def.heal;
  if (h) {
    if (h.revive !== undefined) return 'revive';
    if (h.pp !== undefined) return 'pp';
    if (h.hp !== undefined) return 'heal';
    if (h.status) return 'heal';
  }
  return 'other';
}

/** The brief's own order, and the default an Auto-Buy budget is spent in. */
export const PURCHASE_ORDER = Object.freeze(['heal', 'revive', 'pp', 'ball', 'other']);

export const STASH_CATEGORIES = Object.freeze(new Set(['treasure']));
export const isStashItem = (def) => STASH_CATEGORIES.has(def?.category);

export const ITEM_IDS = Object.freeze(ITEMS.map((i) => i.id));

export function item(id) {
  return BY_ID.get(String(id)) ?? null;
}

export function itemsBy(pred) {
  return ITEMS.filter(pred);
}

/** Default per-slot cap before bag upgrades. Mainline is 999; we start lower and sell it. */
export const BASE_STACK = 99;

export function stackCap(id, bagLevel = 0) {
  const def = item(id);
  if (!def) return 0;
  if (def.stack != null) return def.stack;
  return BASE_STACK + 100 * bagLevel;
}

/**
 * The ball half of the catch equation. `economy` owns how good a ball is; `encounter`
 * owns the species catch rate, HP and status. Keep it that way and neither module has to
 * know the other's numbers.
 *
 * @param {string} id
 * @param {BallContext} [context]
 * @returns {number} multiplier; 255 means "never fails"
 */
export function ballMultiplier(id, context = {}) {
  const def = item(id);
  if (!def) return 0;
  if (typeof def.ballMult === 'function') {
    const n = def.ballMult(context);
    return Number.isFinite(n) ? n : 1;
  }
  return def.ball ?? 0;
}

/**
 * Gen 3/4 capture maths, with the ball multiplier from above.
 *
 *   a = (3·maxHP − 2·curHP) / (3·maxHP) · catchRate · ball · status
 *   p(shake) = 65536 / (255/a)^(3/16)   ,  p(catch) = p(shake)^4
 *
 * Exposed here because the ball is ours and the formula is short; `encounter` supplies
 * `catchRate`, `hpFraction` and `status` and decides what to do with the answer. Pure and
 * deterministic — no RNG in this file at all.
 *
 * @returns {number} probability in [0,1]
 */
export function catchOdds({
  ball = 'pokeball', catchRate = 45, hpFraction = 1, status = 'none', context = {}, bonus = 1,
} = {}) {
  const ballMult = ballMultiplier(ball, context);
  if (ballMult >= 255) return 1;
  const statusMult = status === 'sleep' || status === 'freeze' ? 2.5
    : status === 'paralysis' || status === 'poison' || status === 'burn' ? 1.5 : 1;
  const hp = clamp(hpFraction, 0.01, 1);
  const a = ((3 - 2 * hp) / 3) * catchRate * ballMult * statusMult * bonus;
  if (a >= 255) return 1;
  if (a <= 0) return 0;
  const shake = 65536 / Math.pow(255 / a, 3 / 16);
  return clamp(Math.pow(shake / 65536, 4), 0, 1);
}
