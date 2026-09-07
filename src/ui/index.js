/**
 * ui — HUD, panels and the debug overlay (ARCHITECTURE §5.12).
 *
 * A DOM overlay at full resolution rather than a WebGL layer: text stays crisp next to a
 * deliberately chunky scene, which is how the reference games do it too. SEED — the `ui`
 * builder owns the visual design.
 */

export default {
  id: 'ui',
  needs: [],

  init(ctx) {
    const root = document.getElementById('ui');
    const { config, bus } = ctx;

    const style = document.createElement('style');
    style.textContent = `
      .hud { position:absolute; top:12px; left:12px; display:flex; gap:8px; align-items:center;
        font: 600 12px/1 ui-monospace, Menlo, monospace; letter-spacing:.06em; }
      .chip { background:rgba(8,12,20,.72); border:1px solid rgba(140,180,230,.18);
        border-radius:6px; padding:7px 10px; color:#dce8f6; backdrop-filter:blur(6px); }
      .toast { position:absolute; left:50%; bottom:48px; transform:translateX(-50%);
        background:rgba(8,12,20,.86); border:1px solid rgba(140,180,230,.22); border-radius:8px;
        padding:9px 14px; color:#eaf2fb; font:600 12px ui-monospace, Menlo, monospace;
        opacity:0; transition:opacity .25s; }
      .toast.show { opacity:1; }
      .debug { position:absolute; top:12px; right:12px; background:rgba(6,9,15,.82);
        border:1px solid rgba(140,180,230,.16); border-radius:6px; padding:9px 11px;
        font:11px/1.55 ui-monospace, Menlo, monospace; color:#a8c4e0; white-space:pre;
        min-width:190px; }
      .debug b { color:#eaf2fb; font-weight:600; }
      .debug .bad { color:#ff8f8f; }
    `;
    document.head.appendChild(style);

    const hud = document.createElement('div');
    hud.className = 'hud';
    const money = document.createElement('div'); money.className = 'chip'; money.textContent = '₽ 0';
    const clock = document.createElement('div'); clock.className = 'chip'; clock.textContent = '--:--';
    hud.append(money, clock);
    root.appendChild(hud);

    const toast = document.createElement('div');
    toast.className = 'toast';
    root.appendChild(toast);
    let toastTimer = null;

    const debug = document.createElement('div');
    debug.className = 'debug';
    debug.style.display = config.debug ? 'block' : 'none';
    root.appendChild(debug);

    bus.on('economy:changed', ({ total }) => { money.textContent = `₽ ${Math.floor(total).toLocaleString()}`; });
    bus.on('ui:toast', ({ text }) => {
      toast.textContent = text;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
    });

    addEventListener('keydown', (e) => {
      if (e.key === '`') { config.set({ debug: !config.debug }); debug.style.display = config.debug ? 'block' : 'none'; }
    });

    let acc = 0;
    return {
      toast: (text, kind = 'info') => bus.emit('ui:toast', { text, kind }),
      _frame(dt) {
        acc += dt;
        if (acc < 0.25) return;
        acc = 0;
        const env = ctx.get('environment');
        const tod = env.getTimeOfDay?.() ?? 0;
        const hh = String(Math.floor(tod)).padStart(2, '0');
        const mm = String(Math.floor((tod % 1) * 60)).padStart(2, '0');
        clock.textContent = `${hh}:${mm}`;
        if (!config.debug) return;
        const m = window.__HOOKS__?.metrics?.();
        if (!m) return;
        const failed = m.modules.filter((s) => s.status !== 'ready' && s.status !== 'skipped');
        debug.innerHTML =
          `<b>${m.fps.mean} fps</b>  p95 ${m.fps.p95ms}ms\n` +
          `draws <b>${m.drawCalls}</b>  tris ${(m.triangles / 1000).toFixed(0)}k\n` +
          `buffer ${m.internal?.join('x')} -> ${m.output?.join('x')}\n` +
          `tod ${tod.toFixed(2)}  seed ${m.seed}\n` +
          (failed.length ? `<span class="bad">down: ${failed.map((f) => f.id).join(', ')}</span>\n` : '') +
          (m.consoleErrors.length ? `<span class="bad">${m.consoleErrors.length} errors</span>` : 'no errors');
      },
    };
  },

  frame(dt, alpha, ctx) { ctx.get('ui')._frame?.(dt); },

  async showcase(mode, ctx) { ctx.get('ui').toast?.('ui showcase'); },
};
