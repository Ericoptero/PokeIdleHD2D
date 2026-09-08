/**
 * A hand-authored bitmap font, because this UI is drawn into the same low-resolution buffer
 * the world is (see `screen.js`) and a hinted vector face at 8 px would be the one thing on
 * screen that is not on the pixel grid.
 *
 * Layout, fixed:
 *
 * ```
 *   row 0 ─┐
 *          │ cap height / ascender
 *   row 6 ─┴ baseline row (the last row a capital occupies)
 *   row 7    descender row (g j p q y and the comma tail)
 * ```
 *
 * so `HEIGHT` is 8 and `BASELINE` is 6. Lower-case x-height letters start at row 2.
 *
 * A glyph is stored as `'<top>|row/row/row'`, `top` defaulting to 0; every row of one glyph
 * is the same length and that length is the glyph's width, so the font is **variable width**
 * (an `i` is 3 px, an `M` is 5) and a line of it reads like DS-era UI text rather than like a
 * terminal. `#` is ink, everything else is paper.
 *
 * Pure data plus measurement — no DOM. `selftest.js` runs under Node and imports this file,
 * so nothing here may touch `document`.
 */

/** Rows in a glyph cell, including the descender row. */
export const HEIGHT = 8;
/** The last row a capital letter occupies. */
export const BASELINE = 6;
/** Blank columns between two glyphs. */
export const TRACKING = 1;
/** Baseline-to-baseline distance for `drawText`'s own line breaking. */
export const LINE_HEIGHT = 10;
/** Width of a space, in pixels, excluding tracking. */
export const SPACE_WIDTH = 3;

