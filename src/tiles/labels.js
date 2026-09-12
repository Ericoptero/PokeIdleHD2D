/**
 * Showcase labels.
 *
 * The scene renders at `config.pixelScale` (640x360 internally at 1080p), which is right
 * for the art and hopeless for text: a 6-pixel-tall glyph upscaled 3x is a smudge. So the
 * labels are DOM, at full resolution, projected from world space every frame — the same
 * split the debug overlay uses (src/ui/index.js).
 */

import * as THREE from 'three';

const _v = new THREE.Vector3();

export function makeLabelOverlay(ctx) {
  const root = document.createElement('div');
  root.id = 'tiles-showcase-overlay';
  root.style.cssText = [
    'position:fixed', 'inset:0', 'pointer-events:none', 'z-index:40',
    'font:500 12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace',
    '-webkit-font-smoothing:antialiased',
  ].join(';');
  document.body.appendChild(root);

  const STYLES = {
    case: 'padding:1px 5px;border-radius:3px;background:rgba(6,10,16,.82);color:#dfe9f6;'
      + 'border:1px solid rgba(150,190,235,.28);font-size:11px;letter-spacing:.02em;white-space:nowrap',
    title: 'padding:3px 9px;border-radius:4px;background:rgba(6,10,16,.9);color:#ffd98a;'
      + 'border:1px solid rgba(255,217,138,.35);font-size:14px;font-weight:700;letter-spacing:.06em;white-space:nowrap',
    note: 'padding:1px 5px;border-radius:3px;background:rgba(60,14,14,.86);color:#ffb4b4;'
      + 'border:1px solid rgba(255,140,140,.4);font-size:11px;white-space:nowrap',
  };

  /** @type {{el:HTMLElement, x:number, y:number, z:number, dy:number}[]} */
  const items = [];

  /**
   * @param {string|[string,string]} text  a caption, or a [headline, sub-caption] pair
   */
  function add(text, x, y, z, kind = 'case', dy = 0) {
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;transform:translate(-50%,-100%);text-align:center;${STYLES[kind] ?? STYLES.case}`;
    if (Array.isArray(text)) {
      const head = document.createElement('div');
      head.textContent = text[0];
      const sub = document.createElement('div');
      sub.textContent = text[1];
      sub.style.cssText = 'font-size:10px;opacity:.62;letter-spacing:0';
      el.append(head, sub);
    } else {
      el.textContent = text;
    }
    root.appendChild(el);
    const item = { el, x, y, z, dy };
    items.push(item);
    return item;
  }

  /** A fixed block of text in a screen corner — the coverage readout lives here. */
  function panel(lines, { corner = 'top-left' } = {}) {
    const el = document.createElement('div');
    const [v, h] = corner.split('-');
    el.style.cssText = [
      'position:absolute', `${v}:14px`, `${h}:14px`, 'padding:10px 13px', 'border-radius:5px',
      'background:rgba(5,8,13,.86)', 'border:1px solid rgba(140,180,225,.25)',
      'color:#cfdcec', 'font-size:12px', 'line-height:1.5', 'white-space:pre',
      'max-height:calc(100vh - 28px)', 'overflow:hidden',
    ].join(';');
    el.textContent = Array.isArray(lines) ? lines.join('\n') : String(lines);
    root.appendChild(el);
    return el;
  }

  function update() {
    if (!items.length) return;
    const cam = ctx.three?.camera;
    const canvas = ctx.three?.renderer?.domElement;
    if (!cam || !canvas) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    for (const it of items) {
      _v.set(it.x, it.y, it.z).project(cam);
      const behind = _v.z > 1 || _v.z < -1;
      it.el.style.opacity = behind ? '0' : '1';
      if (behind) continue;
      it.el.style.left = `${((_v.x * 0.5 + 0.5) * w).toFixed(1)}px`;
      it.el.style.top = `${((-_v.y * 0.5 + 0.5) * h + it.dy).toFixed(1)}px`;
    }
  }

  function clear() {
    root.replaceChildren();
    items.length = 0;
  }

  return { root, add, panel, update, clear, count: () => items.length };
}
