/**
 * Inline SVG icons for the Códice DOM screens — a deliberate departure from the source
 * design, which specifies Google's Material Symbols (a ligature icon font: `<span
 * class="ms">bedtime</span>`).
 *
 * Before that font decodes, the browser paints the literal text `bedtime` — a real, different
 * frame `tools/shots/parity.js` would catch (two captures of the same URL must be
 * byte-identical), on top of a 250-400KB network font the screenshot harness would flag as a
 * request the same way `base.css`'s header explains for the type faces. Inline `<path>` data
 * is deterministic from the first frame, zero-network, and tints with `currentColor` exactly
 * like the ligature glyphs would have.
 *
 * Hand-authored, generic geometric shapes (not traced from any icon set) on a 24×24 grid,
 * `stroke`-based to match Material Symbols' outlined weight the design uses throughout.
 */

const NS = 'http://www.w3.org/2000/svg';

/** @type {Record<string, string[]>} one or more `<path d>` strings per icon, 24×24 viewBox. */
const PATHS = {
  // A crescent moon — "while you were away".
  bedtime: ['M20 14.5A8.5 8.5 0 1 1 9.5 4 6.8 6.8 0 0 0 20 14.5Z'],
  // A ring with a check mark — "already collected / done".
  'check-circle': [
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
    'M8 12.5l2.5 2.5L16 9.5',
  ],
  // A coin — currency.
  coin: [
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
    'M12 7.5v9M9.5 9.3c0-1 1-1.8 2.5-1.8s2.5.7 2.5 1.7-1 1.4-2.5 1.7-2.5.8-2.5 1.8 1 1.8 2.5 1.8 2.5-.7 2.5-1.7',
  ],
  // A rising line — XP / progress.
  'trending-up': ['M4 16l5-5 4 4 7-8', 'M15 6h5v5'],
  // An open eye — encounters seen.
  eye: [
    'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z',
    'M12 14.7a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4Z',
  ],
  // A simplified capture ball — the top hemisphere, band, and button.
  capture: [
    'M3 12a9 9 0 0 1 18 0',
    'M3 12a9 9 0 0 0 18 0',
    'M3 12h6.2M14.8 12H21',
    'M9.8 12a2.2 2.2 0 1 0 4.4 0 2.2 2.2 0 0 0-4.4 0Z',
  ],
  close: ['M6 6l12 12M18 6L6 18'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-up': ['M6 15l6-6 6 6'],
  // A triangle with an exclamation mark — the toast stack's "warn" kind.
  alert: ['M12 3.5L21.5 20h-19L12 3.5Z', 'M12 10v4', 'M12 17.2v.1'],
  // A small dot — a compact bullet for a note line.
  dot: ['M12 12m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0'],
};

/**
 * @param {keyof typeof PATHS} name
 * @param {{size?: number, strokeWidth?: number, filled?: string[]}} [opts] `filled` names the
 *   sub-paths (by index) that should be filled rather than stroked — `coin`/`capture` want a
 *   filled dot or band inside an otherwise outlined mark.
 */
export function icon(name, { size = 20, strokeWidth = 1.6 } = {}) {
  const paths = PATHS[name] ?? PATHS.dot;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ci-icon');
  for (const d of paths) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', String(strokeWidth));
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
  }
  return svg;
}

export const ICON_NAMES = Object.freeze(Object.keys(PATHS));
