import { expect, it, vi } from 'vitest';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import {
  createStreamIteratorFromRuntime,
  createToolApprovalIteratorFromRuntime,
} from '../mastra/attempt-legs';
import { listSuspendedMastraRuns } from '../mastra/suspended-run-discovery';
import type { StreamChunk } from '../types';
import {
  createBackgroundFixture,
  FIXTURE_GENERATION_RUN_ID,
} from './fixtures/background-worker-runtime';

// ONE TURN, ONE LEDGER (BST-1749, PR #3198 review item 5; owner ruling
// 2026-09-15: per GENERATION, carried by a persisted column).
//
// A turn spans several native parent runs: the root's first run, then one per
// continuation, and the runs an approval/resume leg re-streams. The ledger of
// that turn is the GENERATION's — one `metadata.ledgerId` across every leg, and
// counts over every invocation the generation dispatched. Keying it on "the
// parent run ids this leg observed" gave each leg its own id: the initial
// leg's row was never superseded (a reloaded thread kept "2 of 3 · 1 running"
// for good) and the later leg counted only its own run.
//
// These cases drive the production stream entry points; the generation itself
// comes from the host port the fixture stands in for (the desktop derivation
// is covered against real SQL in the host and repository integration tests).

/** The ledger rows a leg published, in order, with the identity that scopes them. */
function ledgerRows(chunks: readonly StreamChunk[]) {
  return chunks.flatMap((chunk) =>
    chunk.type === 'run-event' && chunk.event.kind === 'delegation.ledger'
      ? [
          {
            label: chunk.event.label,
            ledgerId: chunk.event.metadata?.['ledgerId'],
            total: chunk.event.metadata?.['total'],
          },
        ]
      : []
  );
}

it('one turn, one ledger: the resume leg reports the whole GENERATION, not the resumed run', async () => {
  // `background-child` runs in the root's first run, then `background-late-1`
  // and `background-late-2` are dispatched from CONTINUATIONS — each a fresh
  // Mastra run id. Approving late-2's gated read opens the resume leg, whose
  // ledger row and wakeup directive must still cover all three invocations.
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    continuationDispatch: true,
  });
  const { backing, runtime, runtimeData, release, database, scope, discoveryOptions } = fixture;
  release.resolve();
  let resumedRuntime: Awaited<ReturnType<typeof createMastraAgentRuntime>> | undefined;
  try {
    const first: StreamChunk[] = [];
    for await (const chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [{ id: 'generation', parts: [{ text: 'Survey', type: 'text' }], role: 'user' }],
      runtime,
      runtimeData,
    })) {
      first.push(chunk);
    }
    const rediscovered = await listSuspendedMastraRuns(scope, discoveryOptions);
    const approval = rediscovered.approvals.find(
      (entry) => entry.delegation?.toolCallId === 'late-read'
    );
    if (!approval) {
      throw new Error('No pending approval for the late child gate');
    }
    const approvalRuntime = await createMastraAgentRuntime(discoveryOptions);
    resumedRuntime = approvalRuntime;
    const second: StreamChunk[] = [];
    for await (const chunk of await createToolApprovalIteratorFromRuntime({
      action: {
        action: 'approve',
        runId: approval.runId,
        toolCallId: approval.toolCallId,
        ...(approval.delegation ? { delegation: approval.delegation } : {}),
      },
      memory: backing.memory,
      runtime: resumedRuntime,
      runtimeData,
    })) {
      second.push(chunk);
    }
    // Control: BOTH legs published rows — without it the identity assertion
    // below passes vacuously on an empty set.
    expect(ledgerRows(first).length).toBeGreaterThan(0);
    expect(ledgerRows(second).length).toBeGreaterThan(0);
    const rows = [...ledgerRows(first), ...ledgerRows(second)];
    expect(new Set(rows.map((row) => row.ledgerId))).toEqual(new Set([FIXTURE_GENERATION_RUN_ID]));
    expect(rows.at(-1)).toMatchObject({ label: '3 of 3 specialists returned', total: 3 });
    // The three parent runs of this turn are the ones the host mapped.
    expect(fixture.nativeRootRuns.length).toBeGreaterThanOrEqual(3);
    const resumeWakeup = fixture.wakeups.findLast((row) => row.kind === 'resume-leg');
    expect(resumeWakeup?.directive).toContain('background-child');
    expect(resumeWakeup?.directive).toContain('background-late-1');
    expect(resumeWakeup?.directive).toContain('background-late-2');
  } finally {
    release.resolve();
    await resumedRuntime?.dispose();
    await runtime.dispose();
    await database.close();
  }
}, 120_000);

