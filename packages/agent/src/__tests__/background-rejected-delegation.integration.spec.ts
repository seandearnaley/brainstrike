import { expect, it } from 'vitest';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import {
  createStreamIteratorFromRuntime,
  createToolApprovalIteratorFromRuntime,
} from '../mastra/attempt-legs';
import { listSuspendedMastraRuns } from '../mastra/suspended-run-discovery';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

/** The scripted root stops on its own here; a host that never bounds wakeups reaches it. */
const RUNAWAY_DISPATCHES = 20;
const ADMITTED = Array.from({ length: 8 }, (_, index) => `redelegate-${index + 1}`);

async function drain(iterator: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterator) {
    chunks.push(chunk);
  }
  return chunks;
}

function ledgerLabels(chunks: readonly StreamChunk[]): string[] {
  return chunks.flatMap((chunk) =>
    chunk.type === 'run-event' && chunk.event.kind === 'delegation.ledger'
      ? [chunk.event.label]
      : []
  );
}

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

/**
 * The KNOWN LIMIT of the leg-scoped capture: three siblings dispatched in ONE
 * root step, two admitted and parked on their gated read (a parked child keeps
 * its concurrency slot) and the third refused at start (`maxConcurrentWork` is
 * 2). Every row carries the root's run id, so the leg that resumes a parked
 * sibling reads the refused row too — with a capture of its own that never saw
 * the refusal.
 */
it('a resume leg leaves a sibling refused in the same parent run out of its ledger', async () => {
  const fixture = await createBackgroundFixture(true, undefined, false, undefined, false, 1, {
    siblings: 3,
  });
  const { backing, database, discoveryOptions, release, runtime, runtimeData, scope, wakeups } =
    fixture;
  release.resolve();
  const resumedRuntimes: Awaited<ReturnType<typeof createMastraAgentRuntime>>[] = [];
  try {
    await drain(
      await createStreamIteratorFromRuntime({
        memory: backing.memory,
        messages: [
          { id: 'refused-sibling', parts: [{ text: 'Inspect', type: 'text' }], role: 'user' },
        ],
        runtime,
        runtimeData,
      })
    );
    const manager = runtime.backgroundTaskManager;
    if (!manager) {
      throw new Error('Missing background task manager');
    }
    const { tasks } = await manager.listTasks(runtimeData.memory);
    expect(new Set(tasks.map((task) => task.runId)).size).toBe(1);
    const parked = tasks.filter((task) => task.status === 'suspended');
    const refused = tasks.filter((task) => task.status === 'completed');
    expect(parked).toHaveLength(2);
    expect(refused).toHaveLength(1);
    // The TEST's oracle for which sibling was refused, read from Mastra's own
    // result text. Production never matches on it — a child can echo the words
    // — so only the leg's capture and the host's invocation graph name one.
    expect(refused[0]?.result).toMatchObject({
      text: '[Delegation Rejected] Too many concurrent subagents (max 2); try again after the current ones finish.',
    });
    const [resumed] = parked;
    const refusedCall = refused[0]?.toolCallId;
    if (!(resumed && refusedCall)) {
      throw new Error('Missing the parked or the refused sibling');
    }
    const leaf = resumed.toolCallId.replace('background-child-', 'background-read-');
    const { approvals } = await listSuspendedMastraRuns(scope, discoveryOptions);
    const approval = approvals.find((entry) => entry.delegation?.toolCallId === leaf);
    if (!approval) {
      throw new Error(`No pending approval for ${leaf}`);
    }
    const resumedRuntime = await createMastraAgentRuntime(discoveryOptions);
    resumedRuntimes.push(resumedRuntime);
    const chunks = await drain(
      await createToolApprovalIteratorFromRuntime({
        action: {
          action: 'approve',
          runId: approval.runId,
          toolCallId: approval.toolCallId,
          ...(approval.delegation ? { delegation: approval.delegation } : {}),
        },
        memory: backing.memory,
        runtime: resumedRuntime,
        runtimeData,
      })
    );
    const resumeWakeups = wakeups.filter((wakeup) => wakeup.kind === 'resume-leg');
    // The resume leg wakes only for the task it resumed.
    expect(
      resumeWakeups.map((wakeup) => wakeup.invocations.map((entry) => entry.toolCallId))
    ).toEqual([[resumed.toolCallId]]);
    // MUTATION: a resume ledger that trusts only its own leg's capture reads
    // the refused row as returned — "3 total: 2 returned".
    expect(resumeWakeups[0]?.directive).toContain(
      '2 total: 1 returned, 0 failed, 0 cancelled, 1 still running'
    );
    expect(resumeWakeups[0]?.directive).not.toContain(refusedCall);
    expect(ledgerLabels(chunks).at(-1)).toBe('1 of 2 specialists returned · 1 running');
  } finally {
    for (const resumedRuntime of resumedRuntimes) {
      await resumedRuntime.dispose();
    }
    await runtime.dispose();
    await database.close();
  }
});
