import { expect, it } from 'vitest';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import {
  createStreamIteratorFromRuntime,
  createToolApprovalIteratorFromRuntime,
} from '../mastra/attempt-legs';
import { listSuspendedMastraRuns } from '../mastra/suspended-run-discovery';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';
import {
  hasGrantedShellProgressOrder,
  shellOutputOwners,
} from './fixtures/delegated-progress-order';

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
    // The decision lives in the ROOT thread: ONE root-level notice addressed to
    // the delegation call, naming the leaf tool and carrying the leaf identity,
    // synthesized when the task parks (thread-b629776b, 2026-09-14: four parked
    // children, no card on the root, five stray canvas approvals instead). A
    // background child never suspends its parent RUN, but Mastra does emit a
    // parent-level pause on the dispatching turn while that turn is still
    // open; the host drops it ("reaches each view ONCE", below). This root
    // answers instantly, so its turn has closed before the child pauses.
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

it("a background child's decision reaches each view ONCE while the dispatching root turn is still open", async () => {
  // Live GLM run 19 (2026-09-15): the root's first turn stayed open (parallel
  // reads, long reasoning) while four specialists streamed and parked. While
  // that turn is open Mastra's background executor delivers every child
  // pause TWICE: to the task (`background-task-suspended`) and, through the
  // dispatching step's own suspend, to the turn itself (a parent-level
  // `tool-call-approval` for the delegation call). It delivered every child
  // output twice too (`background-task-output` and a raw `tool-output`
  // envelope on the turn) until patches/@mastra__core@1.71.0.patch made the
  // task the only output delivery. Projecting both gave every child view each
  // frame twice and the root thread eight cards for four decisions. A root that answers instantly closes its turn
  // before any child output exists, so only a held-open turn delivers the
  // runtime shape.
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    permissionPolicy: READ_ASK_POLICY,
    siblings: 2,
    slowRootTurn: true,
  });
  const { backing, runtime, runtimeData, release, database } = fixture;
  release.resolve();
  try {
    const chunks: StreamChunk[] = [];
    for await (const chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [{ id: 'fan-out', parts: [{ text: 'Survey', type: 'text' }], role: 'user' }],
      runtime,
      runtimeData,
    })) {
      chunks.push(chunk);
    }
    const failures = chunks.filter(
      (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
    );
    expect(failures, JSON.stringify(failures)).toEqual([]);
    // ONE root card per parked leaf decision, addressed to its delegation call.
    const rootCards = chunks
      .flatMap((chunk) =>
        chunk.type === 'tool-approval-required'
          ? [[chunk.toolCallId, chunk.delegation?.toolCallId]]
          : []
      )
      .sort();
    expect(rootCards).toEqual([
      ['background-child-1', 'background-read-1'],
      ['background-child-2', 'background-read-2'],
    ]);
    const rootRequested = chunks
      .flatMap((chunk) =>
        chunk.type === 'run-event' && chunk.event.kind === 'tool.approval.requested'
          ? [chunk.event.metadata?.['toolCallId']]
          : []
      )
      .sort();
    expect(rootRequested).toEqual(['background-child-1', 'background-child-2']);
    // Each child view carries every frame exactly once: the same view a root
    // that closed its turn first produces.
    const childFrames = (parentToolCallId: string) =>
      chunks.flatMap((chunk) =>
        chunk.type === 'delegated-conversation-chunk' &&
        chunk.identity.parentToolCallId === parentToolCallId
          ? [chunk.chunk.type === 'run-event' ? chunk.chunk.event.kind : chunk.chunk.type]
          : []
      );
    for (const child of ['background-child-1', 'background-child-2']) {
      expect(childFrames(child), child).toEqual([
        'run.started',
        'run.step.started',
        'tool-event',
        'tool.started',
        'tool.approval.requested',
        'tool-approval-required',
        'message-finish',
      ]);
    }
    const parked = await runtime.backgroundTaskManager?.listTasks({ status: 'suspended' });
    expect(parked?.tasks).toHaveLength(2);
  } finally {
    release.resolve();
    await runtime.dispose();
    await database.close();
  }
});

