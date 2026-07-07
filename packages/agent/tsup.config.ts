import { defineConfig } from 'tsup';

const assistantContractExternal = /^@brainstrike\/assistant-contract(?:\/.*)?$/;

export default defineConfig((_options) => ({
  // Keep previous outputs available across rebuilds because multiple app prebuilds
  // may invoke @brainstrike/agent builds concurrently. tsup's clean step is not
  // concurrency-safe and can unlink sibling build outputs mid-run.
  clean: false,
  dts: {
    compilerOptions: {
      composite: false,
      paths: {
        '@brainstrike/assistant-contract': ['../../assistant-contract/dist/index.d.ts'],
        '@brainstrike/assistant-contract/*': ['../../assistant-contract/dist/*'],
      },
    },
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
  },
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
  external: [
    assistantContractExternal,
    '@brainstrike/assistant-contract',
    '@brainstrike/types',
    '@electric-sql/pglite',
    '@mastra/core',
    '@mastra/mcp',
    '@mastra/memory',
  ],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  sourcemap: false,
  splitting: false,
}));
