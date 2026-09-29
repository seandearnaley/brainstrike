// @vitest-environment node
import type { StreamChunk } from '@brainstrike/agent';
import { createDelegatedConversationRepository, migrate, wasmLoader } from '@brainstrike/db';
import { expect, it } from 'vitest';
import { observeDesktopAssistantRunEvents } from '../../assistant-server/run-persistence';
import { createBudgetedHost } from './fixtures/budgeted-host';

it('keeps approval and terminal display aligned across continuation resume legs without root anchors', async () => {
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
    const first = createBudgetedHost(database, 'wake-host').continuation;
    await first.prepareContinuation(input);
    const displayIds = new Set<string>();
    for (const hostRunId of ['wake-host', 'resume-host']) {
      const host = createBudgetedHost(database, hostRunId).continuation;
      if (hostRunId === 'resume-host') {
        await database.exec(`UPDATE brainstrike_assistant_thread_runs SET status='completed' WHERE id='wake-host';
          INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id,generation_run_id)
          VALUES ('resume-host','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'new-root-user','wake-host');`);
        const decision = {
          id: input.id,
          kind: 'tool-approval' as const,
          nativeRunId: 'native-wake',
          toolCallId: 'call_0',
        };
        await host.resolveContinuationDecision(decision);
        await host.claimContinuationDecision(decision);
      }
      // Initial binding reuses the host that captured its baseline.
      const owner = hostRunId === 'wake-host' ? first : host;
      const bound = await owner.bindContinuation({ id: input.id, nativeRunId: 'native-wake' });
      const pause = {
        id: `pause-${hostRunId}`,
        kind: 'tool.approval.requested',
        label: 'Approval requested',
        metadata: { toolCallId: 'call_0' },
        runId: 'native-wake',
        status: 'info',
        timestamp: new Date().toISOString(),
      } as const;
      const terminal = {
        ...pause,
        id: `terminal-${hostRunId}`,
        kind: 'run.finished',
        label: 'Finished',
        status: 'completed',
      } as const;
      async function* source(): AsyncIterable<StreamChunk> {
        const envelope = {
          continuationId: input.id,
          messageId: bound.messageId,
          nativeRunId: 'native-wake',
          threadId: bound.threadId,
          type: 'child-continuation-chunk',
        } as const;
        await owner.persistContinuationEvent({
          event: pause,
          id: input.id,
          messageId: bound.messageId,
          sequence: 0,
        });
        yield { ...envelope, chunk: { event: pause, type: 'run-event' } };
        yield {
          ...envelope,
          chunk: {
            runId: 'native-wake',
            toolCallId: 'call_0',
            toolName: 'brainstrike.readWorkspaceFile',
            type: 'tool-approval-required',
          },
        };
        if (hostRunId === 'resume-host') {
          await owner.persistContinuationEvent({
            event: terminal,
            id: input.id,
            messageId: bound.messageId,
            sequence: 1,
          });
          yield { ...envelope, chunk: { event: terminal, type: 'run-event' } };
        }
      }
      const output: StreamChunk[] = [];
      for await (const chunk of observeDesktopAssistantRunEvents(
        source(),
        hostRunId,
        [],
        async () => database
      )) {
        output.push(chunk);
      }
      const records = await database.query<{ run_id: string }>(
        'SELECT run_id FROM brainstrike_assistant_run_events WHERE id = $1',
        [pause.id]
      );
      const displayId = records.rows[0]?.run_id;
      expect(displayId).toBe(bound.messageId);
      expect(output[0]).toMatchObject({
        chunk: { event: { runId: displayId } },
        nativeRunId: 'native-wake',
      });
      expect(output[1]).toMatchObject({
        chunk: { runId: 'native-wake', timelineRunId: displayId },
        nativeRunId: 'native-wake',
      });
      if (output[1]?.type !== 'child-continuation-chunk') {
        throw new Error('Missing continuation notice');
      }
      expect(output[1].chunk).not.toHaveProperty('hostRunId');
      if (hostRunId === 'resume-host') {
        expect(output[2]).toMatchObject({
          chunk: { event: { kind: 'run.finished', runId: displayId, status: 'completed' } },
          nativeRunId: 'native-wake',
        });
        expect(
          (
            await database.query(
              'SELECT run_id FROM brainstrike_assistant_run_events WHERE id = $1',
              [terminal.id]
            )
          ).rows
        ).toEqual([{ run_id: displayId }]);
      }
      if (displayId) {
        displayIds.add(displayId);
      }
      await owner.finishContinuation({
        id: input.id,
        status: hostRunId === 'wake-host' ? 'awaiting-approval' : 'completed',
      });
    }
    expect(displayIds.size).toBe(2);
  } finally {
    await database.close();
  }
});
