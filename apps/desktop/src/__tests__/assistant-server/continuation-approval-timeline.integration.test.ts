// @vitest-environment node
import type { StreamChunk } from '@brainstrike/agent';
import { createDelegatedConversationRepository, migrate, wasmLoader } from '@brainstrike/db';
import { expect, it } from 'vitest';
import { observeDesktopAssistantRunEvents } from '../../assistant-server/run-persistence';
import { createBudgetedHost } from './fixtures/budgeted-host';

it('uses the persisted continuation timeline for approval display without a root decision anchor', async () => {
  const database = await wasmLoader.createPGlite('memory://continuation-approval-timeline');
  try {
    await migrate(database);
    await database.exec(`INSERT INTO mastra_threads (id,"resourceId",title,metadata,"createdAt","updatedAt") VALUES
      ('root','owner','Root','{}',NOW(),NOW()),('child','child-resource','Child','{}',NOW(),NOW());
      INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id,generation_run_id)
      VALUES ('wake-host','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'new-root-user','wake-host');`);
    const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
    const graph = createDelegatedConversationRepository(database);
    await graph.registerRoot(scope);
    await graph.createChild(scope, {
      color: 'blue',
      configuration: { maxSteps: 8, persona: { id: 'worker', instructions: 'Inspect the file' } },
      displayName: 'Worker',
      parentThreadId: 'root',
      resourceId: 'child-resource',
      threadId: 'child',
    });
    const input = { id: 'new-human-input', text: 'Continue the work.', threadId: 'child' };
    const host = createBudgetedHost(database, 'wake-host').continuation;
    await host.prepareContinuation(input);
    const bound = await host.bindContinuation({ id: input.id, nativeRunId: 'native-wake' });
    const event = {
      id: 'continuation-pause',
      kind: 'tool.approval.requested',
      label: 'Approval requested',
      metadata: { toolCallId: 'call_0' },
      runId: 'native-wake',
      status: 'info',
      timestamp: new Date().toISOString(),
    } as const;
    await host.persistContinuationEvent({
      event,
      id: input.id,
      messageId: bound.messageId,
      sequence: 0,
    });
    async function* source(): AsyncIterable<StreamChunk> {
      const envelope = {
        continuationId: input.id,
        messageId: bound.messageId,
        nativeRunId: 'native-wake',
        threadId: bound.threadId,
        type: 'child-continuation-chunk',
      } as const;
      yield { ...envelope, chunk: { event, type: 'run-event' } };
      yield {
        ...envelope,
        chunk: {
          runId: 'native-wake',
          toolCallId: 'call_0',
          toolName: 'brainstrike.readWorkspaceFile',
          type: 'tool-approval-required',
        },
      };
    }
    const output: StreamChunk[] = [];
    for await (const chunk of observeDesktopAssistantRunEvents(
      source(),
      'wake-host',
      [],
      async () => database
    )) {
      output.push(chunk);
    }
    const records = await database.query<{ run_id: string }>(
      'SELECT run_id FROM brainstrike_assistant_run_events WHERE id = $1',
      [event.id]
    );
    const displayId = records.rows[0]?.run_id;
    expect(displayId).toBe(bound.messageId);
    expect(output[0]).toMatchObject({ chunk: { event: { runId: displayId } } });
    expect(output[1]).toMatchObject({ chunk: { runId: 'native-wake', timelineRunId: displayId } });
    if (output[1]?.type !== 'child-continuation-chunk') {
      throw new Error('Missing continuation notice');
    }
    expect(output[1].chunk).not.toHaveProperty('hostRunId');
  } finally {
    await database.close();
  }
});
