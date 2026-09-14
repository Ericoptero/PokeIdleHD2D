import { cp, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * The runtime roots under `assets/` — the ones a *browser* fetches, not the ones `tools/` reads.
 *
 * `publicDir` only copies `public/`, and `assets/` is served in dev because Vite serves the
 * project root — which is how `dist/` once shipped with no sprite art while every gate stage
 * stayed green (`tools/gate.js builtAssets()` checks for missing runtime art).
 *
 * Listed rather than copying `assets/` wholesale: `props/` and `structures/` are OBJ + MTL
 * source that `tools/assets/build-structures.js` bakes into `public/generated/tiles/`, and
 * shipping them would put a megabyte of build input in front of a player for nothing.
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
  build: {
    target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500,
    // Three pages, one build: the game (`index.html`), the admin Map Studio (`studio.html`,
    // a separate site sharing the game's tile/terrain code and its `#ui-dom` theme — see
    // `studio/README.md`), and the Studio's headless snapshot-export target
    // (`studio/snapshot.html`, driven by `tools/mapstudio/snapshot.js`, never linked from
    // either UI). Listing `rollupOptions.input` REPLACES Vite's implicit single-entry
    // default, so `index.html` has to be named here too or the game drops out of `dist/`.
    rollupOptions: {
      input: {
        main: resolve(ROOT, 'index.html'),
        studio: resolve(ROOT, 'studio.html'),
        snapshot: resolve(ROOT, 'studio/snapshot.html'),
      },
    },
  },
  // assets/ holds the shipped sprite source art; public/ holds build products. Vite copies
  // `public/` on its own; the plugin above is what gets the sprites into the build.
  publicDir: 'public',
  plugins: [copyRuntimeAssets()],
  resolve: { alias: { '@': '/src' } },
});
