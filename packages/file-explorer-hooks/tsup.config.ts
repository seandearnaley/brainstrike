import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: false, // Assuming types are handled by build:types script
  splitting: false,
  sourcemap: true,
  clean: true,
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