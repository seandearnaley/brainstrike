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
    await expect(readPausedActionReplayPrefix({ ...common, toolCallId: 'call-1' })).rejects.toThrow(
      'no unique durable assistant owner'
    );
  });
});