it('a session grant answers every parked background sibling in the same approval leg', async () => {
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    customToolOutput: 'shell',
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
    // The initiating card needs an answer independently of its temporary user echo.
    expect(
      answered.map(({ delegation, decision, reason, toolName }) => [
        delegation?.toolCallId,
        decision,
        reason,
        toolName,
      ])
    ).toEqual([
      ['background-read-1', 'approve', 'user', 'brainstrike.grepSearch'],
      ['background-read-2', 'approve', 'session-grant', 'brainstrike.grepSearch'],
    ]);
    // The sibling is recorded as a policy answer, never as a second claim.
    expect(fixture.policyAnswers).toEqual(['background-child-2']);
    // Both children ran their read, both returned, the parent woke once with both.
    expect(effect).toHaveBeenCalledTimes(2);
    expect(shellOutputOwners(chunks)).toEqual(['background-child-1', 'background-child-2']);
    expect(hasGrantedShellProgressOrder(chunks, 'background-read-2', 'background-child-2')).toBe(
      true
    );
    const parked = await runtime.backgroundTaskManager?.listTasks({ status: 'suspended' });
    expect(parked?.tasks).toEqual([]);
    expect(JSON.stringify(chunks)).toContain('PARENT_FINAL_OUTCOME');
    // The wakeup is recorded before the parent inference it names.
    // Moving its write after agent.stream would put promptsAtRecord past the wakeup prompt.
    expect(fixture.wakeups.map((row) => row.kind)).toEqual(['resume-leg']);
    const directive = fixture.wakeups[0]?.directive;
    const wakeupPrompt = fixture.model.prompts.findIndex((call) =>
      call.prompt.some(
        (message) =>
          message.role === 'user' &&
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === 'text' && part.text === directive)
      )
    );
    expect(wakeupPrompt).toBeGreaterThanOrEqual(0);
    expect(fixture.wakeups[0]?.promptsAtRecord).toBe(wakeupPrompt);
    expect(
      fixture.wakeups[0]?.invocations.map((entry) => [entry.outcome, entry.toolCallId]).sort()
    ).toEqual([
      ['completed', 'background-child-1'],
      ['completed', 'background-child-2'],
    ]);
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
    expect(
      chunks.flatMap((chunk) =>
        chunk.type === 'tool-approval-answered' ? [chunk.delegation?.toolCallId] : []
      )
    ).toEqual(['background-read-1']);
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
    // Debug-pack evidence (swarm diagnostics): the running leg recorded the
    // user's live one-shot decision as delivered — its task, dispatch address
    // and leaf call, no answered siblings and no policy snapshot.
    expect(fixture.liveDecisions).toEqual([
      {
        answeredSiblingTaskIds: [],
        decision: 'approve',
        delegationToolCallId: 'background-read-1',
        kind: 'approval',
        outcome: 'delivered',
        source: 'user',
        taskId: expect.any(String),
        toolCallId: 'background-child-1',
        toolName: 'brainstrike.grepSearch',
      },
    ]);
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

it("after a live session grant the sibling's NEXT gated read runs without a pause", async () => {
  // Claude Code's contract: after "allow for session" the tool simply runs.
  // Sibling 2's allowed read is held open so the leg keeps running; sibling 1
  // parks on its first ask-gated read; the user's "Allow reads this session"
  // is delivered live on that card. Sibling 1's SECOND gated read must then
  // run under the remembered grant with no pause, no card and no resume.
  // MUTATION: a gate that ignores `remembered` (Task 1) parks read 2 again
  // and a second root card appears — `rootCards` below fails.
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
        delivered = fixture
          .decide({
            action: {
              action: 'approve',
              delegation: chunk.delegation,
              runId: chunk.runId,
              toolCallId: chunk.toolCallId,
            },
            permissionPolicy: {
              ...READ_ASK_POLICY,
              perToolOverrides: { 'brainstrike.readWorkspaceFile': 'allow' },
              sessionGrants: ['read'],
            },
          })
          .finally(() => hold.resolve());
      }
    }
    await expect(delivered).resolves.toBeUndefined();
    const failures = chunks.filter(
      (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
    );
    expect(failures, JSON.stringify(failures)).toEqual([]);
    // Exactly one root card for the whole leg: read 1. Read 2 never parked.
    const rootCards = chunks
      .flatMap((chunk) => (chunk.type === 'tool-approval-required' ? [chunk] : []))
      .map((chunk) => [chunk.toolCallId, chunk.delegation?.toolCallId]);
    expect(rootCards).toEqual([['background-child-1', 'background-read-1']]);
    // The user's answer is the only answer; no policy answer was needed.
    const answered = chunks.flatMap((chunk) =>
      chunk.type === 'tool-approval-answered' ? [chunk] : []
    );
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ reason: 'user', toolCallId: 'background-child-1' });
    expect(fixture.policyAnswers).toEqual(['background-child-1']);
    // Debug-pack evidence: the live grant is recorded as delivered with the
    // trusted snapshot it was delivered with; no parked sibling needed an answer.
    // MUTATION: dropping the snapshot from the delivered record fails this.
    expect(fixture.liveDecisions).toEqual([
      expect.objectContaining({
        answeredSiblingTaskIds: [],
        outcome: 'delivered',
        policySnapshot: expect.objectContaining({ sessionGrants: ['read'] }),
        source: 'user',
        toolCallId: 'background-child-1',
      }),
    ]);
    // Both gated reads of sibling 1 executed.
    expect(effect).toHaveBeenCalledTimes(2);
    const parked = await runtime.backgroundTaskManager?.listTasks({ status: 'suspended' });
    expect(parked?.tasks).toEqual([]);
    expect(JSON.stringify(chunks)).toContain('PARENT_FINAL_OUTCOME');
  } finally {
    hold.resolve();
    release.resolve();
    await runtime.dispose();
    await database.close();
  }
});

