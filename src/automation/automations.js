/**
 * The catalog — six automations, expressed entirely as data.
 *
 * Nothing in this file runs. It declares what each automation is called, what it costs to
 * unlock, which `idle` flag it turns on, which subject kind its rules test, which actions
 * its rules may take, what it can be configured with, and the ruleset it ships with. The
 * engine reads this table; `ui` renders it; `selftest.js` checks that every default rule
 * validates against the schema its own automation declares.
 *
 * ### Nothing is on by default (src/automation/index.js)
 *
 * Every automation starts `locked`. Unlocking spends **research (◈)** — the currency
 * `idle` mints and nothing else spends — and is a one-way purchase. Unlocking does not
 * enable: an unlocked automation still has to be switched on, so a player who buys
 * auto-release never wakes up to an empty box because they forgot a rule was live.
 *
 * ### Where the safety rails live
 *
 * In the *rules*, not in a settings panel. Auto-release ships with seven protective rules
 * before the one that releases anything, and because the engine is first-match-wins the
 * protections cannot be outvoted — only reordered, deliberately, by the player. That is
 * strictly better than a row of `protectShiny` checkboxes, because the same mechanism that
 * expresses "never a shiny" also expresses "never a Dragon type under level 40", and the
 * UI that renders one renders the other for free.
 *
 * ### Prices
 *
 * Research accrues at `BASE_RESEARCH · power^0.6 · biome · chain` (see `idle/accrual.js`),
 * which is about 0.05–0.4 ◈/s for an early save. The ladder below is therefore roughly
 * 10 minutes to the first automation and a couple of hours to all six, and it deliberately
 * sits alongside `idle`'s own unlock ladder (Route Permit 8 ◈ … Shiny Charm 900 ◈) rather
 * than above or below it.
 */

/** @typedef {Object} SettingSpec
 *  @property {string} key
 *  @property {string} label
 *  @property {'number'|'bool'|'enum'|'text'|'ladder'|'order'} type
 *    `ladder` is an ordered list of `{item, enabled, atPercent}` — the brief's healing priority
 *    list, which a condition tree cannot express because the match depends on **stock** and the
 *    rules engine cannot see a bag. `order` is a bare ordered list of item ids.
 *  @property {*} default
 *  @property {string} [unit]
 *  @property {number} [min] @property {number} [max] @property {number} [step]
 *  @property {string[]} [values]
 *  @property {string} [blurb]
 */

/** Keep orders auto-release can rank a pile of duplicates by. */
/**
 * **`BUY_COOLDOWN`** — the seconds between two automatic purchase cycles.
 *
 * The brief names it, and it is the cadence `restock` already declared: `everyS`, counted in
 * the engine's own **sim seconds** (`engine.js` `lastRunS`/`due()`/`mark()`), not in wall time.
 * That is what keeps it replayable — a fold has no clock — and keeps it out of the save
 * entirely, which is why this phase needs no document migration for it.
 *
 * Named here rather than left as a bare `30` on one automation, so the brief's word points at
 * something a reader can find.
 */
export const BUY_COOLDOWN = 30;

import { HEAL_DEFAULTS, REVIVE_DEFAULTS, ETHER_DEFAULTS, LEAD_DEFAULTS } from './duel.js';

export const KEEP_ORDERS = Object.freeze([
  { id: 'iv', label: 'best IVs' },
  { id: 'level', label: 'highest level' },
  { id: 'bst', label: 'strongest species' },
  { id: 'first', label: 'caught first' },
  { id: 'last', label: 'caught last' },
]);

