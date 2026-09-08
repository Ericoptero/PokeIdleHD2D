/**
 * The engine — everything the automations *are*, with nothing that knows about the game.
 *
 * No `ctx`, no bus, no DOM, no clock of its own. It owns the mutable half of this module:
 * which automations are unlocked and switched on, their settings, their rules, the
 * compiled rulesets, the run cadence, the per-automation counters and the audit log. That
 * separation is what lets `selftest.js` drive a full session in Node and compare two runs
 * for equality.
 *
 * ### Compilation is cached on a dirty flag
 *
 * Rules are compiled once and reused until something edits them. The tick path calls
 * `compiled(id)` and gets the same object back every time, so the cost of a pass is the
 * cost of the facts plus a few closure calls — never a re-parse of the rule tree.
 *
 * ### The audit log is part of the product, not debug output
 *
 * Every action an automation takes lands in a bounded ring with the simulated time, the
 * rule that decided it and a one-line reason. It is what makes a destructive automation
 * trustworthy: a player who finds a Pokémon missing can read the line that released it and
 * the rule that said so. It is keyed on `simTime` and never on `Date.now()`, so two runs
 * from the same seed produce byte-identical logs — which `selftest.js` asserts.
 */

import { compileRuleset } from './rules.js';
import {
  AUTOMATIONS, automation, defaultSettings, defaultRules, requirementMet,
} from './automations.js';

/** How many audit entries are kept. Enough for a session; bounded so memory cannot run. */
export const HISTORY_CAPACITY = 240;

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

