#!/usr/bin/env node
/**
 * The checks a screenshot cannot make. Discovered and run by `tools/seams/run.js`, under
 * Node with no DOM — so it may only import the parts of this module that are pure data:
 * `font.js`, `format.js` and the key tables out of `input.js`.
 *
 *   node src/ui/selftest.js
 *
 * What is worth testing here rather than looking at:
 *
 *  - **font coverage.** A missing glyph is invisible in review — it renders as a blank of
 *    the right width inside a word, and you only notice when a critic reads "POK  MART" off
 *    a screenshot. Every printable ASCII character plus every symbol the other modules put
 *    on the bus must exist, and every glyph must be rectangular and fit its cell.
 *  - **measurement.** Every panel lays itself out against `measure()`, so if measurement and
 *    drawing disagree the whole UI is subtly wrong and nothing throws.
 *  - **the movement map.** The four directions must be exactly `core/dir.js`'s, once each.
 */

import { SOUTH, WEST, NORTH, EAST, DIR_NAME } from '../core/dir.js';
import {
  HEIGHT, BASELINE, TRACKING, SPACE_WIDTH,
  glyph, has, characters, measure, ellipsize, wrap,
} from './font.js';
import { fmt, shortNumber, duration, titleCase, clockTime } from './format.js';
import { MOVE_KEYS, PANEL_KEYS, PANEL_IDS } from './input.js';
import { C, applyLight, lightAt } from './theme.js';
import { fit, margin } from './panels/common.js';
// `gesture.js` touches no DOM by construction (it is the pointer layer's pure half, pulled out
// for exactly this reason — slice 015), so its reducer and its scroll clamp run here the same
// way `panels/battle.js`'s transcript formatter already does.
import { startDrag, move as moveDrag, drop as dropDrag, cancel as cancelDrag, clampScroll } from './gesture.js';
// `window.js` is the same split applied to a window's geometry (slice 016): pure clamp math,
// no DOM, so it runs here the same way `gesture.js`'s reducer does.
import { MIN_SIZE, minSizeFor, clampMove, clampResize } from './window.js';
// `panels/battle.js` touches the DOM only inside `draw`, so its transcript formatter is a pure
// function this file may call — the same discipline that lets `evolution.js` be tested here.
import { lineFor, STATUS_NAME } from './panels/battle.js';
// `evolution.js` touches the DOM only inside its functions, so importing its pure pieces here
// is safe under Node — the same discipline that lets `font.js` be tested without a canvas.
import { BEATS, TOTAL, swapKeyframes } from './evolution.js';
// `panels/inventory.js` touches the DOM only inside `draw`, same as `battle.js` above; its
// category labels are pure data.
import { CATEGORY_LABEL } from './panels/inventory.js';

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
};

