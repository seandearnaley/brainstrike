import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-approval';
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it } from 'vitest';
import {
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
  readPausedActionReplayPrefix,
} from '../assistant-memory-repository';
import { createMigratedTestPGlite } from './helpers/test-pglite';

let fixtureIndex = 0;

async function insertMessage(
  db: DbHandle,
  threadId: string,
  id: string,
  role: 'assistant' | 'user',
  parts: readonly Record<string, unknown>[],
  at: string
): Promise<void> {
  await db.query(
    `INSERT INTO mastra_messages
      (id, thread_id, content, role, type, "createdAt", "resourceId")
     VALUES ($1, $2, $3::jsonb, $4, 'v2', $5, 'workspace-a')`,
    [
      id,
      threadId,
      JSON.stringify({
        ...(role === 'user' ? { content: parts[0]?.['text'] } : {}),
        format: 2,
        parts,
      }),
      role,
      new Date(at),
    ]
  );
}

function toolPart(toolCallId: string): Record<string, unknown> {
  return {
    toolInvocation: {
      args: {},
      state: 'input-available',
      toolCallId,
      toolName: 'brainstrike_executeCommand',
    },
    type: 'tool-invocation',
  };
}

describe('action replay prefix', () => {
  it('proves a second pause on a transient resume message through its host turn', async () => {
    fixtureIndex += 1;
    const db = (await createMigratedTestPGlite(
      `memory://action-prefix-${fixtureIndex}`
    )) as DbHandle;
    const repository = createPgliteAssistantThreadRepository(db);
    const thread = await repository.createThread('workspace-a');
    let releaseStaleLookup!: () => void;
    const staleLookupGate = new Promise<void>((resolve) => {
      releaseStaleLookup = resolve;
    });
    let staleLookupStarted!: () => void;
    const staleLookupPending = new Promise<void>((resolve) => {
      staleLookupStarted = resolve;
    });
    const adapter = createAssistantThreadHistoryAdapter({
      repository: {
        ...repository,
        getThreadRunTurnMessageId: async (runId, runThreadId) => {
          if (runId === 'stale-host') {
            staleLookupStarted();
            await staleLookupGate;
          }
          return repository.getThreadRunTurnMessageId(runId, runThreadId);
        },
      },
      resourceId: 'workspace-a',
      threadId: thread.id,
    });
    type AppendItem = Parameters<typeof adapter.append>[0];
    const echo = (id: string, parentId: string, hostRunId: string, toolCallId: string) =>
      ({
        message: {
          attachments: [],
          content: [{ text: 'Approved', type: 'text' }],
          createdAt: new Date(),
          id,
          metadata: {
            custom: {
              [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
                action: 'approve',
                hostRunId,
                runId: 'native-run',
                toolCallId,
                toolName: 'brainstrike.executeCommand',
              },
            },
          },
          role: 'user',
        },
        parentId,
      }) as AppendItem;
    const resumedAssistant = (id: string, parentId: string, text: string): AppendItem =>
      ({
        message: {
          content: [{ text, type: 'text' }],
          createdAt: new Date(),
          id,
          metadata: {
            custom: {},
            steps: [],
            unstable_annotations: [],
            unstable_data: [],
            unstable_state: null,
          },
          role: 'assistant',
          status: { reason: 'stop', type: 'complete' },
        },
        parentId,
      }) as AppendItem;
    await insertMessage(
      db,
      thread.id,
      'user-a',
      'user',
      [{ text: 'prompt', type: 'text' }],
      '2026-08-10T17:00:00Z'
    );
    await insertMessage(
      db,
      thread.id,
      'canvas-owner',
      'assistant',
      [toolPart('canvas-call')],
      '2026-08-10T17:00:01Z'
    );
    await repository.recordMessageParent?.({
      messageId: 'user-a',
      parentId: null,
      resourceId: 'workspace-a',
      threadId: thread.id,
    });
    await repository.createThreadRun({
      id: 'canvas-host' as HostRunId,
      model: 'gpt-test',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: thread.id,
      turnMessageId: 'user-a',
    });
    await db.query(
      `INSERT INTO brainstrike_assistant_native_runs (native_run_id, host_run_id) VALUES ('native-run', 'canvas-host')`
    );
    await adapter.append(echo('canvas-echo', 'canvas-owner', 'canvas-host', 'canvas-call'));
    await adapter.append(resumedAssistant('resume-ui', 'canvas-echo', 'Workers paused'));
    expect(
      await repository.getMessageParent?.('resume-ui', thread.id, 'workspace-a')
    ).toBeUndefined();
    await insertMessage(
      db,
      thread.id,
      'worker-snapshot',
      'assistant',
      [toolPart('worker-call')],
      '2026-08-10T17:00:02Z'
    );
    await repository.createThreadRun({
      decision: { delegated: false, runId: 'native-run', toolCallId: 'canvas-call' },
      id: 'worker-host' as HostRunId,
      model: 'gpt-test',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: thread.id,
      turnMessageId: 'user-a',
    });
    await repository.appendThreadRunEvent('worker-host', {
      id: 'worker-approval',
      kind: 'tool.approval.requested',
      label: 'Awaiting approval',
      metadata: { toolCallId: 'worker-call' },
      sequence: 1,
      status: 'running',
      timestamp: '2026-08-10T17:00:03Z',
    });
    await adapter.append(echo('worker-echo', 'resume-ui', 'worker-host', 'worker-call'));
    expect(await repository.getMessageParent?.('resume-ui', thread.id, 'workspace-a')).toBe(
      'user-a'
    );
    const replay = await readPausedActionReplayPrefix({
      hostRunId: 'worker-host',
      nativeRunId: 'native-run',
      pausedMessageId: 'resume-ui',
      pauseKind: 'approval',
      repository,
      resourceId: 'workspace-a',
      threadId: thread.id,
      toolCallId: 'worker-call',
    });
    expect(replay.pausedMessageId).toBe('canvas-owner');
    expect(replay.pausedParentMessageId).toBe('user-a');
    await insertMessage(
      db,
      thread.id,
      'user-b',
      'user',
      [{ text: 'another turn', type: 'text' }],
      '2026-08-10T17:00:04Z'
    );
    await repository.createThreadRun({
      id: 'foreign-host' as HostRunId,
      model: 'gpt-test',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: thread.id,
      turnMessageId: 'user-b',
    });
    await expect(
      adapter.append(echo('foreign-echo', 'resume-ui', 'foreign-host', 'worker-call'))
    ).rejects.toThrow('disagrees with its durable host turn');
    // assistant-ui retains an optimistic action echo after a failed history
    // write. A later message must still resolve through its durable alias.
    await adapter.append({
      message: {
        attachments: [],
        content: [{ text: 'later prompt', type: 'text' }],
        createdAt: new Date(),
        id: 'after-failed-echo',
        metadata: { custom: {} },
        role: 'user',
      },
      parentId: 'foreign-echo',
    } as AppendItem);
    expect(await repository.getMessageParent?.('after-failed-echo', thread.id, 'workspace-a')).toBe(
      'canvas-owner'
    );
    await db.query(
      `UPDATE brainstrike_assistant_message_parents SET parent_id = 'user-b'
       WHERE thread_id = $1 AND message_id = 'resume-ui'`,
      [thread.id]
    );
    await expect(
      adapter.append(echo('conflict-echo', 'resume-ui', 'worker-host', 'worker-call'))
    ).rejects.toThrow('conflicting persisted parent');
    await adapter.append(resumedAssistant('resume-ui-2', 'worker-echo', 'Another pause'));
    await repository.createThreadRun({
      id: 'stale-host' as HostRunId,
      model: 'gpt-test',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: thread.id,
      turnMessageId: 'user-a',
    });
    const staleEcho = adapter.append(
      echo('stale-echo', 'resume-ui-2', 'stale-host', 'worker-call')
    );
    await staleLookupPending;
    await adapter.load();
    releaseStaleLookup();
    await expect(staleEcho).rejects.toThrow('changed while its parent was loading');
    expect(
      await repository.getMessageParent?.('resume-ui-2', thread.id, 'workspace-a')
    ).toBeUndefined();
    await repository.recordMessageParent?.({
      messageId: 'user-b',
      parentId: 'canvas-owner',
      resourceId: 'workspace-a',
      threadId: thread.id,
    });
    await insertMessage(
      db,
      thread.id,
      'assistant-b',
      'assistant',
      [toolPart('foreign-call')],
      '2026-08-10T17:00:05Z'
    );
    await repository.recordMessageParent?.({
      messageId: 'assistant-b',
      parentId: 'user-b',
      resourceId: 'workspace-a',
      threadId: thread.id,
    });
    await adapter.load();
    await adapter.append(echo('foreign-turn-echo', 'assistant-b', 'foreign-host', 'foreign-call'));
    await adapter.append(resumedAssistant('foreign-resume', 'foreign-turn-echo', 'Later pause'));
    await expect(
      adapter.append(echo('old-turn-echo', 'foreign-resume', 'worker-host', 'worker-call'))
    ).rejects.toThrow('disagrees with its durable host turn');
    expect(
      await repository.getMessageParent?.('foreign-resume', thread.id, 'workspace-a')
    ).toBeUndefined();
  });

  it('accepts a typed pause on an approval resume leg in the native owner generation', async () => {
    fixtureIndex += 1;
    const db = (await createMigratedTestPGlite(
      `memory://action-prefix-${fixtureIndex}`
    )) as DbHandle;
    const repository = createPgliteAssistantThreadRepository(db);
    const thread = await repository.createThread('workspace-a');
    await insertMessage(
      db,
      thread.id,
      'user-a',
      'user',
      [{ text: 'prompt', type: 'text' }],
      '2026-08-10T17:00:00Z'
    );
    await insertMessage(
      db,
      thread.id,
      'native-owner',
      'assistant',
      [toolPart('canvas-call')],
      '2026-08-10T17:00:01Z'
    );
    await repository.recordMessageParent?.({
      messageId: 'paused-gate-b-ui',
      parentId: 'user-a',
      resourceId: 'workspace-a',
      threadId: thread.id,
    });
    await repository.createThreadRun({
      id: 'first-host' as HostRunId,
      model: 'gpt-test',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: thread.id,
      turnMessageId: 'user-a',
    });
    await db.query(
      `INSERT INTO brainstrike_assistant_native_runs (native_run_id, host_run_id)
       VALUES ('native-run', 'first-host')`
    );
    await repository.appendThreadRunEvent('first-host', {
      id: 'gate-a-approval',
      kind: 'tool.approval.requested',
      label: 'Awaiting approval',
      metadata: { toolCallId: 'canvas-call' },
      sequence: 1,
      status: 'running',
      timestamp: '2026-08-10T17:00:02Z',
    });
    await repository.createThreadRun({
      decision: { delegated: false, runId: 'native-run', toolCallId: 'canvas-call' },
      id: 'resume-host' as HostRunId,
      model: 'gpt-test',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: thread.id,
      turnMessageId: 'user-a',
    });
    await repository.appendThreadRunEvent('resume-host', {
      id: 'gate-b-started',
      kind: 'tool.started',
      label: 'Tool started',
      metadata: { toolCallId: 'canvas-call' },
      sequence: 1,
      status: 'running',
      timestamp: '2026-08-10T17:00:03Z',
    });
    const action = {
      hostRunId: 'resume-host',
      nativeRunId: 'native-run',
      pausedMessageId: 'paused-gate-b-ui',
      pauseKind: 'suspend' as const,
      repository,
      resourceId: 'workspace-a',
      threadId: thread.id,
      toolCallId: 'canvas-call',
    };
    expect((await readPausedActionReplayPrefix(action)).pausedMessageId).toBe('native-owner');
    expect(
      (
        await db.query<{ hostRunId: string }>(
          `SELECT host_run_id AS "hostRunId" FROM brainstrike_assistant_native_runs
           WHERE native_run_id = 'native-run'`
        )
      ).rows[0]?.hostRunId
    ).toBe('first-host');

    const otherThread = await repository.createThread('workspace-a');
    await repository.createThreadRun({
      id: 'other-thread-host' as HostRunId,
      model: 'gpt-test',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: otherThread.id,
      turnMessageId: 'user-a',
    });
    await db.query(
      `UPDATE brainstrike_assistant_thread_runs
       SET generation_run_id = 'first-host' WHERE id = 'other-thread-host'`
    );
    expect(await repository.sharesNativeRunGeneration?.('other-thread-host', 'native-run')).toBe(
      false
    );
    await db.query(
      `UPDATE brainstrike_assistant_thread_runs
       SET thread_id = $1, resource_id = 'another-workspace' WHERE id = 'other-thread-host'`,
      [thread.id]
    );
    expect(await repository.sharesNativeRunGeneration?.('other-thread-host', 'native-run')).toBe(
      false
    );

    await db.query(
      `UPDATE brainstrike_assistant_thread_runs SET generation_run_id = id WHERE id = 'resume-host'`
    );
    await expect(readPausedActionReplayPrefix(action)).rejects.toThrow('disagrees');
    await db.query(
      `UPDATE brainstrike_assistant_thread_runs SET generation_run_id = NULL
       WHERE id IN ('first-host', 'resume-host')`
    );
    expect(await repository.sharesNativeRunGeneration?.('resume-host', 'native-run')).toBe(false);
    await expect(readPausedActionReplayPrefix(action)).rejects.toThrow('disagrees');
  });

  it('resolves a live paused UI owner through its exact host leg and durable parent', async () => {
    fixtureIndex += 1;
    const db = (await createMigratedTestPGlite(
      `memory://action-prefix-${fixtureIndex}`
    )) as DbHandle;
    const repository = createPgliteAssistantThreadRepository(db);
    const thread = await repository.createThread('workspace-a');
    await insertMessage(
      db,
      thread.id,
      'user-a',
      'user',
      [{ text: 'prompt', type: 'text' }],
      '2026-08-10T17:00:00Z'
    );
    await insertMessage(
      db,
      thread.id,
      'native-owner',
      'assistant',
      [toolPart('canvas-call')],
      '2026-08-10T17:00:01Z'
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
    await db.query(
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
    const common = {
      nativeRunId: 'native-run',
      pausedMessageId: 'paused-ui-owner',
      pauseKind: 'approval' as const,
      repository,
      resourceId: 'workspace-a',
      threadId: thread.id,
      toolCallId: 'canvas-call',
    };
    expect(
      (await readPausedActionReplayPrefix({ ...common, hostRunId: 'host-leg' })).pausedMessageId
    ).toBe('native-owner');
    await db.query(`DELETE FROM brainstrike_assistant_run_events WHERE id = 'pending-canvas'`);
    const typedSuspension = { ...common, hostRunId: 'host-leg', pauseKind: 'suspend' as const };
    await expect(readPausedActionReplayPrefix(typedSuspension)).rejects.toThrow('disagrees');
    await repository.appendThreadRunEvent('host-leg', {
      id: 'unsupported-suspend',
      kind: 'tool.resume.unsupported',
      label: 'Tool pause cannot be answered by this build (no registered resume UI)',
      metadata: {
        resumeSupportedByClient: false,
        runId: 'native-run',
        runStillSuspended: true,
        suspended: true,
        toolCallId: 'canvas-call',
        toolName: 'brainstrike.manageCanvas',
        unregisteredResumeSchema: true,
      },
      sequence: 2,
      status: 'failed',
      timestamp: '2026-08-10T17:00:02Z',
    });
    await expect(readPausedActionReplayPrefix(typedSuspension)).rejects.toThrow('disagrees');
    await repository.appendThreadRunEvent('host-leg', {
      id: 'started-typed-suspend',
      kind: 'tool.started',
      label: 'Tool started',
      metadata: { toolCallId: 'canvas-call', toolName: 'brainstrike.manageCanvas' },
      sequence: 3,
      status: 'running',
      timestamp: '2026-08-10T17:00:02Z',
    });
    expect((await readPausedActionReplayPrefix(typedSuspension)).syntheticPauseMessageId).toBe(
      'suspended-pause:native-run:canvas-call'
    );
    await db.query(`DELETE FROM brainstrike_assistant_run_events WHERE id = 'unsupported-suspend'`);
    expect((await readPausedActionReplayPrefix(typedSuspension)).pausedMessageId).toBe(
      'native-owner'
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
    await expect(
      readPausedActionReplayPrefix({ ...common, hostRunId: 'wrong-host' })
    ).rejects.toThrow('disagrees');
    await expect(
      readPausedActionReplayPrefix({
        ...common,
        hostRunId: 'host-leg',
        nativeRunId: 'wrong-native-run',
      })
    ).rejects.toThrow('disagrees');
    await expect(
      readPausedActionReplayPrefix({ ...common, hostRunId: 'host-leg', pausedMessageId: 'unknown' })
    ).rejects.toThrow('disagrees');
    await insertMessage(
      db,
      thread.id,
      'user-b',
      'user',
      [{ text: 'another turn', type: 'text' }],
      '2026-08-10T17:00:03Z'
    );
    await repository.createThreadRun({
      id: 'other-host-leg' as HostRunId,
      model: 'gpt-test',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: thread.id,
      turnMessageId: 'user-b',
    });
    await repository.appendThreadRunEvent('other-host-leg', {
      id: 'other-generation-terminal',
      kind: 'tool.completed',
      label: 'Tool completed',
      metadata: { toolCallId: 'canvas-call', toolName: 'brainstrike.manageCanvas' },
      sequence: 1,
      status: 'completed',
      timestamp: '2026-08-10T17:00:03Z',
    });
    expect(
      (await readPausedActionReplayPrefix({ ...common, hostRunId: 'host-leg' })).pausedMessageId
    ).toBe('native-owner');
    await db.query(
      `UPDATE brainstrike_assistant_thread_runs SET generation_run_id = 'host-leg'
       WHERE id = 'other-host-leg'`
    );
    await expect(
      readPausedActionReplayPrefix({ ...common, hostRunId: 'host-leg' })
    ).rejects.toThrow('disagrees');
    await db.query(
      `UPDATE brainstrike_assistant_thread_runs SET generation_run_id = NULL
       WHERE id IN ('host-leg', 'other-host-leg')`
    );
    expect(
      (await readPausedActionReplayPrefix({ ...common, hostRunId: 'host-leg' })).pausedMessageId
    ).toBe('native-owner');
    await insertMessage(
      db,
      thread.id,
      'other-durable',
      'assistant',
      [{ text: 'another assistant', type: 'text' }],
      '2026-08-10T17:00:04Z'
    );
    await expect(
      readPausedActionReplayPrefix({
        ...common,
        hostRunId: 'host-leg',
        pausedMessageId: 'other-durable',
      })
    ).rejects.toThrow('disagrees');
    await repository.recordMessageParent?.({
      messageId: 'wrong-turn-ui',
      parentId: 'user-b',
      resourceId: 'workspace-a',
      threadId: thread.id,
    });
    await expect(
      readPausedActionReplayPrefix({
        ...common,
        hostRunId: 'host-leg',
        pausedMessageId: 'wrong-turn-ui',
      })
    ).rejects.toThrow('disagrees');
    await insertMessage(
      db,
      thread.id,
      'colliding-native-owner',
      'assistant',
      [toolPart('canvas-call')],
      '2026-08-10T17:00:05Z'
    );
    await expect(
      readPausedActionReplayPrefix({ ...common, hostRunId: 'host-leg' })
    ).rejects.toThrow('disagrees');
    await db.query(`DELETE FROM mastra_messages WHERE id = 'colliding-native-owner'`);
    await repository.appendThreadRunEvent('host-leg', {
      id: 'declined-canvas',
      kind: 'tool.failed',
      label: 'Tool call declined',
      metadata: { toolCallId: 'canvas-call', toolName: 'brainstrike.manageCanvas' },
      sequence: 4,
      status: 'failed',
      timestamp: '2026-08-10T17:00:06Z',
    });
    await expect(
      readPausedActionReplayPrefix({ ...common, hostRunId: 'host-leg' })
    ).rejects.toThrow('disagrees');
    await expect(readPausedActionReplayPrefix(typedSuspension)).rejects.toThrow('disagrees');
  });

  it('selects two same-turn pauses by exact tool identity and freezes the pre-resume prefix', async () => {
    fixtureIndex += 1;
    const db = (await createMigratedTestPGlite(
      `memory://action-prefix-${fixtureIndex}`
    )) as DbHandle;
    const repository = createPgliteAssistantThreadRepository(db);
    const thread = await repository.createThread('workspace-a');
    await insertMessage(
      db,
      thread.id,
      'user-a',
      'user',
      [{ text: 'prompt', type: 'text' }],
      '2026-08-10T17:00:00Z'
    );
    await insertMessage(
      db,
      thread.id,
      'assistant-a',
      'assistant',
      [{ text: 'before decisions', type: 'text' }, toolPart('call-1'), toolPart('call-2')],
      '2026-08-10T17:00:01Z'
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_message_parents
       (thread_id, resource_id, message_id, parent_id)
       VALUES ($1, 'workspace-a', 'assistant-a', 'user-a')`,
      [thread.id]
    );
    expect(
      (await repository.listMessages(thread.id, 'workspace-a')).find(
        (row) => row.id === 'assistant-a'
      )?.parentId
    ).toBe('user-a');
    const common = {
      nativeRunId: 'run-1',
      pauseKind: 'approval' as const,
      repository,
      resourceId: 'workspace-a',
      threadId: thread.id,
    };
    const first = await readPausedActionReplayPrefix({
      ...common,
      pausedMessageId: 'assistant-a',
      toolCallId: 'call-1',
    });
    const second = await readPausedActionReplayPrefix({
      ...common,
      pausedMessageId: 'suspended-approval:run-1:call-2',
      toolCallId: 'call-2',
    });
    expect(first.prefixContent).toEqual(second.prefixContent);
    expect(first.pausedMessageId).toBe(second.pausedMessageId);
    expect(first.pausedMessageId).toBe('assistant-a');
    expect(first.pausedParentMessageId).toBe('user-a');
    expect(first.syntheticPauseMessageId).toBe('suspended-approval:run-1:call-1');
    const delegated = await readPausedActionReplayPrefix({
      delegation: {
        path: [
          {
            childRuntimeRunId: 'child-run',
            parentRuntimeRunId: 'parent-run',
            parentToolCallId: 'call-2',
            personaId: 'explore',
          },
        ],
        toolCallId: 'leaf-call',
      },
      nativeRunId: 'parent-run',
      pausedMessageId: 'suspended-approval:["child-run","leaf-call"]',
      pauseKind: 'approval',
      repository,
      resourceId: 'workspace-a',
      threadId: thread.id,
      toolCallId: 'call-2',
    });
    expect(delegated.pausedMessageId).toBe('assistant-a');
    expect(delegated.syntheticPauseMessageId).toBe('suspended-approval:["child-run","leaf-call"]');
    await db.query(
      `DELETE FROM brainstrike_assistant_message_parents WHERE thread_id = $1 AND message_id = 'assistant-a'`,
      [thread.id]
    );
    expect(
      (
        await readPausedActionReplayPrefix({
          ...common,
          pausedMessageId: 'assistant-a',
          toolCallId: 'call-1',
        })
      ).pausedParentMessageId
    ).toBe('user-a');
    await expect(
      readPausedActionReplayPrefix({
        ...common,
        pausedMessageId: 'another-assistant',
        toolCallId: 'call-1',
      })
    ).rejects.toThrow('disagrees');
    await expect(
      readPausedActionReplayPrefix({
        ...common,
        pausedMessageId: 'suspended-approval:wrong-run:call-1',
        toolCallId: 'call-1',
      })
    ).rejects.toThrow('disagrees');
    await db.query(
      `INSERT INTO brainstrike_assistant_message_parents
       (thread_id, resource_id, message_id, parent_id)
       VALUES ($1, 'workspace-a', 'assistant-a', 'user-a')`,
      [thread.id]
    );

    await insertMessage(
      db,
      thread.id,
      'continuation',
      'assistant',
      [{ text: 'after decision', type: 'text' }],
      '2026-08-10T17:00:02Z'
    );
    expect(
      first.prefixContent.some((part) => part.type === 'text' && part.text === 'after decision')
    ).toBe(false);

    await insertMessage(
      db,
      thread.id,
      'user-b',
      'user',
      [{ text: 'other turn', type: 'text' }],
      '2026-08-10T17:00:03Z'
    );
    await insertMessage(
      db,
      thread.id,
      'assistant-b',
      'assistant',
      [toolPart('call-1')],
      '2026-08-10T17:00:04Z'
    );
    expect(
      (
        await readPausedActionReplayPrefix({
          ...common,
          pausedMessageId: 'assistant-a',
          toolCallId: 'call-1',
        })
      ).pausedMessageId
    ).toBe('assistant-a');
    await expect(readPausedActionReplayPrefix({ ...common, toolCallId: 'call-1' })).rejects.toThrow(
      'no unique durable assistant owner'
    );
    await expect(
      readPausedActionReplayPrefix({
        ...common,
        pausedMessageId: 'suspended-approval:run-1:call-1',
        toolCallId: 'call-1',
      })
    ).rejects.toThrow('no unique durable assistant owner');
  });
});
