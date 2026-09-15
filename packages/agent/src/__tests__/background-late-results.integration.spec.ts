import { expect, it, vi } from 'vitest';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import {
  createStreamIteratorFromRuntime,
  createToolApprovalIteratorFromRuntime,
} from '../mastra/attempt-legs';
import { listSuspendedMastraRuns } from '../mastra/suspended-run-discovery';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

// LATE RESULTS AFTER A ROOT PAUSE (live-app verifier runs 6 and 7,
// 2026-09-15): the root parks on its own gated write while background
// specialists still run. A parked run takes no continuation; the results
// that return meanwhile reach the root when IT resumes, as the host's
// late-results wakeup, and are restored into memory after the resumed
// run's stale save. See docs/agents/assistant-subagents.md.

it("the root's own pause ends the leg once its children return: one card, no continuation on the parked run", async () => {
  // Run 6 of the live-app verifier (2026-09-15): the root paused on its canvas
  // write while a child's wakeup was still queued; the host loop ran that
  // wakeup as a continuation ON the parked run, the root proposed the write
  // again, and the thread carried two canvas cards, one orphaned for good. A
  // parked parent is on the user; the leg closes when nothing runs, and the
  // approval leg finds the child's result in the root's own history.
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    rootGate: true,
  });
  const { backing, runtime, runtimeData, entered, release, database, model, effect } = fixture;
  const { discoveryOptions, scope } = fixture;
  const rootPauses = (chunks: readonly StreamChunk[]) =>
    chunks.flatMap((chunk) => (chunk.type === 'tool-approval-required' ? [chunk.toolCallId] : []));
  const failures = (chunks: readonly StreamChunk[]) =>
    chunks.filter((chunk) => chunk.type === 'run-event' && chunk.event.kind === 'run.failed');
  let consuming: Promise<void> | undefined;
  let resumed: Awaited<ReturnType<typeof createMastraAgentRuntime>> | undefined;
  try {
    const iterator = await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [{ id: 'root-gate', parts: [{ text: 'Report', type: 'text' }], role: 'user' }],
      runtime,
      runtimeData,
    });
    const chunks: StreamChunk[] = [];
    consuming = (async () => {
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }
    })();
    consuming.catch(() => {});
    await entered.promise;
    // The root proposes its write while the child is still inside its read;
    // its card is held until the leg ends (the KNOWN LIMIT: a root pause with
    // children running is not live-deliverable), so wait for the call itself.
    await vi.waitFor(
      () =>
        expect(
          chunks.some(
            (chunk) =>
              chunk.type === 'run-event' &&
              chunk.event.kind === 'tool.started' &&
              chunk.event.metadata?.['toolCallId'] === 'root-write'
          )
        ).toBe(true),
      { timeout: 10_000 }
    );
    release.resolve();
    await consuming;
    expect(failures(chunks), JSON.stringify(failures(chunks))).toEqual([]);
    expect(rootPauses(chunks)).toEqual(['root-write']);
    // Dispatch, then the step that read the acknowledgement and proposed the
    // write: the child's wakeup never ran a third prompt on the parked run.
    const parentPrompts = model.prompts.filter((prompt) =>
      prompt.tools?.some((tool) => tool.name === 'agent-explore')
    );
    expect(parentPrompts, JSON.stringify(parentPrompts.map((p) => p.prompt))).toHaveLength(2);
    expect(effect).toHaveBeenCalledTimes(1);
    const tasks = await runtime.backgroundTaskManager?.listTasks({});
    expect(tasks?.tasks.map((task) => task.status)).toEqual(['completed']);
    // Approving the write resumes the parked root, which already holds the
    // child's returned result and reports without any wakeup.
    const rediscovered = await listSuspendedMastraRuns(scope, discoveryOptions);

    const approval = rediscovered.approvals.find(
      (entry) => entry.toolCallId === 'root-write' && entry.delegation === undefined
    );
    if (!approval) {
      throw new Error('No pending root approval for root-write');
    }
    const promptsBeforeApproval = model.prompts.length;
    resumed = await createMastraAgentRuntime(discoveryOptions);
    const second: StreamChunk[] = [];
    for await (const chunk of await createToolApprovalIteratorFromRuntime({
      action: { action: 'approve', runId: approval.runId, toolCallId: approval.toolCallId },
      memory: backing.memory,
      runtime: resumed,
      runtimeData,
    })) {
      second.push(chunk);
    }
    expect(failures(second), JSON.stringify(failures(second))).toEqual([]);
    expect(rootPauses(second)).toEqual([]);
    // Mastra's `approveToolCall` restores the message list snapshotted AT THE
    // PAUSE (the dispatch acknowledgement only): the host overlays the child's
    // late result onto that acknowledgement at the provider boundary, and the
    // resumed run reports from it.
    const resumedText = second
      .flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.value] : []))
      .join('');
    expect(resumedText).toBe('PARENT_FINAL_OUTCOME');
    // The resumed run's final save wrote its stale acknowledgement back; the
    // leg restored the delivered result from the task row.
    const history = await backing.memory.recall({
      perPage: false,
      resourceId: scope.resourceId,
      threadId: scope.threadId,
    });
    const invocation = history.messages
      .flatMap((message) => message.content.parts)
      .find(
        (part) =>
          part.type === 'tool-invocation' && part.toolInvocation.toolCallId === 'background-child'
      );
    expect(JSON.stringify(invocation)).toContain('CHILD_FINAL_EVIDENCE');
    // Debug-pack evidence (swarm diagnostics): the parked first leg recorded its
    // deferral, and the root's resume recorded the late overlay BEFORE its
    // inference ran. MUTATION: recording the overlay after the resumed stream
    // starts moves `promptsAtRecord` past the approval's first prompt.
    expect(fixture.wakeups.map((row) => row.kind)).toEqual(['deferred', 'late-overlay']);
    expect(fixture.wakeups[0]?.directive).toContain('Parked parent leg closed');
    expect(
      fixture.wakeups[0]?.invocations.map((entry) => [entry.outcome, entry.toolCallId])
    ).toEqual([['deferred', 'background-child']]);
    expect(
      fixture.wakeups[1]?.invocations.map((entry) => [
        entry.outcome,
        entry.toolCallId,
        entry.toolName,
      ])
    ).toEqual([['late', 'background-child', 'agent-explore']]);
    expect(fixture.wakeups[1]?.promptsAtRecord).toBe(promptsBeforeApproval);
  } finally {
    release.resolve();
    await Promise.allSettled([consuming]);
    await resumed?.dispose();
    await runtime.dispose();
    await database.close();
  }
});

