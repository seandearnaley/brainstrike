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
vi.mock(
  '../../../../../packages/host-capabilities/src/native-tools/workspace-text-file-reader',
  async () => (await mocks()).makeWorkspaceTextFileReaderMock()
);
vi.mock('../../db-main', async () => (await mocks()).makeDbMainMock());

const runRequest = createRunRequest(handleAssistantRequest);

afterEach(() => {
  vi.clearAllMocks();
  resetDesktopMastraMemoryCacheForTests();
});

it('replays a typed Gate B suspension on the Gate A approval continuation host leg', async () => {
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

    // A continuation tool belongs to the child's receipt/transcript, not a
    // parent message. Its native decision still runs through the normal action
    // stream; only root transcript replay is inapplicable.
    const childResponse = await runRequest({
      body: JSON.stringify({
        data: {
          memory: { resourceId: 'workspace-a', runId: 'child-answer-leg', threadId: thread.id },
          provider: 'openai',
        },
        messages: [],
        runConfig: {
          custom: {
            brainstrikeToolApproval: {
              action: 'approve',
              continuationId: 'child-continuation',
              hostRunId: 'host-leg',
              runId: 'child-native-run',
              toolCallId: 'child-only-call',
            },
          },
        },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });
    expect(childResponse.status).toBe(200);
    expect(streamMastraToolApprovalAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        continuationId: 'child-continuation',
        toolCallId: 'child-only-call',
      }),
      expect.anything()
    );
    const childSession = vi.mocked(assistantDataStreamSessions.create).mock.calls.at(-1);
    expect(childSession?.[1]?.discovery).toBeDefined();
    expect(childSession?.[1]?.discovery).not.toHaveProperty('actionReplay');

    // Exercise the real approval router for an untrusted continuation ID. It
    // must reject at the durable child owner, never fall through to root resume.
    await repository.createThreadRun({
      id: 'forged-answer-leg' as HostRunId,
      model: 'gpt-test',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: thread.id,
      turnMessageId: 'user-a',
    });
    const actualAgent =
      await vi.importActual<typeof import('@brainstrike/agent')>('@brainstrike/agent');
    vi.mocked(streamMastraToolApprovalAction).mockImplementationOnce(
      actualAgent.streamMastraToolApprovalAction
    );
    const forged = await runRequest({
      body: JSON.stringify({
        data: {
          memory: { resourceId: 'workspace-a', runId: 'forged-answer-leg', threadId: thread.id },
          provider: 'openai',
        },
        messages: [],
        runConfig: {
          custom: {
            brainstrikeToolApproval: {
              action: 'approve',
              continuationId: 'unknown-child-receipt',
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
    expect(forged.status).toBe(502);
    expect(JSON.parse(forged.body)).toMatchObject({
      error: 'agent_stream_init_failed',
      stage: 'stream_construction',
    });
    expect(assistantDataStreamSessions.create).toHaveBeenCalledTimes(2);
    expect(
      (await database.query('SELECT * FROM brainstrike_delegated_continuation_decisions')).rows
    ).toEqual([]);

    // Gate A resumed the original native run on a new host leg. The native
    // mapping stays with its first leg; Gate B is suspended on this second leg.
    await repository.createThreadRun({
      decision: { delegated: false, runId: 'native-run', toolCallId: 'canvas-call' },
      id: 'gate-b-host' as HostRunId,
      model: 'gpt-test',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: thread.id,
      turnMessageId: 'user-a',
    });
    await repository.recordMessageParent?.({
      messageId: 'gate-b-paused-ui-owner',
      parentId: 'user-a',
      resourceId: 'workspace-a',
      threadId: thread.id,
    });
    await repository.appendThreadRunEvent('gate-b-host', {
      id: 'gate-b-started',
      kind: 'tool.started',
      label: 'Tool started',
      metadata: { toolCallId: 'canvas-call', toolName: 'brainstrike.manageCanvas' },
      sequence: 1,
      status: 'running',
      timestamp: '2026-08-10T17:00:03Z',
    });

    const resumeGateB = (
      hostRunId: string,
      threadId: string,
      pausedId: string
    ): ReturnType<typeof runRequest> =>
      runRequest({
        body: JSON.stringify({
          data: {
            memory: { resourceId: 'workspace-a', runId: `answer-${hostRunId}`, threadId },
            provider: 'openai',
          },
          messages: [],
          pausedMessageId: pausedId,
          runConfig: {
            custom: {
              brainstrikeToolSuspend: {
                hostRunId,
                resumeData: { answer: 'continue' },
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

    const gateBResponse = await resumeGateB('gate-b-host', thread.id, 'gate-b-paused-ui-owner');
    expect(gateBResponse.status).toBe(200);
    const { streamMastraToolResumeAction } = await import('@brainstrike/agent');
    expect(streamMastraToolResumeAction).toHaveBeenCalledTimes(1);
    expect(streamMastraToolResumeAction).toHaveBeenCalledWith(
      expect.objectContaining({ hostRunId: 'gate-b-host', runId: 'native-run' }),
      expect.anything()
    );
    expect(assistantDataStreamSessions.create).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        discovery: expect.objectContaining({
          actionReplay: expect.objectContaining({ pausedMessageId: 'native-owner' }),
        }),
      })
    );

    // The same thread and turn are insufficient when the host leg opened a
    // different generation, even with a matching transient parent and event.
    await repository.createThreadRun({
      id: 'other-generation-host' as HostRunId,
      model: 'gpt-test',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: thread.id,
      turnMessageId: 'user-a',
    });
    await repository.appendThreadRunEvent('other-generation-host', {
      id: 'other-generation-started',
      kind: 'tool.started',
      label: 'Tool started',
      metadata: { toolCallId: 'canvas-call', toolName: 'brainstrike.manageCanvas' },
      sequence: 1,
      status: 'running',
      timestamp: '2026-08-10T17:00:04Z',
    });
    const wrongGeneration = await resumeGateB(
      'other-generation-host',
      thread.id,
      'gate-b-paused-ui-owner'
    );
    expect(wrongGeneration.status).toBe(500);
    expect(JSON.parse(wrongGeneration.body)).toEqual({
      error: 'assistant_admission_rejected',
      message: 'Assistant stream failed.',
    });
    expect(streamMastraToolResumeAction).toHaveBeenCalledTimes(1);

    const otherThread = await repository.createThread('workspace-a');
    await database.query(
      `INSERT INTO mastra_messages
        (id, thread_id, content, role, type, "createdAt", "resourceId")
       VALUES ($1, $2, $3::jsonb, 'user', 'v2', $4, 'workspace-a'),
              ($5, $2, $6::jsonb, 'assistant', 'v2', $7, 'workspace-a')`,
      [
        'other-user',
        otherThread.id,
        JSON.stringify({ format: 2, parts: [{ text: 'Other thread', type: 'text' }] }),
        new Date('2026-08-10T17:00:00Z'),
        'other-native-owner',
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
      messageId: 'other-paused-ui-owner',
      parentId: 'other-user',
      resourceId: 'workspace-a',
      threadId: otherThread.id,
    });
    await repository.createThreadRun({
      id: 'other-thread-host' as HostRunId,
      model: 'gpt-test',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: otherThread.id,
      turnMessageId: 'other-user',
    });
    // Give it the same generation ID to isolate thread ownership as the guard.
    await database.query(
      `UPDATE brainstrike_assistant_thread_runs SET generation_run_id = 'host-leg'
       WHERE id = 'other-thread-host'`
    );
    await repository.appendThreadRunEvent('other-thread-host', {
      id: 'other-thread-started',
      kind: 'tool.started',
      label: 'Tool started',
      metadata: { toolCallId: 'canvas-call', toolName: 'brainstrike.manageCanvas' },
      sequence: 1,
      status: 'running',
      timestamp: '2026-08-10T17:00:04Z',
    });
    const wrongThread = await resumeGateB(
      'other-thread-host',
      otherThread.id,
      'other-paused-ui-owner'
    );
    expect(wrongThread.status).toBe(500);
    expect(JSON.parse(wrongThread.body)).toEqual({
      error: 'assistant_admission_rejected',
      message: 'Assistant stream failed.',
    });
    expect(streamMastraToolResumeAction).toHaveBeenCalledTimes(1);
  } finally {
    await database.close();
  }
});
