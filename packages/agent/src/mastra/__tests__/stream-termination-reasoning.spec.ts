import { describe, expect, it } from 'vitest';
import { StreamStalledError } from '../../stream/with-inactivity-timeout';
import { makeStreamWatchdogTermination } from '../stream-termination';
import { createDelegationLifecycleTracker } from '../subagent-delegation';
import type { ToolLifecycleState } from '../tool-lifecycle-processors';

/**
 * The user-visible half of the reasoning phase.
 *
 * Driven through `makeStreamWatchdogTermination` — the exported seam
 * `turn-attempts.ts` actually calls (moved out of `agent-streaming.ts` by
 * BST-1649) — rather than the private message helper,
 * so this covers the WIRING and not just the string. A phase the watchdog
 * reports but the termination path never translates would leave the user with
 * text that contradicts what happened.
 */
describe('makeStreamWatchdogTermination — reasoning stall', () => {
  const lifecycleState = (): ToolLifecycleState =>
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

  const visibleText = (phase: 'awaiting-output' | 'reasoning' | 'streaming'): string => {
    const chunks = makeStreamWatchdogTermination(
      new StreamStalledError(600_000, {
        lastPartType: 'reasoning-delta',
        partsSeen: 58,
        phase,
      }),
      lifecycleState(),
      undefined
    );
    return JSON.stringify(chunks);
  };

  it('does not tell the user a thinking model produced no output', () => {
    // The generic text reads "stalled ... without output", which is actively
    // WRONG for this phase: the model WAS producing output — reasoning — and
    // then stopped mid-thought.
    const text = visibleText('reasoning');
    expect(text).toContain('mid-reasoning');
    expect(text).not.toContain('without output');
  });

  it('leaves the other two phases unchanged', () => {
    expect(visibleText('streaming')).toContain('without output');
    expect(visibleText('awaiting-output')).toContain('produced no output within');
  });
});
