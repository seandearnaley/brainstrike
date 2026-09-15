import { expect, it } from 'vitest';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import {
  createStreamIteratorFromRuntime,
  createToolApprovalIteratorFromRuntime,
} from '../mastra/attempt-legs';
import { listSuspendedMastraRuns } from '../mastra/suspended-run-discovery';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

// Host policy over the model-facing background knobs and over Mastra's
// documented `untilIdle` terminals, driven through the production stream entry
// points (BST-1749; thread-8d471973, 2026-09-14).

it('a background child that pauses again on its resumed leg ends that leg as a pause, not a failure', async () => {
  // Mastra's documented `untilIdle` terminal for a suspension is a stream
  // CLOSE. The resumed leg used to read that close as a missing finish and
  // report "Assistant stream ended without a normal stop signal" while the
  // child's second approval sat pending (thread-8d471973, 2026-09-14).
  const fixture = await createBackgroundFixture(true, undefined, false, undefined, false, 2);
  const { backing, runtime, runtimeData, effect, release, discoveryOptions, scope, database } =
    fixture;
  release.resolve();
  const drainRun = async (iterator: AsyncIterable<StreamChunk>) => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }
    return chunks;
  };
  const pendingNotices = (chunks: readonly StreamChunk[]) =>
    chunks.flatMap((chunk) =>
      chunk.type === 'delegated-conversation-chunk' && chunk.chunk.type === 'tool-approval-required'
        ? [chunk.chunk.toolCallId]
        : []
    );
  const finishReasons = (chunks: readonly StreamChunk[]) =>
    chunks.flatMap((chunk) => (chunk.type === 'message-finish' ? [chunk.finishReason] : []));
  const failures = (chunks: readonly StreamChunk[]) =>
    chunks.filter((chunk) => chunk.type === 'run-event' && chunk.event.kind === 'run.failed');
  const resumedRuntimes: Awaited<ReturnType<typeof createMastraAgentRuntime>>[] = [];
  try {
    const first = await drainRun(
      await createStreamIteratorFromRuntime({
        memory: backing.memory,
        messages: [
          { id: 'two-gates', parts: [{ text: 'Inspect twice', type: 'text' }], role: 'user' },
        ],
        runtime,
        runtimeData,
      })
    );
    expect(pendingNotices(first)).toEqual(['background-read']);
    const approve = async (leaf: string) => {
      const rediscovered = await listSuspendedMastraRuns(scope, discoveryOptions);
      const approval = rediscovered.approvals.find(
        (entry) => entry.delegation?.toolCallId === leaf
      );
      if (!approval) {
        throw new Error(`No pending approval for ${leaf}`);
      }
      const resumedRuntime = await createMastraAgentRuntime(discoveryOptions);
      resumedRuntimes.push(resumedRuntime);
      return await drainRun(
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
    };
    // Approving the first read resumes the child, which pauses on its second.
    const second = await approve('background-read');
    expect(failures(second), JSON.stringify(failures(second))).toEqual([]);
    expect(finishReasons(second)).toEqual(['tool-calls']);
    expect(pendingNotices(second)).toEqual(['background-read-2']);
    expect(effect).toHaveBeenCalledTimes(1);
    const parked = await runtime.backgroundTaskManager?.listTasks({});
    expect(parked?.tasks[0]).toMatchObject({ status: 'suspended', toolCallId: 'background-child' });
    // Approving the second read completes the child and the parent reports.
    const third = await approve('background-read-2');
    expect(failures(third)).toEqual([]);
    expect(effect).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(third)).toContain('PARENT_FINAL_OUTCOME');
  } finally {
    release.resolve();
    for (const resumedRuntime of resumedRuntimes) {
      await resumedRuntime.dispose();
    }
    await runtime.dispose();
    await database.close();
  }
});

