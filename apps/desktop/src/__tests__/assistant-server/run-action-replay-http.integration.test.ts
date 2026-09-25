import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { app } from 'electron';
import { afterEach, expect, it, type Mock, vi } from 'vitest';
import { handleAssistantRequest } from '../../assistant-server';
import { resetDesktopMastraMemoryCacheForTests } from '../../assistant-server/mastra-memory';
import {
  mockDesktopDatabase,
  mockPgliteMastraMemory,
  mockPgliteMastraStorage,
  mockSecretsService,
} from './_assistant-server-mocks';
import { createRunRequest } from './_harness';

// Keep the desktop HTTP and run-turn path real. Only the provider/stream and
// desktop process adapters are mocked; every replay lookup uses migrated PGlite.
const mocks = vi.hoisted(() => () => import('./_assistant-server-mocks'));
vi.mock('../../assistant-server/http', async () => (await mocks()).makeAssistantServerHttpMock());
vi.mock('../../mcp-loader', async () => (await mocks()).makeMcpLoaderMock());
vi.mock('../../agent-client-loader', async () => (await mocks()).makeAgentClientLoaderMock());
vi.mock('../../secrets', async () => (await mocks()).makeSecretsMock());
vi.mock('@brainstrike/agent/hosted-web', async () => (await mocks()).makeHostedWebAgentMock());
vi.mock('@brainstrike/agent', async () => (await mocks()).makeAgentMock());
vi.mock('@brainstrike/agent/pglite-mastra-memory', async () =>
  (await mocks()).makePgliteMastraMemoryMock()
);
vi.mock('../../assistant-server/assistant-tools', async () =>
  (await mocks()).makeAssistantToolsMock()
);
vi.mock('../../assistant-server/workspace-text-file-reader', async () =>
  (await mocks()).makeWorkspaceTextFileReaderMock()
);
vi.mock('../../db-main', async () => (await mocks()).makeDbMainMock());

const runRequest = createRunRequest(handleAssistantRequest);

afterEach(() => {
  vi.clearAllMocks();
  resetDesktopMastraMemoryCacheForTests();
});

it('replays a distinct live paused owner through the HTTP action host leg', async () => {
  const database = await wasmLoader.createPGlite('memory://http-action-replay');
  try {
    await migrate(database);
    const repository = createPgliteAssistantThreadRepository(database as unknown as DbHandle);
    const thread = await repository.createThread('workspace-a');
    await database.query(
      `INSERT INTO mastra_messages
        (id, thread_id, content, role, type, "createdAt", "resourceId")
       VALUES ($1, $2, $3::jsonb, 'user', 'v2', $4, 'workspace-a'),
              ($5, $2, $6::jsonb, 'assistant', 'v2', $7, 'workspace-a')`,
      [
        'user-a',
        thread.id,
        JSON.stringify({
          content: 'Create a canvas',
          format: 2,
          parts: [{ text: 'Create a canvas', type: 'text' }],
        }),
        new Date('2026-08-10T17:00:00Z'),
        'native-owner',
        JSON.stringify({
          format: 2,
          parts: [
            {
              toolInvocation: {
                args: {},
                state: 'input-available',
                toolCallId: 'canvas-call',
                toolName: 'brainstrike_manageCanvas',
              },
              type: 'tool-invocation',
            },
          ],
        }),
        new Date('2026-08-10T17:00:01Z'),
      ]
    );
    await repository.recordMessageParent?.({
      messageId: 'paused-ui-owner',
      parentId: 'user-a',
      resourceId: 'workspace-a',
      threadId: thread.id,
    });
    await repository.createThreadRun({
      id: 'host-leg' as HostRunId,
      model: 'gpt-test',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: thread.id,
      turnMessageId: 'user-a',
    });
    await database.query(
      `INSERT INTO brainstrike_assistant_native_runs (native_run_id, host_run_id)
       VALUES ('native-run', 'host-leg')`
    );
    await repository.appendThreadRunEvent('host-leg', {
      id: 'pending-canvas',
      kind: 'tool.approval.requested',
      label: 'Awaiting approval',
      metadata: { toolCallId: 'canvas-call', toolName: 'brainstrike.manageCanvas' },
      sequence: 1,
      status: 'running',
      timestamp: '2026-08-10T17:00:02Z',
    });

    mockDesktopDatabase.query.mockImplementation((sql: unknown, params: unknown) =>
      database.query(sql as string, params as unknown[])
    );
    mockDesktopDatabase.exec.mockImplementation((sql: unknown) => database.exec(sql as string));
    mockSecretsService.getCredential.mockResolvedValue({ key: 'test-api-key', type: 'api_key' });
    mockSecretsService.getKey.mockResolvedValue('test-api-key');
    mockSecretsService.listProviders.mockResolvedValue(['openai']);
    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
    (createPgliteMastraMemory as Mock).mockResolvedValue({
      memory: mockPgliteMastraMemory,
      storage: mockPgliteMastraStorage,
      store: { listMessages: async () => ({ messages: [] }) },
      vector: {},
      workflows: {},
    });
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: false });
    const { streamResponse } = await import('../../assistant-server/http');
    (streamResponse as Mock).mockImplementation(async (res: { end: () => void }) => res.end());

    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: { resourceId: 'workspace-a', runId: 'answer-leg', threadId: thread.id },
          provider: 'openai',
        },
        messages: [],
        pausedMessageId: 'paused-ui-owner',
        runConfig: {
          custom: {
            brainstrikeToolApproval: {
              action: 'approve',
              hostRunId: 'host-leg',
              runId: 'native-run',
              toolCallId: 'canvas-call',
            },
          },
        },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(200);
    const { assistantDataStreamSessions, streamMastraToolApprovalAction } = await import(
      '@brainstrike/agent'
    );
    expect(streamMastraToolApprovalAction).toHaveBeenCalledTimes(1);
    expect(assistantDataStreamSessions.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        discovery: expect.objectContaining({
          actionReplay: expect.objectContaining({ pausedMessageId: 'native-owner' }),
        }),
      })
    );
  } finally {
    await database.close();
  }
});
