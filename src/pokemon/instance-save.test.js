/**
 * What a save can put in `hp`, and what the game can do about it.
 *
 * `deserialize` is the only sanitiser between `localStorage['pokeidle.save']` and a live party
 * member, and it clamps with `Math.max(0, Math.min(maxHp, Math.floor(slice.hp ?? maxHp)))`
 * (instance.js). `??` only catches `null`/`undefined`, and `Math.floor` of anything else
 * non-numeric is `NaN`, which every one of those three operations passes straight through. A
 * member at `hp = NaN` is not conscious (`hp > 0` is false) and not hurt (`hp < maxHp` is
 * false), and that combination was a state the three recovery paths added in slice 012 all
 * declined — a fourth way to strand a run for good. `deserialize` now reads a non-number as
 * absent, and the cases below pin both halves: what a spoiled slice becomes, and that each net's
 * own predicate answers honestly once it is finite.
 *
 * `battle` is passed as `null` on purpose: `instance.js` falls back to `FLAT` and the arithmetic
 * under test is `Math.floor` on a string, which no engine takes part in. Measured with the real
 * engine in a browser too — see the `repro` on the STATUS entry.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as INST from './instance.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const table = JSON.parse(readFileSync(join(REPO, 'public', 'generated', 'species.json'), 'utf8'));
const byName = new Map(table.map((s) => [s.name, s]));
const lookup = (k) => byName.get(String(k ?? '').toLowerCase()) ?? null;

/** A party member exactly as `serialize` writes one, with one field replaced. */
const slice = (patch) => ({
  instanceId: 'oshawott#0',
  species: 'oshawott',
  level: 5,
  shiny: false,
  exp: 135,
  ivs: { hp: 11, atk: 15, def: 23, spa: 1, spd: 11, spe: 2 },
  hp: 21,
  moves: [],
  priority: [],
  status: null,
  ...patch,
});

const load = (patch) => INST.deserialize(slice(patch), lookup, null);

describe('deserialize clamps what the save claims about hp', () => {
  it('a plausible hp survives, a silly one is clamped, a missing one becomes full', () => {
    expect(load({ hp: 7 }).hp).toBe(7);
    expect(load({ hp: -3 }).hp).toBe(0);
    const full = load({ hp: null });
    expect(full.hp).toBe(full.maxHp);
    expect(load({ hp: 9999 }).hp).toBe(full.maxHp);
  });

  it('a save slice whose hp is not a number still deserializes to a finite hp', () => {
    expect(Number.isFinite(load({ hp: 'x' }).hp)).toBe(true);
  });

  it('a save slice whose level is not a number still deserializes to a finite body', () => {
    const inst = load({ level: 'x' });
    expect(Number.isFinite(inst.level)).toBe(true);
    expect(Number.isFinite(inst.maxHp)).toBe(true);
    expect(Number.isFinite(inst.hp)).toBe(true);
  });
});

describe('a spoiled hp can no longer reach the three recovery nets as NaN', () => {
  const spoiled = () => load({ hp: 'x' });

  it('reads as absent, which for hp means full — not as NaN', () => {
    const m = spoiled();
    expect(Number.isFinite(m.hp)).toBe(true);
    expect(m.hp).toBe(m.maxHp);
  });

  /**
   * Why this matters, as the three predicates it used to defeat. Each is transcribed from the
   * module that owns it, as a literal rather than a second live call (DECISIONS #35): a `NaN`
   * member answered `false` to every one, so `slotNear` refused the party, `city.heal()` found
   * nobody hurt and the lap rest wrote `NaN + n`. A finite hp answers all three honestly.
   */
  it('answers every net\u2019s question, where NaN answered none of them', () => {
    const m = spoiled();
    m.hp = 0;                                            // the state the nets exist for
    expect(m.hp > 0).toBe(false);                        // pokemon/index.js firstConscious
    expect(m.hp < m.maxHp || !!m.status).toBe(true);     // src/city/index.js heal()
    expect(m.hp >= m.maxHp).toBe(false);                 // src/hunts/index.js lap rest
  });

  it('the lap rest raises it, and clears the status it fainted under', () => {
    const m = spoiled();
    m.hp = 0;
    m.status = 'psn';
    // src/hunts/index.js, the `player:enteredTile` lap handler, at lapHealFraction 0.34.
    const raise = m.hp <= 0;
    INST.heal(m, { hp: Math.max(1, Math.round(m.maxHp * 0.34)), status: raise, revive: raise });
    expect(m.hp).toBe(Math.max(1, Math.round(m.maxHp * 0.34)));
    expect(m.status).toBeNull();
  });

  it('a wipe restores it in full', () => {
    const m = spoiled();
    m.hp = 0;
    // src/pokemon/index.js reviveAll(), which `encounter`'s wipe() now reaches on every wipe.
    INST.heal(m, { hp: 'full', status: true, revive: true });
    expect(m.hp).toBe(m.maxHp);
  });
});