it('dispatches a delegation whose _background carries the retries knob Mastra advertises (BST-1749)', async () => {
  // Mastra's own background prompt tells the model `_background` accepts
  // `maxRetries`. Rejecting that value failed all four specialists of the
  // production prompt and pushed the model into foreground delegation; the host
  // pins retries to its policy instead and the worker runs in the background.
  const fixture = await createBackgroundFixture(false, undefined, false, {
    enabled: true,
    maxRetries: 1,
    timeoutMs: 120_000,
  });
  const { backing, runtime, runtimeData, entered, release, database, effect } = fixture;
  let consuming: Promise<void> | undefined;
  try {
    const iterator = await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [
        { id: 'retries-task', parts: [{ text: 'Read evidence', type: 'text' }], role: 'user' },
      ],
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
    const tasks = await runtime.backgroundTaskManager?.listTasks({});
    expect(tasks?.tasks).toHaveLength(1);
    expect(tasks?.tasks[0]).toMatchObject({ maxRetries: 0, status: 'running' });
    release.resolve();
    await consuming;
    expect(JSON.stringify(chunks)).toContain('PARENT_FINAL_OUTCOME');
    const failures = chunks.filter(
      (chunk) =>
        chunk.type === 'run-event' &&
        (chunk.event.kind === 'tool.failed' || chunk.event.kind === 'subagent.failed')
    );
    expect(failures).toEqual([]);
    expect(effect).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await Promise.allSettled([consuming]);
    await runtime.dispose();
    await database.close();
  }
});

it("a background child's pause wakes no parent turn: the host surfaces the decision, the model is not the messenger", async () => {
  // Mastra's idle loop treats `background-task-suspended` as a terminal and
  // runs a parent continuation whose directive says "let the user know they
  // are waiting for explicit resume input". The production root parroted that
  // line for every suspended specialist and refused to compile its report
  // (thread-1dab3290, 2026-09-14). A child's pause is a host-surfaced approval
  // prompt, never a wakeup for the parent model.
  const fixture = await createBackgroundFixture(true);
  const { backing, runtime, runtimeData, release, database, model } = fixture;
  release.resolve();
  try {
    const chunks: StreamChunk[] = [];
    for await (const chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [{ id: 'one-gate', parts: [{ text: 'Inspect', type: 'text' }], role: 'user' }],
      runtime,
      runtimeData,
    })) {
      chunks.push(chunk);
    }
    const pending = chunks.flatMap((chunk) =>
      chunk.type === 'delegated-conversation-chunk' && chunk.chunk.type === 'tool-approval-required'
        ? [chunk.chunk.toolCallId]
        : []
    );
    expect(pending).toEqual(['background-read']);
    // The decision lives in the ROOT thread: a root-level notice addressed to
    // the delegation call, naming the leaf tool and carrying the leaf identity.
    // A background child never suspends its parent run, so nothing native
    // produces this card (thread-b629776b, 2026-09-14: four parked children,
    // no card on the root, five stray canvas approvals instead).
    const rootNotices = chunks.flatMap((chunk) =>
      chunk.type === 'tool-approval-required' ? [chunk] : []
    );
    expect(rootNotices).toMatchObject([
      {
        delegation: { toolCallId: 'background-read' },
        toolCallId: 'background-child',
        toolName: 'brainstrike.grepSearch',
      },
    ]);
    expect(rootNotices[0]?.delegation?.path[0]?.parentRuntimeRunId).toBe(rootNotices[0]?.runId);
    const rootRequested = chunks.filter(
      (chunk) =>
        chunk.type === 'run-event' &&
        chunk.event.kind === 'tool.approval.requested' &&
        chunk.event.metadata?.['toolCallId'] === 'background-child'
    );
    expect(rootRequested).toHaveLength(1);
    // The dispatch step and the step that reads its acknowledgement are the
    // first turn; a third parent prompt would be the suspension wakeup.
    const parentPrompts = model.prompts.filter((prompt) =>
      prompt.tools?.some((tool) => tool.name === 'agent-explore')
    );
    expect(
      parentPrompts,
      JSON.stringify(parentPrompts.map((prompt) => prompt.prompt))
    ).toHaveLength(2);
    // Mastra's suspension directive, verbatim, must reach no model call.
    expect(JSON.stringify(model.prompts)).not.toContain('tool-call IDs are suspended');
    expect(
      chunks
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => chunk.value)
        .join('')
    ).toBe('PARENT_USEFUL_PROGRESS');
  } finally {
    release.resolve();
    await runtime.dispose();
    await database.close();
  }
});