it("a root's own pause: the approval leg's ledger still covers the whole generation", async () => {
  // The same ruling for the leg a ROOT pause opens (live-app verifier run 6):
  // `background-child` runs in the root's first run, `background-late-1` in a
  // continuation, and the root then parks on its own gated write in a THIRD
  // run. Approving it dispatches `background-final` on the resumed run, and
  // that leg's ledger must still be the generation's. A root-own pause carries
  // no delegation ancestry, so its generation comes from the native run the
  // host mapped, never from an invocation row.
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    continuationDispatch: true,
    rootGate: true,
  });
  const { backing, runtime, runtimeData, release, database, scope, discoveryOptions } = fixture;
  release.resolve();
  let resumedRuntime: Awaited<ReturnType<typeof createMastraAgentRuntime>> | undefined;
  try {
    const first: StreamChunk[] = [];
    for await (const chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [
        { id: 'root-generation', parts: [{ text: 'Report', type: 'text' }], role: 'user' },
      ],
      runtime,
      runtimeData,
    })) {
      first.push(chunk);
    }
    const rediscovered = await listSuspendedMastraRuns(scope, discoveryOptions);
    const approval = rediscovered.approvals.find(
      (entry) => entry.toolCallId === 'root-write' && entry.delegation === undefined
    );
    if (!approval) {
      throw new Error('No pending root approval for root-write');
    }
    const approvalRuntime = await createMastraAgentRuntime(discoveryOptions);
    resumedRuntime = approvalRuntime;
    const second: StreamChunk[] = [];
    for await (const chunk of await createToolApprovalIteratorFromRuntime({
      action: { action: 'approve', runId: approval.runId, toolCallId: approval.toolCallId },
      memory: backing.memory,
      runtime: resumedRuntime,
      runtimeData,
    })) {
      second.push(chunk);
    }
    // Control: the approval leg published rows of its own, so the identity
    // assertion below is not vacuous.
    expect(ledgerRows(first).length).toBeGreaterThan(0);
    expect(ledgerRows(second).length).toBeGreaterThan(0);
    const rows = [...ledgerRows(first), ...ledgerRows(second)];
    expect(new Set(rows.map((row) => row.ledgerId))).toEqual(new Set([FIXTURE_GENERATION_RUN_ID]));
    expect(rows.at(-1)).toMatchObject({ label: '3 of 3 specialists returned', total: 3 });
    // The pause really happened in a CONTINUATION's run: three mapped runs.
    expect(fixture.nativeRootRuns.length).toBeGreaterThanOrEqual(3);
    const wakeup = fixture.wakeups.findLast((row) => row.kind === 'idle-loop');
    expect(wakeup?.directive).toContain('background-child');
    expect(wakeup?.directive).toContain('background-late-1');
    expect(wakeup?.directive).toContain('background-final');
  } finally {
    release.resolve();
    await resumedRuntime?.dispose();
    await runtime.dispose();
    await database.close();
  }
}, 120_000);

