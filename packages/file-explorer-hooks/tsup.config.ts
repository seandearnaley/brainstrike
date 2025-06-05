import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: false, // Disable dts generation in tsup, handle separately
  splitting: false,
  sourcemap: true,
  minify: !options.watch,
  esbuildOptions(options, context) {
    if (context.format === 'cjs') {
      options.define = {
        ...options.define,
        'import.meta.env.DEV': 'false',
      };
    }
  },
}));
