// @ts-check
/**
 * The pointer layer's pure half: a drag/drop reducer and the scroll-offset clamp.
 *
 * `screen.js` needs a gesture state that survives the `regions = []` reset every `paint()`
 * does, keyed by **what was picked up** rather than by the rectangle it was drawn in — a
 * rectangle is meaningless the instant the next frame moves it. That state machine is pulled out here, pure and DOM-free, so `ui/selftest.js`
 * can run it under plain Node the same way it already runs `panels/battle.js`'s transcript
 * formatter (`lineFor`/`STATUS_NAME`) and `evolution.js`'s keyframe generator.
 *
 * No `Math.random()` — a gesture reducer needs none (`tools/seams/run.js` rule 1 forbids it
 * everywhere in `src/` regardless).
 */

/**
 * A live drag: `{phase:'drag', tag, payload, x, y}`. `x, y` are the pointer's own position in
 * UI buffer pixels, moved by `move()` — not the dragged thing's rectangle, which this module
 * never sees.
 * @typedef {{phase:string, tag:string, payload:*, x:number, y:number}} DragState
 */

/**
 * Picks up a payload. The origin point defaults to `0,0` because a caller that only cares
 * about the payload/tag (a unit test, say) should not have to invent a point.
 * @param {*} payload
 * @param {string} tag
 * @param {number} [x]
 * @param {number} [y]
 * @returns {DragState}
 */
export function startDrag(payload, tag, x = 0, y = 0) {
  return { phase: 'drag', tag, payload, x, y };
}

/**
 * Moves a live drag by a pixel delta (not to an absolute point): `screen.js` only ever knows
 * how far the pointer moved since the last frame it saw, not where the drag "should" be.
 * A cancelled/absent drag (`state` is `null`) passes through unchanged, so a caller does not
 * have to guard every `pointermove` on whether a drag is actually in flight.
 * @param {DragState|null} state
 * @param {number} dx
 * @param {number} dy
 * @returns {DragState|null}
 */
export function move(state, dx, dy) {
  if (!state) return state;
  return { ...state, x: state.x + dx, y: state.y + dy };
}

/**
 * Ends a drag over `target` (the region it was released on, or `null` if it was released
 * somewhere that accepts nothing). Releasing over nothing is a cancel, not a no-op drop — the
 * dragged thing goes back where it came from, so the state does not survive it either.
 * @param {DragState|null} state
 * @param {*} target truthy iff a `drop` region under the release point accepted this payload
 * @returns {DragState|null} the finished state (`phase:'drop'`) if `target` is truthy, else `null`
 */
export function drop(state, target) {
  if (!state || !target) return null;
  return { ...state, phase: 'drop' };
}

/**
 * A `pointercancel` (the OS took the pointer away — an alt-tab, a touch that left the screen)
 * always discards the gesture, regardless of how far it had moved or what `state` was.
 * Takes `state` only so a call site reads the same as `move`/`drop` do; nothing here reads it.
 * @param {DragState|null} state
 * @returns {null}
 */
export function cancel(state) {
  void state;
  return null;
}

/**
 * Clamps a scroll offset to `[0, max(0, contentSize - viewSize)]`.
 *
 * The single formula already covers the case that reads like a special one: when
 * `contentSize <= viewSize` there is nothing to scroll, `max` is `0`, and every offset clamps
 * to `0` — no separate branch needed, and so no separate branch to get wrong.
 * @param {number} offset
 * @param {number} contentSize
 * @param {number} viewSize
 * @returns {number}
 */
export function clampScroll(offset, contentSize, viewSize) {
  const max = Math.max(0, contentSize - viewSize);
  return Math.max(0, Math.min(max, offset));
}
