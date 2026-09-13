/**
 * Automation (Stage 6) — replaces `panels/automation.js` under the same DOM screen contract
 * (`{id, open, close, key, draw}`).
 *
 * **Scope is exactly what the canvas panel already did, no more.** `automation` has published
 * `schema()`/`fields()`/`operators()`/`addRule()`/`removeRule()` since it was written, for a
 * full condition-tree rule editor — and nothing has ever rendered that, in canvas or here. This
 * screen keeps the same three things the canvas panel offered: unlocking and switching an
 * automation on or off, reordering and toggling its existing rules, and editing the settings
 * types it already knew how to (`bool`/`enum`/`number`/`ladder`/`order`). A `text`/`ladders`
 * setting (the "advanced per-species ladder", never editable in the canvas panel either) shows
 * as a plain, honest "not editable here" line instead of `String(value)` on an object.
 *
 * **Drag replaces the old ^/v buttons.** The reason the canvas panel gave for buttons over drag
 * — "the HUD is one 2-D canvas with a hit-region list rebuilt every paint; there is no
 * pointer-capture layer" — is exactly the constraint a DOM screen does not have
 * (`../dom/dnd.js`'s own header). Reordering rules, a healing ladder, or an item-priority list
 * are all the same primitive: an array of ids, moved by drag, rewritten in one `configure()`/
 * `moveRule()` call. A row's own interactive control (its on/off switch, its `-`/`+` stepper)
 * stops the drag from starting on it with `ev.stopPropagation()` on `pointerdown` — the row
 * itself is still the drag handle everywhere else, matching `dom/hud.js`'s party list.
 */
import { h } from '../dom/el.js';
import { icon } from '../dom/icons.js';
import { makeDragReorder } from '../dom/dnd.js';
import { titleCase } from '../format.js';

const isLive = (api) => !!api && api.__missing === undefined;
/** A control inside a draggable row: stop the row's own drag from starting on it. */
const noDrag = { onPointerdown: (ev) => ev.stopPropagation() };

