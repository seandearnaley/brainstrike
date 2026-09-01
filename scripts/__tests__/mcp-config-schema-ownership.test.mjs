import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRepoFile = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('agent and desktop MCP config ingestion delegate to the shared strict validator', () => {
  const owner = readRepoFile('packages/assistant-contract/src/mcp-config.ts');
  const agent = readRepoFile('packages/agent/src/mcp/config.ts');
  const runtime = readRepoFile('packages/agent/src/mastra/mcp-runtime-client.ts');
  const desktop = readRepoFile('apps/desktop/src/mcp-loader.ts');

  assert.match(owner, /export const McpConfigSchema/u);
  assert.match(owner, /export function parseMcpConfigValue/u);

  for (const [name, adapter] of [
    ['agent', agent],
    ['desktop', desktop],
  ]) {
    assert.match(
      adapter,
      /from '@brainstrike\/assistant-contract\/mcp-config'/u,
      `${name} must import the shared MCP config seam`
    );
    assert.match(
      adapter,
      /parseMcpConfigValue\(/u,
      `${name} must validate parsed input through the shared seam`
    );
    assert.doesNotMatch(adapter, /from 'zod'/u, `${name} must not own a second Zod schema`);
    assert.doesNotMatch(
      adapter,
      /(?:strictObject|discriminatedUnion)\(/u,
      `${name} must not rebuild the shared MCP config schema`
    );
  }

  assert.match(runtime, /parseMcpConfigValue\(/u);
  assert.doesNotMatch(runtime, /McpConfigSchema\.parse\(/u);
});