// Sean's real posture (`read: ask`) makes every specialist pause on its first
// read. The canonical answer (Claude Code's queued permission prompts) is that
// one "Allow reads this session" answers every parked sibling; a one-shot
// approve answers only its own call.
const READ_ASK_POLICY = {
  policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'ask' },
  riskByTool: { 'brainstrike.grepSearch': 'read' },
  yolo: false,
} as const;

async function parkTwoSiblings(fixture: Awaited<ReturnType<typeof createBackgroundFixture>>) {
  const { backing, runtime, runtimeData } = fixture;
  const chunks: StreamChunk[] = [];
  for await (const chunk of await createStreamIteratorFromRuntime({
    memory: backing.memory,
    messages: [{ id: 'fan-out', parts: [{ text: 'Survey', type: 'text' }], role: 'user' }],
    runtime,
    runtimeData,
  })) {
    chunks.push(chunk);
  }
  const pending = chunks
    .flatMap((chunk) =>
      chunk.type === 'delegated-conversation-chunk' && chunk.chunk.type === 'tool-approval-required'
        ? [chunk.chunk.toolCallId]
        : []
    )
    .sort();
  expect(pending).toEqual(['background-read-1', 'background-read-2']);
  // One root-level card per parked child, each addressed to its own delegation call.
  const rootNotices = chunks
    .flatMap((chunk) => (chunk.type === 'tool-approval-required' ? [chunk] : []))
    .map((chunk) => [chunk.toolCallId, chunk.delegation?.toolCallId, chunk.riskCategory])
    .sort();
  expect(rootNotices).toEqual([
    ['background-child-1', 'background-read-1', 'read'],
    ['background-child-2', 'background-read-2', 'read'],
  ]);
  const parked = await runtime.backgroundTaskManager?.listTasks({ status: 'suspended' });
  expect(parked?.tasks).toHaveLength(2);
}

async function approveFirstRead(
  fixture: Awaited<ReturnType<typeof createBackgroundFixture>>,
  policy: typeof READ_ASK_POLICY | (typeof READ_ASK_POLICY & { sessionGrants: ['read'] })
) {
  const { backing, runtimeData, discoveryOptions, scope } = fixture;
  const rediscovered = await listSuspendedMastraRuns(scope, discoveryOptions);
  const approval = rediscovered.approvals.find(
    (entry) => entry.delegation?.toolCallId === 'background-read-1'
  );
  if (!approval) {
    throw new Error('No pending approval for background-read-1');
  }
  // The grant travels with the approval request as the runtime's policy
  // snapshot, exactly as the desktop request lifecycle sends it.
  const resumed = await createMastraAgentRuntime({
    ...discoveryOptions,
    runtime: { ...discoveryOptions.runtime, permissionPolicy: policy },
  });
  const chunks: StreamChunk[] = [];
  try {
    for await (const chunk of await createToolApprovalIteratorFromRuntime({
      action: {
        action: 'approve',
        runId: approval.runId,
        toolCallId: approval.toolCallId,
        ...(approval.delegation ? { delegation: approval.delegation } : {}),
      },
      memory: backing.memory,
      runtime: resumed,
      runtimeData: { ...runtimeData, permissionPolicy: policy },
    })) {
      chunks.push(chunk);
    }
  } finally {
    await resumed.dispose();
  }
  return chunks;
}

