// @ts-check
/**
 * Module registry with failure isolation (ARCHITECTURE §2.1).
 *
 * The load-bearing rule of this project: one broken module must never take the game down.
 * Other agents are screenshotting the dev server continuously, so a module that throws in
 * `init` gets quarantined and replaced by a null object, and the frame loop keeps running
 * with everything else intact.
 */

/**
 * What every `src/<module>/index.js` default-exports. `id` and `init` are required (seams rule
 * 3); the rest are the hooks the registry will call if present.
 * @typedef {object} ModuleDescriptor
 * @property {string} id
 * @property {string[]} [needs]
 * @property {string[]} [showcaseNeeds]
 * @property {(ctx: any) => any} [init]
 * @property {(mode: string, ctx: any) => any} [showcase]
 * @property {(dt: number, ctx: any) => void} [tick]
 * @property {(dt: number, alpha: number, ctx: any) => void} [frame]
 * @property {(dt: number, alpha: number, ctx: any) => void} [lateFrame]
 * @property {() => void} [dispose]  called with no arguments, in reverse init order
 */

const NULL_WARNED = new Set();

/**
 * Stands in for a quarantined module's API. Every property reads as a no-op function so
 * callers that forgot to check `status()` degrade instead of cascading.
 */
function nullObject(id, report) {
  const noop = () => undefined;
  return new Proxy(Object.assign(noop, { __missing: id }), {
    get(_t, prop) {
      if (prop === '__missing') return id;
      if (prop === 'then') return undefined;            // never look like a promise
      if (prop === Symbol.toPrimitive || prop === Symbol.toStringTag) return undefined;
      const key = `${id}.${String(prop)}`;
      if (!NULL_WARNED.has(key)) {
        NULL_WARNED.add(key);
        report(`module "${id}" is unavailable; ignoring call to ${key}`);
      }
      return noop;
    },
    apply: () => undefined,
  });
}

