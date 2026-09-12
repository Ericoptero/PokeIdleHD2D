/**
 * The window globals src/main.js installs for the harness (src/main.js) and the ones
 * modules hang diagnostics on. Type-checked files touch them through `window.__X__`.
 */
interface Window {
  /** True once the first real frame has been presented — or on a fatal boot, with __FATAL__ set. */
  __READY__?: boolean;
  __FATAL__?: string;
  /** The ctx every module received: registry, bus, clock, rng, config, log, three, get(id). */
  __CTX__?: any;
  /** Deterministic camera / time / seed / input control for tools/shots and tests/flows. */
  __HOOKS__?: any;
  __LOG__?: any;
  __IDLE__?: any;
  __ENVSHADOW__?: any;
  __ENVCASTERS__?: any;
}
