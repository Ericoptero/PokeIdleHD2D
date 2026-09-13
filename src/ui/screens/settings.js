/**
 * Settings (Stage 4) — the entry point Stage 3a's gear button already opens.
 *
 * Four categories, not the source design's five: "Account" is dropped outright rather than
 * shipped empty — there is no login or account system anywhere in this offline, single-save
 * game, so a category with zero real content would be a tab that always says nothing.
 *
 * **What is real in each category:**
 *  - *Game*: the species watch-list (`../watchlist.js`) — the one genuinely new feature this
 *    stage adds, wired for real to `bus.on('encounter:started', …)` in `../index.js` — and the
 *    debug overlay toggle, both real, existing state.
 *  - *Display*: five real `core/config.js` values (`uiScale`, `targetInternalWidth`, `grain`,
 *    `bloomStrength`, `vignette`), written through `config.set()` + `config.persist()` — the
 *    first caller of `persist()` anywhere in this codebase; every existing `config.set()` call
 *    (`environment`, `hunts`, showcases, …) is a session-only runtime tune, and a settings
 *    screen exists specifically so a player's choice survives a reload.
 *  - *Sound*: two sliders, `disabled`, with the plain-language reason — there is no audio
 *    module anywhere in `src/`. Shipping sliders that silently change nothing would be a worse
 *    lie than shipping none; this ships the layout and says why it doesn't work yet.
 *  - *Controls*: read-only, real key bindings pulled directly from `../input.js`'s own
 *    `MOVE_KEYS`/`PANEL_KEYS` maps — never a second, hand-copied list to drift from the first.
 *
 * The mockup's "Batalha automática" / "Vender repetidos sozinho" toggles are not here: both
 * describe automation *rules*, which already have a real, unlock-gated home in the Automation
 * screen — a second on/off switch in Settings would either fight that state or duplicate it,
 * and "auto-battle" specifically describes something that isn't optional in this game at all
 * (a fight resolves the moment the party reaches a slot; there is no manual-battle mode to
 * switch away from).
 */
import { h, setText, syncList } from '../dom/el.js';
import { icon } from '../dom/icons.js';
import { PANEL_KEYS } from '../input.js';
import * as watchlist from '../watchlist.js';

const isLive = (api) => !!api && api.__missing === undefined;

const CATEGORIES = [
  { id: 'game', icon: 'auto-mode', label: 'Game' },
  { id: 'display', icon: 'gear', label: 'Display' },
  { id: 'sound', icon: 'volume', label: 'Sound' },
  { id: 'controls', icon: 'keyboard', label: 'Controls' },
];

/** A labelled on/off row. Returns the element so the caller can flip its own visual state
 *  without a full rebuild. */
function toggleRow(label, sub, initial, onChange, dataUi) {
  const sw = h('div', { class: 'ci-toggle', 'data-on': String(initial) });
  const knob = h('div', { class: 'ci-toggle__knob' });
  sw.appendChild(knob);
  const row = h('div', {
    class: 'ci-settings-row',
    'data-ui': dataUi,
    onClick: () => {
      const now = sw.dataset.on !== 'true';
      sw.dataset.on = String(now);
      onChange(now);
    },
  }, [
    h('div', { class: 'ci-settings-row__text' }, [
      h('span', { class: 'ci-settings-row__label' }, label),
      sub ? h('span', { class: 'ci-settings-row__sub' }, sub) : null,
    ]),
    sw,
  ]);
  return row;
}

/** A labelled slider row bound to one `config` key — or, with `disabled: true`, bound to
 *  nothing at all (the Sound category, until there is an audio module to bind it to). */
function sliderRow(label, {
  value, min, max, step, format, onChange, disabled = false,
}) {
  const valueEl = h('span', { class: 'ci-settings-row__value' }, format(value));
  const input = h('input', {
    type: 'range', min: String(min), max: String(max), step: String(step), value: String(value),
    class: 'ci-slider', disabled,
    oninput: (ev) => {
      const v = Number(ev.target.value);
      setText(valueEl, format(v));
      onChange(v);
    },
  });
  return h('div', { class: 'ci-settings-row ci-settings-row--slider' }, [
    h('div', { class: 'ci-settings-row__text' }, [
      h('span', { class: 'ci-settings-row__label' }, label),
      valueEl,
    ]),
    input,
  ]);
}

