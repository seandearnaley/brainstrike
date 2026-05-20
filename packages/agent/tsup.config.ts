import { defineConfig } from 'tsup';

export default defineConfig((_options) => ({
  entry: [
    'src/index.ts',
    'src/client.ts',
    'src/local-llm.ts',
    'src/browser-safe.ts',
    'src/tool-metadata.ts',
    'src/provider-metadata.ts',
    'src/local-runtime.ts',
    'src/context-packer.ts',
    'src/memory-settings.ts',
    'src/run-events.ts',
    'src/pglite-mastra-memory/index.ts',
    'src/pglite-mastra-memory/schema.ts',
  ],
  format: ['esm', 'cjs'],
  dts: {
    entry: [
      'src/index.ts',
      'src/client.ts',
      'src/local-llm.ts',
      'src/browser-safe.ts',
      'src/tool-metadata.ts',
      'src/provider-metadata.ts',
      'src/local-runtime.ts',
      'src/context-packer.ts',
      'src/memory-settings.ts',
      'src/run-events.ts',
      'src/pglite-mastra-memory/index.ts',
      'src/pglite-mastra-memory/schema.ts',
    ],
    compilerOptions: {
      composite: false,
    },
  },
  outDir: 'dist',
  // Keep previous outputs available across rebuilds because multiple app prebuilds
  // may invoke @brainstrike/agent builds concurrently. tsup's clean step is not
  // concurrency-safe and can unlink sibling build outputs mid-run.
  clean: false,
  sourcemap: false,
  splitting: false,
  external: [
    '@brainstrike/assistant-contract',
    '@brainstrike/types',
    '@electric-sql/pglite',
    '@mastra/core',
    '@mastra/mcp',
    '@mastra/memory',
  ],
}));
