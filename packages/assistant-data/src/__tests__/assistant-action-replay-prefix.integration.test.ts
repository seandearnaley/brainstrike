import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
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
    expect(
      (
        await readPausedActionReplayPrefix({
          ...common,
          hostRunId: 'host-leg',
          pauseKind: 'suspend',
        })
      ).syntheticPauseMessageId
    ).toBe('suspended-pause:native-run:canvas-call');
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
      id: 'completed-canvas',
      kind: 'tool.completed',
      label: 'Tool completed',
      metadata: { toolCallId: 'canvas-call', toolName: 'brainstrike.manageCanvas' },
      sequence: 2,
      status: 'completed',
      timestamp: '2026-08-10T17:00:06Z',
    });
    await expect(
      readPausedActionReplayPrefix({ ...common, hostRunId: 'host-leg' })
    ).rejects.toThrow('disagrees');
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
