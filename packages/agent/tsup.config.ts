import { defineConfig } from 'tsup';

const assistantContractExternal = /^@brainstrike\/assistant-contract(?:\/.*)?$/;
const modelContextProtocolSdkExternal = /^@modelcontextprotocol\/sdk(?:\/.*)?$/;

const hostedWebEntries = ['src/hosted-web.ts', 'src/request-boundary.ts'];
const broadEntries = [
  'src/index.ts',
  'src/client.ts',
  'src/code-execution.ts',
  'src/fence-executor.ts',
  'src/mcp-client.ts',
  'src/local-llm.ts',
  'src/browser-safe.ts',
  'src/tool-metadata.ts',
  'src/provider-metadata.ts',
  'src/context-packer.ts',
  'src/memory-settings.ts',
  'src/run-events.ts',
  'src/pglite-mastra-memory/index.ts',
  'src/pglite-mastra-memory/schema.ts',
];
const sharedExternal = [
  modelContextProtocolSdkExternal,
  // Node-only: spawns platform sandbox tooling and proxy servers. Bundling it
  // would drag that into every consumer, including browser entries.
  '@anthropic-ai/sandbox-runtime',
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
  // TypeScript owns declaration emit in build and watch modes. Starting tsup's
  // separate declaration-bundler worker here causes severe startup contention.
  dts: false,
  format: ['esm', 'cjs'] as const,
  outDir: 'dist',
  sourcemap: false,
  splitting: false,
};

export default defineConfig((_options) => [
  {
    ...sharedConfig,
    entry: broadEntries,
    external: [assistantContractExternal, ...sharedExternal],
  },
  {
    ...sharedConfig,
    entry: hostedWebEntries,
    external: sharedExternal,
    // Vercel builds these functions as CommonJS and disables require(ESM).
    // Bundle the browser-safe contract into the Hosted Web entries so the
    // emitted function never crosses that incompatible package boundary.
    //
    // `@brainstrike/types` is inlined for the same reason and must stay that
    // way. It is ESM-only (`type: module`, no `require` condition), so leaving
    // it external emits `require("@brainstrike/types")` into the CJS output and
    // that throws ERR_REQUIRE_ESM the moment the function loads — before any
    // request is served. It is externalized for every OTHER entry via
    // `sharedExternal`; this override is deliberately hosted-only.
    noExternal: [assistantContractExternal, '@brainstrike/types'],
  },
]);
