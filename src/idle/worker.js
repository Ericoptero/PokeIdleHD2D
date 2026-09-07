/**
 * Heartbeat. A worker's setInterval survives background throttling far better than the
 * main thread's, so this is what keeps the idle loop honest when the player switches tabs.
 * It carries no game state — it only says "time passed"; the main thread reads the clock.
 */
let timer = null;
self.onmessage = (e) => {
  const { type, intervalMs = 1000 } = e.data ?? {};
  if (type === 'start') {
    clearInterval(timer);
    timer = setInterval(() => self.postMessage({ type: 'beat', at: Date.now() }), intervalMs);
  } else if (type === 'stop') {
    clearInterval(timer); timer = null;
  }
};
