/**
 * `permission.gate.resolved` rides the FRESH-turn prelude (attempt-legs.ts,
 * beside `mcp.tools.unavailable`) through a real runtime assembly, so the
 * summary is the gate the Agent was actually built with — not a re-derivation.
 */
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { streamMastraAgent } from '../mastra/agent-streaming';
import {
  findRunEventChunks,
  resetMastraStreamHarness,
  setMockStreamParts,
} from './fixtures/mastra-stream-harness';

vi.mock(
  '@ai-sdk/openai',
  async () => (await import('./fixtures/mastra-stream-harness')).openAiSdkMock
);

vi.mock(
  '@ai-sdk/anthropic',
  async () => (await import('./fixtures/mastra-stream-harness')).anthropicSdkMock
);

vi.mock(
  '@ai-sdk/google',
  async () => (await import('./fixtures/mastra-stream-harness')).googleSdkMock
);

vi.mock(
  '@mastra/core/agent',
  async () => (await import('./fixtures/mastra-stream-harness')).mastraAgentModuleMock
);

vi.mock(
  '@mastra/core/mastra',
  async () => (await import('./fixtures/mastra-stream-harness')).mastraCoreModuleMock
);

vi.mock(
  '../mcp/explicit-stdio-client',
  async () => (await import('./fixtures/mastra-stream-harness')).explicitStdioMcpClientModuleMock
);

const TOOLS = {
  'brainstrike.readWorkspaceFile': { description: 'read', id: 'brainstrike.readWorkspaceFile' },
  'brainstrike.runShell': { description: 'run shell', id: 'brainstrike.runShell' },
  'brainstrike.writeWorkspaceFile': { description: 'write', id: 'brainstrike.writeWorkspaceFile' },
};

const POLICY: PermissionToolGateSnapshot = {
  policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
  riskByTool: {
    'brainstrike.readWorkspaceFile': 'read',
    'brainstrike.runShell': 'execute',
    'brainstrike.writeWorkspaceFile': 'edit',
  },
  yolo: false,
};

async function streamTurn(options: {
  readonly permissionPolicy: PermissionToolGateSnapshot | undefined;
  readonly storage: boolean;
}): Promise<unknown[]> {
  setMockStreamParts([
    { type: 'start' },
    { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
  ]);
  const iterator = await streamMastraAgent(
    [{ id: 'user-gate', parts: [{ text: 'hi', type: 'text' }], role: 'user' }],
    {
      runtime: {
        apiKey: 'test-key',
        provider: 'openai',
        ...(options.permissionPolicy ? { permissionPolicy: options.permissionPolicy } : {}),
      },
      ...(options.storage ? { storage: { id: 'workflow-storage' } as never } : {}),
      tools: TOOLS,
    }
  );
  const chunks: unknown[] = [];
  for await (const chunk of iterator) {
    chunks.push(chunk);
  }
  return chunks;
}

function kindIndex(chunks: readonly unknown[], kind: string): number {
  return chunks.findIndex((chunk) => (chunk as { event?: { kind?: string } }).event?.kind === kind);
}

describe('permission.gate.resolved prelude', () => {
  beforeEach(() => {
    resetMastraStreamHarness();
  });

  it('leads a gated fresh turn with ONE row naming the ask and deny decisions', async () => {
    const chunks = await streamTurn({ permissionPolicy: POLICY, storage: true });

    const rows = findRunEventChunks(chunks, 'permission.gate.resolved');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toMatchObject({
      detail: '1 tool gated to ask (execute: 1); 1 denied; session grants: none',
      status: 'completed',
    });
    expect(rows[0]?.event.metadata).toEqual({
      askTools: [{ riskCategory: 'execute', tool: 'brainstrike.runShell' }],
      defaultRisk: null,
      deniedTools: [{ riskCategory: 'edit', tool: 'brainstrike.writeWorkspaceFile' }],
      grantedCategories: [],
      omittedAskTools: [],
      overrideCount: 0,
      policies: POLICY.policies,
      yolo: false,
    });
    expect(kindIndex(chunks, 'permission.gate.resolved')).toBeLessThan(
      kindIndex(chunks, 'run.started')
    );
  });

  it('reports ask tools omitted when no storage could resume an approval', async () => {
    const chunks = await streamTurn({ permissionPolicy: POLICY, storage: false });

    const rows = findRunEventChunks(chunks, 'permission.gate.resolved');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.metadata).toMatchObject({
      askTools: [],
      omittedAskTools: [{ riskCategory: 'execute', tool: 'brainstrike.runShell' }],
    });
  });

  it('emits no gate row when no policy gated the run', async () => {
    const chunks = await streamTurn({ permissionPolicy: undefined, storage: true });

    expect(findRunEventChunks(chunks, 'permission.gate.resolved')).toEqual([]);
  });
});
