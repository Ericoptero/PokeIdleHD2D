import { cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from 'vite';

/**
 * The runtime roots under `assets/` — the ones a *browser* fetches, not the ones `tools/` reads.
 *
 * `publicDir` only copies `public/`, and `assets/` is served in dev because Vite serves the
 * project root. That is the whole of why `dist/` shipped with **no Pokemon sprite art at all**
 * and nobody noticed: `tools/shots/boot.js` and `regress.js` shoot the dev server, and the one
 * stage that uses the build (`coldBoot`) measures time rather than pixels. On `vite preview`
 * every creature in the game drew as an untextured quad.
 *
 * Listed rather than copying `assets/` wholesale: `props/` and `structures/` are OBJ + MTL
 * source that `tools/assets/build-tiles.js` bakes into `public/generated/`, and shipping them
 * would put a megabyte of build input in front of a player for nothing.
 */
export const RUNTIME_ASSET_ROOTS = ['overworld', 'trainer'];

/** Copies those roots into the build, preserving the `/assets/<root>/...` URL `src/` fetches. */
function copyRuntimeAssets() {
  return {
    name: 'pokeidle-runtime-assets',
    apply: 'build',
    async closeBundle() {
      for (const root of RUNTIME_ASSET_ROOTS) {
        await cp(join('assets', root), join('dist', 'assets', root), { recursive: true });
      }
      const n = (await Promise.all(RUNTIME_ASSET_ROOTS.map(async (r) =>
        (await readdir(join('dist', 'assets', r))).length))).reduce((a, b) => a + b, 0);
      this.info?.(`runtime assets: ${RUNTIME_ASSET_ROOTS.join(', ')} -> dist/assets (${n} entries)`);
    },
  };
}

export default defineConfig({
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  preview: { port: 4173, strictPort: true },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  // assets/ holds the shipped sprite source art; public/ holds build products. Vite copies
  // `public/` on its own; the plugin above is what gets the sprites into the build.
  publicDir: 'public',
  plugins: [copyRuntimeAssets()],
  resolve: { alias: { '@': '/src' } },
});
