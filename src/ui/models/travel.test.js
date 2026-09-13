/**
 * `travel.destinations()` can carry a `hidden` row (src/travel/index.js, `pokecenter`'s
 * door-only entry) and the Routes screen must keep showing exactly the rows a player can pick:
 * the city plus every hunt. Moved here unchanged from `panels/travel.test.js` when the view
 * built on `travelRows` converted to a DOM screen (`screens/travel.js`, Stage 6) — the model
 * this pins did not change, only the thing rendering it.
 */
import { describe, it, expect } from 'vitest';
import { travelRows } from './travel.js';

/** Just enough of `app` for `travelRows()`: a `travel` module off `ctx.get`. */
function fakeApp(destinations) {
  return {
    ctx: {
      get: (id) => (id === 'travel'
        ? { destinations: () => destinations, current: () => ({ id: 'demo-city' }) }
        : { __missing: true }),
    },
  };
}

describe('the travel row model', () => {
  it('drops a hidden destination from the row list', () => {
    const rows = travelRows(fakeApp([
      { id: 'demo-city', name: 'Lumen City', kind: 'Town' },
      { id: 'pokecenter', name: 'Pokemon Center', kind: 'Building', hidden: true },
      { id: 'hunt-meadow', name: 'Verdant Meadow', kind: 'Hunt' },
    ]));
    expect(rows.map((r) => r.id)).toEqual(['demo-city', 'hunt-meadow']);
  });

  it('keeps every row when nothing is hidden', () => {
    const rows = travelRows(fakeApp([
      { id: 'demo-city', name: 'Lumen City', kind: 'Town' },
      { id: 'hunt-meadow', name: 'Verdant Meadow', kind: 'Hunt' },
      { id: 'hunt-forest', name: 'Whisper Wood', kind: 'Hunt', locked: true, requiredLevel: 5 },
    ]));
    expect(rows.length).toBe(3);
  });
});
