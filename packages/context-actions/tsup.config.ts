import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: false, // Disable tsup dts; tsc -b . handles declarations (composite: true)
  splitting: false,
  sourcemap: true,
  clean: false, // tsc -b . outputs d.ts first; don't wipe it
});