/* eslint-disable quote-props */
const GLYPHS = {
  '!': '#/#/#/#/#/./#',
  '"': '#.#/#.#',
  '#': '2|.#.#./#####/.#.#./#####/.#.#.',
  '$': '..#../.####/#.#../.###./..#.#/####./..#..',
  '%': '##..#/##..#/...#./..#../.#.../#..##/#..##',
  '&': '.##../#..#./.##../##.#./#..##/#..#./.##.#',
  "'": '#/#',
  '(': '..#/.#./#../#../#../.#./..#',
  ')': '#../.#./..#/..#/..#/.#./#..',
  '*': '1|#.#/.#./###/.#./#.#',
  '+': '2|.#./###/.#.',
  ',': '6|.#/#.',
  '-': '3|###',
  '.': '6|#',
  '/': '....#/....#/...#./..#../.#.../#..../#....',
  // Not a slashed zero. The diagonal through the counter is a *terminal* face's answer to
  // O-versus-0, and no Pokemon UI has ever used one: on screen `₽598,099` read as
  // 598,O-slash-99 and `12:00` as 12:O-slash-O-slash. The DS answer is a plain oval, and the
  // digits stay 5 px wide so a wallet number does not change width as it counts up.
  '0': '.###./#...#/#...#/#...#/#...#/#...#/.###.',
  '1': '..#../.##../..#../..#../..#../..#../.###.',
  '2': '.###./#...#/....#/...#./..#../.#.../#####',
  '3': '####./....#/....#/.###./....#/....#/####.',
  '4': '...#./..##./.#.#./#..#./#####/...#./...#.',
  '5': '#####/#..../####./....#/....#/#...#/.###.',
  '6': '..##./.#.../#..../####./#...#/#...#/.###.',
  '7': '#####/....#/...#./..#../.#.../.#.../.#...',
  '8': '.###./#...#/#...#/.###./#...#/#...#/.###.',
  '9': '.###./#...#/#...#/.####/....#/...#./.##..',
  ':': '2|#/./././#',
  ';': '2|.#/../../../.#/#.',
  '<': '1|..#/.#./#../.#./..#',
  '=': '2|####/..../####',
  '>': '1|#../.#./..#/.#./#..',
  '?': '.###./#...#/....#/...#./..#../...../..#..',
  '@': '.###./#...#/#.###/#.#.#/#.###/#..../.###.',
  'A': '.###./#...#/#...#/#####/#...#/#...#/#...#',
  'B': '####./#...#/#...#/####./#...#/#...#/####.',
  'C': '.###./#...#/#..../#..../#..../#...#/.###.',
  'D': '####./#...#/#...#/#...#/#...#/#...#/####.',
  'E': '#####/#..../#..../####./#..../#..../#####',
  'F': '#####/#..../#..../####./#..../#..../#....',
  'G': '.###./#...#/#..../#.###/#...#/#...#/.###.',
  'H': '#...#/#...#/#...#/#####/#...#/#...#/#...#',
  'I': '###/.#./.#./.#./.#./.#./###',
  'J': '..###/...#./...#./...#./...#./#..#./.##..',
  'K': '#...#/#..#./#.#../##.../#.#../#..#./#...#',
  'L': '#..../#..../#..../#..../#..../#..../#####',
  'M': '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#',
  'N': '#...#/##..#/#.#.#/#.#.#/#..##/#...#/#...#',
  'O': '.###./#...#/#...#/#...#/#...#/#...#/.###.',
  'P': '####./#...#/#...#/####./#..../#..../#....',
  'Q': '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#',
  'R': '####./#...#/#...#/####./#.#../#..#./#...#',
  'S': '.####/#..../#..../.###./....#/....#/####.',
  'T': '#####/..#../..#../..#../..#../..#../..#..',
  'U': '#...#/#...#/#...#/#...#/#...#/#...#/.###.',
  'V': '#...#/#...#/#...#/#...#/#...#/.#.#./..#..',
  'W': '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#',
  'X': '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
  'Y': '#...#/#...#/.#.#./..#../..#../..#../..#..',
  'Z': '#####/....#/...#./..#../.#.../#..../#####',
  '[': '##/#./#./#./#./#./##',
  '\\': '#..../#..../.#.../..#../...#./....#/....#',
  ']': '##/.#/.#/.#/.#/.#/##',
  '^': '.#./#.#',
  '_': '7|#####',
  '`': '#./.#',
  'a': '2|.###./....#/.####/#...#/.####',
  'b': '#..../#..../####./#...#/#...#/#...#/####.',
  'c': '2|.###./#..../#..../#..../.###.',
  'd': '....#/....#/.####/#...#/#...#/#...#/.####',
  'e': '2|.###./#...#/#####/#..../.###.',
  'f': '..##./.#.../.#.../####./.#.../.#.../.#...',
  'g': '2|.####/#...#/#...#/.####/....#/.###.',
  'h': '#..../#..../####./#...#/#...#/#...#/#...#',
  'i': '.#./.../##./.#./.#./.#./###',
  'j': '..#./..../..#./..#./..#./..#./#.#./.##.',
  'k': '#..../#..../#..#./#.#../##.../#.#../#..#.',
  'l': '##./.#./.#./.#./.#./.#./.##',
  'm': '2|##.#./#.#.#/#.#.#/#.#.#/#.#.#',
  'n': '2|####./#...#/#...#/#...#/#...#',
  'o': '2|.###./#...#/#...#/#...#/.###.',
  'p': '2|####./#...#/#...#/####./#..../#....',
  'q': '2|.####/#...#/#...#/.####/....#/....#',
  'r': '2|#.##/##../#.../#.../#...',
  's': '2|.####/#..../.###./....#/####.',
  't': '.#../.#../###./.#../.#../.#../..#.',
  'u': '2|#...#/#...#/#...#/#...#/.####',
  'v': '2|#...#/#...#/#...#/.#.#./..#..',
  'w': '2|#...#/#...#/#.#.#/#.#.#/.#.#.',
  'x': '2|#...#/.#.#./..#../.#.#./#...#',
  'y': '2|#...#/#...#/#...#/.####/....#/.###.',
  'z': '2|#####/...#./..#../.#.../#####',
  '{': '.##/.#./.#./#../.#./.#./.##',
  '|': '#/#/#/#/#/#/#',
  '}': '##./.#./.#./..#/.#./.#./##.',
  '~': '3|.#..#/#.#.#/#..#.',

  // --- the glyphs the other modules' own strings need ------------------------
  // economy/currencies.js mints ₽ ◈ ◆; collection toasts a ★ and an em dash.
  '₽': '.###./.#..#/.#..#/.###./####./.#.../.#...',   // ₽ ruble — the bar crosses the stem
  '◈': '1|..#../.#.#./#.#.#/.#.#./..#..',              // ◈ research
  '◆': '1|..#../.###./#####/.###./..#..',              // ◆ shard
  // Five points, and sitting on the baseline like a capital. The round-1 glyph was four
  // rows of a widening wedge and read as a four-pointed sparkle or an asterisk, which is
  // what "★ Shiny Ditto caught!" opened with.
  '★': '2|..#../.###./#####/.###./.#.#.',             // ★ shiny
  '—': '3|#####',                                       // — em dash
  '–': '3|####',                                        // – en dash
  '×': '2|#.#/.#./#.#',                                 // × times
  '·': '3|#',                                           // · middot
  '…': '6|#.#.#',                                       // … ellipsis
  '°': '..#./.#.#/..#.',                                // ° degree
  'é': '...#./..#../.###./#...#/#####/#..../.###.',     // é (Pokémon)
  'É': '..#../.#.../#####/#..../####./#..../#####',      // É (POKéMON uppercased)
  '→': '2|...#./#####/...#.',                           // →
  '←': '2|.#.../#####/.#...',                           // ←
  '↑': '.#./###/#.#/.#./.#./.#./.#.',                   // ↑
  '↓': '.#./.#./.#./.#./#.#/###/.#.',                   // ↓
  '▸': '2|#../##./###/##./#..',                         // ▸
  '▾': '3|#####/.###./..#..',                           // ▾
  '▴': '3|..#../.###./#####',                           // ▴
  '✓': '1|....#/...#./#..#./.##../..#..',               // ✓
  '✗': '1|#...#/.#.#./..#../.#.#./#...#',               // ✗
  '♥': '1|.#.#./#####/#####/.###./..#..',               // ♥
  '█': '#####/#####/#####/#####/#####/#####/#####',     // █ full block
};
/* eslint-enable quote-props */

