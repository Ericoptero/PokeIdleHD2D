/**
 * Three clocks, never conflated (ARCHITECTURE §2.4):
 *   frameDt  render-rate seconds, clamped so an alt-tab does not teleport the world
 *   simDt    fixed 1/20 s steps; the only time gameplay may advance by
 *   wallMs   Date.now(), for idle accrual and saves
 */
export const SIM_HZ = 20;
export const SIM_DT = 1 / SIM_HZ;
const MAX_FRAME_DT = 0.1;         // 10 fps floor; below that we slow down rather than skip
const MAX_STEPS_PER_FRAME = 8;    // keeps a long stall from spiralling

export function makeClock() {
  let last = performance.now();
  let accumulator = 0;
  let simTime = 0;
  let frames = 0;
  let paused = false;

  return {
    SIM_DT,
    get simTime() { return simTime; },
    get frames() { return frames; },
    get paused() { return paused; },
    pause() { paused = true; },
    resume() { paused = false; last = performance.now(); },
    wallMs: () => Date.now(),

    /**
     * Advances the clock one rendered frame.
     * @returns {{frameDt:number, steps:number, alpha:number}} `alpha` is the fraction of a
     *   sim step left over, for interpolating rendering between fixed steps.
     */
    beginFrame(now = performance.now()) {
      const raw = (now - last) / 1000;
      last = now;
      const frameDt = paused ? 0 : Math.min(Math.max(raw, 0), MAX_FRAME_DT);
      accumulator += frameDt;
      let steps = 0;
      while (accumulator >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
        accumulator -= SIM_DT;
        simTime += SIM_DT;
        steps++;
      }
      if (accumulator > SIM_DT * MAX_STEPS_PER_FRAME) accumulator = 0;   // give up, do not spiral
      frames++;
      return { frameDt, steps, alpha: accumulator / SIM_DT };
    },

    /** Runs `n` sim steps with no rendering — used by the deterministic step() hook. */
    forceSteps(n) {
      for (let i = 0; i < n; i++) simTime += SIM_DT;
      return n;
    },
  };
}
