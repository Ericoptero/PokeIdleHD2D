# 010 — Playwright flows: the things a frame cannot show

Status: done          Branch / commit: workflow-harness

## Why
No gate stage drove a user flow: `shoot.js` records bus events and `checkBudgets` ignores them,
every capture is a fresh browser profile, nothing pressed a key. The audit's headline bugs are
all invisible to a still frame.

## Inspected before writing this slice
- `src/main.js:537` sets `window.__CTX__` synchronously before `registry.init`; `:642-644`
  emits `boot:ready` BEFORE `__READY__` flips — a subscriber installed after ready misses it.
- `src/core/bus.js:64-76` — the bus is a plain object every module holds; `emit` is patchable.
- `src/encounter/index.js:120,136` — T.READY 8 + T.LEAVE 26 sim steps is the throw window;
  `src/ui/index.js:246-256` opens the card on `encounter:started`, closes on
  `encounter:resolved`; `src/ui/panels/battle.js:255` throws on KeyZ only while it is open.
- `src/offline/index.js:409,424` — `persist(reason)` and `keys`; `info().unrestored` carries
  `simulation` with a `why` (deferred to the first `world:loaded`) by design.
- `src/offline/save.js` — writes are wall-clock debounced; `pagehide` flushes — which is why
  `localStorage.clear()` before `page.reload()` does not wipe a save.
- `tools/shots/serve.js:37-40` attaches to a live 5173 and kills only what it spawned;
  `vite.config.js:37` binds 127.0.0.1.
- `tools/shots/shoot.js:19-20,63-81` — Chrome path and launch flags, now shared.

## Files / modules affected
`playwright.config.js`, `tools/shots/chrome.js`, `tests/flows/{harness,boot.spec,hunt.spec,
save.spec}.js` (new); `tools/shots/shoot.js` (imports chrome.js); `tools/gate.js` (stage
`flows`, `needsServer: true`); `package.json` (`flows`).

## Expected behaviour
`npx playwright test` runs three flows in ~6 s against the gate's vite; the gate runs `flows`
after `boot`; both harnesses refuse a missing Chrome with the same message.

## Acceptance criteria
- 3 passed. Hunt path recorded by the test itself: encounter after 40 ticks (lechonk L7), fight
  won in 9 turns / 19 strikes / 240 ticks, KeyZ → one `catch:*` → `encounter:resolved`, card
  closed, walk resumed.
- Each flow proved able to fail: boot with `?break=economy` fails on "every registered module
  reached ready"; hunt with `maxTicks: 1` fails with the event list in the message (not a
  timeout); save with the stored document tampered before reload fails on "the slices were
  restored" (nothing restored — quarantined).
- `node tools/gate.js --only unit,flows` starts exactly one vite (Playwright reuses it) and
  leaves none listening.
- `CHROME_PATH=/nonexistent` → "Chrome not found at /nonexistent. Set CHROME_PATH." from both
  `shoot.js` and `playwright test`.

## Tests required
The three specs.

## Verification in the real application
`npx playwright test tests/flows/hunt.spec.js --headed` shows the walk, the fight and the throw.

## Docs to touch
CLAUDE.md Testing section (slice 11): flows drive `__HOOKS__`/`__CTX__`, assert on events.

## Out of scope
`economy.spec.js` (can only time out today; written red-first in P1); `--hidden`; a hook to
seed a save.

## Result
The first save flow was vacuous: at a fixed seed a fresh game deals the same starter and the
same purse, so it passed with the save wiped. It now credits money and gives an item through
the API — state a fresh save cannot have — and asserts those. `localStorage.clear()` turned
out to be the wrong wipe probe because `pagehide` re-flushes on navigation; tampering the
document in an init script is the probe that fails it. Timing: flows 6.6 s in the gate.
