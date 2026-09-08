/**
 * The rule engine.
 *
 * A rule is a plain object. Nothing in this file is specific to Pokémon, to the bag or to
 * the box — it takes a field schema (`fields.js`), an operator table (`ops.js`) and a list
 * of legal actions, and turns a list of rules into one function from facts to a decision.
 *
 * ```js
 * { id: 'dupes', name: 'Release plain duplicates', enabled: true,
 *   when: { all: [ { field:'copies', op:'gte', value:2 },
 *                  { field:'ivPct',  op:'lt',  value:60 },
 *                  { field:'shiny',  op:'isFalse' } ] },
 *   then: 'release' }
 * ```
 *
 * ### Three properties everything else leans on
 *
 * **Compiled once.** `compileRuleset` walks the tree once and produces closures; the hot
 * path never re-reads the rule objects, never allocates, and never looks a field up by
 * string in a `switch`. Evaluating twenty rules over a nine-hundred-slot box is a few tens
 * of thousands of property reads, which is why this can run on a cadence measured in
 * seconds rather than minutes. `selftest.js` measures it and states the number.
 *
 * **First match wins, top to bottom.** The order of the list *is* the priority, so a
 * player reorders rules to change precedence instead of learning a weight system, and the
 * decision always has exactly one rule to blame — which is what makes the audit log
 * readable. A ruleset with no match yields the automation's declared default, which is
 * always the conservative action (keep, skip, don't).
 *
 * **Explainable.** `explain` re-runs the same tree collecting per-leaf outcomes, so a UI
 * can show *why* a Pokémon was released and a player can trust the thing enough to turn it
 * on. An automation nobody dares enable is worth nothing.
 *
 * ### Failure model
 *
 * A rule that does not validate is **not** silently dropped: it compiles to a predicate
 * that never matches, keeps its errors, and is reported by `errors()`. A bad rule
 * therefore does nothing rather than doing something surprising, and the player can see
 * what is wrong with it.
 */

import { operator, phrase } from './ops.js';
import { field as fieldOf, schemaFor } from './fields.js';

/** Guard rails. A rule tree deeper or wider than this is a bug or an attack, not a rule. */
export const MAX_DEPTH = 6;
export const MAX_LEAVES = 32;
export const MAX_RULES = 64;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Always-true predicate, shared so an empty `when` allocates nothing. */
const ALWAYS = () => true;
const NEVER = () => false;

/**
 * @typedef {Object} Rule
 * @property {string} id
 * @property {string} [name]
 * @property {boolean} [enabled]
 * @property {Object} [when]     condition tree; omitted means "always"
 * @property {string} then       an action id
 * @property {Object} [args]     action arguments
 * @property {string} [note]     free text the player wrote
 */

/**
 * Fills in the defaults so a rule from a save, from a UI, or from a defaults table all
 * look the same downstream. Never throws: validation is a separate, reportable step.
 */