export function makeAutomationDomScreen(app, domLayer) {
  let root = null;
  let selectedId = null;
  let view = 'rules';

  const auto = () => app.ctx.get('automation');
  const eco = () => app.ctx.get('economy');
  const itemName = (id) => {
    const e = eco();
    return (isLive(e) ? e.item?.(id)?.name : null) ?? titleCase(id);
  };

  const list = () => {
    const a = auto();
    return isLive(a) && typeof a.list === 'function' ? (a.list() ?? []) : [];
  };

  function ensureSelection() {
    const all = list();
    if (!all.length) { selectedId = null; return; }
    if (!all.some((d) => d.id === selectedId)) selectedId = all[0].id;
  }

  function setSetting(id, key, value) {
    const a = auto();
    if (!isLive(a) || typeof a.configure !== 'function') return;
    a.configure(id, { [key]: value });
    renderRoot();
  }

  function reorderArray(arr, from, to) {
    const next = arr.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  }

  /** A reorderable list of full-width rows sharing one drag-reorder instance — the shape
   *  the rule list, the healing ladder and every `order` setting all need. */
  function dragList(rowEls, onReorder, onClick) {
    const dnd = makeDragReorder({ elements: () => rowEls, onReorder, onClick });
    rowEls.forEach((el, i) => dnd.bind(el, i));
    return dnd;
  }

  function ruleRow(def, rule, index, total) {
    const off = rule.enabled === false;
    const sw = h('div', { class: 'ci-toggle', 'data-on': String(!off), ...noDrag });
    sw.appendChild(h('div', { class: 'ci-toggle__knob' }));
    return h('div', { class: 'ci-shelf-row ci-automation-rule', 'data-ui': `auto-rule-${rule.id}` }, [
      h('span', { class: 'ci-automation-rule__rank' }, String(index + 1)),
      h('div', { class: 'ci-shelf-row__body' }, [
        h('span', { class: 'ci-shelf-row__name' }, rule.name ?? rule.id),
        h('span', { class: 'ci-shelf-row__sub' }, auto().describeRule?.(def.id, rule) ?? ''),
      ]),
      h('button', {
        type: 'button', class: 'ci-toggle-wrap', 'data-ui': `auto-rule-toggle-${rule.id}`, ...noDrag,
        onClick: () => { auto().updateRule(def.id, rule.id, { enabled: off }); renderRoot(); },
        title: total > 1 ? 'Drag the row to reorder' : undefined,
      }, sw),
    ]);
  }

  function rulesPane(def) {
    const rules = def.rules ?? [];
    if (!rules.length) {
      return h('div', { class: 'ci-shelf-empty' }, 'This one has no rules — it is configured in Settings.');
    }
    const rows = rules.map((r, i) => ruleRow(def, r, i, rules.length));
    dragList(rows, (from, to) => {
      auto().moveRule(def.id, rules[from].id, to);
      renderRoot();
    });
    return h('div', { class: 'ci-automation-list', 'data-ui': 'auto-rules' }, rows);
  }

  function boolRow(spec, value) {
    const sw = h('div', { class: 'ci-toggle', 'data-on': String(!!value) });
    sw.appendChild(h('div', { class: 'ci-toggle__knob' }));
    return h('div', {
      class: 'ci-settings-row', 'data-ui': `auto-set-${spec.key}`,
      onClick: () => setSetting(currentDef().id, spec.key, !value),
    }, [
      h('div', { class: 'ci-settings-row__text' }, [
        h('span', { class: 'ci-settings-row__label' }, spec.label),
        spec.blurb ? h('span', { class: 'ci-settings-row__sub' }, spec.blurb) : null,
      ].filter(Boolean)),
      sw,
    ]);
  }

  function enumRow(spec, value) {
    const vals = spec.values ?? [];
    const at = Math.max(0, vals.indexOf(String(value)));
    return h('div', { class: 'ci-settings-row', style: { cursor: 'default' } }, [
      h('div', { class: 'ci-settings-row__text' }, [
        h('span', { class: 'ci-settings-row__label' }, spec.label),
        spec.blurb ? h('span', { class: 'ci-settings-row__sub' }, spec.blurb) : null,
      ].filter(Boolean)),
      h('button', {
        type: 'button', class: 'ci-shelf-btn ci-automation-cycle', 'data-ui': `auto-set-${spec.key}`,
        onClick: () => setSetting(currentDef().id, spec.key, vals[(at + 1) % vals.length]),
      }, [h('span', {}, titleCase(String(value ?? vals[0] ?? '')))]),
    ]);
  }

  function numberRow(spec, value) {
    const step = spec.step ?? 1;
    const fmtV = (v) => `${v}${spec.unit ? ` ${spec.unit}` : ''}`;
    return h('div', { class: 'ci-settings-row', 'data-ui': `auto-set-${spec.key}` }, [
      h('div', { class: 'ci-settings-row__text' }, [
        h('span', { class: 'ci-settings-row__label' }, spec.label),
        spec.blurb ? h('span', { class: 'ci-settings-row__sub' }, spec.blurb) : null,
      ].filter(Boolean)),
      h('div', { class: 'ci-automation-stepper' }, [
        h('button', {
          type: 'button', class: 'ci-icon-btn ci-automation-stepper__btn', 'data-ui': `auto-set-${spec.key}-lo`,
          onClick: () => setSetting(currentDef().id, spec.key, Math.max(spec.min ?? -Infinity, Number(value) - step)),
        }, '−'),
        h('span', { class: 'ci-automation-stepper__value' }, fmtV(value)),
        h('button', {
          type: 'button', class: 'ci-icon-btn ci-automation-stepper__btn', 'data-ui': `auto-set-${spec.key}-hi`,
          onClick: () => setSetting(currentDef().id, spec.key, Math.min(spec.max ?? Infinity, Number(value) + step)),
        }, '+'),
      ]),
    ]);
  }

  function orderRow(spec, value) {
    const ids = Array.isArray(value) ? value : [];
    if (!ids.length) {
      return h('div', { class: 'ci-settings-section' }, [
        h('h3', { class: 'ci-settings-section__title' }, spec.label),
        h('div', { class: 'ci-shelf-empty' }, 'Nothing on this list yet.'),
      ]);
    }
    const rows = ids.map((id, i) => h('div', { class: 'ci-shelf-row ci-automation-chip-row' }, [
      h('span', { class: 'ci-automation-rule__rank' }, String(i + 1)),
      h('span', { class: 'ci-shelf-row__name' }, itemName(id)),
    ]));
    dragList(rows, (from, to) => setSetting(currentDef().id, spec.key, reorderArray(ids, from, to)));
    return h('div', { class: 'ci-settings-section' }, [
      h('h3', { class: 'ci-settings-section__title' }, spec.label),
      spec.blurb ? h('p', { class: 'ci-settings-section__hint' }, spec.blurb) : null,
      h('div', { class: 'ci-automation-list', 'data-ui': `auto-order-${spec.key}` }, rows),
    ].filter(Boolean));
  }

  function ladderRow(spec, value) {
    const ladder = Array.isArray(value) ? value : [];
    if (!ladder.length) {
      return h('div', { class: 'ci-settings-section' }, [
        h('h3', { class: 'ci-settings-section__title' }, spec.label),
        h('div', { class: 'ci-shelf-empty' }, 'Nothing on this ladder yet.'),
      ]);
    }
    const bump = (i, patch) => {
      const next = ladder.map((r) => ({ ...r }));
      Object.assign(next[i], patch);
      setSetting(currentDef().id, spec.key, next);
    };
    const rows = ladder.map((rung, i) => {
      const off = rung.enabled === false;
      const sw = h('div', { class: 'ci-toggle', 'data-on': String(!off), ...noDrag });
      sw.appendChild(h('div', { class: 'ci-toggle__knob' }));
      return h('div', { class: 'ci-shelf-row ci-automation-ladder-row' }, [
        h('span', { class: 'ci-automation-rule__rank' }, String(i + 1)),
        h('span', { class: 'ci-shelf-row__name', style: { flex: '1' } }, itemName(rung.item)),
        h('div', { class: 'ci-automation-stepper', ...noDrag }, [
          h('button', {
            type: 'button', class: 'ci-icon-btn ci-automation-stepper__btn',
            onClick: () => bump(i, { atPercent: Math.max(0, (rung.atPercent ?? 0) - 5) }),
          }, '−'),
          h('span', { class: 'ci-automation-stepper__value' }, `${rung.atPercent ?? 0}%`),
          h('button', {
            type: 'button', class: 'ci-icon-btn ci-automation-stepper__btn',
            onClick: () => bump(i, { atPercent: Math.min(100, (rung.atPercent ?? 0) + 5) }),
          }, '+'),
        ]),
        h('button', {
          type: 'button', class: 'ci-toggle-wrap', ...noDrag, onClick: () => bump(i, { enabled: off }),
        }, sw),
      ]);
    });
    dragList(rows, (from, to) => setSetting(currentDef().id, spec.key, reorderArray(ladder, from, to)));
    return h('div', { class: 'ci-settings-section' }, [
      h('h3', { class: 'ci-settings-section__title' }, spec.label),
      spec.blurb ? h('p', { class: 'ci-settings-section__hint' }, spec.blurb) : null,
      h('div', { class: 'ci-automation-list', 'data-ui': `auto-ladder-${spec.key}` }, rows),
    ].filter(Boolean));
  }

  function settingsPane(def) {
    const specs = def.settings ?? [];
    if (!specs.length) return h('div', { class: 'ci-shelf-empty' }, 'Nothing to configure — this one is all rules.');
    const out = [];
    for (const spec of specs) {
      if (spec.type === 'ladder') out.push(ladderRow(spec, spec.value));
      else if (spec.type === 'order') out.push(orderRow(spec, spec.value));
      else if (spec.type === 'bool') out.push(boolRow(spec, spec.value));
      else if (spec.type === 'enum') out.push(enumRow(spec, spec.value));
      else if (spec.type === 'number') out.push(numberRow(spec, spec.value));
      else {
        // `text`/`ladders` — never editable in the canvas panel either (`INLINE` there did
        // not name them); a plain line saying so beats `String({})`.
        out.push(h('div', { class: 'ci-settings-row', style: { cursor: 'default' } }, [
          h('div', { class: 'ci-settings-row__text' }, [
            h('span', { class: 'ci-settings-row__label' }, spec.label),
            h('span', { class: 'ci-settings-row__sub' }, 'Not editable here.'),
          ]),
        ]));
      }
    }
    return h('div', { class: 'ci-settings-section' }, out);
  }

  function currentDef() {
    return list().find((d) => d.id === selectedId) ?? null;
  }

  function render() {
    ensureSelection();
    const all = list();
    const def = currentDef();
    const e = eco();

    const railBtns = all.map((d) => h('button', {
      type: 'button',
      class: `ci-shelf-rail__item${d.id === selectedId ? ' ci-shelf-rail__item--active' : ''}${!d.unlocked ? ' ci-shelf-rail__item--locked' : ''}`,
      'data-ui': `auto-item-${d.id}`,
      onClick: () => { selectedId = d.id; view = 'rules'; renderRoot(); },
    }, [
      h('span', { class: 'ci-shelf-rail__item-label' }, d.name),
      h('span', { class: 'ci-shelf-rail__item-sub' }, !d.unlocked ? 'Locked' : d.enabled ? 'On' : 'Off'),
    ]));

    let content;
    if (!def) {
      content = h('div', { class: 'ci-shelf-empty' }, 'Automation is unavailable.');
    } else {
      const research = isLive(e) ? e.balance('research') : 0;
      const headRight = !def.unlocked
        ? h('button', {
          type: 'button', class: 'ci-shelf-btn ci-shelf-btn--primary', 'data-ui': 'auto-unlock',
          disabled: def.unlock?.met === false || research < (def.unlock?.cost ?? 0),
          onClick: () => { auto().unlock(def.id); renderRoot(); },
        }, [h('span', {}, def.unlock?.met === false ? 'Locked' : `Unlock — ${def.unlock?.cost ?? 0} ◈`)])
        : h('button', {
          type: 'button', class: `ci-shelf-btn${def.enabled ? ' ci-shelf-btn--primary' : ''}`, 'data-ui': 'auto-toggle',
          onClick: () => { auto().toggle(def.id); renderRoot(); },
        }, [h('span', {}, def.enabled ? 'Switch off' : 'Switch on')]);

      content = h('div', { class: 'ci-automation-content' }, [
        h('div', { class: 'ci-automation-header' }, [
          h('div', { class: 'ci-automation-header__text' }, [
            h('h3', { class: 'ci-shelf-detail__name' }, def.name),
            h('p', { class: 'ci-shelf-detail__desc' }, def.detail ?? def.blurb ?? ''),
            h('span', { class: 'ci-shelf-row__sub' },
              !def.unlocked ? (def.unlock?.text || '') : def.everyS > 0 ? `Runs every ${def.everyS}s` : 'Runs inside a fight, not on a clock'),
          ]),
          headRight,
        ]),
        h('div', { class: 'ci-shelf-tabs' }, [
          h('button', {
            type: 'button', class: `ci-shelf-tab${view === 'rules' ? ' ci-shelf-tab--active' : ''}`, 'data-ui': 'auto-view-rules',
            onClick: () => { view = 'rules'; renderRoot(); },
          }, 'Rules'),
          h('button', {
            type: 'button', class: `ci-shelf-tab${view === 'settings' ? ' ci-shelf-tab--active' : ''}`, 'data-ui': 'auto-view-settings',
            onClick: () => { view = 'settings'; renderRoot(); },
          }, 'Settings'),
        ]),
        h('div', { class: 'ci-automation-body', 'data-ui': 'auto-body' }, [view === 'rules' ? rulesPane(def) : settingsPane(def)]),
      ]);
    }

    return h('div', { class: 'ci-offline-scrim', 'data-ui': 'auto-scrim' }, [
      h('div', { class: 'ci-shelf-card' }, [
        h('div', { class: 'ci-shelf-head' }, [
          h('h2', { class: 'ci-shelf-head__title' }, 'Automation'),
          h('span', { class: 'ci-shelf-detail__row-label' }, 'Every list is checked top to bottom — first match wins.'),
          h('button', {
            type: 'button', class: 'ci-icon-btn', 'data-ui': 'auto-close', onClick: () => app.close(),
          }, icon('close', { size: 18 })),
        ]),
        h('div', { class: 'ci-shelf-body' }, [
          h('nav', { class: 'ci-shelf-rail' }, railBtns),
          content,
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

  let offChange = null;

  return {
    id: 'automation',
    has: () => isLive(app.ctx.get('automation')),
    open() {
      selectedId = null; view = 'rules';
      root = render();
      domLayer.host.appendChild(root);
      // Unlock cost and `unlock.met` are read fresh on every render, but nothing re-renders
      // this screen on its own the way a canvas panel repaints every frame — `economy.
      // onChange` (the same live-update seam `screens/bag.js`/`screens/shop.js` subscribe to)
      // is what makes the Unlock button turn affordable the moment research trickles in from
      // idle ticks while the screen is sitting open, rather than only on the next click here.
      const e = eco();
      if (isLive(e) && typeof e.onChange === 'function') offChange = e.onChange(() => renderRoot());
    },
    close() {
      offChange?.();
      offChange = null;
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