it('an unmapped pre-upgrade pause refuses before side effects and releases its claim', async () => {
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    continuationDispatch: true,
  });
  const { backing, runtime, runtimeData, release, database, scope, discoveryOptions } = fixture;
  release.resolve();
  let resumedRuntime: Awaited<ReturnType<typeof createMastraAgentRuntime>> | undefined;
  try {
    for await (const _chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [{ id: 'pre-upgrade', parts: [{ text: 'Survey', type: 'text' }], role: 'user' }],
      runtime,
      runtimeData,
    })) {
      // Drive the original generation until its delegated child parks.
    }
    const rediscovered = await listSuspendedMastraRuns(scope, discoveryOptions);
    const approval = rediscovered.approvals.find(
      (entry) => entry.delegation?.toolCallId === 'late-read'
    );
    if (!approval) {
      throw new Error('No pending approval for the pre-upgrade child gate');
    }
    const binding = discoveryOptions.conversationBinding;
    if (!binding) {
      throw new Error('Missing durable conversation binding');
    }
    const releaseClaim = vi.spyOn(binding, 'releaseUnexecutedToolAction');
    const recordAnswers = vi.spyOn(binding, 'recordToolActionAnswers');
    vi.spyOn(binding, 'readBackgroundGeneration').mockRejectedValueOnce(
      Object.assign(
        new Error(
          'This approval predates the background ledger upgrade and cannot resume safely. Stop or cancel the pending work, then start a new request.'
        ),
        {
          name: 'DelegatedConversationIdentityError',
          reason: 'background-generation-unmapped',
        }
      )
    );
    const approvalRuntime = await createMastraAgentRuntime(discoveryOptions);
    resumedRuntime = approvalRuntime;
    await expect(async () => {
      for await (const _chunk of await createToolApprovalIteratorFromRuntime({
        action: {
          action: 'approve',
          runId: approval.runId,
          toolCallId: approval.toolCallId,
          ...(approval.delegation ? { delegation: approval.delegation } : {}),
        },
        memory: backing.memory,
        runtime: approvalRuntime,
        runtimeData,
      })) {
        // The generation guard rejects before a stream can begin.
      }
    }).rejects.toMatchObject({
      cause: {
        message:
          'This approval predates the background ledger upgrade and cannot resume safely. Stop or cancel the pending work, then start a new request.',
        reason: 'background-generation-unmapped',
      },
    });
    expect(releaseClaim).toHaveBeenCalledOnce();
    expect(recordAnswers).not.toHaveBeenCalled();
    expect(fixture.policyAnswers).toEqual([]);
  } finally {
    release.resolve();
    await resumedRuntime?.dispose();
    await runtime.dispose();
    await database.close();
  }
}, 120_000);

it('an unmapped pre-upgrade root pause refuses before late-result writes or native resume', async () => {
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    continuationDispatch: true,
    rootGate: true,
  });
  const { backing, runtime, runtimeData, release, database, scope, discoveryOptions } = fixture;
  release.resolve();
  let resumedRuntime: Awaited<ReturnType<typeof createMastraAgentRuntime>> | undefined;
  try {
    for await (const _chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [
        { id: 'pre-upgrade-root', parts: [{ text: 'Report', type: 'text' }], role: 'user' },
      ],
      runtime,
      runtimeData,
    })) {
      // Drive the original generation until its root tool call parks.
    }
    const rediscovered = await listSuspendedMastraRuns(scope, discoveryOptions);
    const approval = rediscovered.approvals.find(
      (entry) => entry.toolCallId === 'root-write' && entry.delegation === undefined
    );
    if (!approval) {
      throw new Error('No pending root approval for the pre-upgrade gate');
    }
    const binding = discoveryOptions.conversationBinding;
    if (!binding) {
      throw new Error('Missing durable conversation binding');
    }
    const recordWakeup = vi.spyOn(binding, 'recordWakeup');
    vi.spyOn(binding, 'readBackgroundGeneration').mockRejectedValueOnce(
      Object.assign(
        new Error(
          'This approval predates the background ledger upgrade and cannot resume safely. Stop or cancel the pending work, then start a new request.'
        ),
        {
          name: 'DelegatedConversationIdentityError',
          reason: 'background-generation-unmapped',
        }
      )
    );
    const promptsBeforeApproval = fixture.model.prompts.length;
    const approvalRuntime = await createMastraAgentRuntime(discoveryOptions);
    resumedRuntime = approvalRuntime;
    await expect(async () => {
      for await (const _chunk of await createToolApprovalIteratorFromRuntime({
        action: { action: 'approve', runId: approval.runId, toolCallId: approval.toolCallId },
        memory: backing.memory,
        runtime: approvalRuntime,
        runtimeData,
      })) {
        // The generation guard rejects before a stream can begin.
      }
    }).rejects.toMatchObject({
      cause: { reason: 'background-generation-unmapped' },
    });
    expect(recordWakeup).not.toHaveBeenCalled();
    expect(fixture.model.prompts).toHaveLength(promptsBeforeApproval);
    expect(fixture.policyAnswers).toEqual([]);
  } finally {
    release.resolve();
    await resumedRuntime?.dispose();
    await runtime.dispose();
    await database.close();
  }
}, 120_000);
