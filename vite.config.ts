import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// The demo app consumes the SDK source directly (HMR); the npm package build is checked separately.
// 演示应用直接使用 SDK 源码（支持热更新）；npm 包产物另行校验。
export default defineConfig({
  root: 'app',
  css: { postcss: here('.') },
  // Pre-bundle everything the SDK imports so the first visit to a section never triggers a full reload.
  // 预构建 SDK 全部依赖，避免首次进入某分区时整页重载。
  optimizeDeps: { entries: ['index.html', 'embed.html', 'qa.html'] },
  server: { proxy: { '/api': 'http://127.0.0.1:8765' }, fs: { allow: ['..'] } },
  preview: { proxy: { '/api': 'http://127.0.0.1:8765' } },
  build: {
    outDir: '../app-dist',
    emptyOutDir: true,
    manifest: true,
    rollupOptions: { input: { index: here('app/index.html'), embed: here('app/embed.html'), qa: here('app/qa.html') } },
  },
});
