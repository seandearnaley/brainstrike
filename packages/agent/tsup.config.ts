import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/client.ts', 'src/providers/types.ts'],
  format: ['esm', 'cjs'],
  dts: {
    entry: ['src/index.ts', 'src/client.ts', 'src/providers/types.ts'],
    compilerOptions: {
      composite: false,
    },
  },
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  treeshake: true,
});
