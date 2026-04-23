import { resolve } from 'node:path';

const AGENT_BROWSER_SAFE_SOURCE_FILES = {
  '@brainstrike/agent/client': 'src/client.ts',
  '@brainstrike/agent/local-llm': 'src/local-llm.ts',
  '@brainstrike/agent/local-runtime': 'src/local-runtime.ts',
  '@brainstrike/agent/pglite-mastra-memory/schema': 'src/pglite-mastra-memory/schema.ts',
  '@brainstrike/agent/provider-metadata': 'src/provider-metadata.ts',
  '@brainstrike/agent/tool-metadata': 'src/tool-metadata.ts',
};

export function createAgentBrowserSafeAliasEntries(agentPackageDir) {
  return Object.entries(AGENT_BROWSER_SAFE_SOURCE_FILES).map(([find, relativePath]) => ({
    find,
    replacement: resolve(agentPackageDir, relativePath),
  }));
}

export function createAgentBrowserSafeAliasMap(agentPackageDir) {
  return Object.fromEntries(
    createAgentBrowserSafeAliasEntries(agentPackageDir).map(({ find, replacement }) => [
      find,
      replacement,
    ])
  );
}
