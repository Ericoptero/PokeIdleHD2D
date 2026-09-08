/**
 * The operator table — half of what makes a rule *data* instead of code.
 *
 * A rule leaf is `{ field, op, value }`. `field` names something in the fact object,
 * `op` names one of these, and `value` is a literal. Nothing here knows what a Pokémon is;
 * this file is pure predicate logic over the four shapes a field can have.
 *
 * Every operator declares which field types it accepts and how many operands it takes, so
 * `ui` can render the right control (a number box, a multi-select, nothing at all for a
 * boolean test) without a single `if (field.id === …)` anywhere in its code. That is the
 * whole reason the arity and `types` list exist: they are the UI contract, not decoration.
 *
 * Pure, allocation-free in the hot path, and free of `Math.random` by construction.
 */

/** Field types an operator can be declared against. */
export const FIELD_TYPES = Object.freeze(['number', 'text', 'enum', 'bool', 'list']);

const norm = (v) => (typeof v === 'string' ? v.toLowerCase() : v);

/** Coerces a rule's stored value into a Set once, at compile time, not per evaluation. */
function toSet(value) {
  const arr = Array.isArray(value) ? value : [value];
  return new Set(arr.map(norm));
}

/**
 * @typedef {Object} Operator
 * @property {string} id
 * @property {string} label      human wording, e.g. "is at least"
 * @property {string} symbol     compact wording for a dense table, e.g. "≥"
 * @property {0|1|2} arity       how many literals the operator needs from the player
 * @property {string[]} types    field types it may be used on
 * @property {(value:any) => (a:any) => boolean} make   compiles the right-hand side once
 */

/** @type {Operator[]} */
export const OPERATORS = [
  { id: 'gt', label: 'is more than', symbol: '>', arity: 1, types: ['number'],
    make: (v) => { const n = +v; return (a) => a > n; } },
  { id: 'gte', label: 'is at least', symbol: '≥', arity: 1, types: ['number'],
    make: (v) => { const n = +v; return (a) => a >= n; } },
  { id: 'lt', label: 'is less than', symbol: '<', arity: 1, types: ['number'],
    make: (v) => { const n = +v; return (a) => a < n; } },
  { id: 'lte', label: 'is at most', symbol: '≤', arity: 1, types: ['number'],
    make: (v) => { const n = +v; return (a) => a <= n; } },
  { id: 'between', label: 'is between', symbol: '∈', arity: 2, types: ['number'],
    make: (v) => {
      const lo = +(Array.isArray(v) ? v[0] : v);
      const hi = +(Array.isArray(v) ? v[1] : v);
      return (a) => a >= lo && a <= hi;
    } },

  { id: 'eq', label: 'is', symbol: '=', arity: 1, types: ['number', 'text', 'enum'],
    make: (v) => { const n = norm(v); return (a) => norm(a) === n; } },
  { id: 'ne', label: 'is not', symbol: '≠', arity: 1, types: ['number', 'text', 'enum'],
    make: (v) => { const n = norm(v); return (a) => norm(a) !== n; } },

  { id: 'in', label: 'is one of', symbol: '∈', arity: 1, types: ['text', 'enum'],
    make: (v) => { const set = toSet(v); return (a) => set.has(norm(a)); } },
  { id: 'notIn', label: 'is none of', symbol: '∉', arity: 1, types: ['text', 'enum'],
    make: (v) => { const set = toSet(v); return (a) => !set.has(norm(a)); } },

  { id: 'has', label: 'includes', symbol: '∋', arity: 1, types: ['list'],
    make: (v) => { const n = norm(v); return (a) => Array.isArray(a) && a.some((x) => norm(x) === n); } },
  { id: 'hasAny', label: 'includes any of', symbol: '∩', arity: 1, types: ['list'],
    make: (v) => { const set = toSet(v); return (a) => Array.isArray(a) && a.some((x) => set.has(norm(x))); } },
  { id: 'hasNone', label: 'includes none of', symbol: '∅', arity: 1, types: ['list'],
    make: (v) => { const set = toSet(v); return (a) => !Array.isArray(a) || !a.some((x) => set.has(norm(x))); } },

  // Arity 0: the field *is* the question. A boolean leaf renders as a bare checkbox.
  { id: 'isTrue', label: 'is true', symbol: '✓', arity: 0, types: ['bool'],
    make: () => (a) => a === true },
  { id: 'isFalse', label: 'is false', symbol: '✗', arity: 0, types: ['bool'],
    make: () => (a) => a !== true },
];

const BY_ID = new Map(OPERATORS.map((o) => [o.id, o]));

/** @returns {Operator|null} */
export const operator = (id) => BY_ID.get(id) ?? null;

/** Operator ids legal on a field of this type, in table order. */
export function operatorsFor(type) {
  return OPERATORS.filter((o) => o.types.includes(type)).map((o) => o.id);
}

/** One-line rendering of a leaf, used by the audit log and by `explain`. */
export function phrase(field, op, value) {
  const o = BY_ID.get(op);
  const label = field?.label ?? field?.id ?? '?';
  if (!o) return `${label} ${op} ${JSON.stringify(value)}`;
  if (o.arity === 0) return `${label} ${o.symbol}`;
  if (o.arity === 2) {
    const [a, b] = Array.isArray(value) ? value : [value, value];
    return `${label} ${o.symbol} ${a}…${b}`;
  }
  const v = Array.isArray(value) ? value.join('/') : value;
  return `${label} ${o.symbol} ${v}`;
}
