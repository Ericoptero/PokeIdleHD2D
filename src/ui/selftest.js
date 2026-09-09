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
import { MOVE_KEYS, PANEL_KEYS } from './input.js';
import { C, applyLight, lightAt } from './theme.js';
import { fit, margin } from './panels/common.js';
// `panels/battle.js` touches the DOM only inside `draw`, so its transcript formatter is a pure
// function this file may call — the same discipline that lets `evolution.js` be tested here.
import { lineFor, STATUS_NAME } from './panels/battle.js';
// `evolution.js` touches the DOM only inside its functions, so importing its pure pieces here
// is safe under Node — the same discipline that lets `font.js` be tested without a canvas.
import { BEATS, TOTAL, swapKeyframes } from './evolution.js';

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
  check('every panel shortcut names a panel this module ships',
    [...PANEL_KEYS.values()].every((id) => ['travel', 'party', 'shop', 'boxes', 'dex', 'menu'].includes(id)),
    [...new Set(PANEL_KEYS.values())].join(' '));
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
  const buffers = [[640, 360], [534, 300], [756, 492], [640, 270], [390, 844]];
  const authored = [[560, 288], [540, 278], [502, 264], [424, 250]];
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

console.log(failed ? `\n${failed} check(s) failed` : '\nui: all checks pass');
process.exit(failed ? 1 : 0);
