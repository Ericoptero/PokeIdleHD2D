/**
 * Pointer-based drag-to-reorder for the Códice DOM screens — the party list first
 * (`dom/hud.js`, Stage 3), then the automation rule list, the route queue and the trainer's
 * team order (Stage 6).
 *
 * **A deliberate departure from the plan's own suggestion** to wrap `../gesture.js`'s pure
 * drag/drop reducer: that reducer exists to survive `screen.js`'s `regions = []` reset every
 * canvas `paint()` — there is no DOM equivalent to survive, a DOM node is not rebuilt every
 * frame, and the browser already answers "what is under the pointer right now"
 * (`elementFromPoint`) without the tag/payload indirection `gesture.js` needs to answer the
 * same question on a canvas with no hit-testing of its own. Reusing it here would be
 * indirection in service of a problem this layer does not have.
 *
 * The interaction is deliberately plain: no floating ghost element, just the dragged item
 * dimmed in place and the item under the pointer outlined as the drop target — released over
 * its own start index is a click, released over a different one is a reorder, released
 * nowhere valid is a cancel. Touch works today because Pointer Events unify mouse and touch,
 * but nothing here yet accounts for a touch's own scroll gesture (`touch-action: none` on the
 * handle is the whole of it) — the fuller mobile pass is Stage 8.
 */

/**
 * @param {object} opts
 * @param {() => HTMLElement[]} opts.elements - the draggable elements, in index order, read
 *   fresh on every drag start (so a list that reflows between drags — a party member added or
 *   removed — is never stale).
 * @param {(from:number, to:number) => void} opts.onReorder
 * @param {(index:number) => void} [opts.onClick] - a press-and-release with no reorder
 * @param {string} [opts.dragClass]
 * @param {string} [opts.overClass]
 * @returns {{ bind(el:HTMLElement, index:number): void, dispose(): void }}
 */
export function makeDragReorder({
  elements, onReorder, onClick, dragClass = 'ci-dragging', overClass = 'ci-drag-over',
}) {
  let fromIndex = null;
  let overIndex = null;
  let fromEl = null;
  const teardown = [];

  function clearOver() {
    if (overIndex == null) return;
    elements()[overIndex]?.classList.remove(overClass);
    overIndex = null;
  }

  function onPointerMove(ev) {
    if (fromIndex == null) return;
    const list = elements();
    const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-drag-index]');
    const idx = under ? list.indexOf(under) : -1;
    if (idx === overIndex) return;
    clearOver();
    if (idx >= 0 && idx < list.length) {
      overIndex = idx;
      list[overIndex].classList.add(overClass);
    }
  }

  function onPointerUp() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    fromEl?.classList.remove(dragClass);
    const from = fromIndex;
    const to = overIndex;
    clearOver();
    fromIndex = null;
    fromEl = null;
    if (from == null) return;
    if (to == null || to === from) onClick?.(from);
    else onReorder(from, to);
  }

  function onPointerDown(ev, index) {
    // A plain click still has to reach a button inside the row (a "more" affordance, say);
    // only the primary button starts a drag.
    if (ev.button !== 0) return;
    ev.preventDefault();
    fromIndex = index;
    fromEl = elements()[index];
    fromEl?.classList.add(dragClass);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  return {
    /** Called once per element each time the list is (re)rendered — cheap, and idempotent
     *  enough that re-binding an element already bound just replaces its own listener. */
    bind(el, index) {
      el.dataset.dragIndex = String(index);
      el.style.touchAction = 'none';
      el.onpointerdown = (ev) => onPointerDown(ev, index);
    },
    dispose() {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      for (const off of teardown) off();
    },
  };
}