it('a live session grant is remembered BEFORE the parked child is resumed, so its next call already sees it', async () => {
  // The resumed child's next gated call consults the leg's remembered grant
  // through its function-form flag (approval-gate.ts). If the grant were
  // remembered only after `manager.resume` returned, a child that reaches its
  // next call within the resume's own tick chain would park again. The
  // ordering is the invariant: `remember` strictly precedes every `resume`
  // the decision issues.
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 2, {
    heldSibling: 2,
    permissionPolicy: {
      ...READ_ASK_POLICY,
      perToolOverrides: { 'brainstrike.readWorkspaceFile': 'allow' },
    },
    siblings: 2,
  });
  const { backing, runtime, runtimeData, release, hold, database } = fixture;
  const manager = runtime.backgroundTaskManager;
  if (!manager) {
    throw new Error('Background manager missing');
  }
  const order: string[] = [];
  const originalResume = manager.resume.bind(manager);
  manager.resume = async (taskId, resumeData) => {
    order.push(`resume:${runtime.liveDecisions.remembered ? 'remembered' : 'forgotten'}`);
    return await originalResume(taskId, resumeData);
  };
  const originalRemember = runtime.liveDecisions.remember.bind(runtime.liveDecisions);
  runtime.liveDecisions.remember = (policy) => {
    order.push('remember');
    originalRemember(policy);
  };
  release.resolve();
  let delivered: Promise<void> | undefined;
  try {
    for await (const chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [{ id: 'fan-out', parts: [{ text: 'Survey', type: 'text' }], role: 'user' }],
      runtime,
      runtimeData,
    })) {
      if (
        chunk.type === 'tool-approval-required' &&
        chunk.delegation?.toolCallId === 'background-read-1' &&
        !delivered
      ) {
        delivered = fixture
          .decide({
            action: {
              action: 'approve',
              delegation: chunk.delegation,
              runId: chunk.runId,
              toolCallId: chunk.toolCallId,
            },
            permissionPolicy: { ...READ_ASK_POLICY, sessionGrants: ['read'] },
          })
          .finally(() => hold.resolve());
      }
    }
    await expect(delivered).resolves.toBeUndefined();
    // MUTATION: remembering after `answerGranted` (the pre-2026-09-15 order)
    // records ['resume:forgotten', 'remember'].
    expect(order).toEqual(['remember', 'resume:remembered']);
  } finally {
    hold.resolve();
    release.resolve();
    await runtime.dispose();
    await database.close();
  }
});