export function normaliseRule(rule, index = 0) {
  const r = isPlainObject(rule) ? rule : {};
  return {
    id: String(r.id ?? `r${index + 1}`),
    name: String(r.name ?? 'Rule'),
    enabled: r.enabled !== false,
    when: r.when ?? null,
    then: String(r.then ?? ''),
    args: isPlainObject(r.args) ? { ...r.args } : {},
    note: r.note ? String(r.note) : '',
    builtin: !!r.builtin,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Checks one condition tree against a kind's schema.
 * @returns {{errors:string[], leaves:number, depth:number}}
 */
export function validateCondition(when, kind, path = 'when', depth = 1) {
  const errors = [];
  if (when == null || when === true) return { errors, leaves: 0, depth: depth - 1 };
  if (depth > MAX_DEPTH) {
    errors.push(`${path}: nested deeper than ${MAX_DEPTH}`);
    return { errors, leaves: 0, depth };
  }
  if (!isPlainObject(when)) {
    errors.push(`${path}: expected an object, got ${typeof when}`);
    return { errors, leaves: 0, depth };
  }

  for (const key of ['all', 'any']) {
    if (key in when) {
      const list = when[key];
      if (!Array.isArray(list) || list.length === 0) {
        errors.push(`${path}.${key}: expected a non-empty array`);
        return { errors, leaves: 0, depth };
      }
      let leaves = 0;
      let deepest = depth;
      list.forEach((child, i) => {
        const r = validateCondition(child, kind, `${path}.${key}[${i}]`, depth + 1);
        errors.push(...r.errors);
        leaves += r.leaves;
        deepest = Math.max(deepest, r.depth);
      });
      return { errors, leaves, depth: deepest };
    }
  }

  if ('not' in when) {
    const r = validateCondition(when.not, kind, `${path}.not`, depth + 1);
    return { errors: [...errors, ...r.errors], leaves: r.leaves, depth: r.depth };
  }

  // A leaf.
  const f = fieldOf(kind, when.field);
  if (!f) {
    errors.push(`${path}: "${when.field}" is not a field a ${kind} rule can test`);
    return { errors, leaves: 1, depth };
  }
  const op = operator(when.op);
  if (!op) {
    errors.push(`${path}: "${when.op}" is not an operator`);
    return { errors, leaves: 1, depth };
  }
  if (!op.types.includes(f.type)) {
    errors.push(`${path}: "${op.id}" cannot be used on ${f.type} field "${f.id}"`);
    return { errors, leaves: 1, depth };
  }
  if (op.arity === 1 && when.value === undefined) {
    errors.push(`${path}: "${op.id}" needs a value`);
  }
  if (op.arity === 2 && (!Array.isArray(when.value) || when.value.length !== 2)) {
    errors.push(`${path}: "${op.id}" needs a two-element range`);
  }
  if (f.type === 'number' && op.arity >= 1) {
    const vals = Array.isArray(when.value) ? when.value : [when.value];
    for (const v of vals) {
      if (!Number.isFinite(Number(v))) errors.push(`${path}: "${v}" is not a number`);
    }
  }
  if (f.values && op.arity === 1) {
    const vals = Array.isArray(when.value) ? when.value : [when.value];
    for (const v of vals) {
      if (!f.values.includes(String(v).toLowerCase())) {
        errors.push(`${path}: "${v}" is not one of ${f.values.join(', ')}`);
      }
    }
  }
  return { errors, leaves: 1, depth };
}

/**
 * Validates a whole rule against a kind and a set of legal actions.
 * @returns {string[]} human-readable problems; empty means the rule is sound
 */
export function validateRule(rule, { kind, actions = [] } = {}) {
  const r = normaliseRule(rule);
  const errors = [];
  if (!r.then) errors.push('no action: `then` is empty');
  else if (actions.length && !actions.some((a) => a.id === r.then)) {
    errors.push(`"${r.then}" is not one of this automation's actions (${actions.map((a) => a.id).join(', ')})`);
  }
  const cond = validateCondition(r.when, kind);
  errors.push(...cond.errors);
  if (cond.leaves > MAX_LEAVES) errors.push(`${cond.leaves} conditions; the limit is ${MAX_LEAVES}`);
  return errors;
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/**
 * Turns a condition tree into a closure over the fact object. Called once per rule change,
 * never per subject.
 * @returns {(facts:Object) => boolean}
 */
export function compileCondition(when, kind) {
  if (when == null || when === true) return ALWAYS;
  if (!isPlainObject(when)) return NEVER;

  if (Array.isArray(when.all)) {
    const parts = when.all.map((c) => compileCondition(c, kind));
    if (parts.length === 1) return parts[0];
    return (facts) => {
      for (let i = 0; i < parts.length; i++) if (!parts[i](facts)) return false;
      return true;
    };
  }
  if (Array.isArray(when.any)) {
    const parts = when.any.map((c) => compileCondition(c, kind));
    if (parts.length === 1) return parts[0];
    return (facts) => {
      for (let i = 0; i < parts.length; i++) if (parts[i](facts)) return true;
      return false;
    };
  }
  if ('not' in when) {
    const inner = compileCondition(when.not, kind);
    return (facts) => !inner(facts);
  }

  const f = fieldOf(kind, when.field);
  const op = operator(when.op);
  if (!f || !op || !op.types.includes(f.type)) return NEVER;
  const test = op.make(when.value);
  const key = f.id;
  return (facts) => test(facts[key]);
}

/**
 * @typedef {Object} CompiledRuleset
 * @property {(facts:Object) => Decision} evaluate
 * @property {(facts:Object) => Explanation} explain
 * @property {Object[]} rules      the normalised rules, in priority order
 * @property {string[]} errors     every problem across every rule, prefixed with the rule id
 * @property {number} leaves       total leaf count, a rough cost proxy
 */

/**
 * @typedef {Object} Decision
 * @property {string} action
 * @property {string|null} ruleId
 * @property {string|null} ruleName
 * @property {Object} args
 */

/**
 * Compiles a rule list for one automation.
 *
 * @param {Rule[]} rules
 * @param {{kind:string, actions:Object[], defaultAction:string}} spec
 * @returns {CompiledRuleset}
 */
export function compileRuleset(rules, { kind, actions = [], defaultAction = 'skip' } = {}) {
  const list = (Array.isArray(rules) ? rules : []).slice(0, MAX_RULES).map(normaliseRule);
  const errors = [];
  let leaves = 0;

  const compiled = list.map((r) => {
    const problems = validateRule(r, { kind, actions });
    for (const p of problems) errors.push(`${r.id}: ${p}`);
    const cond = validateCondition(r.when, kind);
    leaves += cond.leaves;
    return {
      rule: r,
      ok: problems.length === 0,
      test: problems.length === 0 ? compileCondition(r.when, kind) : NEVER,
      errors: problems,
    };
  });

  const fallback = Object.freeze({ action: defaultAction, ruleId: null, ruleName: 'default', args: {} });

  function evaluate(facts) {
    for (let i = 0; i < compiled.length; i++) {
      const c = compiled[i];
      if (!c.rule.enabled || !c.ok) continue;
      if (c.test(facts)) {
        return { action: c.rule.then, ruleId: c.rule.id, ruleName: c.rule.name, args: c.rule.args };
      }
    }
    return fallback;
  }

  function explain(facts) {
    const trace = [];
    let decision = fallback;
    for (const c of compiled) {
      if (!c.rule.enabled) { trace.push({ ruleId: c.rule.id, name: c.rule.name, state: 'off', leaves: [] }); continue; }
      if (!c.ok) { trace.push({ ruleId: c.rule.id, name: c.rule.name, state: 'invalid', leaves: [], errors: c.errors }); continue; }
      const leafTrace = traceCondition(c.rule.when, kind, facts);
      const matched = c.test(facts);
      trace.push({
        ruleId: c.rule.id, name: c.rule.name,
        state: matched ? (decision.ruleId === null ? 'matched' : 'shadowed') : 'no',
        then: c.rule.then, leaves: leafTrace,
      });
      if (matched && decision.ruleId === null) {
        decision = { action: c.rule.then, ruleId: c.rule.id, ruleName: c.rule.name, args: c.rule.args };
      }
    }
    return { ...decision, trace };
  }

  return { evaluate, explain, rules: list, compiled, errors, leaves };
}

/** Per-leaf outcomes, for `explain`. Allocates; never called on the hot path. */
function traceCondition(when, kind, facts, out = [], prefix = '') {
  if (when == null || when === true) return out;
  if (!isPlainObject(when)) return out;
  if (Array.isArray(when.all)) {
    when.all.forEach((c) => traceCondition(c, kind, facts, out, prefix ? `${prefix}·and` : 'and'));
    return out;
  }
  if (Array.isArray(when.any)) {
    when.any.forEach((c) => traceCondition(c, kind, facts, out, prefix ? `${prefix}·or` : 'or'));
    return out;
  }
  if ('not' in when) return traceCondition(when.not, kind, facts, out, `${prefix}not`);

  const f = fieldOf(kind, when.field);
  const op = operator(when.op);
  const ok = f && op && op.types.includes(f.type) ? op.make(when.value)(facts[f.id]) : false;
  out.push({
    join: prefix,
    text: phrase(f ?? { id: when.field }, when.op, when.value),
    got: f ? formatValue(facts[f.id]) : '—',
    ok,
  });
  return out;
}

function formatValue(v) {
  if (Array.isArray(v)) return v.join('/');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v ?? '—');
}

/**
 * The whole schema for one kind, in the shape a generic editor wants: fields with their
 * types and legal operators, plus every operator's arity and wording.
 */
export function kindSchema(kind) {
  return { kind, fields: schemaFor(kind) };
}

/**
 * One line of English for a condition tree. `ui` shows this on a collapsed rule row and
 * the audit log quotes it, so a player never has to read JSON to know what a rule says.
 */
export function describeCondition(when, kind) {
  if (when == null || when === true) return 'always';
  if (!isPlainObject(when)) return '(malformed)';
  if (Array.isArray(when.all)) return when.all.map((c) => wrap(c, kind)).join(' and ');
  if (Array.isArray(when.any)) return when.any.map((c) => wrap(c, kind)).join(' or ');
  if ('not' in when) return `not ${wrap(when.not, kind)}`;
  return phrase(fieldOf(kind, when.field) ?? { id: when.field, label: when.field }, when.op, when.value);
}

function wrap(node, kind) {
  const text = describeCondition(node, kind);
  const compound = isPlainObject(node) && (Array.isArray(node.all) || Array.isArray(node.any));
  return compound ? `(${text})` : text;
}
