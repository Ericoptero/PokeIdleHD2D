/**
 * Pure logic in `elements.js` — the personality table and the beat timeline. Everything here
 * runs with no `three`, no `ctx`, exactly like `src/encounter/selftest.js`'s own checks on
 * this file; this suite is the fine-grained diff version of the same claims.
 */
import { describe, it, expect } from 'vitest';
import { PROFILE, profileFor, MOTION, ROLE, MOTION_CODE, ROLE_CODE, shapeOf, BEATS, beatAt } from './elements.js';

describe('profileFor', () => {
  it('resolves all eighteen types to a member of PROFILE', () => {
    expect(Object.keys(PROFILE)).toHaveLength(18);
    for (const t of Object.keys(PROFILE)) expect(profileFor(t)).toBe(PROFILE[t]);
  });

  it('falls back to normal for an unknown or missing type', () => {
    expect(profileFor('nonsense')).toBe(PROFILE.normal);
    expect(profileFor(undefined)).toBe(PROFILE.normal);
    expect(profileFor(null)).toBe(PROFILE.normal);
  });

  it('is case-insensitive', () => {
    expect(profileFor('FIRE')).toBe(PROFILE.fire);
  });

  it('every profile names a real motion and role with a positive intensity', () => {
    const motions = new Set(Object.values(MOTION));
    const roles = new Set(Object.values(ROLE));
    for (const p of Object.values(PROFILE)) {
      expect(motions.has(p.motion)).toBe(true);
      expect(roles.has(p.role)).toBe(true);
      expect(p.intensity).toBeGreaterThan(0);
    }
  });
});

describe('MOTION_CODE / ROLE_CODE', () => {
  it('gives every motion and role a distinct numeric code', () => {
    const motionCodes = Object.values(MOTION).map((m) => MOTION_CODE[m]);
    const roleCodes = Object.values(ROLE).map((r) => ROLE_CODE[r]);
    expect(new Set(motionCodes).size).toBe(motionCodes.length);
    expect(new Set(roleCodes).size).toBe(roleCodes.length);
  });
});

describe('shapeOf', () => {
  it('reads the shape off the move\'s category', () => {
    expect(shapeOf({ c: 0 })).toBe('field');
    expect(shapeOf({ c: 1 })).toBe('contact');
    expect(shapeOf({ c: 2 })).toBe('projectile');
  });

  it('a missing move still resolves to a shape', () => {
    expect(shapeOf(null)).toBe('contact');
    expect(shapeOf(undefined)).toBe('contact');
  });
});

describe('BEATS', () => {
  for (const shape of ['contact', 'projectile', 'field']) {
    it(`${shape} covers [0,1] with no gap or overlap, in charge/deliver/impact/resolve order`, () => {
      const beats = BEATS[shape];
      expect(beats.map((b) => b.name)).toEqual(['charge', 'deliver', 'impact', 'resolve']);
      expect(beats[0].from).toBe(0);
      expect(beats[beats.length - 1].to).toBe(1);
      for (let i = 1; i < beats.length; i++) expect(beats[i].from).toBe(beats[i - 1].to);
      for (const b of beats) expect(b.to).toBeGreaterThan(b.from);
    });
  }
});

describe('beatAt', () => {
  it('names the beat a phase falls in and how far through it, in [0,1]', () => {
    expect(beatAt('contact', 0)).toEqual({ name: 'charge', k: 0 });
    expect(beatAt('contact', 0.075).name).toBe('charge');
    expect(beatAt('contact', 0.075).k).toBeCloseTo(0.5, 5);
    expect(beatAt('contact', 0.15).name).toBe('deliver');
  });

  it('holds the last beat at phase 1, and clamps out-of-range phases', () => {
    expect(beatAt('contact', 1)).toEqual({ name: 'resolve', k: 1 });
    expect(beatAt('contact', 2)).toEqual({ name: 'resolve', k: 1 });
    expect(beatAt('contact', -1)).toEqual({ name: 'charge', k: 0 });
  });

  it('falls back to contact\'s own timeline for an unrecognised shape', () => {
    expect(beatAt('made-up-shape', 0.5)).toEqual(beatAt('contact', 0.5));
  });
});
