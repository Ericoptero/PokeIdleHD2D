/**
 * The "while you were away" card — the Códice DOM layer's first screen, and the proof of the
 * whole architecture (`../dom/layer.js`'s header, and the plan this was built from).
 *
 * Replaces `../panels/offline.js` one-for-one under the **same panel contract**
 * (`{id, open, close, draw, key}`) `../index.js` already drives — `draw(g)` is a no-op here
 * (nothing is painted on the canvas; the card lives in `#ui-dom`), which is a deliberate,
 * minimal bridge: the driver's `open`/`close`/single-`state.panel` model does not change in
 * this slice, because only one screen has converted so far. The richer `{mount, update,
 * unmount}` contract the fuller migration calls for is worth adopting once more than one
 * screen needs the coordination it buys.
 *
 * `offline.summary()` is the *whole* payload this draws, exactly as `panels/offline.js` did —
 * see that file's own header for why nothing here is rounded away. It is also, on purpose,
 * the ceiling of what this screen can show: the source design's loot grid, per-species XP
 * table, encounter table and capture grid all show data `offline` does not track at that
 * grain (an aggregate `applied`/`pending` per currency, not a line-item ledger). Building
 * those tables would mean inventing numbers nothing in `src/offline/` computes, which is the
 * exact failure mode this file's predecessor was written to avoid — so this screen is honest
 * to the design's *language* (a soft card, collapsible amber sections, an efficiency bar) and
 * to the game's *actual* data, not to every artboard pixel.
 */
import { h } from '../dom/el.js';
import { icon } from '../dom/icons.js';
import { fmt, duration } from '../format.js';

const CURRENCY_LABEL = { money: '₽', tokens: '◈', research: '◈', shards: '◆', bp: 'BP' };
const CURRENCY_NAME = {
  money: 'Poké Dollars', tokens: 'Research', research: 'Research', shards: 'Shards', bp: 'Battle Points',
};
const CURRENCY_ICON = { money: 'coin', tokens: 'trending-up', research: 'trending-up' };

/** The same five-step ramp `panels/offline.js` used for the efficiency bands, as CSS colours
 *  instead of `theme.js` hex — chosen for the identical reason: a flat 0.9+ vs 0.45- split
 *  reads clearly even before the percentage label does. */
function bandColour(t) {
  if (t > 0.9) return { bg: 'var(--c-amber-light)', ink: 'var(--c-amber-ink)' };
  if (t > 0.75) return { bg: 'var(--c-amber-lighter)', ink: 'var(--c-amber-ink)' };
  if (t > 0.6) return { bg: 'var(--c-amber)', ink: 'var(--c-amber-ink)' };
  if (t > 0.45) return { bg: '#C2851F', ink: 'var(--c-amber-ink)' };
  return { bg: 'var(--c-amber-deep)', ink: 'var(--c-ink-strong)' };
}

function currencyLine(id, value, held) {
  const label = CURRENCY_LABEL[id];
  const text = label === '₽' ? `₽${fmt(value)}` : label ? `${fmt(value)} ${label}` : `×${fmt(value)}`;
  return h('div', { class: `ci-line${held ? ' ci-line--held' : ''}` }, [
    icon(CURRENCY_ICON[id] ?? 'dot', { size: 18, class: 'ci-line__icon' }),
    h('span', { class: 'ci-line__label' }, held ? `${CURRENCY_NAME[id] ?? id} (held)` : CURRENCY_NAME[id] ?? id),
    h('span', { class: 'ci-line__value' }, text),
  ]);
}

/** One collapsible section: a clickable head row, and a body toggled by a `data-open`
 *  attribute (plain CSS, `screens.css`'s `.ci-section[data-open='false']`) — no re-render
 *  needed to open or close one, so this needs no `update()` at all. */
function section({ icon: iconName, label, value, open = true, body }) {
  const root = h('div', { class: 'ci-section', 'data-open': String(open), 'data-ui': `offline-section-${label}` });
  const chevron = icon(open ? 'chevron-up' : 'chevron-down', { size: 18, class: 'ci-section__head-chevron' });
  const head = h('button', {
    type: 'button',
    class: 'ci-section__head',
    onClick: () => {
      const now = root.getAttribute('data-open') !== 'true';
      root.setAttribute('data-open', String(now));
      chevron.replaceWith(icon(now ? 'chevron-up' : 'chevron-down', { size: 18, class: 'ci-section__head-chevron' }));
    },
  }, [
    icon(iconName, { size: 22, class: 'ci-section__head-icon' }),
    h('span', { class: 'ci-section__head-label' }, label),
    h('span', { class: 'ci-section__head-value' }, value),
    chevron,
  ]);
  root.append(head, h('div', { class: 'ci-section__body' }, body));
  return root;
}

