import { describe, expect, it } from 'vitest';
import { createToolExecutionDurations } from '../../tools/tool-execution-durations';
import { createDelegationLifecycleTracker } from '../subagent-delegation';
import type { ToolLifecycleState } from '../tool-lifecycle-processors';
import { mapToolLifecyclePart } from '../tool-lifecycle-processors';

/**
 * The WIRING between the guard's measurement and the terminal run event.
 *
 * The arithmetic is covered in `tool-execution-durations.spec.ts` and the
 * consumer side in `@brainstrike/assistant-ui`. What neither proves is that the
 * number actually travels — and a fix whose units pass while the value never
 * reaches the event is exactly the shape of the first, inert attempt at this.
 */
describe('terminal tool run events carry the measured duration', () => {
  const lifecycleState = (durations?: ReturnType<typeof createToolExecutionDurations>) =>
    ({
      carriedCompletionTokens: 0,
      carriedPromptTokens: 0,
      delegationLifecycle: createDelegationLifecycleTracker(),
      includeCacheTokenClasses: false,
      outputOnlyToolEvents: new Map(),
      requiresBilledCost: false,
      sawStepBilledCost: false,
      sawStepWithoutBilledCost: false,
      stepBilledCostUsd: 0,
      stepCount: 0,
      steppedCompletionTokens: 0,
      steppedPromptTokens: 0,
      streamStartedAtMs: 0,
      terminalToolCallStates: new Map(),
      warnedUnknownChunkTypes: new Set(),
      ...(durations ? { toolExecutionDurations: durations } : {}),
    }) satisfies ToolLifecycleState;

  /** Drives the PUBLIC mapper entry, the one agent-streaming actually calls. */
  const terminalEvent = (state: ToolLifecycleState, status: 'success' | 'error') =>
    mapToolLifecyclePart(
      {
        payload: { output: { ok: true }, toolCallId: 'call-1', toolName: 'executeCommand' },
        type: status === 'success' ? 'tool-result' : 'tool-error',
      },
      new Map([['executeCommand', 'brainstrike.executeCommand']]),
      state,
      status === 'success' ? 'tool-result' : 'tool-error',
      undefined,
      new Map()
    ).chunks;

  it('stamps durationMs on tool.completed', () => {
    const durations = createToolExecutionDurations();
    durations.record('call-1', 2000);

    const chunks = terminalEvent(lifecycleState(durations), 'success');
    const event = chunks.find(
      (chunk) => (chunk as { event?: { kind?: string } }).event?.kind === 'tool.completed'
    ) as { event: { durationMs?: number } } | undefined;

    expect(event?.event.durationMs).toBe(2000);
  });

  it('stamps durationMs on tool.failed too', () => {
    // "How long did it run before failing" is exactly what a reader wants on a
    // failure, so the guard records for throws and timeouts as well.
    const durations = createToolExecutionDurations();
    durations.record('call-1', 750);

    const chunks = terminalEvent(lifecycleState(durations), 'error');
    const event = chunks.find(
      (chunk) => (chunk as { event?: { kind?: string } }).event?.kind === 'tool.failed'
    ) as { event: { durationMs?: number } } | undefined;

    expect(event?.event.durationMs).toBe(750);
  });

  it('omits durationMs when nothing was recorded', () => {
    // NO FABRICATION: the consumer then falls back to the timestamp delta,
    // which is the pre-existing behaviour.
    const chunks = terminalEvent(lifecycleState(createToolExecutionDurations()), 'success');
    const event = chunks.find(
      (chunk) => (chunk as { event?: { kind?: string } }).event?.kind === 'tool.completed'
    ) as { event: { durationMs?: number } } | undefined;

    expect(event?.event.durationMs).toBeUndefined();
  });
});