export function makeEngine({ onChange = () => {} } = {}) {
  /** @type {Map<string, Object>} */
  const state = new Map();

  for (const def of AUTOMATIONS) {
    state.set(def.id, {
      id: def.id,
      unlocked: false,
      enabled: false,
      settings: defaultSettings(def.id),
      rules: defaultRules(def.id),
      compiled: null,
      lastRunS: -Infinity,
      stats: { runs: 0, actions: 0, skipped: 0, money: 0, errors: 0 },
    });
  }

  /** @type {Object[]} bounded ring, oldest first */
  const history = [];
  let logSeq = 0;

  function rec(id) {
    const s = state.get(id);
    if (!s) throw new Error(`automation: no such automation "${id}"`);
    return s;
  }

  function invalidate(id) {
    rec(id).compiled = null;
  }

  function changed(id, what) {
    onChange({ id, what });
  }

  // ------------------------------------------------------------------ rules

  /** The compiled ruleset, built on first use after any edit. */
  function compiled(id) {
    const s = rec(id);
    if (!s.compiled) {
      const def = automation(id);
      s.compiled = compileRuleset(s.rules, {
        kind: def.kind,
        actions: def.actions,
        defaultAction: def.defaultAction,
      });
    }
    return s.compiled;
  }

  /** Every rule problem across every automation, ready to print. */
  function errors() {
    const out = [];
    for (const def of AUTOMATIONS) {
      for (const e of compiled(def.id).errors) out.push(`${def.id}/${e}`);
    }
    return out;
  }

  // -------------------------------------------------------------- lifecycle

  const isUnlocked = (id) => rec(id).unlocked;
  const isEnabled = (id) => rec(id).enabled;
  /** Unlocked *and* switched on. Nothing acts unless this is true. */
  const isActive = (id) => { const s = rec(id); return s.unlocked && s.enabled; };

  function canUnlock(id, progress) {
    const def = automation(id);
    if (!def) return { ok: false, why: 'no such automation' };
    if (rec(id).unlocked) return { ok: false, why: 'already unlocked' };
    if (!requirementMet(def.unlock?.requires, progress)) return { ok: false, why: 'requirement not met' };
    return { ok: true, why: null };
  }

  /** Marks it bought. Spending the currency is the caller's job — this file has no wallet. */
  function markUnlocked(id, on = true) {
    const s = rec(id);
    if (s.unlocked === on) return false;
    s.unlocked = on;
    if (!on) s.enabled = false;
    changed(id, 'unlocked');
    return true;
  }

  function enable(id, on = true) {
    const s = rec(id);
    const want = !!on && s.unlocked;
    if (s.enabled === want) return want;
    s.enabled = want;
    changed(id, 'enabled');
    return want;
  }

  // --------------------------------------------------------------- settings

  function settings(id) { return { ...rec(id).settings }; }

  /** Coerces against the declared spec, so a UI cannot put a string in a number. */
  function configure(id, patch = {}) {
    const def = automation(id);
    const s = rec(id);
    let touched = false;
    for (const spec of def.settings ?? []) {
      if (!(spec.key in patch)) continue;
      const next = coerce(spec, patch[spec.key]);
      if (next !== undefined && next !== s.settings[spec.key]) {
        s.settings[spec.key] = next;
        touched = true;
      }
    }
    if (touched) changed(id, 'settings');
    return touched;
  }

  function coerce(spec, raw) {
    if (spec.type === 'bool') return raw === true || raw === 'true' || raw === 1;
    if (spec.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) return undefined;
      const lo = spec.min ?? -Infinity;
      const hi = spec.max ?? Infinity;
      return Math.min(hi, Math.max(lo, n));
    }
    if (spec.type === 'enum') {
      const v = String(raw);
      return spec.values?.includes(v) ? v : undefined;
    }
    return String(raw);
  }

  // ------------------------------------------------------------ rule edits

  const rules = (id) => clone(rec(id).rules);

  function setRules(id, list) {
    if (!Array.isArray(list)) return false;
    rec(id).rules = clone(list);
    invalidate(id);
    changed(id, 'rules');
    return true;
  }

  function addRule(id, rule, at = -1) {
    const s = rec(id);
    const r = { ...clone(rule), builtin: false };
    if (!r.id) r.id = `${id}-u${++logSeq}`;
    if (at < 0 || at >= s.rules.length) s.rules.push(r);
    else s.rules.splice(at, 0, r);
    invalidate(id);
    changed(id, 'rules');
    return r.id;
  }

  function updateRule(id, ruleId, patch) {
    const s = rec(id);
    const i = s.rules.findIndex((r) => r.id === ruleId);
    if (i < 0) return false;
    s.rules[i] = { ...s.rules[i], ...clone(patch), id: ruleId };
    invalidate(id);
    changed(id, 'rules');
    return true;
  }

  function removeRule(id, ruleId) {
    const s = rec(id);
    const i = s.rules.findIndex((r) => r.id === ruleId);
    if (i < 0) return false;
    s.rules.splice(i, 1);
    invalidate(id);
    changed(id, 'rules');
    return true;
  }

  /** Reorder is the priority control: the list order *is* the precedence. */
  function moveRule(id, ruleId, to) {
    const s = rec(id);
    const i = s.rules.findIndex((r) => r.id === ruleId);
    if (i < 0) return false;
    const target = Math.max(0, Math.min(s.rules.length - 1, to));
    const [r] = s.rules.splice(i, 1);
    s.rules.splice(target, 0, r);
    invalidate(id);
    changed(id, 'rules');
    return true;
  }

  function resetRules(id) {
    rec(id).rules = defaultRules(id);
    invalidate(id);
    changed(id, 'rules');
    return true;
  }

  // -------------------------------------------------------------- cadence

  /** True when `everyS` has elapsed in *simulated* seconds since the last pass. */
  function due(id, simTime) {
    const def = automation(id);
    const s = rec(id);
    if (!def.everyS) return false;
    return simTime - s.lastRunS >= def.everyS;
  }

  function mark(id, simTime) {
    const s = rec(id);
    s.lastRunS = simTime;
    s.stats.runs++;
  }

  function bump(id, key, n = 1) {
    const s = rec(id).stats;
    s[key] = (s[key] ?? 0) + n;
  }

  // -------------------------------------------------------------- the log

  /**
   * Appends one line. `at` is simulated time; nothing here reads a wall clock, which is
   * what makes two runs of the same seed produce identical logs.
   */
  function log(entry) {
    const line = {
      seq: ++logSeq,
      at: +(entry.at ?? 0).toFixed(2),
      automation: entry.automation,
      action: entry.action,
      subject: entry.subject ?? '',
      rule: entry.rule ?? null,
      detail: entry.detail ?? '',
    };
    history.push(line);
    if (history.length > HISTORY_CAPACITY) history.shift();
    return line;
  }

  const historyOf = (n = HISTORY_CAPACITY, filter = null) => history
    .filter((l) => !filter || l.automation === filter)
    .slice(-n);

  // ---------------------------------------------------------- persistence

  /**
   * The save slice. Rules are stored whole because a player's rules *are* their save;
   * built-in rules are stored too, since they may have been reordered, edited or switched
   * off and re-deriving them from the catalog would silently undo that.
   */
  function serialize() {
    const out = { v: 1, automations: {} };
    for (const def of AUTOMATIONS) {
      const s = rec(def.id);
      out.automations[def.id] = {
        unlocked: s.unlocked,
        enabled: s.enabled,
        settings: { ...s.settings },
        rules: clone(s.rules),
        stats: { ...s.stats },
      };
    }
    return out;
  }

  function restore(value) {
    if (!value || typeof value !== 'object') return false;
    const src = value.automations ?? {};
    for (const def of AUTOMATIONS) {
      const from = src[def.id];
      const s = rec(def.id);
      if (!from) continue;
      s.unlocked = !!from.unlocked;
      s.enabled = !!from.enabled && s.unlocked;
      s.settings = defaultSettings(def.id);
      if (from.settings) {
        for (const spec of def.settings ?? []) {
          if (!(spec.key in from.settings)) continue;
          const v = coerce(spec, from.settings[spec.key]);
          if (v !== undefined) s.settings[spec.key] = v;
        }
      }
      s.rules = Array.isArray(from.rules) && from.rules.length ? clone(from.rules) : defaultRules(def.id);
      if (from.stats) for (const k in s.stats) if (Number.isFinite(from.stats[k])) s.stats[k] = from.stats[k];
      s.compiled = null;
    }
    onChange({ id: null, what: 'restored' });
    return true;
  }

  /** Back to the factory ruleset and a clean sheet. Used by the showcase and the selftest. */
  function reset() {
    for (const def of AUTOMATIONS) {
      const s = rec(def.id);
      s.unlocked = false;
      s.enabled = false;
      s.settings = defaultSettings(def.id);
      s.rules = defaultRules(def.id);
      s.compiled = null;
      s.lastRunS = -Infinity;
      s.stats = { runs: 0, actions: 0, skipped: 0, money: 0, errors: 0 };
    }
    history.length = 0;
    logSeq = 0;
    onChange({ id: null, what: 'reset' });
  }

  return {
    // lifecycle
    isUnlocked, isEnabled, isActive, canUnlock, markUnlocked, enable,
    // configuration
    settings, configure,
    // rules
    rules, setRules, addRule, updateRule, removeRule, moveRule, resetRules, compiled, errors,
    // cadence + counters
    due, mark, bump, stats: (id) => ({ ...rec(id).stats }),
    lastRunS: (id) => rec(id).lastRunS,
    // audit
    log, history: historyOf, historySize: () => history.length,
    // persistence
    serialize, restore, reset,
    /** Raw record, for the showcase's tables. Treat as read-only. */
    peek: (id) => rec(id),
  };
}
