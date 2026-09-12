/**
 * Independent tester coverage for slice 019 (shader-vfx) — a gap neither `elements.test.js`
 * nor `src/encounter/selftest.js` covers.
 *
 * Both existing suites check `MOTION_CODE`/`ROLE_CODE` for internal self-consistency only
 * (every code is distinct) and check every `PROFILE` entry's `motion`/`role` against the
 * `MOTION`/`ROLE` enums — never against the numeric `*_CODE` maps `particles.js` actually
 * reads (`uMotion: MOTION_CODE[profile.motion]`, `uRole: ROLE_CODE[profile.role]`, `play.js`).
 * A `MOTION`/`ROLE` value with no matching `*_CODE` entry — e.g. a sixth motion added to the
 * enum and used by a profile without a line added to `MOTION_CODE` — passes both existing
 * suites (the value is still "one of the five/six motions/roles") but hands `particles.js` an
 * `undefined` uniform at runtime, which `three`'s `WebGLUniforms` either throws on or silently
 * uploads as `NaN` — exactly the kind of defect DECISIONS #79 records losing a round to, and
 * exactly the kind a purely-scalar screenshot regression (`tools/shots/regress.js`) cannot see
 * either (`fps`/`drawCalls`/`consoleErrors` on a frame that never got that type rolled).
 *
 * Proven able to fail: adding `BOUNCE: 'bounce'` to `MOTION` and pointing a profile at it
 * without a matching `MOTION_CODE` entry left `node src/encounter/selftest.js` at 83/83 and
 * `elements.test.js` at 13/13 (both green) — this file is what catches it.
 */
import { describe, it, expect } from 'vitest';
import { PROFILE, MOTION, ROLE, MOTION_CODE, ROLE_CODE } from './elements.js';

describe('MOTION_CODE / ROLE_CODE actually cover what PROFILE and particles.js need', () => {
  it('every MOTION enum value has a numeric MOTION_CODE entry', () => {
    for (const m of Object.values(MOTION)) {
      expect(MOTION_CODE[m], `MOTION_CODE has no entry for "${m}"`).toBeTypeOf('number');
    }
  });

  it('every ROLE enum value has a numeric ROLE_CODE entry', () => {
    for (const r of Object.values(ROLE)) {
      expect(ROLE_CODE[r], `ROLE_CODE has no entry for "${r}"`).toBeTypeOf('number');
    }
  });

  it('every one of the eighteen profiles resolves to a real, numeric shader uniform pair', () => {
    for (const [type, p] of Object.entries(PROFILE)) {
      expect(MOTION_CODE[p.motion], `${type}'s motion "${p.motion}" has no MOTION_CODE entry`)
        .toBeTypeOf('number');
      expect(ROLE_CODE[p.role], `${type}'s role "${p.role}" has no ROLE_CODE entry`)
        .toBeTypeOf('number');
    }
  });
});
