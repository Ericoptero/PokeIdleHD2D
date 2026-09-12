// @ts-check
/**
 * Console wrapper that also keeps a structured buffer. The screenshot harness reads
 * `window.__LOG__` to report console errors without racing Chrome's console events, and
 * repeated identical messages are collapsed so a per-frame warning cannot flood the page.
 */
const buffer = [];
const counts = new Map();
const MAX = 500;
const REPEAT_LIMIT = 5;

function push(level, args) {
  const text = args.map((a) =>
    a instanceof Error ? `${a.message}\n${a.stack ?? ''}` :
    typeof a === 'object' ? safeJson(a) : String(a)).join(' ');
  const key = `${level}:${text.slice(0, 200)}`;
  const n = (counts.get(key) ?? 0) + 1;
  counts.set(key, n);
  if (n === REPEAT_LIMIT) {
    buffer.push({ level, text: `${text}  (further repeats suppressed)`, t: performance.now(), n });
    return true;
  }
  if (n > REPEAT_LIMIT) return false;
  buffer.push({ level, text, t: performance.now(), n });
  if (buffer.length > MAX) buffer.shift();
  return true;
}

function safeJson(o) {
  try { return JSON.stringify(o); } catch { return String(o); }
}

export const log = {
  debug: (...a) => { if (push('debug', a)) console.debug(...a); },
  info: (...a) => { if (push('info', a)) console.info(...a); },
  warn: (...a) => { if (push('warn', a)) console.warn(...a); },
  error: (...a) => { if (push('error', a)) console.error(...a); },
  entries: () => buffer.slice(),
  errors: () => buffer.filter((e) => e.level === 'error'),
  warnings: () => buffer.filter((e) => e.level === 'warn'),
  clear: () => { buffer.length = 0; counts.clear(); },
};

/**
 * Reports a browser-side `selfTest()` result, and **fails loudly when it fails**.
 *
 * Five modules carry invariants that are only reachable with a live `ctx` — the ledger
 * against the shop's own prices, the automation engine against a running world — so they
 * cannot go in a `selftest.js` that runs under plain Node. They were checked by a showcase
 * that painted `20/26 checks` into the page and by nothing else, which means a red
 * invariant was a colour in a screenshot nobody was obliged to look at.
 *
 * `console.error` is what makes it a gate: tools/shots/shoot.js budgets zero console errors, so a failing
 * invariant now fails the capture that ran it. It is the one place an `error` is correct for
 * a handled path, because the handling is *this*.
 *
 * Accepts every shape the five return: `{ ok, results }`, `{ passed, total, results }`, or a
 * bare `results` array of `{ name, ok, detail }`.
 *
 * @returns {{ok:boolean, passed:number, total:number, results:Array}} normalised
 */
export function reportSelfTest(moduleId, result) {
  const results = Array.isArray(result) ? result : (result?.results ?? []);
  const total = results.length;
  const failures = results.filter((r) => r && !r.ok);
  // Trust an explicit `ok` when one is given and there are no rows to count.
  const ok = total ? failures.length === 0 : result?.ok !== false;
  if (!ok) {
    const why = failures.slice(0, 6)
      .map((r) => `${r.name}${r.detail ? ` (${r.detail})` : ''}`).join('; ');
    log.error(`${moduleId}: selfTest failed ${failures.length}/${total} — ${why}`);
  }
  return { ok, passed: total - failures.length, total, results };
}

if (typeof window !== 'undefined') window.__LOG__ = log;