export function makeRegistry({ bus, log }) {
  /** @type {Map<string, {desc:ModuleDescriptor, status:string, api:any, error:Error|null, initMs:number}>} */
  const mods = new Map();
  const order = [];

  /** @param {ModuleDescriptor} desc */
  function add(desc) {
    if (!desc?.id) throw new Error('registry.add: descriptor needs an id');
    if (mods.has(desc.id)) throw new Error(`registry.add: duplicate module "${desc.id}"`);
    mods.set(desc.id, { desc, status: 'registered', api: null, error: null, initMs: 0 });
  }

  /**
   * @param {string} id
   * @param {Error} err
   * @param {string} phase
   * @param {{deliberate?: boolean}} [opts] `deliberate`: the break was *asked for* (`?break=`),
   *   so it is reported at `warn`. A handled path may not spend §7's zero-console-error budget,
   *   and a quarantine the URL requested is the most handled path there is.
   */
  function fail(id, err, phase, { deliberate = false } = {}) {
    const rec = mods.get(id);
    if (!rec) return;
    if (rec.status !== 'failed') {
      rec.status = 'failed';
      rec.error = err;
      rec.api = nullObject(id, (m) => log.warn(m));
      if (deliberate) log.warn(`[${id}] quarantined on purpose by ?break= — ${err?.message ?? err}`);
      else log.error(`[${id}] ${phase} failed — module quarantined`, err);
      bus.emit('module:failed', { id, phase, error: String(err?.message ?? err), stack: err?.stack });
      // Anything downstream of a failed module cannot be trusted either.
      for (const [otherId, other] of mods) {
        if (other.status === 'registered' && other.desc.needs?.includes(id)) {
          other.status = 'blocked';
          other.api = nullObject(otherId, (m) => log.warn(m));
          log.warn(`[${otherId}] blocked: depends on failed module "${id}"`);
        }
      }
    }
  }

  /** Kahn topological sort; a cycle disables only the modules inside it. */
  function resolveOrder() {
    const ids = [...mods.keys()];
    const indeg = new Map(ids.map((id) => [id, 0]));
    for (const id of ids) {
      for (const need of mods.get(id).desc.needs ?? []) {
        if (!mods.has(need)) {
          // Ignored *here* — it cannot contribute an in-degree if it does not exist — but
          // `init` will still block the module, because a need nothing provides is a need
          // that is not met. Say so, or the log promises a boot that will not happen.
          log.warn(`[${id}] declares unknown dependency "${need}" — ${id} will be blocked`);
          continue;
        }
        indeg.set(id, indeg.get(id) + 1);
      }
    }
    const queue = ids.filter((id) => indeg.get(id) === 0).sort();
    const out = [];
    while (queue.length) {
      const id = queue.shift();
      out.push(id);
      for (const other of ids) {
        if ((mods.get(other).desc.needs ?? []).includes(id)) {
          indeg.set(other, indeg.get(other) - 1);
          if (indeg.get(other) === 0) queue.push(other);
        }
      }
      queue.sort();
    }
    const cyclic = ids.filter((id) => !out.includes(id));
    for (const id of cyclic) {
      fail(id, new Error(`dependency cycle involving "${id}"`), 'resolve');
    }
    return out;
  }

  async function init(ctx, { only = null } = {}) {
    const wanted = only ? closure(only) : null;
    // `?break=economy,idle` — the diagnostic that makes failure isolation photographable. The
    // module is failed *instead of* being initialised, so its dependents block down the same
    // path a real throw takes rather than down a second one written for the test.
    const broken = new Set(
      String(ctx?.config?.get?.('break') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    );
    for (const id of resolveOrder()) {
      const rec = mods.get(id);
      if (wanted && !wanted.has(id)) { rec.status = 'skipped'; rec.api = nullObject(id, () => {}); continue; }
      if (rec.status !== 'registered') continue;
      if (broken.has(id)) { fail(id, new Error(`?break=${id}`), 'init', { deliberate: true }); continue; }
      const missing = (rec.desc.needs ?? []).find((n) => mods.get(n)?.status !== 'ready');
      if (missing) {
        rec.status = 'blocked';
        rec.api = nullObject(id, (m) => log.warn(m));
        log.warn(`[${id}] blocked: dependency "${missing}" is not ready`);
        continue;
      }
      const t0 = performance.now();
      try {
        rec.api = (await rec.desc.init(ctx)) ?? {};
        rec.status = 'ready';
        rec.initMs = performance.now() - t0;
        order.push(id);
      } catch (err) {
        rec.initMs = performance.now() - t0;
        fail(id, err, 'init');
      }
    }
  }

  /** All modules `ids` transitively need, plus `ids` themselves. */
  function closure(ids) {
    const out = new Set();
    const walk = (id) => {
      if (out.has(id) || !mods.has(id)) return;
      out.add(id);
      for (const n of mods.get(id).desc.needs ?? []) walk(n);
    };
    for (const id of [].concat(ids)) walk(id);
    return out;
  }

  function run(hook, ...args) {
    for (const id of order) {
      const rec = mods.get(id);
      if (rec.status !== 'ready') continue;
      const fn = rec.desc[hook];
      if (!fn) continue;
      try {
        fn(...args);
      } catch (err) {
        fail(id, err, hook);
      }
    }
  }

  return {
    add,
    init,
    closure,
    tick: (dt, ctx) => run('tick', dt, ctx),
    frame: (dt, alpha, ctx) => run('frame', dt, alpha, ctx),
    /**
     * After the camera has been placed for this frame, before anything is drawn.
     *
     * For work that has to read the camera the frame will actually render with. `frame` runs
     * before `makeCameraRig.update()` — it has to, because that is where the focus is set —
     * so anything reading `camera.matrixWorld` from `frame` gets last frame's.
     */
    lateFrame: (dt, alpha, ctx) => run('lateFrame', dt, alpha, ctx),
    get(id) {
      const rec = mods.get(id);
      if (!rec) {
        const key = `missing:${id}`;
        if (!NULL_WARNED.has(key)) { NULL_WARNED.add(key); log.warn(`ctx.get("${id}"): no such module`); }
        return nullObject(id, () => {});
      }
      return rec.api ?? nullObject(id, (m) => log.warn(m));
    },
    has: (id) => mods.get(id)?.status === 'ready',
    descriptor: (id) => mods.get(id)?.desc ?? null,
    async showcase(id, mode, ctx) {
      const rec = mods.get(id);
      if (!rec) throw new Error(`showcase: no module "${id}"`);
      if (rec.status !== 'ready') throw new Error(`showcase: module "${id}" is ${rec.status}`);
      if (!rec.desc.showcase) throw new Error(`showcase: module "${id}" has no showcase()`);
      try {
        await rec.desc.showcase(mode, ctx);
      } catch (err) {
        fail(id, err, 'showcase');
        throw err;
      }
    },
    status: () => [...mods.entries()].map(([id, r]) => ({
      id, status: r.status, initMs: +r.initMs.toFixed(1),
      error: r.error ? String(r.error.message ?? r.error) : null,
    })),
    dispose() {
      for (const id of [...order].reverse()) {
        try { mods.get(id).desc.dispose?.(); } catch (err) { log.error(`[${id}] dispose failed`, err); }
      }
      order.length = 0;
    },
  };
}
