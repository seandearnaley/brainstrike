import { expect, it } from 'vitest';
import { createStreamIteratorFromRuntime } from '../mastra/attempt-legs';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

/** The scripted root stops on its own here; a host that never bounds wakeups reaches it. */
const RUNAWAY_DISPATCHES = 20;
const ADMITTED = Array.from({ length: 8 }, (_, index) => `redelegate-${index + 1}`);

/**
 * `delegated-worker-write.desktop.test.ts` (2026-09-15), with its scripted
 * parent broken to delegate on every turn: every call past the per-turn cap
 * was answered `[Delegation Rejected]`, yet the host woke the parent for each
 * one and the ledger counted it returned — "1160 total: 1160 returned" and
 * 2337 parent model calls in ~90 s until the test timed out.
 */
it('a delegation rejected at start is no returned invocation and wakes no parent turn', async () => {
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    rootRedelegates: RUNAWAY_DISPATCHES,
  });
  const { backing, database, model, release, runtime, runtimeData, wakeups } = fixture;
  release.resolve();
  try {
    const chunks: StreamChunk[] = [];
    for await (const chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [{ id: 'redelegate', parts: [{ text: 'Inspect', type: 'text' }], role: 'user' }],
      runtime,
      runtimeData,
    })) {
      chunks.push(chunk);
    }
    const manager = runtime.backgroundTaskManager;
    if (!manager) {
      throw new Error('Missing background task manager');
    }
    const { tasks } = await manager.listTasks(runtimeData.memory);
    // Mastra runs the delegation hook INSIDE the background task it already
    // created, so a refusal is still a task row that completes normally.
    expect(tasks.map((task) => task.toolCallId).sort()).toEqual(
      [...ADMITTED, 'redelegate-9'].sort()
    );
    expect(tasks.find((task) => task.toolCallId === 'redelegate-9')).toMatchObject({
      result: { text: '[Delegation Rejected] Subagent delegation limit reached (max 8 per turn).' },
      status: 'completed',
    });
    // BST-1751: the refusal reaches the timeline as its own outcome.
    expect(
      chunks.filter(
        (chunk) =>
          chunk.type === 'run-event' &&
          chunk.event.kind === 'subagent.failed' &&
          chunk.event.metadata?.['outcome'] === 'rejected'
      )
    ).toHaveLength(1);
    // MUTATION: queueing the rejected task's terminal as a wakeup runs one
    // parent turn per refusal until the model itself stops.
    expect(
      wakeups.flatMap((wakeup) => wakeup.invocations.map((entry) => entry.toolCallId))
    ).toEqual(ADMITTED);
    const rootPrompts = model.prompts.filter((prompt) =>
      prompt.tools?.some((tool) => tool.name === 'agent-explore')
    );
    // Nine turns, each the dispatch step and the step that reads its acknowledgement.
    expect(rootPrompts).toHaveLength(18);
    // MUTATION: a ledger that counts the rejected row reads "9 of 9".
    const ledgerRows = chunks.flatMap((chunk) =>
      chunk.type === 'run-event' && chunk.event.kind === 'delegation.ledger'
        ? [chunk.event.label]
        : []
    );
    expect(ledgerRows.at(-1)).toBe('8 of 8 specialists returned');
  } finally {
    await runtime.dispose();
    await database.close();
  }
});