/** Parsed once. `{ w, top, rows }`, rows being strings of `#` and `.`. */
const CACHE = new Map();
/** Anything with no glyph draws as this, so a stray character is visible but never throws. */
const TOFU = { w: 4, top: 1, rows: ['####', '#..#', '#..#', '#..#', '####'] };
const SPACE = { w: SPACE_WIDTH, top: 0, rows: [] };

function parse(spec) {
  const bar = spec.indexOf('|');
  const top = bar < 0 ? 0 : Number(spec.slice(0, bar));
  const rows = spec.slice(bar + 1).split('/');
  return { w: rows[0].length, top, rows };
}

/** The glyph for one character. Never null: an unknown character gets the tofu box. */
export function glyph(ch) {
  if (ch === ' ') return SPACE;
  let g = CACHE.get(ch);
  if (g) return g;
  const spec = GLYPHS[ch];
  g = spec ? parse(spec) : TOFU;
  CACHE.set(ch, g);
  return g;
}

/** Whether this character has a real glyph (the selftest's coverage check). */
export const has = (ch) => ch === ' ' || GLYPHS[ch] !== undefined;

/** Every character the font can draw, in code-point order. */
export const characters = () => Object.keys(GLYPHS).sort();

/** Width in pixels of one line of text, tracking included between glyphs but not after. */
export function measure(text) {
  const s = String(text ?? '');
  let w = 0;
  for (const ch of s) w += glyph(ch).w + TRACKING;
  return Math.max(0, w - TRACKING);
}

/**
 * Trims `text` to fit `maxWidth` pixels, ending in an ellipsis when it had to cut.
 * Used everywhere a species name meets a fixed-width slot.
 */
export function ellipsize(text, maxWidth) {
  const s = String(text ?? '');
  if (measure(s) <= maxWidth) return s;
  const dots = glyph('…').w + TRACKING;
  let w = 0;
  let out = '';
  for (const ch of s) {
    const next = w + glyph(ch).w + TRACKING;
    if (next + dots > maxWidth) break;
    out += ch;
    w = next;
  }
  return `${out}…`;
}

/** Greedy word wrap to `maxWidth` pixels. Returns the lines. */
export function wrap(text, maxWidth) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate) <= maxWidth || !line) line = candidate;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}
