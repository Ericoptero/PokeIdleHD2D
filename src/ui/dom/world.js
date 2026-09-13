/**
 * The world-anchor sub-layer of `#ui-dom` — the mount point for anything positioned against a
 * 3-D world point rather than the screen: nameplates (`../plates.js`), battle balloons
 * (`../callout.js`) and damage floaters (`../floaters.js`). All three used to live on the
 * bitmap-font HUD canvas (`../screen.js`) because nobody had built the DOM/world-projection
 * bridge for them yet; `ui/index.js`'s own `projectClient()` is that bridge (real, viewport
 * CSS pixels off `view.displayRect`, the same rect the scene canvas itself sits at — not
 * `screen.js`'s internal, letterboxed buffer), and this is where its output lands.
 *
 * Mounted as `domLayer.host`'s FIRST child, before any screen/toast/dialogue is appended —
 * `dom/layer.js`'s own stacking order puts later-appended children visually on top, and a
 * plate under a card the player opened has always read as wrong (`ui/index.js`'s own
 * `platesShow` gate already refuses to draw one under most panels for exactly this reason).
 *
 * Every child here is `position: absolute; pointer-events: none` (`world.css`) — nothing drawn
 * against the world has ever been interactive (`screen.js`'s own header makes the same point
 * about its canvas), and `#ui-dom` itself is already `pointer-events: none` at the root
 * (`base.css`), so this only exists to keep the rule explicit at the layer that would break it
 * first if a future balloon ever grew a button.
 *
 * **`plates`/`balloons`/`floaters` are each fully owned by one `syncList` caller** (`plates.js`
 * /`callout.js`/`floaters.js`), which replaces the container's whole content — including
 * `container.replaceChildren()` on the "nothing to show" path — whenever it has nothing live.
 * Anything else mounted into one of those three would be silently wiped the next time its
 * owner has an empty frame (measured: the capture tooltip, `dom/capture.js`, briefly shared
 * `balloons` and vanished the instant the last battle balloon expired). The fourth container,
 * `capture`, exists for exactly that reason: anything interactive that is not list-synced gets
 * its own container, never one of the three above.
 */
import { h } from './el.js';

/**
 * @param {{host: HTMLElement}} domLayer `dom/layer.js`'s own return value.
 * @returns {{plates: HTMLElement, balloons: HTMLElement, floaters: HTMLElement,
 *   capture: HTMLElement, dispose: Function}}
 *   Four containers, in paint order — plates, then balloons over them, then floaters, then the
 *   capture tooltip last and topmost (the one interactive thing here, `ui/index.js`'s own
 *   `draw()` comment on the paint order beneath it).
 */
export function makeWorldLayer(domLayer) {
  const plates = h('div', { class: 'ci-world-layer', 'data-ui': 'world-plates' });
  const balloons = h('div', { class: 'ci-world-layer', 'data-ui': 'world-balloons' });
  const floaters = h('div', { class: 'ci-world-layer', 'data-ui': 'world-floaters' });
  const capture = h('div', { class: 'ci-world-layer', 'data-ui': 'world-capture' });
  const host = h('div', { id: 'ui-dom-world' }, [plates, balloons, floaters, capture]);
  domLayer.host.insertBefore(host, domLayer.host.firstChild);
  return {
    plates, balloons, floaters, capture,
    dispose() { host.remove(); },
  };
}