it('the wakeup carries the whole ledger: a root that trusts it reports the final outcome exactly once nothing is still running', async () => {
  // Two specialists. Sibling 1 returns at once; sibling 2 is held until the
  // root's FIRST wakeup has reached the model with a ledger that says
  // "1 still running" (the initial leg already answers "progress" once, on
  // its dispatch acknowledgements, so the hold is keyed on the wakeup prompt
  // itself, never on the progress text). The second wakeup says "Nothing is
  // still running" and the root reports the final outcome — even though its
  // own count of tool results would have said the same thing either time.
  // MUTATIONS: emitting the closing sentence unconditionally makes the first
  // continuation say FINAL (order assertion fails); omitting it never says
  // FINAL (the GLM run); building the ledger from in-memory sets instead of
  // the rows cannot produce the durable status row sequence below.
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    heldSibling: 2,
    rootReadsLedger: true,
    siblings: 2,
  });
  const { backing, runtime, runtimeData, release, hold, database, model } = fixture;
  const chunks: StreamChunk[] = [];
  const texts: string[] = [];
  try {
    for await (const chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [{ id: 'fan-out', parts: [{ text: 'Survey', type: 'text' }], role: 'user' }],
      runtime,
      runtimeData,
    })) {
      chunks.push(chunk);
      if (chunk.type === 'text-delta') {
        texts.push(chunk.value);
        // Keep the initial parent step active until its dispatch acknowledgement.
        if (chunk.value.includes('PARENT_USEFUL_PROGRESS')) {
          release.resolve();
        }
      }
      if (fixture.wakeups.some((record) => model.prompts.length > record.promptsAtRecord)) {
        hold.resolve();
      }
    }
    const text = texts.join('');
    expect(text.indexOf('PARENT_USEFUL_PROGRESS')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('PARENT_FINAL_OUTCOME')).toBeGreaterThan(
      text.indexOf('PARENT_USEFUL_PROGRESS')
    );
    const wakeups = fixture.wakeups.map((record) => {
      const prompt = model.prompts[record.promptsAtRecord];
      expect(prompt).toBeDefined();
      const received = prompt?.prompt
        .filter((message) => message.role === 'user')
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .find((part) => part.type === 'text' && part.text === record.directive);
      expect(received).toBeDefined();
      return received?.type === 'text' ? received.text : undefined;
    });
    expect(wakeups).toHaveLength(2);
    expect(wakeups[0]).toContain('2 total: 1 returned, 0 failed, 0 cancelled, 1 still running');
    expect(wakeups[0]).toContain('Explorer): still running');
    expect(wakeups[0]).not.toContain('Nothing is still running');
    expect(wakeups[1]).toContain('2 total: 2 returned, 0 failed, 0 cancelled, 0 still running');
    expect(wakeups[1]).toContain(
      'All 2 background invocations have finished. Nothing is still running.'
    );
    const rows = chunks.flatMap((chunk) =>
      chunk.type === 'run-event' && chunk.event.kind === 'delegation.ledger'
        ? [[chunk.event.label, chunk.event.status]]
        : []
    );
    expect(rows.at(-1)).toEqual(['2 of 2 specialists returned', 'completed']);
    expect(rows).toContainEqual(['1 of 2 specialists returned · 1 running', 'running']);
    expect(new Set(rows.map(([label]) => label)).size).toBeGreaterThanOrEqual(2);
  } finally {
    hold.resolve();
    release.resolve();
    await runtime.dispose();
    await database.close();
  }
});