it('a session grant answers every parked background sibling in the same approval leg', async () => {
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    permissionPolicy: READ_ASK_POLICY,
    siblings: 2,
  });
  const { runtime, release, database, effect } = fixture;
  release.resolve();
  try {
    await parkTwoSiblings(fixture);
    const chunks = await approveFirstRead(fixture, { ...READ_ASK_POLICY, sessionGrants: ['read'] });
    const failures = chunks.filter(
      (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
    );
    expect(failures, JSON.stringify(failures)).toEqual([]);
    const answered = chunks.flatMap((chunk) =>
      chunk.type === 'tool-approval-answered' ? [chunk] : []
    );
    expect(answered.map((chunk) => chunk.delegation?.toolCallId)).toEqual(['background-read-2']);
    expect(answered[0]).toMatchObject({
      decision: 'approve',
      reason: 'session-grant',
      toolName: 'brainstrike.grepSearch',
    });
    // The sibling is recorded as a policy answer, never as a second claim.
    expect(fixture.policyAnswers).toEqual(['background-child-2']);
    // Both children ran their read, both returned, the parent woke once with both.
    expect(effect).toHaveBeenCalledTimes(2);
    const parked = await runtime.backgroundTaskManager?.listTasks({ status: 'suspended' });
    expect(parked?.tasks).toEqual([]);
    expect(JSON.stringify(chunks)).toContain('PARENT_FINAL_OUTCOME');
  } finally {
    release.resolve();
    await runtime.dispose();
    await database.close();
  }
});

it('a one-shot approval answers only its own parked child; the sibling stays parked', async () => {
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    permissionPolicy: READ_ASK_POLICY,
    siblings: 2,
  });
  const { runtime, release, database, effect } = fixture;
  release.resolve();
  try {
    await parkTwoSiblings(fixture);
    const chunks = await approveFirstRead(fixture, READ_ASK_POLICY);
    expect(chunks.filter((chunk) => chunk.type === 'tool-approval-answered')).toEqual([]);
    expect(effect).toHaveBeenCalledTimes(1);
    const parked = await runtime.backgroundTaskManager?.listTasks({ status: 'suspended' });
    expect(parked?.tasks.map((task) => task.toolCallId)).toEqual(['background-child-2']);
    expect(JSON.stringify(chunks)).not.toContain('PARENT_FINAL_OUTCOME');
  } finally {
    release.resolve();
    await runtime.dispose();
    await database.close();
  }
});

it('a session grant never answers a sibling parked on a question', async () => {
  // Mixed pause kinds: both children ask the user first (`brainstrike.askUser`).
  // A read grant is a permission change; a question is not a permission, so
  // the sibling's question stays parked and no policy answer is recorded.
  const fixture = await createBackgroundFixture(false, undefined, true, undefined, false, 1, {
    permissionPolicy: READ_ASK_POLICY,
    siblings: 2,
  });
  const { backing, runtime, runtimeData, release, database, discoveryOptions, scope } = fixture;
  release.resolve();
  try {
    const initial: StreamChunk[] = [];
    for await (const chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [{ id: 'ask-fan-out', parts: [{ text: 'Survey', type: 'text' }], role: 'user' }],
      runtime,
      runtimeData,
    })) {
      initial.push(chunk);
    }
    const questions = initial.flatMap((chunk) =>
      chunk.type === 'tool-suspend-required' ? [chunk.toolName] : []
    );
    expect(questions).toEqual(['brainstrike.askUser', 'brainstrike.askUser']);
    const parked = await runtime.backgroundTaskManager?.listTasks({ status: 'suspended' });
    expect(parked?.tasks).toHaveLength(2);
    const rediscovered = await listSuspendedMastraRuns(scope, discoveryOptions);
    expect(rediscovered.suspends).toHaveLength(2);
    expect(rediscovered.approvals).toEqual([]);
    expect(fixture.policyAnswers).toEqual([]);
  } finally {
    release.resolve();
    await runtime.dispose();
    await database.close();
  }
});

