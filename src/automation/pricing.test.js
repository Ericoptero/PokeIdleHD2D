/**
 * Every automation is bought with research, and `hunt` is the one that grants `idle` its
 * `auto-battler` flag — the flag that lets a fold encounter be won, which is where research
 * comes from (src/idle/unlock.test.js), which pins the resulting fresh-save deadlock.
 */
import { describe, it, expect } from 'vitest';
import { AUTOMATIONS, automation } from './automations.js';

describe('automation pricing', () => {
  it('every automation is priced in research', () => {
    expect(AUTOMATIONS.length).toBe(10);
    for (const def of AUTOMATIONS) expect(def.unlock.currency, def.id).toBe('research');
  });

  it('hunt is the automation that grants the auto-battler flag', () => {
    expect(automation('hunt')?.idleUnlock).toBe('auto-battler');
    expect(AUTOMATIONS.filter((d) => d.idleUnlock === 'auto-battler').map((d) => d.id)).toEqual(['hunt']);
  });
});
