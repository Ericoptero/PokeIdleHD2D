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

if (typeof window !== 'undefined') window.__LOG__ = log;
