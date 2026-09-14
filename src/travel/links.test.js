/**
 * `linkAt()` (`src/travel/links.js`) pinned against plain objects — no `ctx`, no `bus`, no
 * `terrain`. `travel/index.js` is the stateful half (deciding when `justArrivedAt` is set and
 * cleared) and is exercised end-to-end by `src/travel/pokecenter-race.test.js`'s `go()` races
 * instead; this file is only the pure matching rule those races depend on.
 */
import { describe, it, expect } from 'vitest';
import { linkAt } from './links.js';

/** A minimal but shape-complete Link, the way a `.map.json` v3 file would author one. */
function makeLink(overrides = {}) {
  return {
    id: 'door-1',
    kind: 'door',
    from: { cx: 4, cz: 7 },
    to: { map: 'pokecenter', marker: 'pokecenter-door', dir: 0 },
    ...overrides,
  };
}

describe('linkAt()', () => {
  it('matches a landing cell that equals a link\'s `from`', () => {
    const link = makeLink();
    const result = linkAt([link], { cx: 4, cz: 7 }, { justArrivedAt: null });
    expect(result).toBe(link);
  });

  it('returns null when the landing cell matches no link\'s `from`', () => {
    const link = makeLink();
    const result = linkAt([link], { cx: 5, cz: 7 }, { justArrivedAt: null });
    expect(result).toBeNull();
  });

  it('returns null against an empty links array', () => {
    const result = linkAt([], { cx: 4, cz: 7 }, { justArrivedAt: null });
    expect(result).toBeNull();
  });

  it('the anti-ping-pong guard: suppresses a match when justArrivedAt equals the landing cell', () => {
    const link = makeLink();
    const result = linkAt([link], { cx: 4, cz: 7 }, { justArrivedAt: { cx: 4, cz: 7 } });
    expect(result).toBeNull();
  });

  it('the guard clears once justArrivedAt differs from the landing cell — a genuine revisit still fires', () => {
    const link = makeLink();
    const result = linkAt([link], { cx: 4, cz: 7 }, { justArrivedAt: { cx: 9, cz: 1 } });
    expect(result).toBe(link);
  });

  it('a link with only to.cx/to.cz (no to.marker) matches and comes back unmodified', () => {
    const link = makeLink({ id: 'edge-1', kind: 'edge', to: { map: 'hunt-coast', cx: 3, cz: 3, dir: 1 } });
    const result = linkAt([link], { cx: 4, cz: 7 }, { justArrivedAt: null });
    expect(result).toEqual(link);
    expect(result.to.marker).toBeUndefined();
  });

  it('a link with to.marker comes back unmodified, marker and all — linkAt does not resolve it', () => {
    const link = makeLink();
    const result = linkAt([link], { cx: 4, cz: 7 }, { justArrivedAt: null });
    expect(result).toEqual(link);
    expect(result.to.marker).toBe('pokecenter-door');
    expect(result.to.cx).toBeUndefined();
  });
});
