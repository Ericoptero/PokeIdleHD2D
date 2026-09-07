import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  preview: { port: 4173, strictPort: true },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  // assets/ holds the shipped sprite source art; public/ holds build products.
  publicDir: 'public',
  resolve: { alias: { '@': '/src' } },
});
