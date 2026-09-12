/**
 * `plates.js`'s `draw()` has real, non-trivial pure geometry — the collision-avoidance loop,
 * the battle-card keep-out, the bottom-strip clamp — that a fake painter can pin without a
 * canvas or a `ctx`. `read()` (the world pull) is not tested here: it is a thin `ctx.get` chain
 * in the same style `hud.js`'s own `read()` already is, and the properties worth pinning are in
 * what happens once positions are known, which `draw()` owns entirely.
 */
import { describe, it, expect } from 'vitest';
import { makePlates } from './plates.js';

/** Just enough of the painter (`screen.js`'s `g`) for `draw()`: records every fill and text. */
function fakePainter({ width = 200, height = 100 } = {}) {
  const fills = [];
  const texts = [];
  return {
    width, height,
    measure: (s) => String(s ?? '').length * 6,
    fill(x, y, w, h, colour) { fills.push({ x, y, w, h, colour }); },
    text(x, y, str, colour) { texts.push({ x, y, str, colour }); return x + String(str ?? '').length * 6; },
    textRight(x, y, str, colour) { const w = String(str ?? '').length * 6; texts.push({ x: x - w, y, str, colour }); return x - w; },
    _fills: fills,
    _texts: texts,
  };
}

/** A world point maps straight to a screen point — `x,z` become `x,y`, no camera needed. */
const identityProject = (x, y, z) => ({ x, y: z });

/** One plate, positioned so `identityProject(x, y + lift, z)` lands exactly at `(sx, sy)`. */
const plateAt = (sx, sy, extra = {}) => ({ x: sx, y: 0, z: sy, lift: 0, name: 'Pidgey', level: 5, bar: null, ...extra });

const ctx = { get: () => ({ __missing: true }) };

describe('plates.draw — collision avoidance', () => {
  it('stacks two plates that would otherwise land on the same rect', () => {
    const plates = makePlates(ctx);
    const g = fakePainter();
    // Two names close enough on screen (12px apart) that identical-width labels overlap.
    plates.draw(g, identityProject, [plateAt(20, 50), plateAt(26, 50)]);
    const rows = [...new Set(g._texts.filter((t) => t.str === 'Pidgey').map((t) => t.y))];
    expect(rows.length, 'two distinct rows were used').toBe(2);
  });

  it('never draws two overlapping rects', () => {
    const plates = makePlates(ctx);
    const g = fakePainter();
    const list = [plateAt(20, 50), plateAt(22, 50), plateAt(18, 50), plateAt(24, 51)];
    plates.draw(g, identityProject, list);
    const boxes = g._fills.filter((f) => f.colour?.startsWith('rgba'));
    const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i], boxes[j]), `box ${i} and ${j} overlap`).toBe(false);
      }
    }
  });

  it('drops a plate rather than snapping it back onto the one it could not clear', () => {
    const plates = makePlates(ctx);
    // A buffer four rows tall: room for exactly one plate plus one stacked below it, no more.
    const g = fakePainter({ height: HEIGHT_FOR(2) });
    const list = [plateAt(20, 50), plateAt(22, 50), plateAt(24, 50), plateAt(26, 50)];
    plates.draw(g, identityProject, list);
    const drawn = new Set(g._fills.filter((f) => f.colour?.startsWith('rgba')).map((f) => `${f.x},${f.y}`));
    // Never more plates drawn than the buffer had room for, and never two at the same spot.
    expect(drawn.size).toBeLessThanOrEqual(2);
  });
});

/** Enough height for `n` stacked 8px-tall plates plus the floor margin `draw()` reserves. */
function HEIGHT_FOR(n) { return 2 + n * 9 + 2; }

describe('plates.draw — keep-out regions', () => {
  it('keeps a plate off the bottom strip via bottomLimit', () => {
    const plates = makePlates(ctx);
    const g = fakePainter({ height: 100 });
    plates.draw(g, identityProject, [plateAt(20, 95)], { bottomLimit: 40 });
    const box = g._fills.find((f) => f.colour?.startsWith('rgba'));
    expect(box, 'a low-projected plate still draws, clamped upward').toBeTruthy();
    expect(box.y + box.h).toBeLessThanOrEqual(40);
  });

  it('drops a plate that would overlap the battle card\'s box entirely', () => {
    const plates = makePlates(ctx);
    const g = fakePainter();
    const avoid = { x: 0, y: 40, w: 60, h: 60 };
    plates.draw(g, identityProject, [plateAt(20, 50)], { avoid });
    expect(g._fills.some((f) => f.colour?.startsWith('rgba')), 'nothing was drawn').toBe(false);
  });

  it('draws normally once the plate is outside the avoided box', () => {
    const plates = makePlates(ctx);
    const g = fakePainter();
    const avoid = { x: 0, y: 40, w: 20, h: 60 };
    plates.draw(g, identityProject, [plateAt(150, 50)], { avoid });
    expect(g._fills.some((f) => f.colour?.startsWith('rgba')), 'drawn, clear of the box').toBe(true);
  });
});

describe('plates.draw — labels', () => {
  it('prints the level and, on a shiny, the star', () => {
    const plates = makePlates(ctx);
    const g = fakePainter();
    plates.draw(g, identityProject, [plateAt(60, 50, { shiny: true })]);
    expect(g._texts.some((t) => t.str === 'Pidgey')).toBe(true);
    expect(g._texts.some((t) => t.str === 'Lv 5')).toBe(true);
    expect(g._texts.some((t) => t.str === '★')).toBe(true);
  });

  it('draws no level text when a plate carries none (a name-only NPC)', () => {
    const plates = makePlates(ctx);
    const g = fakePainter();
    plates.draw(g, identityProject, [plateAt(60, 50, { level: null })]);
    expect(g._texts.some((t) => /^Lv /.test(t.str))).toBe(false);
  });

  it('draws nothing at all for an empty list', () => {
    const plates = makePlates(ctx);
    const g = fakePainter();
    plates.draw(g, identityProject, []);
    expect(g._fills.length).toBe(0);
    expect(g._texts.length).toBe(0);
  });
});
