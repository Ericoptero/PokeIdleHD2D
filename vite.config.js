import { cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from 'vite';

/**
 * The runtime roots under `assets/` — the ones a *browser* fetches, not the ones `tools/` reads.
 *
 * `publicDir` only copies `public/`, and `assets/` is served in dev because Vite serves the
 * project root — which is how `dist/` once shipped with no sprite art while every gate stage
 * stayed green (DECISIONS #72; `tools/gate.js builtAssets()` is the check that came out of it).
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
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  // assets/ holds the shipped sprite source art; public/ holds build products. Vite copies
  // `public/` on its own; the plugin above is what gets the sprites into the build.
  publicDir: 'public',
  plugins: [copyRuntimeAssets()],
  resolve: { alias: { '@': '/src' } },
});