it('a decision delivered into the running leg resumes the child there; its next gated read parks again with a fresh root card', async () => {
  // Claude Code answers a background subagent's prompt inside the live
  // session. Sibling 2's allowed read is held open so the leg keeps running
  // while sibling 1 parks on its first ask-gated read; the user's one-shot
  // approve arrives through the leg's registered control, the child resumes
  // in the SAME leg, and its second gated read parks that same task again —
  // the loop must surface the second card, not dedupe it as a seen terminal.
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 2, {
    heldSibling: 2,
    permissionPolicy: {
      ...READ_ASK_POLICY,
      perToolOverrides: { 'brainstrike.readWorkspaceFile': 'allow' },
    },
    siblings: 2,
  });
  const { backing, runtime, runtimeData, release, hold, database, effect } = fixture;
  release.resolve();
  const chunks: StreamChunk[] = [];
  let delivered: Promise<void> | undefined;
  try {
    for await (const chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [{ id: 'fan-out', parts: [{ text: 'Survey', type: 'text' }], role: 'user' }],
      runtime,
      runtimeData,
    })) {
      chunks.push(chunk);
      if (
        chunk.type === 'tool-approval-required' &&
        chunk.delegation?.toolCallId === 'background-read-1' &&
        !delivered
      ) {
        delivered = fixture.decide({
          action: {
            action: 'approve',
            delegation: chunk.delegation,
            runId: chunk.runId,
            toolCallId: chunk.toolCallId,
          },
        });
      }
      if (
        chunk.type === 'tool-approval-required' &&
        chunk.delegation?.toolCallId === 'background-read-2'
      ) {
        hold.resolve();
      }
    }
    await expect(delivered).resolves.toBeUndefined();
    const failures = chunks.filter(
      (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
    );
    expect(failures, JSON.stringify(failures)).toEqual([]);
    // The user's own live answer locks the card; nothing was answered by policy.
    const answered = chunks.flatMap((chunk) =>
      chunk.type === 'tool-approval-answered' ? [chunk] : []
    );
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({
      decision: 'approve',
      delegation: { toolCallId: 'background-read-1' },
      reason: 'user',
      toolCallId: 'background-child-1',
    });
    expect(fixture.policyAnswers).toEqual(['background-child-1']);
    // One leg, two root cards for the same child: read 1, then read 2.
    const rootCards = chunks
      .flatMap((chunk) => (chunk.type === 'tool-approval-required' ? [chunk] : []))
      .map((chunk) => [chunk.toolCallId, chunk.delegation?.toolCallId]);
    expect(rootCards).toEqual([
      ['background-child-1', 'background-read-1'],
      ['background-child-1', 'background-read-2'],
    ]);
    expect(effect).toHaveBeenCalledTimes(1);
    const parked = await runtime.backgroundTaskManager?.listTasks({ status: 'suspended' });
    expect(parked?.tasks.map((task) => task.toolCallId)).toEqual(['background-child-1']);
    // The held sibling returned and woke the parent; the parked one did not.
    expect(JSON.stringify(chunks)).toContain('PARENT_USEFUL_PROGRESS');
    expect(JSON.stringify(chunks)).not.toContain('PARENT_FINAL_OUTCOME');
  } finally {
    hold.resolve();
    release.resolve();
    await runtime.dispose();
    await database.close();
  }
});

it('a live decision after the leg settled is refused as not live, never applied', async () => {
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    permissionPolicy: READ_ASK_POLICY,
    siblings: 2,
  });
  const { runtime, release, database, effect, discoveryOptions, scope } = fixture;
  release.resolve();
  try {
    await parkTwoSiblings(fixture);
    const rediscovered = await listSuspendedMastraRuns(scope, discoveryOptions);
    const approval = rediscovered.approvals.find(
      (entry) => entry.delegation?.toolCallId === 'background-read-1'
    );
    if (!approval?.delegation) {
      throw new Error('No pending approval for background-read-1');
    }
    await expect(
      fixture.decide({
        action: {
          action: 'approve',
          delegation: approval.delegation,
          runId: approval.runId,
          toolCallId: approval.toolCallId,
        },
      })
    ).rejects.toMatchObject({ name: 'LiveDecisionUnavailableError' });
    expect(effect).not.toHaveBeenCalled();
    expect(fixture.policyAnswers).toEqual([]);
    const parked = await runtime.backgroundTaskManager?.listTasks({ status: 'suspended' });
    expect(parked?.tasks).toHaveLength(2);
  } finally {
    release.resolve();
    await runtime.dispose();
    await database.close();
  }
});
