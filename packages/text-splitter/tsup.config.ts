import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.ts', 'src/chunking-core.ts', 'src/token-utils-accurate-lite.ts'],
  format: ['esm', 'cjs'],
  splitting: true,
  sourcemap: false,
  dts: false,
  outDir: 'dist',
  clean: !options.watch,
  target: 'es2020',
  noExternal: ['tiktoken'],
  loader: {
    '.wasm': 'dataurl',
  },
  esbuildOptions(options) {
    options.mainFields = ['browser', 'module', 'main'];
    options.conditions = ['browser', 'import', 'default'];
  },
}));
