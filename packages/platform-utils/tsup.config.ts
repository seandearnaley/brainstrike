import { defineConfig } from 'tsup';

export default defineConfig(() => ({
  clean: false, // tsc -b . outputs d.ts first; don't wipe it
  dts: false, // Disable tsup dts; tsc -b . handles declarations (composite: true)
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  sourcemap: true,
  splitting: false,
}));
