/**
 * A tiny hyperscript helper for the Códice DOM screens — enough to build and patch static
 * trees by hand, not a virtual-DOM diffing library. `../index.js`'s existing coarse
 * `update()`-per-screen model (see its own top comment) means nothing here needs to be fast
 * at scale; it needs to never destroy focus, scroll position or an in-flight drag, which is
 * the one rule `innerHTML =` on a live subtree breaks.
 */

/**
 * @param {string} tag
 * @param {object} [props] `class`, `style` (an object, not a string), `data-*`/plain
 *   attributes, `onClick`/`onInput`/… event handlers, `html` (a small, trusted, static
 *   fragment only — never user or game text), and boolean attributes (`disabled: true`).
 * @param {Array|Node|string|number} [children]
 */
export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && value && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'html') el.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (typeof value === 'boolean') {
      if (value) el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child == null || child === false) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Replaces `el`'s text content in place — the one safe use of a blanket write, since a text
 *  node holds neither focus nor a drag. */
export function setText(el, text) {
  const s = String(text ?? '');
  if (el.textContent !== s) el.textContent = s;
}

/**
 * Reconciles `container`'s children against `items` by key, reusing existing nodes rather
 * than rebuilding the list — the one thing `innerHTML =` cannot do, and the reason a
 * variable-length list (a bag grid, a rule list, a route queue) needs this instead of it.
 *
 * @param {HTMLElement} container
 * @param {Array} items
 * @param {(item: any) => string|number} keyFn
 * @param {(item: any) => HTMLElement} createFn called once per new key
 * @param {(node: HTMLElement, item: any) => void} updateFn called every pass, new node included
 */
export function syncList(container, items, keyFn, createFn, updateFn) {
  const existing = new Map();
  for (const child of [...container.children]) {
    if (child.dataset && child.dataset.key != null) existing.set(child.dataset.key, child);
  }
  let after = null;
  for (const item of items) {
    const key = String(keyFn(item));
    let node = existing.get(key);
    if (node) {
      existing.delete(key);
    } else {
      node = createFn(item);
      node.dataset.key = key;
    }
    const wantsToFollow = after ? after.nextElementSibling : container.firstElementChild;
    if (wantsToFollow !== node) {
      container.insertBefore(node, after ? after.nextSibling : container.firstChild);
    }
    updateFn(node, item);
    after = node;
  }
  for (const leftover of existing.values()) leftover.remove();
}
