/**
 * Research starts at zero on a fresh save, and `tokens` is its alias — the name the idle fold
 * pays it out under (src/idle/index.js bank()). A grep for `add('research'` misses that credit
 * path, which is why the deadlock in src/idle/unlock.test.js is stated behaviourally.
 */
import { describe, it, expect } from 'vitest';
import { CURRENCIES, currency, normaliseCurrency } from './currencies.js';

describe('currencies', () => {
  it('research starts at zero', () => {
    expect(CURRENCIES.find((c) => c.id === 'research')?.start).toBe(0);
  });

  it('tokens is an alias for research', () => {
    expect(normaliseCurrency('tokens')).toBe('research');
    expect(currency('tokens')?.id).toBe('research');
  });
});
