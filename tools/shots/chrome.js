/**
 * Where Chrome is, and how it is launched — shared by the screenshot harness (puppeteer-core,
 * `shoot.js`) and the flow tests (Playwright, `playwright.config.js`), so both fail with the
 * same message on a machine without it and both create WebGL the same way.
 *
 * Real Chrome, not a bundled Chromium: `docs/baseline.json` was captured on this GL stack and
 * the pixel stages need it anyway, so there is no fallback to download.
 */
import { existsSync } from 'node:fs';

export const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Throws the one message every harness prints when Chrome is missing. */
export function assertChrome() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}. Set CHROME_PATH.`);
}

/**
 * Launch flags shared by both harnesses. The real GPU by default: SwiftShader renders the same
 * pixels at a tenth of the frame rate, so a software fps number cannot be checked against the
 * budget. `software: true` is bit-identical output across machines instead.
 */
export function chromeArgs({ software = false } = {}) {
  return [
    '--hide-scrollbars',
    '--mute-audio',
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    ...(software ? ['--use-gl=angle', '--use-angle=swiftshader'] : ['--enable-gpu']),
  ];
}
