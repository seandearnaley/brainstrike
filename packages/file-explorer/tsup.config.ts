import { defineConfig } from 'tsup';

export default defineConfig({
  clean: false,
  dts: false,
  entry: [
    'src/context-generation.ts',
    'src/file-tree.ts',
    'src/index.ts',
    'src/project-tree-text.ts',
    'src/selection.ts',
    'src/testing.ts',
  ],
  format: ['esm', 'cjs'],
  injectStyle: false,
  splitting: false,
  target: 'es2022',
});
