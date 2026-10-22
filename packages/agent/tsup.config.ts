import { defineConfig } from 'tsup';

const assistantContractExternal = /^@brainstrike\/assistant-contract(?:\/.*)?$/;
const agentMcpClientExternal = /^@brainstrike\/agent\/mcp-client$/;
const agentGuardDeadlineExternal = /^@brainstrike\/agent\/tool-guard-deadline$/;
const modelContextProtocolV2External =
  /^@modelcontextprotocol\/(?:client|core|node|server|server-legacy)(?:\/.*)?$/;

const broadEntries = [
  'src/index.ts',
  'src/client.ts',
  'src/provider-request.ts',
  'src/provider-runtime.ts',
  'src/tool-runtime.ts',
  'src/code-execution.ts',
  'src/fence-executor.ts',
  'src/mcp-client.ts',
  'src/test-fixtures/mcp-host-lifecycle.ts',
  'src/test-fixtures/scripted-agent-model.ts',
  'src/mcp-tasks.ts',
  'src/browser-safe.ts',
  'src/tool-metadata.ts',
  'src/provider-metadata.ts',
  'src/context-packer.ts',
  'src/memory-settings.ts',
  'src/run-events.ts',
];
const sharedExternal = [
  agentMcpClientExternal,
  agentGuardDeadlineExternal,
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
    // Both import and require resolve one CJS owner. Independently bundled
    // entrypoints must not each initialize their own deadline WeakMap.
    entry: { 'tool-guard-deadline': 'src/tool-guard-deadline.ts' },
    external: [assistantContractExternal, ...sharedExternal],
    format: ['cjs'],
  },
]);
