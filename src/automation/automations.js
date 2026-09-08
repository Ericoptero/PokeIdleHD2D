/**
 * The catalog — six automations, expressed entirely as data.
 *
 * Nothing in this file runs. It declares what each automation is called, what it costs to
 * unlock, which `idle` flag it turns on, which subject kind its rules test, which actions
 * its rules may take, what it can be configured with, and the ruleset it ships with. The
 * engine reads this table; `ui` renders it; `selftest.js` checks that every default rule
 * validates against the schema its own automation declares.
 *
 * ### Nothing is on by default (ARCHITECTURE §5.11)
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
 *  @property {'number'|'bool'|'enum'|'text'} type
 *  @property {*} default
 *  @property {string} [unit]
 *  @property {number} [min] @property {number} [max] @property {number} [step]
 *  @property {string[]} [values]
 *  @property {string} [blurb]
 */

/** Keep orders auto-release can rank a pile of duplicates by. */
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
    everyS: 30,
    actions: [
      { id: 'buy', label: 'Buy up to', blurb: 'Tops the stack up to the rule\'s `upTo` count.' },
      { id: 'skip', label: 'Leave it', blurb: 'Buy nothing.' },
    ],
    defaultAction: 'skip',
    settings: [
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
  for (const s of def?.settings ?? []) out[s.key] = s.default;
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