export const AUTOMATIONS = [
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'hunt',
    name: 'Auto-Hunt',
    blurb: 'The party works the route on its own, battling what it meets.',
    detail: 'Grants `idle`\'s Auto Battler, so wild encounters resolve into wins, experience '
      + 'and money instead of walking past. The rules decide what is worth engaging.',
    kind: 'wild',
    unlock: { currency: 'research', cost: 120, requires: { dexCaught: 1 } },
    idleUnlock: 'auto-battler',
    everyS: 2,
    actions: [
      { id: 'fight', label: 'Battle it', blurb: 'Resolve the encounter.' },
      { id: 'flee', label: 'Walk away', blurb: 'Skip it; no reward, no risk.' },
    ],
    defaultAction: 'flee',
    settings: [
      { key: 'biome', label: 'Hunt in', type: 'enum', values: ['auto', 'city', 'meadow', 'forest', 'cave', 'coast'],
        default: 'auto', blurb: '"auto" follows whichever map is loaded.' },
      { key: 'pauseWhenBoxFull', label: 'Pause when the boxes are full', type: 'bool', default: false,
        blurb: 'Battles still pay even with nowhere to store a catch, so this is off by default.' },
    ],
    rules: [
      { id: 'hunt-boxpressure', name: 'Skip fodder when storage is tight', builtin: true,
        when: { all: [{ field: 'boxFree', op: 'lt', value: 12 }, { field: 'value', op: 'lt', value: 200 }] },
        then: 'flee', note: 'Keeps the last dozen slots for something worth having.' },
      { id: 'hunt-all', name: 'Battle anything else', builtin: true, when: null, then: 'fight' },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'catch',
    name: 'Auto-Catch',
    blurb: 'Throws at what the rules say is worth keeping.',
    detail: 'Grants `idle`\'s Auto Catch. A ball is only thrown at something already beaten, '
      + 'so the target is low on health and the odds are good.',
    kind: 'wild',
    unlock: { currency: 'research', cost: 300, requires: { dexCaught: 5 } },
    idleUnlock: 'auto-catch',
    everyS: 2,
    actions: [
      { id: 'catch', label: 'Throw a ball', blurb: 'The ball comes from the Ball Selection policy.' },
      { id: 'skip', label: 'Let it go', blurb: 'Keep the ball.' },
    ],
    defaultAction: 'skip',
    settings: [
      { key: 'stopWhenBoxFull', label: 'Stop when the boxes are full', type: 'bool', default: true,
        blurb: 'A catch with nowhere to go is a ball spent for nothing.' },
      { key: 'minBalls', label: 'Keep at least', type: 'number', unit: 'balls', min: 0, max: 100, step: 1, default: 0,
        blurb: 'Reserve for manual play; auto-catch stops at this many.' },
    ],
    rules: [
      { id: 'catch-shiny', name: 'Always catch a shiny', builtin: true,
        when: { field: 'shiny', op: 'isTrue' }, then: 'catch' },
      { id: 'catch-new', name: 'Always catch a new species', builtin: true,
        when: { field: 'newSpecies', op: 'isTrue' }, then: 'catch' },
      { id: 'catch-rare', name: 'Catch anything hard to catch', builtin: true,
        when: { field: 'catchRate', op: 'lte', value: 45 }, then: 'catch',
        note: 'Low capture rate means a strong species.' },
      { id: 'catch-value', name: 'Catch anything worth ₽300 or more', builtin: true,
        when: { field: 'value', op: 'gte', value: 300 }, then: 'catch' },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'ball',
    name: 'Ball Selection',
    blurb: 'Picks the ball by cost per Pokémon actually caught, not by multiplier.',
    detail: 'The rules sort a target into a tier; the optimiser in `ball.js` then reads the '
      + 'whole ball line — including conditional balls like Dusk and Net — and picks.',
    kind: 'wild',
    unlock: { currency: 'research', cost: 180, requires: { dexCaught: 5 } },
    idleUnlock: null,
    everyS: 0,                    // evaluated on demand, per catch, never on a cadence
    actions: [
      { id: 'secure', label: 'Secure it', blurb: 'Highest odds that clears the floor; cheapest among equals.' },
      { id: 'value', label: 'Best value', blurb: 'Lowest money-equivalent cost per catch.' },
      { id: 'cheap', label: 'Cheapest', blurb: 'The least valuable ball that still works.' },
      { id: 'skip', label: 'No ball', blurb: 'Do not throw at all.' },
    ],
    defaultAction: 'value',
    settings: [
      /**
       * **Simple is one ladder for everything; Advanced is a ladder per species.**
       *
       * Both are *preferences*, not overrides: the first ball on the ladder that is actually in
       * the bag is thrown, and a ladder that is empty or entirely out of stock falls through to
       * the cost-per-catch optimiser below — which is what the brief's "falls back to the best
       * available option" means.
       */
      { key: 'mode', label: 'Ball choice', type: 'enum', values: ['simple', 'advanced'], default: 'simple' },
      { key: 'ladder', label: 'Preferred balls', type: 'order',
        default: ['ultraball', 'greatball', 'pokeball'],
        blurb: 'First one in stock wins. Empty falls through to the optimiser.' },
      { key: 'perSpecies', label: 'Per species', type: 'ladders', default: {},
        blurb: 'Advanced mode only. A species with no ladder of its own uses the one above.' },
      { key: 'oddsFloor', label: 'Secure floor', type: 'number', unit: '×', min: 0.5, max: 1, step: 0.01, default: 0.9,
        blurb: 'A secured target must have at least this chance from one throw.' },
      { key: 'minOdds', label: 'Never throw below', type: 'number', unit: '×', min: 0.01, max: 0.6, step: 0.01, default: 0.12 },
      { key: 'bpWeight', label: 'One BP is worth', type: 'number', unit: '₽', min: 100, max: 50000, step: 100, default: 2500,
        blurb: 'BP only comes from battles won, so it is priced well above money.' },
      { key: 'maxSpend', label: 'Cap on one secure throw', type: 'number', unit: '₽', min: 500, max: 2000000, step: 500, default: 25000 },
      { key: 'masterFloor', label: 'Master Ball below', type: 'number', unit: '×', min: 0, max: 0.9, step: 0.05, default: 0.25,
        blurb: 'Only spent on a secured target nothing else can reach this chance on.' },
      { key: 'reserveMaster', label: 'Master Balls kept back', type: 'number', min: 0, max: 9, step: 1, default: 1 },
      { key: 'hpFraction', label: 'Assumed target health', type: 'number', unit: '×', min: 0.05, max: 1, step: 0.05, default: 0.35,
        blurb: 'An auto-resolved catch happens after the battle is won.' },
    ],
    rules: [
      { id: 'ball-shiny', name: 'Never lose a shiny', builtin: true,
        when: { field: 'shiny', op: 'isTrue' }, then: 'secure' },
      { id: 'ball-new', name: 'Secure a new dex entry', builtin: true,
        when: { field: 'newSpecies', op: 'isTrue' }, then: 'secure' },
      { id: 'ball-rare', name: 'Secure anything hard to catch', builtin: true,
        when: { field: 'catchRate', op: 'lte', value: 45 }, then: 'secure' },
      { id: 'ball-fodder', name: 'Cheap ball for fodder', builtin: true,
        when: { all: [{ field: 'value', op: 'lt', value: 200 }, { field: 'ownedCount', op: 'gte', value: 3 }] },
        then: 'cheap' },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // The four that run INSIDE a fight, and one that runs at the start of it.
  //
  // **None of them is in `PASSES`.** `PASSES` is the round-robin tick, and these do not run on
  // a cadence: heal, revive and ether are the `between` hook `battle.stepper` calls before each
  // turn, and lead is asked once, at engagement. On a cadence they would fire against no fight
  // at all — which is the trap `hunt` and `catch` already sit in, declaring an `everyS` nothing
  // reads. `everyS: 0` says so out loud.
  {
    id: 'heal',
    name: 'Auto-Heal',
    blurb: 'Drinks the right bottle before the hit that would have ended it.',
    detail: 'An ordered ladder, checked top to bottom every turn. The first rung whose HP '
      + 'threshold has been reached AND whose item is in the bag is the one used — so a party '
      + 'out of Max Potions falls through to a Hyper rather than standing there holding none.',
    kind: 'duel',
    unlock: { currency: 'research', cost: 160, requires: { battlesWon: 5 } },
    idleUnlock: null,
    everyS: 0,
    actions: [
      { id: 'use', label: 'Drink it', blurb: 'Costs the item and a turn of pacing.' },
      { id: 'skip', label: 'Ride it out', blurb: 'Keep the bottle.' },
    ],
    defaultAction: 'skip',
    settings: [
      { key: 'ladder', label: 'Healing priority', type: 'ladder', default: HEAL_DEFAULTS,
        blurb: 'Dearest first: a Potion at 10% HP does not prevent the faint it was spent on.' },
    ],
    rules: [],
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'revive',
    name: 'Auto-Revive',
    blurb: 'Puts the one that just fell back on its feet.',
    detail: '`any` raises whoever needs it; `specific` raises only the member you name. Using '
      + 'one pauses the duel for `config.reviveSeconds` on screen and costs nothing at all in a '
      + 'closed-tab replay, because a fold has no clock.',
    kind: 'duel',
    unlock: { currency: 'research', cost: 260, requires: { battlesWon: 20 } },
    idleUnlock: null,
    everyS: 0,
    actions: [
      { id: 'use', label: 'Revive', blurb: 'Costs the item; the duel goes on.' },
      { id: 'skip', label: 'Send the next one', blurb: 'Swap instead.' },
    ],
    defaultAction: 'skip',
    settings: [
      { key: 'mode', label: 'Revive', type: 'enum', values: ['any', 'specific'], default: REVIVE_DEFAULTS.mode },
      { key: 'member', label: 'Only this member', type: 'text', default: '',
        blurb: 'An instance id. Ignored unless the mode is "specific".' },
      { key: 'order', label: 'Item priority', type: 'order', default: [...REVIVE_DEFAULTS.order],
        blurb: 'Revive before Max Revive: half the price for the half of the bar the heal ladder tops up anyway.' },
    ],
    rules: [],
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'ether',
    name: 'Auto-Ether',
    blurb: 'Keeps the move you actually want to use payable.',
    detail: 'Watches the PP of the HIGHEST-PRIORITY move — the one `choose` reaches for every '
      + 'turn — rather than the emptiest. If PP cannot be restored the move is skipped, and if '
      + 'every move runs dry the Pokemon Struggles, which is the game telling you this is off '
      + 'or out of stock.',
    kind: 'duel',
    unlock: { currency: 'research', cost: 220, requires: { battlesWon: 10 } },
    idleUnlock: null,
    everyS: 0,
    actions: [
      { id: 'use', label: 'Use an Ether', blurb: 'Restores the top move.' },
      { id: 'skip', label: 'Struggle on', blurb: 'Keep the Ether.' },
    ],
    defaultAction: 'skip',
    settings: [
      { key: 'atPercent', label: 'When the top move reaches', type: 'number', unit: '% PP',
        min: 0, max: 100, step: 5, default: ETHER_DEFAULTS.atPercent,
        blurb: '0 means "when it is actually empty", which is the default because an Ether is dear.' },
      { key: 'order', label: 'Item priority', type: 'order', default: [...ETHER_DEFAULTS.order] },
    ],
    rules: [],
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'lead',
    name: 'Lead Selection',
    blurb: 'Sends the member that can win, not the one at the front.',
    detail: 'Offensive effectiveness against the wild decides it; the defensive matchup against '
      + 'what the wild throws back breaks ties; current HP breaks those. A fainted member is '
      + 'never eligible. `manual` reads your own per-species assignment instead.',
    kind: 'duel',
    unlock: { currency: 'research', cost: 200, requires: { battlesWon: 10 } },
    idleUnlock: null,
    everyS: 0,
    actions: [
      { id: 'send', label: 'Send it', blurb: 'Lead with the chosen member.' },
      { id: 'keep', label: 'Keep the current lead', blurb: 'Change nothing.' },
    ],
    defaultAction: 'send',
    settings: [
      { key: 'mode', label: 'Choose the lead', type: 'enum', values: ['auto', 'manual'], default: LEAD_DEFAULTS.mode },
    ],
    rules: [],
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'release',
    name: 'Auto-Release',
    blurb: 'Lets duplicates go and banks what they are worth.',
    detail: 'Seven protective rules run before the one that releases anything, and because '
      + 'the engine is first-match-wins they cannot be outvoted — only reordered.',
    kind: 'stored',
    unlock: { currency: 'research', cost: 240, requires: { stored: 24 } },
    idleUnlock: null,
    everyS: 15,
    dangerous: true,
    actions: [
      { id: 'release', label: 'Release it', blurb: 'Gone for good; `economy` pays the appraisal.' },
      { id: 'keep', label: 'Keep it', blurb: 'Never considered again this pass.' },
    ],
    defaultAction: 'keep',
    settings: [
      { key: 'keepOrder', label: 'Rank duplicates by', type: 'enum', values: KEEP_ORDERS.map((k) => k.id),
        default: 'iv', blurb: 'Decides which of a pile is rank 1 and therefore protected.' },
      { key: 'maxPerRun', label: 'Release at most', type: 'number', unit: 'per pass', min: 1, max: 200, step: 1, default: 20,
        blurb: 'A cap makes a mistake recoverable: you notice after twenty, not after nine hundred.' },
      { key: 'requireUnlock', label: 'Only while the boxes are over', type: 'number', unit: '% full', min: 0, max: 100, step: 5, default: 0,
        blurb: 'Hold off entirely until storage is under this much pressure.' },
    ],
    rules: [
      { id: 'rel-shiny', name: 'Never a shiny', builtin: true, when: { field: 'shiny', op: 'isTrue' }, then: 'keep' },
      { id: 'rel-fav', name: 'Never a favourite', builtin: true, when: { field: 'favourite', op: 'isTrue' }, then: 'keep' },
      { id: 'rel-party', name: 'Never one in the party', builtin: true, when: { field: 'inParty', op: 'isTrue' }, then: 'keep' },
      { id: 'rel-only', name: 'Never the only one you own', builtin: true, when: { field: 'onlyCopy', op: 'isTrue' }, then: 'keep',
        note: 'Protects the living dex.' },
      { id: 'rel-best', name: 'Never the best of its species', builtin: true, when: { field: 'rank', op: 'lte', value: 1 }, then: 'keep' },
      { id: 'rel-fresh', name: 'Never one caught in the last two minutes', builtin: true,
        when: { field: 'ageS', op: 'lt', value: 120 }, then: 'keep',
        note: 'The grace period. You get to see what you caught before it goes.' },
      { id: 'rel-good', name: 'Never above 80% IVs', builtin: true, when: { field: 'ivPct', op: 'gte', value: 80 }, then: 'keep' },
      { id: 'rel-trained', name: 'Never above level 30', builtin: true, when: { field: 'level', op: 'gte', value: 30 }, then: 'keep' },
      { id: 'rel-dupes', name: 'Release plain duplicates', builtin: true,
        when: { field: 'copies', op: 'gte', value: 2 }, then: 'release' },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'sell',
    name: 'Auto-Sell',
    blurb: 'Turns loot into money and leaves the kit alone.',
    kind: 'item',
    unlock: { currency: 'research', cost: 200, requires: { dexCaught: 10 } },
    idleUnlock: null,
    everyS: 20,
    actions: [
      { id: 'sell', label: 'Sell it', blurb: 'Down to the `keep` count in the rule\'s arguments.' },
      { id: 'keep', label: 'Keep it', blurb: 'Never sold.' },
    ],
    defaultAction: 'keep',
    settings: [
      { key: 'maxPerRun', label: 'Sell at most', type: 'number', unit: 'stacks per pass', min: 1, max: 40, step: 1, default: 8 },
    ],
    rules: [
      { id: 'sell-unsellable', name: 'Never what cannot be sold', builtin: true,
        when: { field: 'sellable', op: 'isFalse' }, then: 'keep' },
      { id: 'sell-balls', name: 'Never a ball', builtin: true, when: { field: 'isBall', op: 'isTrue' }, then: 'keep' },
      { id: 'sell-medicine', name: 'Never medicine', builtin: true,
        when: { field: 'category', op: 'eq', value: 'medicine' }, then: 'keep' },
      { id: 'sell-lures', name: 'Never lures or evolution stones', builtin: true,
        when: { field: 'category', op: 'in', value: ['lure', 'evolution'] }, then: 'keep' },
      { id: 'sell-treasure', name: 'Sell all treasure', builtin: true,
        when: { field: 'category', op: 'eq', value: 'treasure' }, then: 'sell', args: { keep: 0 } },
      { id: 'sell-candy', name: 'Keep ten of every candy, sell the rest', builtin: true,
        when: { all: [{ field: 'category', op: 'eq', value: 'candy' }, { field: 'count', op: 'gt', value: 10 }] },
        then: 'sell', args: { keep: 10 } },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'restock',
    name: 'Auto-Restock',
    blurb: 'Buys the consumables the other automations spend.',
    detail: '`idle` gates auto-catch on having balls in the bag, so this is the automation '
      + 'that keeps auto-catch running overnight.',
    kind: 'item',
    unlock: { currency: 'research', cost: 150, requires: { dexCaught: 5 } },
    idleUnlock: null,
    /** `BUY_COOLDOWN`: the brief's cooldown between automatic purchase cycles. */
    everyS: BUY_COOLDOWN,
    actions: [
      { id: 'buy', label: 'Buy up to', blurb: 'Tops the stack up to the rule\'s `upTo` count.' },
      { id: 'skip', label: 'Leave it', blurb: 'Buy nothing.' },
    ],
    defaultAction: 'skip',
    settings: [
      /**
       * The brief's own example — "10 Potions, 5 Ethers, 20 Poké Balls". A target the player
       * typed is a stronger statement than a default a rule shipped with, so it wins over the
       * rule's `upTo`, and an item with a target is bought whether or not a rule names it.
       */
      { key: 'targets', label: 'Keep this many', type: 'targets',
        default: { potion: 10, ether: 5, pokeball: 20, revive: 3 },
        blurb: 'Bought up to this count, budget allowing.' },
      /**
       * Healing, Revival, PP, Balls — and it cannot be `item.category`, because three of those
       * four ARE `medicine`. `economy.purchaseClass` reads what an item does.
       */
      { key: 'categoryOrder', label: 'Budget priority', type: 'order',
        default: ['heal', 'revive', 'pp', 'ball'],
        blurb: 'Earlier classes get the money first. Price only breaks ties inside a class.' },
      { key: 'budgetFraction', label: 'Spend at most', type: 'number', unit: '× wallet', min: 0.01, max: 1, step: 0.01, default: 0.25,
        blurb: 'One pass never spends more than this share of the money on hand.' },
      { key: 'floor', label: 'Never go below', type: 'number', unit: '₽', min: 0, max: 1000000, step: 100, default: 2000,
        blurb: 'A reserve, so restocking cannot leave you unable to buy anything else.' },
    ],
    rules: [
      { id: 'stock-pokeball', name: 'Keep 50 Poké Balls', builtin: true,
        when: { all: [{ field: 'id', op: 'eq', value: 'pokeball' }, { field: 'count', op: 'lt', value: 50 }] },
        then: 'buy', args: { upTo: 50 } },
      { id: 'stock-greatball', name: 'Keep 20 Great Balls once they are worth it', builtin: true,
        when: { all: [
          { field: 'id', op: 'eq', value: 'greatball' },
          { field: 'count', op: 'lt', value: 20 },
          { field: 'money', op: 'gte', value: 50000 },
        ] },
        then: 'buy', args: { upTo: 20 } },
      { id: 'stock-potion', name: 'Keep 5 Potions', builtin: true,
        when: { all: [{ field: 'id', op: 'eq', value: 'potion' }, { field: 'count', op: 'lt', value: 5 }] },
        then: 'buy', args: { upTo: 5 } },
    ],
  },
];

const BY_ID = new Map(AUTOMATIONS.map((a) => [a.id, a]));

/** @returns {Object|null} */
export const automation = (id) => BY_ID.get(id) ?? null;
export const AUTOMATION_IDS = Object.freeze(AUTOMATIONS.map((a) => a.id));

/** Defaults for one automation's settings, as a plain object. */
export function defaultSettings(id) {
  const def = BY_ID.get(id);
  const out = {};
  // Deep-copied for the list types, because a frozen shipped default handed straight to a
  // player's settings record is a default they cannot edit — and one they *could* edit would be
  // the catalogue itself, shared by every save in the tab.
  for (const s of def?.settings ?? []) {
    const d = s.default;
    if (Array.isArray(d)) out[s.key] = d.map((v) => (v && typeof v === 'object' ? { ...v } : v));
    else if (d && typeof d === 'object') out[s.key] = JSON.parse(JSON.stringify(d));
    else out[s.key] = d;
  }
  return out;
}

/** A deep-enough copy of the shipped ruleset — the player edits their own, never ours. */
export function defaultRules(id) {
  const def = BY_ID.get(id);
  return (def?.rules ?? []).map((r) => ({
    ...r,
    enabled: r.enabled !== false,
    args: { ...(r.args ?? {}) },
    when: r.when ? JSON.parse(JSON.stringify(r.when)) : null,
  }));
}

/**
 * Whether a requirement is met by a progress snapshot. Requirements are plain
 * `{ field: minimum }` maps so a UI can render "24 stored (you have 11)" without knowing
 * what any particular gate means.
 */
export function requirementMet(requires, progress = {}) {
  if (!requires) return true;
  for (const [k, min] of Object.entries(requires)) {
    if ((Number(progress[k]) || 0) < min) return false;
  }
  return true;
}

/** Human wording for an unmet requirement, for the locked row in a UI. */
export function requirementText(requires, progress = {}) {
  if (!requires) return null;
  const LABELS = { dexCaught: 'species caught', stored: 'Pokémon stored', money: '₽ earned' };
  const parts = [];
  for (const [k, min] of Object.entries(requires)) {
    const have = Number(progress[k]) || 0;
    if (have < min) parts.push(`${min} ${LABELS[k] ?? k} (${have})`);
  }
  return parts.length ? parts.join(', ') : null;
}
