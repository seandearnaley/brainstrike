import { defineConfig } from 'tsup';

const assistantContractExternal = /^@brainstrike\/assistant-contract(?:\/.*)?$/;
const modelContextProtocolSdkExternal = /^@modelcontextprotocol\/sdk(?:\/.*)?$/;

const hostedWebEntries = ['src/hosted-web.ts', 'src/request-boundary.ts'];
const broadEntries = [
  'src/index.ts',
  'src/client.ts',
  'src/mcp-client.ts',
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
];
const allEntries = [...broadEntries, ...hostedWebEntries];
const sharedExternal = [
  modelContextProtocolSdkExternal,
  '@brainstrike/types',
  '@electric-sql/pglite',
  '@mastra/core',
  '@mastra/memory',
];
const sharedConfig = {
  // Keep previous outputs available across rebuilds because multiple app prebuilds
  // may invoke @brainstrike/agent builds concurrently. tsup's clean step is not
  // concurrency-safe and can unlink sibling build outputs mid-run.
  clean: false,
  format: ['esm', 'cjs'] as const,
  outDir: 'dist',
  sourcemap: false,
  splitting: false,
};

export default defineConfig((_options) => [
  {
    ...sharedConfig,
    dts: {
      compilerOptions: {
        composite: false,
        paths: {
          '@brainstrike/assistant-contract': ['../../assistant-contract/dist/index.d.ts'],
          '@brainstrike/assistant-contract/*': ['../../assistant-contract/dist/*'],
        },
      },
      entry: allEntries,
    },
    entry: broadEntries,
    external: [assistantContractExternal, ...sharedExternal],
  },
  {
    ...sharedConfig,
    dts: false,
    entry: hostedWebEntries,
    external: sharedExternal,
    // Vercel builds these functions as CommonJS and disables require(ESM).
    // Bundle the browser-safe contract into the Hosted Web entries so the
    // emitted function never crosses that incompatible package boundary.
    noExternal: [assistantContractExternal],
  },
]);
