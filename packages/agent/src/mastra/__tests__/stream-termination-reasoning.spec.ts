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

  const visibleText = (
    phase: 'awaiting-output' | 'reasoning' | 'streaming' | 'tool-executing',
    runtimeData?: { model?: string; provider?: string }
  ): string => {
    const chunks = makeStreamWatchdogTermination(
      new StreamStalledError(phase === 'tool-executing' ? 635_000 : 600_000, {
        lastPartType: phase === 'tool-executing' ? 'tool-call' : 'reasoning-delta',
        partsSeen: phase === 'tool-executing' ? 4 : 58,
        phase,
      }),
      lifecycleState(),
      runtimeData
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

  it('reports a tool-executing stall without asserting a cause it cannot know', () => {
    const text = visibleText('tool-executing');
    expect(text).toContain(
      'A tool call was still running after 635000ms, including its lifecycle hooks. The turn was ended rather than retried, because re-running the step could start a second execution of a command that may still be alive. If no PreToolUse/PostToolUse hook is slow, please report it with a debug bundle.'
    );
    // The guard is not the only thing inside this silence: lifecycle hooks
    // compose OUTSIDE it and are not capped in aggregate, so the message must
    // not claim the guard failed.
    expect(text).not.toContain('never answered');
    expect(text).not.toContain('Brainstrike bug');
  });

  it('gives the same tool-executing text on a local runtime, not the Ollama remedy', () => {
    // A local-runtime stall normally gets the "verify the Ollama server"
    // remedy, but that is wrong advice here: the provider already answered
    // and the FAILURE is in our own execution guard, not the runner.
    const text = visibleText('tool-executing', { model: 'x', provider: 'ollama' });
    expect(text).toContain(
      'A tool call was still running after 635000ms, including its lifecycle hooks. The turn was ended rather than retried, because re-running the step could start a second execution of a command that may still be alive. If no PreToolUse/PostToolUse hook is slow, please report it with a debug bundle.'
    );
    expect(text).not.toContain('Verify the Ollama server');
  });
});
