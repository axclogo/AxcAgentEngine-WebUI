import { defineConfig } from 'tsup';
// Dependencies and peer dependencies stay external; consumers install them once.
// 依赖与 peer 依赖保持外置，由使用方安装。
export default defineConfig({
  entry: ['src/index.ts', 'src/core.ts'],
  format: ['esm'],
  dts: true,
  splitting: true,
  clean: true,
});