export function makeOfflineDomScreen(app, domLayer) {
  let summary = null;
  let root = null;

  function render() {
    const s = summary;
    const gains = Object.entries(s.applied ?? {}).filter(([, v]) => v > 0);
    const pending = Object.entries(s.pending ?? {}).filter(([, v]) => v > 0);
    const bands = s.bands ?? [];
    const totalS = bands.reduce((a, b) => a + b.seconds, 0) || 1;

    const rows = [
      h('div', { class: 'ci-offline-row' }, [
        h('span', { class: 'ci-offline-row__label' }, 'Away'),
        h('span', { class: 'ci-offline-row__value' }, s.awayText ?? duration(s.awayS)),
      ]),
    ];
    if (s.capped) {
      rows.push(h('div', { class: 'ci-offline-row ci-offline-row--capped' }, [
        h('span', { class: 'ci-offline-row__label' }, 'Credited (capped)'),
        h('span', { class: 'ci-offline-row__value' },
          `${s.creditedText ?? duration(s.creditedS)} of ${s.capText ?? duration(s.capS)}`),
      ]));
    }
    rows.push(h('div', { class: 'ci-offline-row' }, [
      h('span', { class: 'ci-offline-row__label' }, 'Worth'),
      h('span', { class: 'ci-offline-row__value' }, `${s.effectiveText ?? duration(s.effectiveS)} of play`),
    ]));

    const bandBar = h('div', { class: 'ci-offline-bands' }, bands.map((b) => {
      const t = Math.max(0, Math.min(1, b.avgEfficiency));
      const pct = Math.round((b.seconds / totalS) * 100);
      const colour = bandColour(t);
      return h('div', {
        class: 'ci-offline-band',
        style: { flex: `0 0 ${pct}%`, background: colour.bg, color: colour.ink },
      }, pct >= 8 ? `${Math.round(t * 100)}%` : '');
    }));

    const sections = [];
    sections.push(section({
      icon: 'coin',
      label: 'What you earned',
      value: gains.length ? `${gains.length} currenc${gains.length === 1 ? 'y' : 'ies'}` : 'nothing',
      body: gains.length
        ? gains.map(([id, v]) => currencyLine(id, v, false))
        : [h('div', { class: 'ci-note' }, 'Nothing banked this session.')],
    }));
    if (pending.length) {
      sections.push(section({
        icon: 'trending-up',
        label: 'Held back',
        value: `${pending.length}`,
        open: false,
        body: pending.map(([id, v]) => currencyLine(id, v, true)),
      }));
    }

    const notes = (s.notes ?? []).filter(Boolean).slice(0, 4);

    root.replaceChildren(h('div', { class: 'ci-offline-scrim', 'data-ui': 'offline-scrim' }, [
      h('div', { class: 'ci-offline-card' }, [
        h('div', { class: 'ci-offline-head' }, [
          h('div', { class: 'ci-offline-head__icon' }, icon('bedtime', { size: 25 })),
          h('div', { class: 'ci-offline-head__text' }, [
            h('h2', { class: 'ci-offline-head__title' }, 'While you were away'),
            h('span', { class: 'ci-offline-head__subtitle' },
              `Your team explored for ${s.awayText ?? duration(s.awayS)} without you.`),
          ]),
          h('div', { class: 'ci-offline-pill' }, [
            icon('check-circle', { size: 17 }),
            h('span', {}, 'Already collected'),
          ]),
        ]),
        h('div', { class: 'ci-offline-body' }, [
          ...rows,
          bands.length ? bandBar : null,
          bands.length ? h('div', { class: 'ci-offline-bands-caption' }, [
            h('span', {}, 'full rate'),
            h('span', {}, `average ${Math.round((s.efficiency ?? 0) * 100)}%`),
          ]) : null,
          ...sections,
          notes.length ? h('div', { class: 'ci-notes' }, notes.map((note) => h('div', { class: 'ci-note' }, [
            icon('dot', { size: 10 }),
            h('span', {}, note),
          ]))) : null,
        ]),
        h('div', { class: 'ci-offline-footer' }, [
          h('button', {
            type: 'button', class: 'ci-btn', 'data-ui': 'offline-continue', onClick: () => app.close(),
          }, [icon('close', { size: 18 }), h('span', {}, 'Continue')]),
        ]),
      ]),
    ]));
  }

  return {
    id: 'offline',
    /** @param {{summary:object}} opts */
    open(opts = {}) {
      summary = opts.summary ?? null;
      if (!summary) return;
      root = h('div', {});
      domLayer.host.appendChild(root);
      render();
    },
    close() {
      summary = null;
      root?.remove();
      root = null;
    },
    payload: () => summary,

    key(ev) {
      if (ev.code === 'Enter' || ev.code === 'KeyZ' || ev.code === 'Space') { app.close(); return true; }
      return false;
    },

    /** Nothing is painted on the canvas — the card lives in `#ui-dom`. If `open()` was ever
     *  called with no summary (defensive, matching the old panel's own guard), close so the
     *  driver's `state.panel` slot does not sit on a screen with nothing to show. */
    draw() {
      if (!summary) app.close();
      return null;
    },
  };
}

// Exported for the same reason `panels/inventory.js` exports `filterRows` — a future test can
// exercise the rendering shape with a synthetic summary and no live `offline` module.
export { CURRENCY_LABEL, CURRENCY_NAME };
