import { defineConfig } from 'tsup';

const assistantContractExternal = /^@brainstrike\/assistant-contract(?:\/.*)?$/;
const agentMcpClientExternal = /^@brainstrike\/agent\/mcp-client$/;
const modelContextProtocolV2External =
  /^@modelcontextprotocol\/(?:client|core|node|server|server-legacy)(?:\/.*)?$/;

const hostedWebEntries = ['src/hosted-web.ts', 'src/request-boundary.ts'];
const broadEntries = [
  'src/index.ts',
  'src/client.ts',
  'src/code-execution.ts',
  'src/fence-executor.ts',
  'src/mcp-client.ts',
  'src/test-fixtures/mcp-host-lifecycle.ts',
  'src/test-fixtures/delegated-stream.ts',
  'src/test-fixtures/scripted-agent-model.ts',
  'src/mcp-tasks.ts',
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
  agentMcpClientExternal,
  modelContextProtocolV2External,
  // Node-only: spawns platform sandbox tooling and proxy servers. Bundling it
  // would drag that into every consumer, including browser entries.
  '@anthropic-ai/sandbox-runtime',
  // Node-only (BST-1353): the AWS default credential chain reads `~/.aws`,
  // spawns `credential_process` children, and talks to IMDS. Externalized so
  // esbuild can never inline it into a browser entry — the module that
  // imports it (providers/aws-credential-chain.ts) is reachable only from the
  // Node entrypoints, and this keeps that true by construction rather than by
  // import discipline alone.
  '@aws-sdk/credential-providers',
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
    // Vercel builds these functions as CommonJS, so anything left external is
    // emitted as a bare `require(...)`. Bundle the browser-safe contract into
    // the Hosted Web entries so the emitted function never crosses that
    // package boundary. `@brainstrike/types` is inlined for the same reason and
    // must stay that way: it is ESM-only (`type: module`, no `require`
    // condition), so leaving it external emits `require("@brainstrike/types")`
    // into the CJS output. It is externalized for every OTHER entry via
    // `sharedExternal`, so this override is deliberately hosted-only.
    //
    // This comment used to claim Vercel "disables require(ESM)". That was a
    // trap, and it is corrected rather than removed because it invites the
    // wrong conclusion in both directions: these bundles still `require()` four
    // ESM-only workspace packages (logging, utils, tokenization,
    // local-runtime), so a loader that genuinely disabled require(ESM) would
    // already fail on load today. They work because Node enables it by default
    // (>= 22.12). Treat an ESM-only external here as a latent hazard riding on
    // that default, not as an instant break — and do not add new ones:
    // `scripts/verify-hosted-web-bundle.mjs` fails the build on any beyond the
    // four already recorded there.
    noExternal: [
      assistantContractExternal,
      '@brainstrike/mcp-app-host',
      '@brainstrike/mcp-tasks-extension',
      '@brainstrike/types',
    ],
  },
]);
