/**
 * `travel.destinations()` can carry a `hidden` row (src/travel/index.js, `pokecenter`'s door-only entry) and the T panel must keep showing exactly the rows a player can pick: the city
 * plus every hunt. `rows()` is not part of the panel contract `ui/index.js` drives (`open`,
 * `close`, `key`, `draw`); it is handed back on the returned object purely so this file does
 * not need a canvas to check the filter.
 */
import { describe, it, expect } from 'vitest';
import { makeTravel } from './travel.js';

/** Just enough of `app` for `rows()`: a `travel` module off `ctx.get`. */
function fakeApp(destinations) {
  return {
    ctx: {
      get: (id) => (id === 'travel'
        ? { destinations: () => destinations, current: () => ({ id: 'demo-city' }) }
        : { __missing: true }),
    },
  };
}

describe('the travel panel', () => {
  it('drops a hidden destination from the row list', () => {
    const panel = makeTravel(fakeApp([
      { id: 'demo-city', name: 'Lumen City', kind: 'Town' },
      { id: 'pokecenter', name: 'Pokemon Center', kind: 'Building', hidden: true },
      { id: 'hunt-meadow', name: 'Verdant Meadow', kind: 'Hunt' },
    ]));
    const ids = panel.rows().map((r) => r.id);
    expect(ids).toEqual(['demo-city', 'hunt-meadow']);
  });

  it('keeps every row when nothing is hidden', () => {
    const panel = makeTravel(fakeApp([
      { id: 'demo-city', name: 'Lumen City', kind: 'Town' },
      { id: 'hunt-meadow', name: 'Verdant Meadow', kind: 'Hunt' },
      { id: 'hunt-forest', name: 'Whisper Wood', kind: 'Hunt', locked: true, requiredLevel: 5 },
    ]));
    expect(panel.rows().length).toBe(3);
  });
});
