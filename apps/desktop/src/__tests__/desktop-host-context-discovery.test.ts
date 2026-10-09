import { buildDefaultInstructions } from '@brainstrike/agent/tool-runtime';
import type { HostTool } from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { readDesktopHostSystemContext } from '../agent-host-platform/desktop-host-context';

function nativeTool(permissionToolId: string): readonly [string, HostTool] {
  return [
    permissionToolId.replace('.', '_'),
    {
      description: `Fixture ${permissionToolId}`,
      execute: async () => null,
      identity: permissionToolId,
      inputSchema: z.object({}),
      permissionToolId,
      risk: 'read',
    },
  ];
}

/** The host run's composed instructions for `tools` under `provider`. */
async function hostSystem(
  provider: string,
  tools: Readonly<Record<string, HostTool>>
): Promise<string> {
  return z.string().parse(
    await readDesktopHostSystemContext({
      inputTokenLimit: 100_000,
      planMode: false,
      readWorkspaceFile: async () => {
        throw new Error('No workspace file is read by this run');
      },
      request: {
        modelId: `${provider}::gpt-6-sol`,
        prompt: 'List the worktrees',
        signal: new AbortController().signal,
        threadId: 'thread-discovery',
      },
      runtime: { model: 'gpt-6-sol', provider, workspaceRoots: [] },
      tools,
    })
  );
}

function names(tools: Readonly<Record<string, HostTool>>): Map<string, string> {
  return new Map(
    Object.entries(tools).map(([name, tool]) => [name, tool.permissionToolId ?? name])
  );
}

test('a hosted run whose tools discovery defers is taught discovery, as legacy', async () => {
  const tools = Object.fromEntries([
    nativeTool(NATIVE_TOOL_ID.readWorkspaceFile),
    nativeTool(NATIVE_TOOL_ID.listWorktrees),
  ]);
  expect(await hostSystem('openai', tools)).toContain(
    buildDefaultInstructions(names(tools), { planMode: false, toolDiscoveryEnabled: true })
  );
});

test('a hosted run with nothing deferred keeps the instructions without discovery', async () => {
  const tools = Object.fromEntries([nativeTool(NATIVE_TOOL_ID.readWorkspaceFile)]);
  const system = await hostSystem('openai', tools);
  expect(system).toContain(buildDefaultInstructions(names(tools), { planMode: false }));
  expect(system).not.toContain(
    buildDefaultInstructions(names(tools), { planMode: false, toolDiscoveryEnabled: true })
  );
});
