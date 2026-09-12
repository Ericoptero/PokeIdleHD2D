/**
 * The automation panel — the one this project specified in full and never built.
 *
 * `automation` has published `schema()`, `fields()`, `operators()`, `addRule`, `updateRule`,
 * `removeRule`, **`moveRule`**, `settings()` and `configure()` since it was written, and the
 * §5.11 block calls that "the schema `ui` renders from". Nothing rendered it. `moveRule` had
 * zero callers anywhere in `src/`, and after DECISIONS #76 four automations that decide what
 * happens inside a fight were configurable only from a console. Four automations nobody can see
 * are not shipped (DECISIONS #77).
 *
 * ## Reordering is ↑ / ↓ buttons, not drag
 *
 * The HUD is one 2-D canvas with a hit-region list rebuilt every paint (`screen.js`); there is
 * no pointer-capture layer, no drag state and nothing that survives a repaint mid-gesture.
 * Building one for a list that is at most eight rows long would be a subsystem in service of a
 * flourish. Two buttons per row are keyboard-reachable, work on touch, and say what they do —
 * and `engine.moveRule` is exactly the primitive they need.
 *
 * ## Order matters, and the panel has to say so
 *
 * Every list here is **first match wins**: the healing ladder, the rules, the ball tiers. A
 * player who cannot see that will write a list whose first row eats every case. So the rank is
 * drawn in the margin of every row, and the footer says it in words.
 */

import { C, panel, header, well, meter } from '../theme.js';
import { windowFrame, section, list, tabs, action, fit } from './common.js';

const isLive = (api) => !!api && api.__missing === undefined;
const titleCase = (s) => String(s ?? '').replace(/(^|[\s-])\w/g, (m) => m.toUpperCase());

/** Which settings a row editor knows how to change in place. */
const INLINE = new Set(['bool', 'enum', 'number', 'ladder', 'order']);

