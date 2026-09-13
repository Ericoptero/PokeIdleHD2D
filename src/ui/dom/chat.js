/**
 * The chat shell (Stage 3c) — a mockup of a **future** multiplayer chat, built at the user's
 * own explicit request ("implement a mockup to future multiplayer chat"), not a claim that
 * this single-player game has any networking today. It does not.
 *
 * **What is real and what is a placeholder, stated plainly so nobody mistakes one for the
 * other later:**
 *  - The panel, its tabs, the Enter-to-open/close binding, the input box and the send
 *    interaction are all real and fully wired.
 *  - World/Local/Guild's seeded lines (`SEED_MESSAGES` below) are placeholder content, in the
 *    same spirit as `showcase.js`'s own `SEED_CATCHES`/`SEED_ITEMS` — there is no other player
 *    anywhere in this codebase, so nothing populates these tabs at runtime; they exist to show
 *    what the panel will look like once a real backend exists.
 *  - Help's lines are the one tab that is **not** a placeholder — real, static reference text
 *    about this game's own controls, since a help tab needs no other player to be honest.
 *  - A line the player types is echoed locally (tagged "You"), never broadcast anywhere, and
 *    also emitted as `bus.emit('ui:said', {tab, text})` — a seam for a real chat module to
 *    pick up later, exactly the pattern the plan this was built from calls for. Nothing in
 *    `src/` currently listens for it, which is safe: `tools/seams/run.js` rule 8 only fails an
 *    event that is *listened for* with no emitter, never the reverse.
 *  - History is ephemeral — not part of the save (matches the plan's own "History is
 *    ephemeral, not saved").
 */
import { h } from './el.js';
import { icon } from './icons.js';

const TABS = [
  { id: 'world', label: 'World' },
  { id: 'local', label: 'Local' },
  { id: 'guild', label: 'Guild', dot: true },
  { id: 'help', label: 'Help' },
];

/** Placeholder content for World/Local/Guild — see this file's own header. Names are
 *  generic on purpose, not styled as anyone real. */
const SEED_MESSAGES = {
  world: [
    { from: 'Wren', text: 'anyone found a shiny yet today?' },
    { from: 'Bo', text: 'route 4 just opened up for me' },
  ],
  local: [
    { from: 'Sam', text: 'found something rare on the upper trail' },
    { from: 'Ivy', text: 'heading that way after this route' },
  ],
  guild: [
    { from: 'Guild', text: 'weekly reset is in 3 days' },
  ],
  help: null, // filled from REAL_HELP below — not a seed, not a placeholder.
};

/** Real, static reference text — this game's own controls, not a placeholder for anything. */
const REAL_HELP = [
  { from: 'Tip', text: 'WASD or the arrow keys walk; the game tells you when it can\'t.' },
  { from: 'Tip', text: 'T opens Travel, X opens the menu, Z interacts or confirms.' },
  { from: 'Tip', text: 'Your team fights on its own — check Automation to change the rules.' },
];

export function makeChat(domLayer, app, { minimal = false } = {}) {
  let barsFlag = true;
  let activeTab = 'world';
  /** @type {Record<string, {from:string, text:string}[]>} */
  const log = {
    world: [...SEED_MESSAGES.world],
    local: [...SEED_MESSAGES.local],
    guild: [...SEED_MESSAGES.guild],
    help: [...REAL_HELP],
  };

  const pill = h('button', {
    type: 'button', class: 'ci-chat-pill', 'data-ui': 'chat-pill', title: 'Press Enter to chat',
    onClick: () => open(),
  }, [icon('enter', { size: 14 }), h('span', {}, 'Enter to chat')]);

  const tabButtons = new Map();
  const tabsRow = h('div', { class: 'ci-chat-tabs' }, TABS.map((t) => {
    const btn = h('button', {
      type: 'button', class: 'ci-chat-tab', 'data-ui': `chat-tab-${t.id}`,
      onClick: () => selectTab(t.id),
    }, [t.label, t.dot ? h('span', { class: 'ci-chat-tab__dot' }) : null]);
    tabButtons.set(t.id, btn);
    return btn;
  }));

  const messages = h('div', { class: 'ci-chat-messages', 'data-ui': 'chat-messages' });
  const input = h('input', {
    type: 'text', class: 'ci-chat-input', 'data-ui': 'chat-input',
    placeholder: 'Type and press Enter…', maxlength: '140',
  });
  const sendBtn = h('button', {
    type: 'button', class: 'ci-chat-send', 'data-ui': 'chat-send', title: 'Send', onClick: () => send(),
  }, icon('send', { size: 16 }));

  const panel = h('div', { class: 'ci-chat-panel', 'data-ui': 'chat-panel', hidden: true }, [
    tabsRow,
    messages,
    h('div', { class: 'ci-chat-input-row' }, [input, sendBtn]),
  ]);

  const root = h('div', { class: 'ci-chat', 'data-ui': 'chat' }, [pill, panel]);
  domLayer.host.appendChild(root);

  function renderMessages() {
    messages.replaceChildren(...log[activeTab].map((m) => h('div', { class: 'ci-chat-line' }, [
      h('span', { class: 'ci-chat-line__from' }, `${m.from}:`),
      h('span', { class: 'ci-chat-line__text' }, ` ${m.text}`),
    ])));
    messages.scrollTop = messages.scrollHeight;
  }

  function selectTab(id) {
    activeTab = id;
    for (const [tid, btn] of tabButtons) btn.classList.toggle('ci-chat-tab--active', tid === id);
    renderMessages();
  }

  function open() {
    pill.hidden = true;
    panel.hidden = false;
    renderMessages();
    input.focus();
  }

  function close() {
    panel.hidden = true;
    pill.hidden = false;
    input.blur();
  }

  function send() {
    const text = input.value.trim();
    if (!text) { close(); return; }
    log[activeTab].push({ from: 'You', text });
    input.value = '';
    renderMessages();
    // The seam for a real backend — see this file's own header. Safe to emit with nothing
    // listening yet (`tools/seams/run.js` rule 8 only checks the other direction).
    app.ctx.bus.emit('ui:said', { tab: activeTab, text });
  }

  // Enter/Escape here are the input's own — `input.js`'s global handler already steps aside
  // for any focused text field (its own editable-target guard), so this is the only place
  // these two keys are handled while the box has focus.
  input.addEventListener('keydown', (ev) => {
    if (ev.code === 'Enter') { ev.stopPropagation(); send(); return; }
    if (ev.code === 'Escape') { ev.stopPropagation(); close(); }
  });

  selectTab('world');

  function applyVisibility() { root.hidden = !barsFlag || minimal; }
  applyVisibility();

  return {
    /** `Enter`, from `input.js`'s global handler, when nothing is focused — opens if closed,
     *  closes if open and empty (matching the source design's own "Enter abre e fecha o
     *  chat"); sends instead of closing when there is text in the box, exactly like the
     *  input's own local Enter handler above. */
    toggle() { (panel.hidden ? open : (input.value.trim() ? send : close))(); },
    setBarsVisible(bars) { barsFlag = !!bars; applyVisibility(); },
    dispose() { root.remove(); },
  };
}
