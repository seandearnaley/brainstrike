import { describe, expect, it } from 'vitest';
import { createDelegationLifecycleTracker } from '../subagent-delegation';
import { makeFinishChunk, type ToolLifecycleState } from '../tool-lifecycle-processors';

/**
 * A missing provider-reported cost must never destroy a completed turn.
 *
 * `requiresBilledCost` is set for EVERY OpenRouter model, but OpenRouter does
 * not report `usage.cost` for anonymous/stealth routes — `stealth/ox-alpha` is
 * one, added by migration 107 and described there as "the anonymous Ox Alpha
 * route". Every such turn that reached the finish threw, discarding the
 * assistant's completed answer over a BILLING TELEMETRY gap.
 *
 * It was masked for a while: long OpenRouter turns died on the stream
 * inactivity watchdog before reaching the finish. Fixing that watchdog
 * (#2607) removed the mask and turned a latent bug into an instant failure.
 */
describe('OpenRouter finish without a provider-reported cost', () => {
  const lifecycleState = (over: Partial<ToolLifecycleState> = {}): ToolLifecycleState =>
    ({
      carriedCompletionTokens: 0,
      carriedPromptTokens: 0,
      delegationLifecycle: createDelegationLifecycleTracker(),
      includeCacheTokenClasses: false,
      outputOnlyToolEvents: new Map(),
      requiresBilledCost: true,
      sawStepBilledCost: false,
      sawStepWithoutBilledCost: false,
      stepBilledCostUsd: 0,
      stepCount: 1,
      steppedCompletionTokens: 0,
      steppedPromptTokens: 0,
      streamStartedAtMs: 0,
      terminalToolCallStates: new Map(),
      warnedUnknownChunkTypes: new Set(),
      ...over,
    }) satisfies ToolLifecycleState;

  const finishPart = {
    finishReason: 'stop',
    type: 'finish',
    usage: { completionTokens: 7, promptTokens: 11 },
  };

  it('completes the turn when NO step reported a cost', () => {
    // The ox-alpha shape: an anonymous route that never reports usage.cost.
    const chunk = makeFinishChunk(
      finishPart,
      lifecycleState({ sawStepWithoutBilledCost: true })
    ) as { billedCostUsd?: number; finishReason?: string };

    expect(chunk.finishReason).toBe('stop');
    // UNKNOWN, not zero. Recording 0 would under-report a real bill; omitting
    // the field records "we do not know", which the ledger already stores as
    // null.
    expect(chunk.billedCostUsd).toBeUndefined();
  });

  it('completes the turn when only SOME steps reported a cost', () => {
    // Mastra copies providerMetadata from the final model step only, so a
    // terminal cost cannot repair a missing earlier one. The honest result is
    // still "unknown" rather than a partial sum presented as the total.
    const chunk = makeFinishChunk(
      finishPart,
      lifecycleState({
        sawStepBilledCost: true,
        sawStepWithoutBilledCost: true,
        stepBilledCostUsd: 0.004,
      })
    ) as { billedCostUsd?: number };

    expect(chunk.billedCostUsd).toBeUndefined();
  });

  it('still reports a cost when every step reported one', () => {
    const chunk = makeFinishChunk(
      finishPart,
      lifecycleState({ sawStepBilledCost: true, stepBilledCostUsd: 0.004 })
    ) as { billedCostUsd?: number };

    expect(chunk.billedCostUsd).toBeCloseTo(0.004);
  });

  it('reports a genuine ZERO cost as zero, not as unknown', () => {
    // A free route that DOES report `cost: 0` is a measured zero and must not
    // be conflated with an absent one.
    const chunk = makeFinishChunk(
      finishPart,
      lifecycleState({ sawStepBilledCost: true, stepBilledCostUsd: 0 })
    ) as { billedCostUsd?: number };

    expect(chunk.billedCostUsd).toBe(0);
  });
});
