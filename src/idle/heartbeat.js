/**
 * heartbeat.js — keeping a pulse when the tab is not being drawn.
 *
 * Three transports, in order of preference:
 *
 *   worker    a dedicated worker's `setInterval`. Survives background throttling far
 *             better than the main thread and is the reason accrual feels live when the
 *             player comes back to the tab.
 *   timer     a plain `setInterval`. Used when workers are unavailable (a sandboxed
 *             iframe, a blocked blob URL) or when the worker has gone silent.
 *   frame     no timer at all — the frame loop still calls `pump()`, so a visible tab
 *             keeps working even if both of the above are gone.
 *
 * One subtlety worth spelling out: liveness is measured on `performance.now()`, never on
 * the wall clock. The wall clock legitimately jumps — an NTP correction, a laptop waking,
 * or this module's own diagnostic time travel — and a jump would otherwise look exactly
 * like a worker that had died, and swap a perfectly healthy worker for a timer.
 *
 * None of them is trusted for *how much* time passed. Every beat only triggers a
 * reconciliation against `Date.now()`. A missed beat, a throttled worker, a suspended
 * laptop and a clock that jumps all end up in the same place: the next reconciliation
 * measures the real elapsed wall time and the gap is drained. The heartbeat exists to make
 * progress land smoothly and to keep it landing while backgrounded, not to be the clock.
 */

const DEAD_AFTER_MULTIPLIER = 6;

/**
 * @param {Object} opts
 * @param {number} opts.intervalMs
 * @param {() => void} opts.onBeat        called for every beat, from any transport
 * @param {{warn:Function, info:Function}} opts.log
 * @param {boolean} [opts.allowWorker]
 */
export function makeHeartbeat({ intervalMs = 1000, onBeat, log, allowWorker = true }) {
  /** Monotonic, immune to wall-clock jumps. Liveness questions are asked of this only. */
  const since = () => performance.now();
  let worker = null;
  let timer = null;
  let transport = 'frame';
  let disposed = false;

  const stats = {
    beats: 0,
    /** Beats the browser never delivered, inferred from the worker's own sequence numbers. */
    missed: 0,
    /** Milliseconds between when a beat was due and when it arrived. */
    lastDriftMs: 0,
    maxDriftMs: 0,
    lastBeatMs: 0,
    startedMs: since(),
    workerErrors: 0,
    fallbacks: 0,
    lastSeq: 0,
  };

  function fire(meta) {
    stats.beats++;
    stats.lastBeatMs = since();
    if (meta?.dueAt != null) {
      const drift = Math.max(0, meta.at - meta.dueAt);
      stats.lastDriftMs = drift;
      if (drift > stats.maxDriftMs) stats.maxDriftMs = drift;
    }
    if (meta?.seq != null) {
      // The worker numbers its own beats, so anything the browser dropped on the way
      // shows up here as a hole rather than as silence.
      if (stats.lastSeq && meta.seq > stats.lastSeq + 1) stats.missed += meta.seq - stats.lastSeq - 1;
      stats.lastSeq = meta.seq;
    }
    try { onBeat(); } catch (err) { log?.warn?.('idle: heartbeat listener threw', err); }
  }

  function startTimer(reason) {
    if (timer != null) return;
    stats.fallbacks++;
    transport = 'timer';
    timer = setInterval(() => fire(null), intervalMs);
    log?.info?.(`idle: heartbeat on a main-thread timer (${reason})`);
  }

  function startWorker() {
    if (!allowWorker || typeof Worker === 'undefined') { startTimer('workers unavailable'); return; }
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const msg = e.data ?? {};
        if (msg.type === 'beat') { transport = 'worker'; fire(msg); }
      };
      worker.onerror = (err) => {
        stats.workerErrors++;
        // A worker that fails at runtime must not take the module down: fall back and
        // keep the game accruing. This is logged as a warning, not an error, because the
        // player has lost nothing — reconciliation still measures the real elapsed time.
        log?.warn?.('idle: heartbeat worker failed, falling back to a timer', err?.message ?? err);
        try { worker.terminate(); } catch { /* already gone */ }
        worker = null;
        startTimer('worker error');
      };
      worker.postMessage({ type: 'start', intervalMs });
      transport = 'worker';
    } catch (err) {
      log?.warn?.('idle: could not start the heartbeat worker', err?.message ?? err);
      worker = null;
      startTimer('worker construction failed');
    }
  }

  startWorker();

  return {
    /** 'worker' | 'timer' | 'frame' */
    get transport() { return transport; },
    intervalMs,
    stats: () => ({ ...stats, transport, intervalMs, ageMs: since() - stats.startedMs }),

    /**
     * Called from the frame loop. Notices a heartbeat that has gone quiet while the tab is
     * visible — the one case where silence is definitely a fault rather than throttling —
     * and swaps transports. A hidden tab is never judged: being throttled is the whole
     * situation this module exists for.
     */
    check(hidden) {
      if (disposed || hidden) return;
      const quietFor = since() - (stats.lastBeatMs || stats.startedMs);
      if (quietFor > intervalMs * DEAD_AFTER_MULTIPLIER && transport !== 'timer') {
        if (worker) { try { worker.terminate(); } catch { /* already gone */ } worker = null; }
        startTimer(`no beat for ${Math.round(quietFor)}ms`);
      }
    },

    dispose() {
      disposed = true;
      if (worker) { try { worker.postMessage({ type: 'stop' }); worker.terminate(); } catch { /* already gone */ } }
      worker = null;
      clearInterval(timer);
      timer = null;
      transport = 'frame';
    },
  };
}
