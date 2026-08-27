import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
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
      sawModelContribution: true,
      sawStepBilledCost: false,
      sawStepWithoutBilledCost: false,
      startedToolCallIds: new Set(),
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
        sawModelContribution: true,
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

  it('names the PARTIAL case and logs the amount it discards', () => {
    // `stepBilledCostUsd` here is real provider-reported spend the turn total
    // cannot honestly use. Dropping it silently defeats the point of the
    // warning — and it is not a corner case: `sawStepWithoutBilledCost` is
    // carried across retry attempts, so ONE cost-less step anywhere in a
    // multi-attempt turn drops the whole turn's known spend.
    const records: LogRecord[] = [];
    const remove = addLogListener((record) => records.push(record));
    try {
      makeFinishChunk(
        finishPart,
        lifecycleState({
          sawModelContribution: true,
          sawStepBilledCost: true,
          sawStepWithoutBilledCost: true,
          stepBilledCostUsd: 0.004,
        })
      );
    } finally {
      remove();
    }

    const warning = records.find(
      (record) =>
        record.level === LogLevel.WARN && JSON.stringify(record).includes('only some steps')
    );
    expect(warning).toBeDefined();
    expect(JSON.stringify(warning)).toContain('discardedPartialCostUsd');
    expect(JSON.stringify(warning)).toContain('0.004');
  });

  it('does NOT claim a partial when nothing was reported', () => {
    const records: LogRecord[] = [];
    const remove = addLogListener((record) => records.push(record));
    try {
      makeFinishChunk(finishPart, lifecycleState({ sawStepWithoutBilledCost: true }));
    } finally {
      remove();
    }

    const warning = records.find(
      (record) =>
        record.level === LogLevel.WARN &&
        JSON.stringify(record).includes('provider_billed_cost_unreported')
    );
    expect(JSON.stringify(warning)).toContain('no billed cost');
    expect(JSON.stringify(warning)).not.toContain('discardedPartialCostUsd');
  });

  it('completes the turn when the finish cost is MALFORMED, logging at error', () => {
    // The last member of this bug class. A malformed cost is a broken provider
    // contract someone should fix — but binning a finished answer over it is
    // the same trade that made a missing cost fatal. Loud, never fatal.
    const records: LogRecord[] = [];
    const remove = addLogListener((record) => records.push(record));
    let chunk: { billedCostUsd?: number; finishReason?: string };
    try {
      chunk = makeFinishChunk(
        {
          finishReason: 'stop',
          providerMetadata: { openrouter: { usage: { cost: -1 } } },
          type: 'finish',
          usage: { completionTokens: 7, promptTokens: 11 },
        },
        lifecycleState()
      ) as { billedCostUsd?: number; finishReason?: string };
    } finally {
      remove();
    }

    expect(chunk.finishReason).toBe('stop');
    // UNKNOWN, never zero — a fabricated zero is the undercount this path
    // exists to avoid, and it is the one number a malformed value must not
    // become.
    expect(chunk.billedCostUsd).toBeUndefined();
    expect(
      records.some(
        (record) =>
          record.level === LogLevel.ERROR &&
          JSON.stringify(record).includes('provider_billed_cost_malformed')
      )
    ).toBe(true);
  });
});