export function makeSettingsDomScreen(app, domLayer) {
  let root = null;
  let category = 'game';

  function gameCategory() {
    const config = app.ctx.config;
    const pokemon = app.ctx.get('pokemon');

    const watchList = h('div', { class: 'ci-watch-list' });
    const nameInput = h('input', {
      type: 'text', class: 'ci-watch-input', placeholder: 'Species name…', 'data-ui': 'settings-watch-input',
    });
    const addBtn = h('button', {
      type: 'button', class: 'ci-btn', 'data-ui': 'settings-watch-add',
      onClick: () => {
        const name = nameInput.value.trim();
        if (!name) return;
        const species = isLive(pokemon) && typeof pokemon.species === 'function' ? pokemon.species(name) : null;
        if (!species) { app.toast(`"${name}" isn't a species this game knows`, 'warn'); return; }
        if (!watchlist.add(species.name)) { app.toast(`Already watching ${species.display ?? species.name}`, 'info'); return; }
        nameInput.value = '';
        app.toast(`Watching for ${species.display ?? species.name}`, 'good');
        renderWatchList();
      },
    }, [icon('check-circle', { size: 16 }), h('span', {}, 'Add')]);

    function renderWatchList() {
      const names = watchlist.list();
      if (!names.length) {
        watchList.replaceChildren(h('div', { class: 'ci-settings-empty' }, 'Nothing watched yet — add a species below.'));
        return;
      }
      syncList(
        watchList, names, (n) => n,
        (_n) => h('div', { class: 'ci-watch-chip' }, [
          h('span', {}, ''),
          h('button', { type: 'button', class: 'ci-watch-chip__x', title: 'Stop watching' }, icon('close', { size: 12 })),
        ]),
        (el, n) => {
          const species = isLive(pokemon) && typeof pokemon.species === 'function' ? pokemon.species(n) : null;
          setText(el.querySelector('span'), species?.display ?? n);
          el.querySelector('button').onclick = () => {
            watchlist.remove(n);
            renderWatchList();
          };
        },
      );
    }
    renderWatchList();

    return h('div', { class: 'ci-settings-section' }, [
      h('h3', { class: 'ci-settings-section__title' }, 'Alerts'),
      h('p', { class: 'ci-settings-section__hint' },
        'Get a toast the moment a species on this list appears — a rare you don\'t want to miss while doing something else.'),
      watchList,
      h('div', { class: 'ci-settings-row--add' }, [nameInput, addBtn]),
      h('h3', { class: 'ci-settings-section__title' }, 'Diagnostics'),
      toggleRow('Debug overlay', 'FPS, draw calls and module status, over the game', !!config.get('debug'),
        () => app.toggleDebug(), 'settings-toggle-debug'),
    ]);
  }

  function displayCategory() {
    const config = app.ctx.config;
    const set = (patch) => { config.set(patch); config.persist(); };
    return h('div', { class: 'ci-settings-section' }, [
      h('h3', { class: 'ci-settings-section__title' }, 'Interface'),
      toggleRow('Larger UI', 'Doubles the size of every panel and label', Number(config.get('uiScale')) >= 2,
        (on) => set({ uiScale: on ? 2 : 1 }), 'settings-toggle-uiscale'),
      h('h3', { class: 'ci-settings-section__title' }, 'Rendering'),
      sliderRow('Rendering detail', {
        value: Number(config.get('targetInternalWidth')) || 640, min: 480, max: 960, step: 80,
        format: (v) => `${v}px`, onChange: (v) => set({ targetInternalWidth: v }),
      }),
      sliderRow('Film grain', {
        value: Number(config.get('grain')) || 0, min: 0, max: 0.05, step: 0.005,
        format: (v) => `${Math.round((v / 0.05) * 100)}%`, onChange: (v) => set({ grain: v }),
      }),
      sliderRow('Glow', {
        value: Number(config.get('bloomStrength')) || 0, min: 0, max: 1, step: 0.05,
        format: (v) => `${Math.round(v * 100)}%`, onChange: (v) => set({ bloomStrength: v }),
      }),
      sliderRow('Vignette', {
        value: Number(config.get('vignette')) || 0, min: 0, max: 0.6, step: 0.05,
        format: (v) => `${Math.round((v / 0.6) * 100)}%`, onChange: (v) => set({ vignette: v }),
      }),
    ]);
  }

  function soundCategory() {
    return h('div', { class: 'ci-settings-section' }, [
      h('p', { class: 'ci-settings-section__hint ci-settings-section__hint--warn' },
        'Sound isn\'t in the game yet. These will wake up when it is.'),
      sliderRow('Music', {
        value: 70, min: 0, max: 100, step: 1, format: (v) => `${v}`, onChange: () => {}, disabled: true,
      }),
      sliderRow('Effects', {
        value: 85, min: 0, max: 100, step: 1, format: (v) => `${v}`, onChange: () => {}, disabled: true,
      }),
    ]);
  }

  function controlsCategory() {
    // Real bindings, read straight from `../input.js` — never a second, hand-typed list.
    // Deduplicated to the LOWEST code per direction/panel so "WASD or the arrows" reads once,
    // not eight times.
    const rows = [
      ['Walk', '↑ ↓ ← → or W A S D'],
      ['Interact / confirm', 'Z or Space'],
      ['Menu', 'X or Escape'],
      ['Chat', 'Enter'],
      ['Debug overlay', '`'],
    ];
    for (const [id, label] of [
      ['travel', 'Travel'], ['party', 'Party'], ['shop', 'Shop'], ['boxes', 'Boxes'],
      ['inventory', 'Bag'], ['dex', 'Dex'], ['trainer', 'Trainer'], ['automation', 'Automation'],
    ]) {
      const codes = [...PANEL_KEYS.entries()].filter(([, v]) => v === id).map(([k]) => k);
      if (codes.length) rows.push([label, codes.map(prettyCode).join(' or ')]);
    }
    return h('div', { class: 'ci-settings-section' }, [
      h('h3', { class: 'ci-settings-section__title' }, 'Keyboard'),
      h('div', { class: 'ci-controls-table' }, rows.map(([label, keys]) => h('div', { class: 'ci-controls-row' }, [
        h('span', { class: 'ci-controls-row__label' }, label),
        h('span', { class: 'ci-controls-row__keys' }, keys),
      ]))),
    ]);
  }

  function prettyCode(code) {
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Key')) return code.slice(3);
    return code;
  }

  const RENDER = { game: gameCategory, display: displayCategory, sound: soundCategory, controls: controlsCategory };

  function render() {
    const railBtns = CATEGORIES.map((c) => h('button', {
      type: 'button', class: `ci-settings-rail__item${c.id === category ? ' ci-settings-rail__item--active' : ''}`,
      'data-ui': `settings-cat-${c.id}`,
      onClick: () => { category = c.id; renderRoot(); },
    }, [icon(c.icon, { size: 18 }), h('span', {}, c.label)]));

    return h('div', { class: 'ci-offline-scrim', 'data-ui': 'settings-scrim' }, [
      h('div', { class: 'ci-settings-card' }, [
        h('div', { class: 'ci-settings-head' }, [
          h('h2', { class: 'ci-settings-head__title' }, 'Settings'),
          h('button', {
            type: 'button', class: 'ci-icon-btn', 'data-ui': 'settings-close', onClick: () => app.close(),
          }, icon('close', { size: 18 })),
        ]),
        h('div', { class: 'ci-settings-body' }, [
          h('nav', { class: 'ci-settings-rail' }, railBtns),
          h('div', { class: 'ci-settings-content', 'data-ui': 'settings-content' }, [RENDER[category]()]),
        ]),
      ]),
    ]);
  }

  function renderRoot() {
    if (!root) return;
    const next = render();
    root.replaceWith(next);
    root = next;
  }

  return {
    id: 'settings',
    open() {
      category = 'game';
      root = render();
      domLayer.host.appendChild(root);
    },
    close() {
      root?.remove();
      root = null;
    },
    key(ev) {
      if (ev.code === 'Escape') { app.close(); return true; }
      return false;
    },
    draw() { return null; },
  };
}
