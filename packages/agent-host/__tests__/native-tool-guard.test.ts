import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentHostToolBindings } from '../src/adapters/canonical-tool-bindings.js';
import type { HostToolContext } from '../src/ports.js';

const budget = {
  domainModelResultCharBudget: 20_000,
  transportResultTokens: 10_000,
} as unknown as Parameters<typeof createAgentHostToolBindings>[0]['resolvedToolResultBudget'];

function canonical(id: string, execute: () => Promise<unknown>) {
  return { description: id, execute, id, inputSchema: z.object({}) };
}

function context(): HostToolContext {
  return {
    runId: 'run-1',
    signal: new AbortController().signal,
    threadId: 'thread-1',
    toolCallId: 'call-1',
  };
}

function bind(tools: Record<string, ReturnType<typeof canonical>>) {
  return createAgentHostToolBindings({
    bindings: Object.fromEntries(
      Object.keys(tools).map((id) => [id, { identity: id, risk: 'read' as const }])
    ),
    resolvedToolResultBudget: budget,
    tools: tools as unknown as Parameters<typeof createAgentHostToolBindings>[0]['tools'],
    toolTimeoutMs: 50,
  }).tools;
}

describe('native host tool guard', () => {
  it('answers a native tool that never settles with the legacy timeout result', async () => {
    const tools = bind({
      [NATIVE_TOOL_ID.manageTaskList]: canonical(
        NATIVE_TOOL_ID.manageTaskList,
        () => new Promise(() => undefined)
      ),
    });
    const [tool] = Object.values(tools);
    await expect(tool?.execute({}, context())).resolves.toMatchObject({
      error: { code: 'tool_timeout', toolName: NATIVE_TOOL_ID.manageTaskList },
      ok: false,
    });
  });

  it('normalizes a native tool failure into the legacy guarded error result', async () => {
    const tools = bind({
      [NATIVE_TOOL_ID.manageTaskList]: canonical(NATIVE_TOOL_ID.manageTaskList, async () => {
        throw new Error('disk on fire');
      }),
    });
    const [tool] = Object.values(tools);
    await expect(tool?.execute({}, context())).resolves.toMatchObject({
      error: { code: 'tool_failed', toolName: NATIVE_TOOL_ID.manageTaskList },
      ok: false,
    });
  });

  it('leaves a non-native tool to its own owner (MCP bindings guard themselves)', async () => {
    const tools = bind({
      server__tool: canonical('server__tool', async () => {
        throw new Error('peer failed');
      }),
    });
    const [tool] = Object.values(tools);
    await expect(tool?.execute({}, context())).rejects.toThrow('peer failed');
  });
});