it("a child card answered on a new leg never wakes a parked root; the root's own resume presents the late result", async () => {
  // Both park in the first leg: the child on its gated read, the root on its
  // write. Approving the child (a new leg) must resume the child only — a
  // fresh parent inference would propose the root's pending write again —
  // and the root's own approval then reads the child's result as a wakeup.
  const fixture = await createBackgroundFixture(true, undefined, false, undefined, false, 1, {
    rootGate: true,
  });
  const { backing, runtime, runtimeData, release, database, model, effect } = fixture;
  const { discoveryOptions, scope } = fixture;
  release.resolve();
  const rootPauses = (chunks: readonly StreamChunk[]) =>
    chunks.flatMap((chunk) => (chunk.type === 'tool-approval-required' ? [chunk.toolCallId] : []));
  const failures = (chunks: readonly StreamChunk[]) =>
    chunks.filter((chunk) => chunk.type === 'run-event' && chunk.event.kind === 'run.failed');
  const parentPrompts = () =>
    model.prompts.filter((prompt) => prompt.tools?.some((tool) => tool.name === 'agent-explore'));
  const resumedRuntimes: Awaited<ReturnType<typeof createMastraAgentRuntime>>[] = [];
  type Approval = Awaited<ReturnType<typeof listSuspendedMastraRuns>>['approvals'][number];
  const approve = async (predicate: (entry: Approval) => boolean) => {
    const rediscovered = await listSuspendedMastraRuns(scope, discoveryOptions);
    const approval = rediscovered.approvals.find(predicate);
    if (!approval) {
      throw new Error('No pending approval matched');
    }
    const resumed = await createMastraAgentRuntime(discoveryOptions);
    resumedRuntimes.push(resumed);
    const chunks: StreamChunk[] = [];
    for await (const chunk of await createToolApprovalIteratorFromRuntime({
      action: {
        action: 'approve',
        runId: approval.runId,
        toolCallId: approval.toolCallId,
        ...(approval.delegation ? { delegation: approval.delegation } : {}),
      },
      memory: backing.memory,
      runtime: resumed,
      runtimeData,
    })) {
      chunks.push(chunk);
    }
    return chunks;
  };
  try {
    const first: StreamChunk[] = [];
    for await (const chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [{ id: 'both-park', parts: [{ text: 'Report', type: 'text' }], role: 'user' }],
      runtime,
      runtimeData,
    })) {
      first.push(chunk);
    }
    expect(failures(first)).toEqual([]);
    expect(rootPauses(first).sort()).toEqual(['background-child', 'root-write']);
    const promptsBefore = parentPrompts().length;
    // The child's card: its read runs and it returns; the parked root is not prompted.
    const childLeg = await approve((entry) => entry.delegation?.toolCallId === 'background-read');
    expect(failures(childLeg), JSON.stringify(failures(childLeg))).toEqual([]);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(parentPrompts()).toHaveLength(promptsBefore);
    expect(JSON.stringify(childLeg)).toContain('CHILD_FINAL_EVIDENCE');
    expect(JSON.stringify(childLeg)).not.toContain('PARENT_');
    const tasks = await runtime.backgroundTaskManager?.listTasks({});
    expect(tasks?.tasks.map((task) => task.status)).toEqual(['completed']);
    // The root's card: its resume reads the late result and reports.
    const rootLeg = await approve(
      (entry) => entry.toolCallId === 'root-write' && entry.delegation === undefined
    );
    expect(failures(rootLeg), JSON.stringify(failures(rootLeg))).toEqual([]);
    expect(
      rootLeg.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.value] : [])).join('')
    ).toBe('PARENT_FINAL_OUTCOME');
    expect(parentPrompts()).toHaveLength(promptsBefore + 1);
    // The child-card leg found the root parked: it recorded that deferral and
    // ran no resume-leg wakeup; the root's own resume recorded the late overlay.
    expect(fixture.wakeups.map((row) => row.kind)).toEqual(['deferred', 'late-overlay']);
    expect(fixture.wakeups[0]?.directive).toContain('waits for the parked root to resume');
    expect(
      fixture.wakeups[0]?.invocations.map((entry) => [entry.outcome, entry.toolCallId])
    ).toEqual([['deferred', 'background-child']]);
  } finally {
    for (const resumed of resumedRuntimes) {
      await resumed.dispose();
    }
    await runtime.dispose();
    await database.close();
  }
});
