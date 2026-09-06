import { describe, expect, it } from 'vitest';
import { createDelegationLifecycleTracker } from '../subagent-delegation';
import type { ToolLifecycleState } from '../tool-lifecycle-processors';
import { makeToolLifecycleRunEventChunk } from '../tool-lifecycle-processors';

/**
 * `tool.started` is emitted ONCE PER LEG per call — and the per-leg scope is the
 * whole point, not an implementation detail.
 *
 * Since BST-1440 an approved call legitimately produces TWO `tool.started` run
 * events: Mastra's own `tool-call` part on the pausing leg, and the synthetic
 * start `makeResumedStartChunks` hands over on the resume leg. That pair is what
 * lets the Threads panel's "needs you" projection clear when the user ANSWERS
 * instead of when the tool finishes. So a guard here must reject a duplicate
 * within one leg while still permitting the cross-leg pair — a guard drawn at
 * the wrong scope would silently restore the bug the change exists to fix, with
 * every test still green.
 *
 * The duplicate-within-a-leg case is not hypothetical bookkeeping: the resume
 * emission rests on @mastra/core 1.59 never replaying a resumed step's
 * `tool-call` part (its one replay site is gated on a `backgroundTaskManager`
 * this repo does not register). If a version bump flips that, both starts land
 * in ONE leg, and without this guard we durably write two rows per call with no
 * error and no log.
 */
describe('tool.started is emitted once per leg, not once per thread', () => {
  const leg = (): ToolLifecycleState =>
    ({
      carriedCompletionTokens: 0,
      carriedPromptTokens: 0,
      delegationLifecycle: createDelegationLifecycleTracker(),
      includeCacheTokenClasses: false,
      outputOnlyToolEvents: new Map(),
      requiresBilledCost: false,
      sawModelContribution: true,
      sawStepBilledCost: false,
      sawStepWithoutBilledCost: false,
      startedToolCallIds: new Set(),
      stepBilledCostUsd: 0,
      stepCount: 0,
      steppedCompletionTokens: 0,
      steppedPromptTokens: 0,
      streamStartedAtMs: 0,
      terminalToolCallStates: new Map(),
      warnedUnknownChunkTypes: new Set(),
    }) satisfies ToolLifecycleState;

  const start = (state: ToolLifecycleState, toolCallId = 'call-1') =>
    makeToolLifecycleRunEventChunk(
      {
        name: 'executeCommand',
        payload: { args: {}, callId: toolCallId, input: {}, toolCallId },
        status: 'start',
        type: 'tool-event',
      },
      'tool-call',
      state
    );

  it('emits the first start for a call', () => {
    const chunk = start(leg());
    expect(chunk).toBeDefined();
    expect(chunk).toMatchObject({ event: { kind: 'tool.started' }, type: 'run-event' });
  });

  it('SUPPRESSES a second start for the same call on the SAME leg', () => {
    const state = leg();
    expect(start(state)).toBeDefined();
    // A replayed Mastra `tool-call` part landing alongside the synthetic one.
    // Two durable `tool.started` rows for one call would be silent corruption.
    expect(start(state)).toBeUndefined();
  });

  it('STILL emits the resume leg start for the same call on a NEW leg', () => {
    const toolCallId = 'call-1';
    // The pausing leg emitted its start; the resume leg is a different run with
    // its own ToolLifecycleState. This is the pair BST-1440 depends on: without
    // the second event the needs-you glyph stays lit until the tool FINISHES.
    expect(start(leg(), toolCallId)).toBeDefined();
    expect(start(leg(), toolCallId)).toBeDefined();
  });

  it('does not let one call suppress a different call on the same leg', () => {
    const state = leg();
    expect(start(state, 'call-1')).toBeDefined();
    // Siblings of a resumed step each get their own start.
    expect(start(state, 'call-2')).toBeDefined();
  });
});