export function makeAutomation(app) {
  let selected = 0;
  let top = 0;
  let ruleTop = 0;
  /** Which pane the right-hand column is showing: what it does, or how it is configured. */
  let view = 'rules';

  const auto = () => app.ctx.get('automation');
  const eco = () => app.ctx.get('economy');

  /**
   * An item's shop name, not its id.
   *
   * `economy` owns the catalogue and is the only thing that knows a `maxpotion` is called a
   * "Max Potion"; title-casing the id gives "Maxpotion", which is a placeholder wearing a
   * label's clothes. A quarantined `economy` falls back to the id rather than drawing nothing.
   */
  const itemName = (id) => {
    const e = eco();
    return (isLive(e) ? e.item?.(id)?.name : null) ?? titleCase(id);
  };

  const listOf = () => {
    const a = auto();
    return isLive(a) && typeof a.list === 'function' ? (a.list() ?? []) : [];
  };
  const current = () => listOf()[selected] ?? null;

  /** Nudges a rule one place and keeps the selection pointing at the same rule. */
  function move(id, ruleId, delta) {
    const a = auto();
    if (!isLive(a) || typeof a.moveRule !== 'function') return;
    const rules = a.get(id)?.rules ?? [];
    const at = rules.findIndex((r) => r.id === ruleId);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= rules.length) return;
    a.moveRule(id, ruleId, to);
    app.markDirty();
  }

  /** Toggles a rule without deleting it, so its threshold survives being switched off. */
  function toggleRule(id, rule) {
    const a = auto();
    if (!isLive(a) || typeof a.updateRule !== 'function') return;
    a.updateRule(id, rule.id, { enabled: rule.enabled === false });
    app.markDirty();
  }

  function setSetting(id, key, value) {
    const a = auto();
    if (!isLive(a) || typeof a.configure !== 'function') return;
    a.configure(id, { [key]: value });
    app.markDirty();
  }

  /** One rung of the healing ladder, edited in place. */
  function bumpRung(id, key, i, patch) {
    const a = auto();
    const ladder = (a.settings(id)?.[key] ?? []).map((r) => ({ ...r }));
    if (!ladder[i]) return;
    Object.assign(ladder[i], patch);
    setSetting(id, key, ladder);
  }

  function moveRung(id, key, i, delta) {
    const a = auto();
    const ladder = (a.settings(id)?.[key] ?? []).map((r) => ({ ...r }));
    const to = i + delta;
    if (to < 0 || to >= ladder.length) return;
    [ladder[i], ladder[to]] = [ladder[to], ladder[i]];
    setSetting(id, key, ladder);
  }

  return {
    id: 'automation',
    /** A sizing hint only (a bigger default `windowFrame` size), not a HUD-visibility flag —
     *  see DECISIONS #85. */
    full: true,
    has: () => isLive(app.ctx.get('automation')),
    open() { top = 0; ruleTop = 0; },
    close() {},

    key(ev) {
      const n = listOf().length;
      if (ev.code === 'ArrowUp' || ev.code === 'KeyW') {
        selected = Math.max(0, selected - 1); ruleTop = 0; app.markDirty(); return true;
      }
      if (ev.code === 'ArrowDown' || ev.code === 'KeyS') {
        selected = Math.min(n - 1, selected + 1); ruleTop = 0; app.markDirty(); return true;
      }
      if (ev.code === 'ArrowLeft' || ev.code === 'ArrowRight') {
        view = view === 'rules' ? 'settings' : 'rules'; app.markDirty(); return true;
      }
      if (ev.code === 'Enter' || ev.code === 'KeyZ') {
        const d = current();
        const a = auto();
        if (d && isLive(a)) {
          if (!d.unlocked) a.unlock(d.id); else a.toggle(d.id);
          app.markDirty();
        }
        return true;
      }
      return false;
    },

    draw(g) {
      const a = auto();
      const all = listOf();
      selected = Math.max(0, Math.min(all.length - 1, selected));
      const def = all[selected] ?? null;

      const win = windowFrame(g, {
        windowId: 'automation',
        title: 'AUTOMATION', bar: C.martBase, edge: C.martDeep, light: C.martLight,
        footer: '↑↓ pick    ←→ rules / settings    Z unlock or toggle    X close',
        footerRight: 'every list is FIRST MATCH WINS',
        onClose: () => app.close(), ...fit(g, 600, 300),
      });

      // --- the roster -------------------------------------------------------
      const colW = Math.max(112, Math.min(150, Math.round(win.w * 0.26)));
      const left = section(g, { x: win.x, y: win.y, w: colW, h: win.h }, 'AUTOMATIONS',
        { bar: C.martShadow, light: C.martBase });

      const rows = all.map((d) => ({ ...d, disabled: false }));
      const r = list(g, { x: left.x + 2, y: left.y + 2, w: left.w - 4, h: left.h - 4 }, {
        items: rows, rowH: 16, top, selected, tag: 'auto',
        onPick: (i) => { selected = i; ruleTop = 0; app.markDirty(); },
        draw: (gg, item, rect, st) => {
          gg.text(rect.x + 4, rect.y + 2, item.name, st.ink);
          // Three states, and they are not the same thing: locked (costs research), unlocked
          // but off (the player's choice), and running.
          const state = !item.unlocked ? 'LOCKED' : item.enabled ? 'ON' : 'off';
          const ink = !item.unlocked ? C.stoneShadow : item.enabled ? C.roofShadow : C.stoneShadow;
          gg.textRight(rect.x + rect.w - 4, rect.y + 2, state, ink);
          // The blurb follows the ROW's ink, not a fixed grey: on the selected row a fixed
          // grey is drawn over the highlight and is the one line in the panel you cannot read.
          gg.text(rect.x + 4, rect.y + 9, item.blurb ?? '',
            st.selected ? st.ink : C.stoneShadow, { max: rect.w - 8 });
        },
      });
      top = r.top;

      if (!def) return;

      // --- what it is -------------------------------------------------------
      const rightX = win.x + colW + 4;
      const rightW = win.w - colW - 4;
      const headH = 44;
      const head = section(g, { x: rightX, y: win.y, w: rightW, h: headH }, def.name.toUpperCase(),
        { bar: C.stoneShadow, light: C.stoneBase });
      g.text(head.x + 4, head.y + 3, def.detail ?? def.blurb ?? '', C.shadowInk, { max: head.w - 8 });

      const money = isLive(eco()) ? eco().balance('research') : 0;
      if (!def.unlocked) {
        const cost = def.unlock?.cost ?? 0;
        const met = def.unlock?.met !== false;
        const why = def.unlock?.text;
        g.text(head.x + 4, head.y + 20, met ? `Costs ${cost} ◈  (you have ${Math.floor(money)})`
          : `Needs ${why}`, met ? C.ink : C.roofShadow);
        action(g, { x: head.x + head.w - 74, y: head.y + 17, w: 70, h: 12 },
          met && money >= cost ? 'UNLOCK' : 'LOCKED',
          { disabled: !met || money < cost, tag: 'auto-unlock', onPick: () => { a.unlock(def.id); app.markDirty(); } });
      } else {
        action(g, { x: head.x + head.w - 74, y: head.y + 17, w: 70, h: 12 },
          def.enabled ? 'SWITCH OFF' : 'SWITCH ON',
          { active: def.enabled, tag: 'auto-toggle', onPick: () => { a.toggle(def.id); app.markDirty(); } });
        // The cadence, in the words the brief uses. `0` is not "never" — it is "when the
        // fight asks", and a blank here would read as broken (DECISIONS #76).
        g.text(head.x + 4, head.y + 20,
          def.everyS > 0 ? `Runs every ${def.everyS}s` : 'Runs inside a fight, not on a clock',
          C.shadowInk);
      }

      // --- rules / settings -------------------------------------------------
      const bodyY = win.y + headH + 3;
      const bodyH = win.h - headH - 3;
      tabs(g, rightX, bodyY, [
        { id: 'rules', label: 'RULES' },
        { id: 'settings', label: 'SETTINGS' },
      ], { active: view, onPick: (id) => { view = id; app.markDirty(); }, tag: 'auto-view' });

      const body = section(g, { x: rightX, y: bodyY + 15, w: rightW, h: bodyH - 15 },
        view === 'rules' ? 'CHECKED TOP TO BOTTOM' : 'SETTINGS',
        { bar: C.stoneShadow, light: C.stoneBase });

      if (view === 'rules') this.drawRules(g, a, def, body);
      else this.drawSettings(g, a, def, body);
    },

    /** The ruleset, in order, with the two buttons that change it. */
    drawRules(g, a, def, box) {
      const rules = a.get(def.id)?.rules ?? [];
      if (!rules.length) {
        g.text(box.x + 5, box.y + 5, 'This one has no rules — it is configured in SETTINGS.', C.stoneShadow,
          { max: box.w - 10 });
        return;
      }
      const r = list(g, { x: box.x + 2, y: box.y + 2, w: box.w - 4, h: box.h - 4 }, {
        items: rules, rowH: 17, top: ruleTop, tag: 'auto-rule',
        draw: (gg, rule, rect, st) => {
          const off = rule.enabled === false;
          const ink = off ? C.stoneShadow : st.ink;
          // The rank, because first-match-wins is invisible otherwise.
          gg.text(rect.x + 3, rect.y + 3, `${st.index + 1}`, C.stoneShadow);
          gg.text(rect.x + 14, rect.y + 2, rule.name ?? rule.id, ink, { max: rect.w - 84 });
          const why = a.describeRule?.(def.id, rule) ?? '';
          gg.text(rect.x + 14, rect.y + 9, why, C.stoneShadow, { max: rect.w - 84 });

          const bx = rect.x + rect.w - 64;
          action(gg, { x: bx, y: rect.y + 3, w: 14, h: 11 }, '^',
            { disabled: st.index === 0, tag: `up-${rule.id}`, onPick: () => move(def.id, rule.id, -1) });
          action(gg, { x: bx + 16, y: rect.y + 3, w: 14, h: 11 }, 'v',
            { disabled: st.index === rules.length - 1, tag: `dn-${rule.id}`, onPick: () => move(def.id, rule.id, 1) });
          action(gg, { x: bx + 32, y: rect.y + 3, w: 30, h: 11 }, off ? 'OFF' : 'ON',
            { active: !off, tag: `on-${rule.id}`, onPick: () => toggleRule(def.id, rule) });
        },
      });
      ruleTop = r.top;
    },

    /** The settings, including the two list types a condition tree cannot express. */
    drawSettings(g, a, def, box) {
      const specs = def.settings ?? [];
      const values = a.settings(def.id) ?? {};
      let y = box.y + 4;
      const right = box.x + box.w - 6;

      if (!specs.length) {
        g.text(box.x + 5, y, 'Nothing to configure — this one is all rules.', C.stoneShadow);
        return;
      }

      for (const spec of specs) {
        if (y > box.y + box.h - 14) break;
        const v = values[spec.key];

        if (spec.type === 'ladder') {
          g.text(box.x + 5, y, spec.label, C.ink);
          y += 9;
          const ladder = Array.isArray(v) ? v : [];
          ladder.forEach((rung, i) => {
            if (y > box.y + box.h - 12) return;
            const off = rung.enabled === false;
            const name = itemName(rung.item);
            g.text(box.x + 8, y, `${i + 1}`, C.stoneShadow);
            g.text(box.x + 18, y, name, off ? C.stoneShadow : C.ink, { max: box.w - 130 });
            g.textRight(right - 96, y, `at ${rung.atPercent}% HP`, off ? C.stoneShadow : C.martShadow);
            action(g, { x: right - 92, y: y - 2, w: 13, h: 11 }, '-',
              { tag: `rung-lo-${i}`, onPick: () => bumpRung(def.id, spec.key, i, { atPercent: Math.max(0, rung.atPercent - 5) }) });
            action(g, { x: right - 77, y: y - 2, w: 13, h: 11 }, '+',
              { tag: `rung-hi-${i}`, onPick: () => bumpRung(def.id, spec.key, i, { atPercent: Math.min(100, rung.atPercent + 5) }) });
            action(g, { x: right - 60, y: y - 2, w: 13, h: 11 }, '^',
              { disabled: i === 0, tag: `rung-up-${i}`, onPick: () => moveRung(def.id, spec.key, i, -1) });
            action(g, { x: right - 45, y: y - 2, w: 13, h: 11 }, 'v',
              { disabled: i === ladder.length - 1, tag: `rung-dn-${i}`, onPick: () => moveRung(def.id, spec.key, i, 1) });
            action(g, { x: right - 30, y: y - 2, w: 28, h: 11 }, off ? 'OFF' : 'ON',
              { active: !off, tag: `rung-on-${i}`, onPick: () => bumpRung(def.id, spec.key, i, { enabled: off }) });
            y += 13;
          });
          if (spec.blurb) { g.text(box.x + 8, y, spec.blurb, C.stoneShadow, { max: box.w - 16 }); y += 10; }
          y += 3;
          continue;
        }

        if (spec.type === 'order') {
          g.text(box.x + 5, y, spec.label, C.ink);
          const ids = Array.isArray(v) ? v : [];
          g.textRight(right, y, ids.map(itemName).join(' > '), C.martShadow);
          y += 11;
          continue;
        }

        g.text(box.x + 5, y, spec.label, C.ink);
        if (spec.type === 'bool') {
          action(g, { x: right - 34, y: y - 2, w: 32, h: 11 }, v ? 'ON' : 'OFF',
            { active: !!v, tag: `set-${spec.key}`, onPick: () => setSetting(def.id, spec.key, !v) });
        } else if (spec.type === 'enum') {
          const vals = spec.values ?? [];
          const at = Math.max(0, vals.indexOf(String(v)));
          action(g, { x: right - 74, y: y - 2, w: 72, h: 11 }, String(v ?? vals[0] ?? ''),
            { tag: `set-${spec.key}`, onPick: () => setSetting(def.id, spec.key, vals[(at + 1) % vals.length]) });
        } else if (spec.type === 'number') {
          const step = spec.step ?? 1;
          g.textRight(right - 34, y, `${v}${spec.unit ? ` ${spec.unit}` : ''}`, C.martShadow);
          action(g, { x: right - 30, y: y - 2, w: 13, h: 11 }, '-',
            { tag: `set-lo-${spec.key}`, onPick: () => setSetting(def.id, spec.key, Number(v) - step) });
          action(g, { x: right - 15, y: y - 2, w: 13, h: 11 }, '+',
            { tag: `set-hi-${spec.key}`, onPick: () => setSetting(def.id, spec.key, Number(v) + step) });
        } else {
          g.textRight(right, y, String(v ?? '—'), C.stoneShadow);
        }
        y += 11;
        if (spec.blurb && y < box.y + box.h - 10) {
          g.text(box.x + 8, y, spec.blurb, C.stoneShadow, { max: box.w - 16 });
          y += 10;
        }
      }
      void INLINE; void panel; void header; void well; void meter;
    },
  };
}
