import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({
  base: './',
  publicDir: 'web/public',
  plugins: [vue()],
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false }, '/healthz': { target: 'http://127.0.0.1:8080', changeOrigin: false } } },
  build: { outDir: 'internal/server/static', emptyOutDir: true, assetsDir: 'assets', sourcemap: false },
})
