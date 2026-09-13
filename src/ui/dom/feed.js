/**
 * The encounter feed card (Stage 3b) — a small, honest summary of the most recent wild
 * encounter, docked under the wallet row.
 *
 * **What this deliberately does not do.** The source design's own mockup shows this card
 * carrying a "Capture" button. It cannot: `encounter.attempt(ball)` — the one real,
 * player-triggered capture path (already wired to `panels/battle.js`'s own throw button) —
 * only works while the encounter it targets is still `active`, and `encounter:resolved`
 * (this card's own trigger) fires *after* `resolve()` has already set `active = null`. There
 * is no "wild defeated, still around, catch it later" state anywhere in this domain — a
 * failed throw is captioned `escaped`, meaning it is already gone by the time this card could
 * show it. A capture button here would call a function with nothing left to act on. This card
 * is a read-only recap; the one real capture control stays exactly where it already worked.
 *
 * **Where "defeated by X" comes from.** Not from `encounter:resolved` itself, which carries
 * no attacker information at all. Every `battle:strike` during the live fight is watched
 * instead, and the last one that fainted the wild (`target === 'b' && fainted`) has its
 * `attackerSpecies` remembered until the matching `encounter:resolved` (correlated by the
 * encounter's own `index`) reads it back. This is real data, not an estimate — but it is only
 * ever a **species name**, never an instance or a nickname (`battle:strike` carries neither),
 * so two Oshawott in one party read identically here. `drop:collected` is correlated the same
 * way, by `index`, for the same reason: it fires independently of `encounter:resolved` and
 * the two have to be matched up rather than assumed adjacent.
 */
import { h, setText } from './el.js';
import { fmt } from '../format.js';

const isLive = (api) => !!api && api.__missing === undefined;

/** How long one card stays up before the next encounter (or nothing) replaces it. Long enough
 *  to read a short sentence and two chips, short enough not to claim a stale fight is still
 *  news. */
const LIFETIME_S = 6;

export function makeEncounterFeed(app) {
  const portrait = h('div', { class: 'ci-feed-card__portrait' });
  const title = h('div', { class: 'ci-feed-card__title' }, '');
  const subtitle = h('div', { class: 'ci-feed-card__subtitle' }, '');
  const chips = h('div', { class: 'ci-feed-card__chips' });
  const el = h('div', { class: 'ci-feed-card', 'data-ui': 'hud-feed', hidden: true }, [
    h('div', { class: 'ci-feed-card__head' }, [
      portrait,
      h('div', { class: 'ci-feed-card__text' }, [title, subtitle]),
    ]),
    chips,
  ]);

  /**
   * One live fight's own `{species, drops}`, keyed by the encounter's `index` — both arrive
   * as separate events strictly before `encounter:resolved` does (`battle:strike` during the
   * simulated fight, `drop:collected` from inside the same `resolve()` call that later emits
   * `encounter:resolved`), so a record always exists by the time it is read, and it is
   * deleted the moment it is, so this never grows across a session.
   */
  const finishers = new Map();
  const record = (index) => {
    let rec = finishers.get(index);
    if (!rec) { rec = { species: null, drops: null }; finishers.set(index, rec); }
    return rec;
  };
  let age = Infinity;
  /** Whether the card has something to show right now — distinct from `el.hidden`, which
   *  also folds in `minimalFlag` (another module's showcase gets none of this chrome, the
   *  same rule the rest of `dom/hud.js` follows). */
  let present = false;
  let minimalFlag = false;
  const applyVisibility = () => { el.hidden = minimalFlag || !present; };

  function chip(text, tone) {
    return h('span', { class: 'ci-feed-chip', 'data-tone': tone ?? '' }, text);
  }

  /** `hud.js`'s own species-name casing (`nidoran-f` → `Nidoran F`) — every bus payload here
   *  carries a bare species key, never the full species record `displayName` is usually
   *  handed, hence the synthetic `{name}` wrapper (`displayName` falls back to `.name` when
   *  `.display` is absent). */
  const speciesName = (name) => (typeof app.hud?.displayName === 'function'
    ? app.hud.displayName({ name }) : name);

  function show(entry) {
    const pokemon = app.ctx.get('pokemon');
    const eco = app.ctx.get('economy');
    const displayName = speciesName(entry.species);

    portrait.style.backgroundImage = isLive(pokemon) && typeof pokemon.spriteUrl === 'function'
      ? `url(${pokemon.spriteUrl(entry.species, { shiny: entry.shiny })})` : '';

    setText(title, entry.caught ? `${displayName} caught!` : entry.outcome === 'win' ? `${displayName} defeated` : `${displayName} got away`);
    setText(subtitle, entry.finisherSpecies ? `by ${speciesName(entry.finisherSpecies)}` : '');

    chips.replaceChildren();
    if (entry.rewards?.exp > 0) chips.appendChild(chip(`+${fmt(entry.rewards.exp)} xp`, 'good'));
    if (entry.rewards?.money > 0) chips.appendChild(chip(`+${fmt(entry.rewards.money)}`, 'amber'));
    for (const drop of entry.drops ?? []) {
      const name = isLive(eco) && typeof eco.item === 'function' ? (eco.item(drop.id)?.name ?? drop.id) : drop.id;
      chips.appendChild(chip(`${name} ×${fmt(drop.n)}`));
    }

    present = true;
    applyVisibility();
    age = 0;
  }

  const off = [
    // A fresh encounter starts a clean slate for its own `index` — a finisher recorded here
    // belongs to exactly one fight, never a stale one an `index` was reused from.
    app.ctx.bus.on('encounter:started', ({ index }) => finishers.delete(index)),
    app.ctx.bus.on('battle:strike', (s) => {
      if (s.target === 'b' && s.fainted) record(s.index).species = s.attackerSpecies;
    }),
    app.ctx.bus.on('drop:collected', ({ index, items }) => { record(index).drops = items; }),
    app.ctx.bus.on('encounter:resolved', (r) => {
      const rec = finishers.get(r.index);
      finishers.delete(r.index);
      show({
        species: r.species, shiny: r.shiny, outcome: r.outcome, caught: r.caught,
        rewards: r.rewards, finisherSpecies: rec?.species ?? null, drops: rec?.drops ?? [],
      });
    }),
  ];

  return {
    el,
    /** Ages the card and hides it once its moment has passed — called from `dom/hud.js`'s
     *  own `update()` poll, which already runs every 0.2s; no need for a second timer. */
    step(dt) {
      if (!present) return;
      age += dt;
      if (age >= LIFETIME_S) { present = false; applyVisibility(); }
    },
    /** Another module's showcase gets none of this chrome — `dom/hud.js`'s own
     *  `applyVisibility()` for the rest of the always-on HUD follows the identical rule. */
    setMinimal(minimal) { minimalFlag = minimal; applyVisibility(); },
    dispose() {
      for (const fn of off) fn();
    },
  };
}
