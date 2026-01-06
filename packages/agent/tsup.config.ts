import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/client.ts'],
  format: ['esm', 'cjs'],
  dts: {
    entry: ['src/index.ts', 'src/client.ts'],
    compilerOptions: {
      composite: false,
    },
  },
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  splitting: false,
  external: ['@brainstrike/types', '@mastra/core', '@mastra/mcp'],
});