// --- the font ---------------------------------------------------------------
{
  const missing = [];
  for (let c = 32; c < 127; c++) if (!has(String.fromCharCode(c))) missing.push(String.fromCharCode(c));
  check('every printable ASCII character has a glyph', missing.length === 0, missing.length ? missing.join('') : '32..126');

  // The symbols other modules already put on the bus and in their own strings.
  const SYMBOLS = [...'₽◈◆★—×·…°éÉ→←↑↓▸▾▴✓✗♥'];
  const missingSymbols = SYMBOLS.filter((ch) => !has(ch));

  check('every symbol the other modules emit has a glyph', missingSymbols.length === 0,
    missingSymbols.length ? missingSymbols.join(' ') : SYMBOLS.join(''));

  /**
   * The battle card's own strings, composed by the same function the panel draws with.
   *
   * A missing glyph renders as a blank of the right width, so it is invisible in review — and
   * `panels/battle.js` shipped "  35 HP  ×2" for a whole capture because the minus in front of
   * it was U+2212 rather than an ASCII hyphen. Nothing threw, nothing warned, and the only way
   * to see it was to look at a capture. So the transcript formatter is *called* here, one event
   * of every kind it handles, and every character it produces is looked up in the face.
   */
  const NAMES = { a: 'Oshawott', b: 'Zubat' };
  const EVENTS = [
    { kind: 'move', actor: 'a', species: 'oshawott', name: 'Water Pulse' },
    { kind: 'damage', actor: 'a', species: 'zubat', damage: 34, hits: 1, effectiveness: 2, crit: true },
    { kind: 'damage', actor: 'a', species: 'zubat', damage: 3, hits: 1, effectiveness: 0.25, crit: false },
    { kind: 'miss', actor: 'a', species: 'zubat' },
    { kind: 'immune', actor: 'a', species: 'zubat' },
    { kind: 'status', actor: 'b', species: 'oshawott', status: 'tox' },
    { kind: 'confused', actor: 'b', species: 'oshawott' },
    { kind: 'confused-hit', actor: 'a', species: 'oshawott', damage: 9 },
    { kind: 'flinch', actor: 'a', species: 'oshawott' },
    { kind: 'asleep', actor: 'a', species: 'oshawott' },
    { kind: 'frozen', actor: 'a', species: 'oshawott' },
    { kind: 'paralysed', actor: 'a', species: 'oshawott' },
    { kind: 'recoil', actor: 'a', species: 'oshawott', damage: 7 },
    { kind: 'faint', species: 'zubat' },
  ];
  const battleText = [
    ...EVENTS.map((ev) => lineFor(ev, NAMES)?.text ?? ''),
    ...Object.values(STATUS_NAME),
    'WILD', 'PITY', 'IN BATTLE', 'LEARNED', 'two slots always hold attacks',
  ].join('');
  const battleMissing = [...new Set([...battleText])].filter((ch) => ch !== ' ' && !has(ch));
  check('every character the battle card draws has a glyph', battleMissing.length === 0,
    battleMissing.map((c) => `${JSON.stringify(c)} U+${c.codePointAt(0).toString(16).toUpperCase()}`).join(' '));
  check('the battle card has a line for every event kind it lists',
    EVENTS.every((ev) => lineFor(ev, NAMES) !== null));

  /**
   * The inventory panel's own strings (slice 018) — the category labels it draws as filter
   * tabs, and one real `desc` per category (`economy/items.js`, copied verbatim as a literal
   * rather than imported: seam rule 2 forbids importing a sibling module's non-`index.js`
   * file, the same reason the battle events above are hand-written rather than pulled from
   * `battle/moves.js`). `CATEGORY_LABEL` is imported for real, so a label added or renamed in
   * `panels/inventory.js` is covered here without a second copy to keep in sync.
   */
  const ITEM_DESC_SAMPLE = [
    'The standard capsule. 1× catch rate.', // ball: pokeball
    'Restores 20 HP. ₽10 per point.', // medicine: potion
    '3,000 EXP. ₽0.27 per point.', // candy: expcandy_xs
    'Evolves the Fire Stone family. 40 shards at the Shard Stall.', // evolution: firestone
    '+50% encounter rate for 10 minutes.', // lure: lure
    '+50% money from every source, forever. One only.', // held: amuletcoin
    'Sell-only loot.', // treasure: nugget
  ];
  const invText = [...Object.values(CATEGORY_LABEL), 'ALL', 'BAG', 'STASH', 'ITEMS', 'DETAIL',
    'Category', 'Held', 'Sells for', 'Stack worth', 'LOCK (never auto-sold)',
    'UNLOCK (auto-sell allowed)', 'nothing in the bag', 'nothing in the stash',
    'nothing selected', ...ITEM_DESC_SAMPLE].join('');
  const invMissing = [...new Set([...invText])].filter((ch) => ch !== ' ' && !has(ch));
  check('every string the inventory panel draws has a glyph', invMissing.length === 0,
    invMissing.map((c) => `${JSON.stringify(c)} U+${c.codePointAt(0).toString(16).toUpperCase()}`).join(' '));

  const ragged = [];
  const tall = [];
  const empty = [];
  for (const ch of characters()) {
    const g = glyph(ch);
    if (g.rows.some((r) => r.length !== g.w)) ragged.push(ch);
    if (g.top + g.rows.length > HEIGHT) tall.push(ch);
    if (!g.rows.length || g.w < 1) empty.push(ch);
    if (g.rows.some((r) => /[^#.]/.test(r))) ragged.push(ch);
  }
  check('every glyph is a rectangle of # and .', ragged.length === 0, ragged.join(' ') || `${characters().length} glyphs`);
  check(`every glyph fits the ${HEIGHT}-row cell`, tall.length === 0, tall.join(' ') || `baseline row ${BASELINE}`);
  check('no glyph is empty', empty.length === 0, empty.join(' '));

  // Every capital must reach the baseline row, or a line of text sits crooked.
  const short = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].filter((ch) => {
    const g = glyph(ch);
    return g.top !== 0 || g.rows.length !== BASELINE + 1;
  });
  check('every capital and digit spans row 0 to the baseline', short.length === 0, short.join(' '));

  // Lower-case x-height letters all start on the same row, or the text ripples.
  const xHeight = [...'acemnorsuvwxz'].filter((ch) => glyph(ch).top !== 2);
  check('x-height letters share a top row', xHeight.length === 0, xHeight.join(' '));
}

// --- measurement ------------------------------------------------------------
{
  const sum = (s) => [...s].reduce((a, ch) => a + glyph(ch).w + TRACKING, 0) - TRACKING;
  const samples = ['A', 'Poké Mart', '₽598,099', 'While you were away', '0123456789', ' '];
  const wrongMeasure = samples.filter((s) => measure(s) !== sum(s));
  check('measure() is the sum of the advances', wrongMeasure.length === 0, wrongMeasure.join(' | '));
  check('measure("") is 0', measure('') === 0);
  check('a space advances by SPACE_WIDTH', measure('a a') - measure('aa') === SPACE_WIDTH + TRACKING,
    `${measure('a a')} vs ${measure('aa')}`);

  for (const width of [10, 24, 40, 80]) {
    const cut = ellipsize('Department Store of Castelia', width);
    check(`ellipsize fits ${width}px`, measure(cut) <= width, `"${cut}" = ${measure(cut)}px`);
  }
  check('ellipsize leaves a short string alone', ellipsize('Lv 5', 200) === 'Lv 5');
  check('ellipsize marks the cut', ellipsize('Department Store', 40).endsWith('…'));

  const lines = wrap('The absence was long enough that the tail of the encounter list was estimated', 120);
  check('wrap never exceeds its width', lines.every((l) => measure(l) <= 120), lines.map(measure).join(','));
  check('wrap keeps every word', wrap('a b c', 200).join(' ') === 'a b c');
  check('wrap of nothing is one empty line', wrap('', 100).length === 1);
}

// --- the strings ------------------------------------------------------------
{
  check('fmt floors and groups', fmt(12345.9) === '12,345', fmt(12345.9));
  check('fmt survives nonsense', fmt(undefined) === '0' && fmt(NaN) === '0');
  check('shortNumber keeps small numbers exact', shortNumber(99999) === '99,999', shortNumber(99999));
  check('shortNumber scales', shortNumber(1234567) === '1.2M', shortNumber(1234567));
  check('duration under a minute', duration(45) === '45 s', duration(45));
  check('duration in minutes', duration(600) === '10 m', duration(600));
  check('duration in hours', duration(5 * 3600) === '5 h', duration(5 * 3600));
  check('duration carries the remainder', duration(5 * 3600 + 12 * 60) === '5 h 12 m', duration(5 * 3600 + 12 * 60));
  check('duration in days', duration(30 * 3600) === '1 d 6 h', duration(30 * 3600));
  check('titleCase splits on dashes', titleCase('nidoran-f') === 'Nidoran F', titleCase('nidoran-f'));
  check('clockTime pads', clockTime(7.25) === '07:15', clockTime(7.25));
  check('clockTime wraps', clockTime(24.5) === '00:30' && clockTime(-1) === '23:00', `${clockTime(24.5)} ${clockTime(-1)}`);
}

// --- the input map ----------------------------------------------------------
{
  const dirs = [...MOVE_KEYS.values()];
  const counts = [SOUTH, WEST, NORTH, EAST].map((d) => dirs.filter((v) => v === d).length);
  check('every direction is bound exactly twice (arrows + WASD)', counts.every((n) => n === 2),
    counts.map((n, i) => `${DIR_NAME[i]}:${n}`).join(' '));
  check('the movement map is nothing but the four directions',
    dirs.every((d) => d === SOUTH || d === WEST || d === NORTH || d === EAST));
  check('arrow keys are bound by physical code', ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].every((k) => MOVE_KEYS.has(k)));
  const clash = [...PANEL_KEYS.keys()].filter((k) => MOVE_KEYS.has(k));
  check('no panel shortcut steals a movement key', clash.length === 0, clash.join(' '));
  // Derived from `PANEL_IDS`, not from a copy of it kept here: the hand-written list failed
  // the day a panel was added, which is the check being brittle rather than the panel being
  // wrong (DECISIONS #77).
  check('every panel shortcut names a panel this module ships',
    [...PANEL_KEYS.values()].every((id) => PANEL_IDS.includes(id)),
    [...new Set(PANEL_KEYS.values())].filter((id) => !PANEL_IDS.includes(id)).join(' ') || 'all known');
}

// --- the layout clamp (round-2 issue 1) -------------------------------------
// Both files are pure: `theme.js` and `panels/common.js` touch no DOM, so the two
// invariants that a screenshot proves *slowly* can be pinned here instead.
{
  // The real internal buffers `render.js` produces, now that `resize()` rounds both
  // dimensions up to **even** and derives the upscale from the viewport (DECISIONS #60).
  // 1920x1080 and 1280x720 both land on 640x360; 1600x900 on 534x300; a 1512x982 laptop on
  // 756x492. The last two are the ones that used to be missing: a 2560x1080 ultrawide is only
  // 270 tall, and a 390 px phone in portrait is 390 wide — both narrower in one axis than any
  // panel this module authors, which is the whole point of the clamp.
  //
  // The five `/2` entries are what `screen.js`'s own `resize()` actually produces from each of
  // the buffers above once `?uiScale=2` (slice 016, DECISIONS #85) halves the UI canvas's own
  // backing store — real produced sizes, not invented ones, matching this array's existing
  // discipline (each halves cleanly; `screen.js` floors regardless).
  const buffers = [
    [640, 360], [534, 300], [756, 492], [640, 270], [390, 844],
    [320, 180], [267, 150], [378, 246], [320, 135], [195, 422],
  ];
  // Every `...fit(g, w, h)` call site across `panels/*.js` — `automation.js`'s 600x300 was
  // missing here before this slice (a pre-existing gap this check's own purpose, "every
  // authored panel size", was silently not living up to); `inventory.js`'s 480x264 (slice
  // 018) is added for the same reason a new authored size always belongs in this list.
  const authored = [[560, 288], [540, 278], [502, 264], [424, 250], [600, 300], [480, 264]];
  const bad = [];
  for (const [W, H] of buffers) {
    const g = { width: W, height: H };
    const m = margin(g);
    for (const [w, h] of authored) {
      const f = fit(g, w, h);
      if (f.w + m * 2 > W || f.h + m * 2 + 2 > H) bad.push(`${w}x${h} in ${W}x${H} -> ${f.w}x${f.h}`);
      if (f.w > w || f.h > h) bad.push(`${w}x${h} grew to ${f.w}x${f.h}`);
    }
  }
  check('fit() clamps every authored panel size into every buffer size', bad.length === 0,
    bad.join(' | ') || `${authored.length} panels x ${buffers.length} buffers`);
  check('the margin scales with the buffer and never vanishes',
    margin({ width: 640 }) === 10 && margin({ width: 390 }) >= 5 && margin({ width: 200 }) >= 5,
    `${margin({ width: 640 })} ${margin({ width: 534 })} ${margin({ width: 390 })}`);
}

// --- the light model (round-2 issue 2) --------------------------------------
{
  const noon = lightAt(12);
  check('noon is the unlit palette', noon.every((v) => Math.abs(v - 1) < 0.001), noon.map((v) => v.toFixed(3)).join(' '));
  const night = lightAt(21);
  check('night is dimmer and cooler than noon', night[0] < 0.7 && night[2] > night[0],
    night.map((v) => v.toFixed(3)).join(' '));
  check('golden hour is warm, not cool', lightAt(17.5)[0] > lightAt(17.5)[2],
    lightAt(17.5).map((v) => v.toFixed(3)).join(' '));

  check('applyLight reports a change once and then not again', applyLight(21) === true && applyLight(21) === false);
  const litPaper = C.wallLight;
  const litGlow = C.glowBase;
  const litWell = C.deepBase;
  applyLight(12);
  check('the sky dims the paper', litPaper !== C.wallLight, `${litPaper} -> ${C.wallLight}`);
  check('the lamp ramp is emissive and does not dim', litGlow === C.glowBase, `${litGlow} / ${C.glowBase}`);
  check('the recess is a screen and does not dim', litWell === C.deepBase, `${litWell} / ${C.deepBase}`);
  // `shade()` re-emits lower case, so the comparison is on the value and not on the spelling.
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  check('the palette is restored exactly at noon', same(C.wallLight, '#F5E9CE') && same(C.ink, '#241E1B'),
    `${C.wallLight} ${C.ink}`);
}

// --- the evolution cutscene's timeline --------------------------------------
// The cutscene is CSS, so almost all of it has to be judged by looking (the three frozen
// captures in docs/progress/pokemon/r3/). What can be wrong on its own is the timeline: one
// clock drives every layer, and a keyframe percentage outside 0..100 or out of order silently
// drops the whole `@keyframes` rule with nothing throwing.
{
  const sum = Object.values(BEATS).reduce((a, b) => a + b, 0);
  check('the cutscene beats sum to its own duration', Math.abs(sum - TOTAL) < 1e-9, `${sum} vs ${TOTAL}`);
  check('every beat is a real length', Object.values(BEATS).every((n) => n > 0.1),
    JSON.stringify(BEATS));

  // The generator is fed the SAME accelerating schedule `pokemon` publishes, which is the
  // point: a hand-written @keyframes block here would be a second copy of the swap timing.
  const swapsBy = (t) => {
    let e = 0; let n = 0;
    for (let i = 0; i < 512; i++) {
      const k = Math.max(0, Math.min(1, e / 2));
      const step = 0.30 + (0.05 - 0.30) * (k * k);
      if (e + step > t) return { n, into: t - e, step };
      e += step; n++;
    }
    return { n, into: 0, step: 0.05 };
  };
  const tracks = swapKeyframes(swapsBy, 2);
  for (const [name, css] of Object.entries(tracks)) {
    const stops = [...css.matchAll(/([\d.]+)%\{/g)].map((m) => Number(m[1]));
    check(`the ${name} track stays inside 0..100%`, stops.every((p) => p >= 0 && p <= 100),
      `${Math.min(...stops)}..${Math.max(...stops)}`);
    check(`the ${name} track never runs backwards`,
      stops.every((p, i) => i === 0 || p >= stops[i - 1]), `${stops.length} stops`);
    check(`the ${name} track ends where the burst starts`, /100%\{opacity:[01]\}$/.test(css), css.slice(-30));
  }
  // The two tracks are the alternation: they must disagree, or nothing is swapping.
  check('the two sprite tracks are not the same animation', tracks.old !== tracks.neu);
}

// --- the pointer layer's pure half (slice 015) -------------------------------
// Proves `gesture.js` has no browser dependency — the same guarantee `battle.js`'s and
// `evolution.js`'s pure exports already have, checked here rather than only in a browser test
// so a DOM-shaped regression (an accidental `document.` reference) fails under plain Node too.
{
  const s1 = startDrag('mon-3', 'party-row', 10, 20);
  check('startDrag returns the picked-up state',
    JSON.stringify(s1) === JSON.stringify({ phase: 'drag', tag: 'party-row', payload: 'mon-3', x: 10, y: 20 }),
    JSON.stringify(s1));

  const s2 = moveDrag(s1, 5, -3);
  check('move() adds the delta, not an absolute position',
    JSON.stringify(s2) === JSON.stringify({ phase: 'drag', tag: 'party-row', payload: 'mon-3', x: 15, y: 17 }),
    JSON.stringify(s2));

  const s3 = dropDrag(s2, { id: 'box-slot-9' });
  check('drop() over a target ends the gesture with phase "drop"',
    JSON.stringify(s3) === JSON.stringify({ phase: 'drop', tag: 'party-row', payload: 'mon-3', x: 15, y: 17 }),
    JSON.stringify(s3));

  check('drop() with no target cancels back to null', dropDrag(s2, null) === null);
  check('cancel() discards the gesture regardless of accumulated motion',
    cancelDrag(moveDrag(s1, 9999, -9999)) === null);
  check('move()/drop() pass a null state through unchanged',
    moveDrag(null, 1, 1) === null && dropDrag(null, { id: 'x' }) === null);

  check('clampScroll: a negative offset clamps to 0', clampScroll(-40, 300, 100) === 0);
  check('clampScroll: an offset beyond contentSize - viewSize clamps to that max',
    clampScroll(1000, 300, 100) === 200, String(clampScroll(1000, 300, 100)));
  check('clampScroll: contentSize <= viewSize always clamps to 0',
    clampScroll(50, 100, 100) === 0 && clampScroll(50, 80, 100) === 0);
  check('clampScroll: an in-range offset passes through unchanged', clampScroll(120, 300, 100) === 120);
}

// --- a window's geometry (slice 016) -----------------------------------------
// `window.test.js` (vitest) already has the full golden set; this is the same invariant run
// under plain Node, the way `window.test.js`'s own precedent (`gesture.js`'s reducer) already
// is here too — so a DOM-shaped regression in `window.js` fails a Node run, not only vitest.
{
  const buf = { width: 640, height: 360 };
  check('minSizeFor falls back to MIN_SIZE for a panel with no override',
    minSizeFor('shop').w === MIN_SIZE.w && minSizeFor('shop').h === MIN_SIZE.h);

  const negX = clampMove({ x: -50, y: 100, w: 200, h: 150 }, buf, 10);
  check('clampMove: a window dragged so x would go negative clamps to the margin',
    negX.x === 10 && negX.y === 100, JSON.stringify(negX));

  const pastRight = clampMove({ x: 600, y: 100, w: 200, h: 150 }, buf, 10);
  check('clampMove: dragged past the right edge clamps so x + w never exceeds buffer.width - margin',
    pastRight.x + pastRight.w === buf.width - 10, JSON.stringify(pastRight));

  const tooSmall = clampResize({ x: 20, y: 20, w: 10, h: 10 }, buf, 10, MIN_SIZE);
  check('clampResize: resized below the declared minimum clamps to that minimum',
    tooSmall.w === MIN_SIZE.w && tooSmall.h === MIN_SIZE.h, JSON.stringify(tooSmall));

  const tooBig = clampResize({ x: 10, y: 10, w: 5000, h: 5000 }, buf, 10, MIN_SIZE);
  check('clampResize: resized past the buffer clamps to fit',
    tooBig.x + tooBig.w === buf.width - 10 && tooBig.y + tooBig.h === buf.height - 10 - 2,
    JSON.stringify(tooBig));
}

console.log(failed ? `\n${failed} check(s) failed` : '\nui: all checks pass');
process.exit(failed ? 1 : 0);
