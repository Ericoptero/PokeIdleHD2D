/**
 * Toasts, converted to the Códice DOM layer (`src/ui/dom/toasts.js`, Stage 2) — driven through
 * the real `ui:toast` bus event every module in the game actually emits through
 * (`ui.toast(text, kind)`, `src/ui/index.js`'s own public API), not by calling the toasts
 * module directly.
 */
import { test, expect } from '@playwright/test';
import { boot, call } from './harness.js';

/** The live DOM toast stack, newest last — the same order `.ci-toasts` renders it in. */
const toastEls = (page) => page.evaluate(() => [...document.querySelectorAll('.ci-toast')].map((el) => ({
  kind: el.dataset.kind,
  text: el.querySelector('.ci-toast__text')?.textContent ?? '',
  barWidth: el.querySelector('.ci-toast__bar-fill')?.style.width ?? '',
})));

const pushToast = (page, text, kind) => call(page, 'ui', 'toast', text, kind);
const clearToasts = (page) => page.evaluate(() => window.__CTX__.get('ui')._toasts.clear());

/** A booted page, with whatever a real boot itself toasted (`travel`'s own "Arrived: …" on a
 *  fresh save) cleared first — every test below wants a known-empty stack to push onto. */
async function bootClean(page) {
  const errors = await boot(page);
  await clearToasts(page);
  return errors;
}

test('a pushed toast mounts in the DOM stack with its kind and text', async ({ page }) => {
  const errors = await bootClean(page);
  await pushToast(page, 'Route 4 unlocked', 'good');

  const toasts = await toastEls(page);
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toMatchObject({ kind: 'good', text: 'Route 4 unlocked' });
  expect(errors, 'no console error pushing a toast').toEqual([]);
});

test('an unrecognised kind falls back to info, exactly like the canvas predecessor', async ({ page }) => {
  await bootClean(page);
  await pushToast(page, 'Idled 12 m — ₽640', 'idle');

  const toasts = await toastEls(page);
  expect(toasts).toEqual([{ kind: 'info', text: 'Idled 12 m — ₽640', barWidth: '' }]);
});

test('only the newest four survive; older ones fall off the top', async ({ page }) => {
  await bootClean(page);
  for (let i = 1; i <= 6; i++) await pushToast(page, `toast ${i}`, 'info');

  const toasts = await toastEls(page);
  expect(toasts.map((t) => t.text)).toEqual(['toast 3', 'toast 4', 'toast 5', 'toast 6']);
});

test('a large step ages a toast past its lifetime and it unmounts', async ({ page }) => {
  await bootClean(page);
  await pushToast(page, 'about to expire', 'good');
  expect(await toastEls(page)).toHaveLength(1);

  // `good` toasts live 2s (`dom/toasts.js`'s DURATION_S) — one oversized `frame()` step is
  // enough to cross it without needing real sim ticks.
  await call(page, 'ui', '_frame', 5);
  expect(await toastEls(page)).toHaveLength(0);
});

test('clear() empties the stack immediately, the way the showcase relies on between modes', async ({ page }) => {
  await bootClean(page);
  await pushToast(page, 'will be cleared', 'warn');
  expect(await toastEls(page)).toHaveLength(1);

  await clearToasts(page);
  expect(await toastEls(page)).toHaveLength(0);
});
