/**
 * The start menu (Stage 9) — the spine of the whole UI, and the only panel that opens without
 * a key of its own. Replaces `panels/menu.js`, keeping its one defining trait: **a column on
 * the right, not a modal in the middle** — "the city stays readable behind it while the player
 * picks" (that file's own header). Every other screen this migration built uses the opaque
 * `.ci-offline-scrim` card; this is the one deliberate exception, so it gets its own
 * transparent click-catcher (`.ci-menu-scrim`, `background: transparent`) instead — present
 * only to close the menu on an outside click, never to dim the world.
 */
import { h } from '../dom/el.js';
import { icon } from '../dom/icons.js';

const ITEMS = [
  { id: 'travel', label: 'Travel', blurb: 'The city and four hunts.', icon: 'map' },
  { id: 'party', label: 'Party', blurb: 'Who leads, and the bench.', icon: 'person' },
  { id: 'trainer', label: 'Trainer', blurb: 'Level, buffs, upgrades and the dex.', icon: 'person' },
  { id: 'shop', label: 'Shop', blurb: 'Four shops and the deal.', icon: 'shop' },
  { id: 'boxes', label: 'Boxes', blurb: '960 slots, ten orders.', icon: 'backpack' },
  { id: 'dex', label: 'Dex', blurb: 'By generation and type.', icon: 'eye' },
  { id: 'automation', label: 'Auto', blurb: 'What the party does on its own.', icon: 'auto-mode' },
  { id: 'away', label: 'Report', blurb: 'The last away card.', icon: 'bedtime' },
];

export function makeMenuDomScreen(app, domLayer) {
  let root = null;
  let col = null;

  function choose(id) {
    if (id === 'away') { app.openReport(); return; }
    app.open(id);
  }

  function clearHud() {
    const y = app.hudTopBottom?.();
    col.style.top = y != null ? `${Math.round(y) + 12}px` : '18px';
  }

  function render() {
    col = h('nav', { class: 'ci-menu-col', 'data-ui': 'menu-col' }, [
      h('div', { class: 'ci-menu-head' }, [icon('menu', { size: 16 }), h('span', {}, 'Menu')]),
      ...ITEMS.map((item) => h('button', {
        type: 'button', class: 'ci-menu-row', 'data-ui': `menu-${item.id}`, onClick: () => choose(item.id),
      }, [
        icon(item.icon, { size: 18 }),
        h('div', { class: 'ci-menu-row__text' }, [
          h('span', { class: 'ci-menu-row__label' }, item.label),
          h('span', { class: 'ci-menu-row__blurb' }, item.blurb),
        ]),
      ])),
      h('button', {
        type: 'button', class: 'ci-menu-row ci-menu-row--close', 'data-ui': 'menu-close', onClick: () => app.close(),
      }, [icon('close', { size: 18 }), h('span', { class: 'ci-menu-row__label' }, 'Close')]),
    ]);
    clearHud();
    return h('div', { class: 'ci-menu-scrim', 'data-ui': 'menu-scrim', onClick: () => app.close() }, [col]);
  }

  return {
    id: 'menu',
    open() {
      root = render();
      // The column swallows its own clicks so they never reach the scrim behind it — the
      // scrim's own onClick is only ever reached by a click on the transparent gap around it.
      root.firstChild.addEventListener('click', (ev) => ev.stopPropagation());
      domLayer.host.appendChild(root);
    },
    close() { root?.remove(); root = null; },
    key(ev) {
      if (ev.code === 'Escape' || ev.code === 'KeyX') { app.close(); return true; }
      return false;
    },
    draw() { return null; },
  };
}
