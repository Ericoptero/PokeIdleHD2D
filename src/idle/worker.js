/**
 * worker.js — the heartbeat.
 *
 * A backgrounded tab stops `requestAnimationFrame` entirely and clamps main-thread timers
 * to roughly 1 Hz, and after a few minutes Chrome pushes an "intensively throttled" tab's
 * timers out to once a minute. A dedicated worker keeps a much better beat than that, so
 * this is what tells the game that time is passing while the player is reading something
 * else (ARCHITECTURE §5.7).
 *
 * It deliberately carries NO game state. It says "time passed, this is beat 41, my clock
 * reads X" and nothing more; the main thread reconciles against `Date.now()` and decides
 * what that was worth. That split is what keeps a throttled or suspended worker from ever
 * costing the player anything: the worker changes how *smoothly* progress lands, never how
 * *much*, because the amount always comes from the wall clock.
 *
 * Each beat carries the sequence number and the time it was due, so the main thread can
 * measure drift and count beats the browser swallowed — that telemetry is what the
 * showcase puts on screen as proof the background path is alive.
 */

let timer = null;
let seq = 0;
let startedAt = 0;
let intervalMs = 1000;

function beat() {
  seq++;
  const at = Date.now();
  self.postMessage({
    type: 'beat',
    seq,
    at,
    /** When this beat was due, so the receiver can measure throttling without guessing. */
    dueAt: startedAt + seq * intervalMs,
    intervalMs,
  });
}

self.onmessage = (e) => {
  const msg = e.data ?? {};
  switch (msg.type) {
    case 'start': {
      clearInterval(timer);
      intervalMs = Math.max(50, Number(msg.intervalMs) || 1000);
      startedAt = Date.now();
      seq = 0;
      timer = setInterval(beat, intervalMs);
      self.postMessage({ type: 'started', at: startedAt, intervalMs });
      break;
    }
    case 'stop':
      clearInterval(timer);
      timer = null;
      self.postMessage({ type: 'stopped', at: Date.now(), seq });
      break;
    case 'ping':
      // Liveness on demand: the main thread uses this to tell "the worker is throttled"
      // apart from "the worker is dead" before it gives up and falls back to a timer.
      self.postMessage({ type: 'pong', at: Date.now(), seq, echo: msg.echo ?? null });
      break;
    default:
      break;
  }
};
