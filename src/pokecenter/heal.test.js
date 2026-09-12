import { describe, it, expect } from 'vitest';
import { HEAL_COOLDOWN_MS, remainingCooldownMs } from './heal.js';

describe('remainingCooldownMs — pure, golden literals', () => {
  const t = 1_700_000_000_000; // an arbitrary wall-clock instant, fixed so the case is a literal

  it('never healed (null) is no cooldown at all', () => {
    expect(remainingCooldownMs(null, t)).toBe(0);
  });

  it('undefined is also "never healed"', () => {
    expect(remainingCooldownMs(undefined, t)).toBe(0);
  });

  it('a non-finite lastHealMs (a corrupt save field) is treated as never healed', () => {
    expect(remainingCooldownMs(NaN, t)).toBe(0);
    expect(remainingCooldownMs('x', t)).toBe(0);
  });

  it('just healed: the full cooldown remains', () => {
    expect(remainingCooldownMs(t, t)).toBe(HEAL_COOLDOWN_MS);
  });

  it('exactly at the cooldown boundary: available again', () => {
    expect(remainingCooldownMs(t, t + HEAL_COOLDOWN_MS)).toBe(0);
  });

  it('one millisecond short of the boundary: one millisecond left', () => {
    expect(remainingCooldownMs(t, t + HEAL_COOLDOWN_MS - 1)).toBe(1);
  });

  it('never goes negative once well past the boundary', () => {
    expect(remainingCooldownMs(t, t + HEAL_COOLDOWN_MS * 10)).toBe(0);
  });
});
