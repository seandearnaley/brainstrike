import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
import { createDelegatedConversationRepository } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it } from 'vitest';
import {
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

describe('delegated action replay prefix', () => {
  it('resolves a transient late child approval after its parent dispatch completed (BST-1902)', async () => {
    fixtureIndex += 1;
    const db = (await createMigratedTestPGlite(
      `memory://action-prefix-${fixtureIndex}`
    )) as DbHandle;
    const repository = createPgliteAssistantThreadRepository(db);
    const thread = await repository.createThread('workspace-a');
    const child = await repository.createThread('workspace-a-explore');
    const graph = createDelegatedConversationRepository(db);
    const scope = { ownerResourceId: 'workspace-a', rootThreadId: thread.id };
    const parentRuntimeRunId = 'df0c8998-1035-47cd-b7f6-149a8060ae80';
    const parentToolCallId = 'chatcmpl-tool-bfe4635d14b03065';
    const identity = {
      childRuntimeRunId: '9f05ad21-68f7-4d37-8d75-05d831e5791e',
      parentRuntimeRunId,
      parentToolCallId,
      personaId: 'explore',
    };
    const leafToolCallId = 'call_01a0f2f66e4c73e3817d5fad';
    const hostRunId = 'run-f3a8240d-abf3-4cb5-a66b-3af76b7853eb' as HostRunId;
    const ownerId = '98ca76ce-201b-4806-a22e-57d7a09c1174';
    const newestId = 'de7068e6-1dd4-4bf0-9a84-db0828e259a8';
    const turnMessageId = 'pzJaHnV';
    await insertMessage(
      db,
      thread.id,
      turnMessageId,
      'user',
      [{ text: 'Explore the workspace in the background', type: 'text' }],
      '2026-09-30T15:39:00Z'
    );
    await insertMessage(
      db,
      thread.id,
      ownerId,
      'assistant',
      [
        {
          toolInvocation: {
            args: { prompt: 'Read workspace files', runInBackground: true },
            result: 'Background task started.',
            state: 'result',
            toolCallId: parentToolCallId,
            toolName: 'agent-explore',
          },
          type: 'tool-invocation',
        },
      ],
      '2026-09-30T15:39:29.691Z'
    );
    await insertMessage(
      db,
      thread.id,
      newestId,
      'assistant',
      [{ text: 'The background explorer is running.', type: 'text' }],
      '2026-09-30T15:39:54Z'
    );
    for (const [messageId, parentId] of [
      [turnMessageId, null],
      [ownerId, turnMessageId],
      [newestId, ownerId],
      ['MznxKuj', turnMessageId],
    ] as const) {
      await repository.recordMessageParent?.({
        messageId,
        parentId,
        resourceId: 'workspace-a',
        threadId: thread.id,
      });
    }
    const host = {
      model: 'gpt-test',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted' as const,
      threadId: thread.id,
      turnMessageId,
    };
    await repository.createThreadRun({ ...host, id: 'original-host' as HostRunId });
    await db.query(
      `INSERT INTO brainstrike_assistant_native_runs (native_run_id, host_run_id)
       VALUES ($1, 'original-host')`,
      [parentRuntimeRunId]
    );
    await graph.registerRoot(scope);
    await graph.createChild(scope, {
      color: 'blue',
      configuration: {},
      displayName: 'Explorer',
      parentThreadId: thread.id,
      resourceId: 'workspace-a-explore',
      threadId: child.id,
    });
    await graph.createInvocation(scope, {
      hostRunId: 'original-host',
      originalToolCall: { args: { prompt: 'Read workspace files' }, toolName: 'agent-explore' },
      parentRuntimeRunId,
      parentThreadId: thread.id,
      parentToolCallId,
      personaId: 'explore',
      threadId: child.id,
    });
    await graph.bindInvocationRun(scope, identity, identity.childRuntimeRunId);
    await repository.createThreadRun({
      ...host,
      decision: { delegated: true, runId: parentRuntimeRunId, toolCallId: parentToolCallId },
      id: hostRunId,
    });
    // Parent completion acknowledges background dispatch; it does not resolve the leaf.
    await repository.appendThreadRunEvent(hostRunId, {
      id: 'parent-dispatch-completed',
      kind: 'tool.completed',
      label: 'Explorer dispatched',
      metadata: { toolCallId: parentToolCallId, toolName: 'agent-explore' },
      sequence: 6,
      status: 'completed',
      timestamp: '2026-09-30T15:39:29.690Z',
    });
    const pendingEvent = {
      id: 'child-leaf-awaiting-approval',
      kind: 'tool.approval.requested',
      label: 'Awaiting approval',
      metadata: {
        ...identity,
        nativeMessageId: 'b2f82103-11a6-4d86-84ca-e85316c76fd6',
        toolCallId: leafToolCallId,
        toolName: 'brainstrike.readWorkspaceFile',
      },
      runId: 'delegated-child-host',
      sequence: 0,
      status: 'running',
      timestamp: '2026-09-30T15:39:33.103Z',
    } as const;
    await graph.recordInvocationEvent(scope, identity, hostRunId, pendingEvent);
    await repository.appendThreadRunEvent(hostRunId, {
      id: 'projected-child-approval',
      kind: 'tool.approval.requested',
      label: 'Awaiting approval',
      metadata: { toolCallId: parentToolCallId, toolName: 'brainstrike.readWorkspaceFile' },
      sequence: 23,
      status: 'running',
      timestamp: '2026-09-30T15:39:33.154Z',
    });
    await repository.completeThreadRun(hostRunId, { status: 'completed' });

    // Parent terminal evidence remains true; the child leaf independently remains pending.
    expect(await repository.getMessageParent?.('MznxKuj', thread.id, 'workspace-a')).toBe(
      turnMessageId
    );
    expect(await repository.getThreadRunTurnMessageId(hostRunId, thread.id)).toBe(turnMessageId);
    expect(await repository.sharesNativeRunGeneration?.(hostRunId, parentRuntimeRunId)).toBe(true);
    expect(await repository.hasResolvedToolCallInGeneration?.(hostRunId, parentToolCallId)).toBe(
      true
    );
    expect(
      (await repository.listThreadRunEvents(thread.id, 'workspace-a')).some(
        (event) =>
          event.runId === hostRunId &&
          event.kind === 'tool.approval.requested' &&
          event.metadata?.['toolCallId'] === parentToolCallId
      )
    ).toBe(true);
    const childEvents = await repository.listThreadRunEvents(child.id, 'workspace-a-explore');
    expect(childEvents).toHaveLength(1);
    expect(childEvents[0]?.kind).toBe('tool.approval.requested');
    expect(childEvents[0]?.metadata?.['toolCallId']).toBe(leafToolCallId);
    const action = {
      delegation: { path: [identity], toolCallId: leafToolCallId },
      hostRunId,
      nativeRunId: parentRuntimeRunId,
      pausedMessageId: 'MznxKuj',
      pauseKind: 'approval' as const,
      repository,
      resourceId: 'workspace-a',
      threadId: thread.id,
      toolCallId: parentToolCallId,
    };
    const replay = await readPausedActionReplayPrefix(action);
    expect(replay.pausedMessageId).toBe(ownerId);
    expect(replay.pausedParentMessageId).toBe(turnMessageId);
    const grandchild = await repository.createThread('workspace-a-grandchild');
    const nestedIdentity = {
      childRuntimeRunId: 'nested-native-run',
      parentRuntimeRunId: identity.childRuntimeRunId,
      parentToolCallId: 'nested-dispatch-call',
      personaId: 'analyst',
    };
    await graph.createChild(scope, {
      color: 'green',
      configuration: {},
      displayName: 'Analyst',
      parentThreadId: child.id,
      resourceId: 'workspace-a-grandchild',
      threadId: grandchild.id,
    });
    // Nested invocations retain the original ROOT host/turn, with a CHILD parent thread.
    await graph.createInvocation(scope, {
      hostRunId: 'original-host',
      parentRuntimeRunId: nestedIdentity.parentRuntimeRunId,
      parentThreadId: child.id,
      parentToolCallId: nestedIdentity.parentToolCallId,
      personaId: 'analyst',
      threadId: grandchild.id,
    });
    await graph.bindInvocationRun(scope, nestedIdentity, nestedIdentity.childRuntimeRunId);
    await graph.recordInvocationEvent(scope, nestedIdentity, hostRunId, {
      ...pendingEvent,
      id: 'nested-leaf-awaiting-approval',
      metadata: {
        ...nestedIdentity,
        toolCallId: 'nested-leaf',
        toolName: 'brainstrike.readWorkspaceFile',
      },
      runId: 'grandchild-host',
    });
    const nestedAction = {
      ...action,
      delegation: { path: [identity, nestedIdentity], toolCallId: 'nested-leaf' },
    };
    expect((await readPausedActionReplayPrefix(nestedAction)).pausedMessageId).toBe(ownerId);
    await db.query(
      'UPDATE brainstrike_delegated_invocations SET cancellation_requested_at = NOW() WHERE thread_id = $1',
      [child.id]
    );
    await expect(readPausedActionReplayPrefix(nestedAction)).rejects.toThrow('disagrees');
    await expect(readPausedActionReplayPrefix(action)).rejects.toThrow('disagrees');
    await db.query(
      'UPDATE brainstrike_delegated_invocations SET cancellation_requested_at = NULL WHERE thread_id = $1',
      [child.id]
    );
    await db.query(
      'UPDATE brainstrike_delegated_invocations SET cancellation_requested_at = NOW() WHERE thread_id = $1',
      [grandchild.id]
    );
    await expect(readPausedActionReplayPrefix(nestedAction)).rejects.toThrow('disagrees');
    expect((await readPausedActionReplayPrefix(action)).pausedMessageId).toBe(ownerId);
    await db.query(
      'UPDATE brainstrike_delegated_invocations SET cancellation_requested_at = NULL WHERE thread_id = $1',
      [grandchild.id]
    );
    await db.query('UPDATE brainstrike_assistant_thread_runs SET status = $1 WHERE id = $2', [
      'cancelled',
      hostRunId,
    ]);
    await expect(readPausedActionReplayPrefix(action)).rejects.toThrow('disagrees');
    await db.query('UPDATE brainstrike_assistant_thread_runs SET status = $1 WHERE id = $2', [
      'completed',
      hostRunId,
    ]);
    // Reconstruction reads durable proofs, rather than retaining an in-memory exception.
    const reconstructedRepository = createPgliteAssistantThreadRepository({
      query: <T>(sql: string, params?: unknown[]) => db.query<T>(sql, params),
    });
    expect(reconstructedRepository).not.toBe(repository);
    expect(
      (
        await readPausedActionReplayPrefix({
          ...action,
          repository: reconstructedRepository,
        })
      ).pausedMessageId
    ).toBe(ownerId);
    const { delegation: _delegation, ...rootAction } = action;
    await expect(readPausedActionReplayPrefix(rootAction)).rejects.toThrow('disagrees');
    await expect(
      readPausedActionReplayPrefix({ ...action, nativeRunId: 'foreign-native-root' })
    ).rejects.toThrow('disagrees');
    await expect(
      readPausedActionReplayPrefix({
        ...nestedAction,
        delegation: {
          path: [identity, { ...nestedIdentity, personaId: 'worker' }],
          toolCallId: 'nested-leaf',
        },
      })
    ).rejects.toThrow('disagrees');
    for (const wrongEdge of [
      { ...identity, childRuntimeRunId: 'foreign-native-child' },
      { ...identity, personaId: 'worker' },
      { ...identity, parentToolCallId: 'foreign-parent-call' },
    ]) {
      await expect(
        readPausedActionReplayPrefix({
          ...action,
          delegation: { path: [wrongEdge], toolCallId: leafToolCallId },
        })
      ).rejects.toThrow();
    }
    await expect(
      readPausedActionReplayPrefix({
        ...action,
        delegation: {
          path: [
            identity,
            {
              ...identity,
              childRuntimeRunId: 'forged-grandchild',
              parentRuntimeRunId: identity.childRuntimeRunId,
              parentToolCallId: 'forged-nested-dispatch',
            },
          ],
          toolCallId: leafToolCallId,
        },
      })
    ).rejects.toThrow();
    await expect(
      readPausedActionReplayPrefix({
        ...action,
        delegation: { path: [identity], toolCallId: 'different-leaf' },
      })
    ).rejects.toThrow('disagrees');
    await db.query(
      'UPDATE brainstrike_assistant_thread_runs SET turn_message_id = $1 WHERE id = $2',
      ['foreign-turn', 'original-host']
    );
    await expect(readPausedActionReplayPrefix(action)).rejects.toThrow();
    await db.query(
      'UPDATE brainstrike_assistant_thread_runs SET turn_message_id = $1 WHERE id = $2',
      [turnMessageId, 'original-host']
    );

    await db.query('DELETE FROM brainstrike_assistant_run_events WHERE id = $1', [pendingEvent.id]);
    await expect(readPausedActionReplayPrefix(action)).rejects.toThrow('disagrees');
    await graph.recordInvocationEvent(scope, identity, hostRunId, pendingEvent);
    await graph.recordInvocationEvent(scope, identity, hostRunId, {
      ...pendingEvent,
      id: 'ambiguous-second-leaf-pause',
      sequence: 1,
    });
    await expect(readPausedActionReplayPrefix(action)).rejects.toThrow('disagrees');
    await db.query('DELETE FROM brainstrike_assistant_run_events WHERE id = $1', [
      'ambiguous-second-leaf-pause',
    ]);
    for (const state of ['claimed', 'consumed', 'interrupted'] as const) {
      await db.query(
        `INSERT INTO brainstrike_delegated_tool_decisions
         (id, owner_resource_id, root_thread_id, parent_runtime_run_id, parent_tool_call_id,
          child_thread_id, child_runtime_run_id, tool_call_id, host_run_id, state)
         VALUES ('leaf-decision', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          'workspace-a',
          thread.id,
          parentRuntimeRunId,
          parentToolCallId,
          child.id,
          identity.childRuntimeRunId,
          leafToolCallId,
          hostRunId,
          state,
        ]
      );
      await expect(readPausedActionReplayPrefix(action)).rejects.toThrow('disagrees');
      await db.query("DELETE FROM brainstrike_delegated_tool_decisions WHERE id = 'leaf-decision'");
    }
    for (const kind of ['tool.completed', 'tool.failed', 'run.finished'] as const) {
      await graph.recordInvocationEvent(scope, identity, hostRunId, {
        ...pendingEvent,
        id: 'terminal-child-leaf',
        kind,
        sequence: 2,
        status: 'completed',
        timestamp: '2026-09-30T15:40:00Z',
      });
      await expect(readPausedActionReplayPrefix(action)).rejects.toThrow('disagrees');
      await db.query(
        "DELETE FROM brainstrike_assistant_run_events WHERE id = 'terminal-child-leaf'"
      );
    }
  });
});
