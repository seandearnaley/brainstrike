import { describe, expect, it } from 'vitest';
import { createToolExecutionDurations } from '../../tools/tool-execution-durations';
import { createDelegationLifecycleTracker } from '../subagent-delegation';
import type { ToolLifecycleState } from '../tool-lifecycle-processors';
import {
  makePendingToolOutputRunEventChunks,
  mapToolLifecyclePart,
} from '../tool-lifecycle-processors';

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

  it('rounds a fractional measured duration to integer milliseconds', () => {
    // Field regression (2026-08-23, 22P02): the guard wrapper measures with
    // performance.now(), whose deltas are FRACTIONAL — and the run-event
    // table's duration_ms column is INTEGER. Every terminal tool event
    // carrying a measured duration failed to persist ("invalid input syntax
    // for type integer: \"15.73333299998194\""), punching holes in the
    // durable timeline the debug bundle reads. The stamp must round, never
    // forward the raw float.
    const durations = createToolExecutionDurations();
    durations.record('call-1', 15.733_332_999_981_94);

    const chunks = terminalEvent(lifecycleState(durations), 'success');
    const event = chunks.find(
      (chunk) => (chunk as { event?: { kind?: string } }).event?.kind === 'tool.completed'
    ) as { event: { durationMs?: number } } | undefined;

    expect(event?.event.durationMs).toBe(16);
  });

  it('drops a non-finite recorded duration instead of stamping garbage', () => {
    // The other half of the integrality contract: NaN/Infinity round to
    // NaN/Infinity, which the column rejects just the same — the field is
    // omitted so the consumer falls back to the timestamp delta.
    const durations = createToolExecutionDurations();
    durations.record('call-1', Number.NaN);

    const chunks = terminalEvent(lifecycleState(durations), 'success');
    const event = chunks.find(
      (chunk) => (chunk as { event?: { kind?: string } }).event?.kind === 'tool.completed'
    ) as { event: { durationMs?: number } } | undefined;

    expect(event?.event.durationMs).toBeUndefined();
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

  it('stamps the buffered output-only completion too', () => {
    // Mastra can terminate a successful call with `tool-output` and no later
    // `tool-result`. That completion is BUFFERED and flushed by
    // makePendingToolOutputRunEventChunks, which builds its own event — so a
    // stamp applied only on the tool-result path leaves this supported stream
    // shape falling back to the start-to-terminal gap, approval wait included.
    const durations = createToolExecutionDurations();
    durations.record('call-1', 2000);
    const state = lifecycleState(durations);

    // A `tool-output` success with no following `tool-result` buffers instead
    // of emitting.
    const buffered = mapToolLifecyclePart(
      {
        payload: { output: { ok: true }, toolCallId: 'call-1', toolName: 'executeCommand' },
        type: 'tool-output',
      },
      new Map([['executeCommand', 'brainstrike.executeCommand']]),
      state,
      'tool-output',
      undefined,
      new Map()
    ).chunks;
    expect(
      buffered.some(
        (chunk) => (chunk as { event?: { kind?: string } }).event?.kind === 'tool.completed'
      )
    ).toBe(false);

    const flushed = makePendingToolOutputRunEventChunks(state);
    const event = flushed.find(
      (chunk) => (chunk as { event?: { kind?: string } }).event?.kind === 'tool.completed'
    ) as { event: { durationMs?: number } } | undefined;

    expect(event?.event.durationMs).toBe(2000);
  });

  it('reports a DECLINED call as zero, not the deliberation time', () => {
    // The same bug in its worst form. A declined requireApproval call gets its
    // `tool.started` when the model emits the tool-call part and its
    // `tool.failed` only after the human clicks Deny — but `execute` never
    // runs, so nothing is recorded and the consumer falls back to the gap.
    // Deny after five minutes and the card reads 5m 0s for a tool that never
    // ran at all. A decline is MORE likely to sit behind a long pause than an
    // approval is.
    //
    // Zero is stamped as an explicit literal rather than through the recorder:
    // the recorder means "measured", this means "known not to have run".
    const chunks = mapToolLifecyclePart(
      {
        payload: { toolCallId: 'call-1', toolName: 'executeCommand' },
        type: 'tool-output-denied',
      },
      new Map([['executeCommand', 'brainstrike.executeCommand']]),
      lifecycleState(createToolExecutionDurations()),
      'tool-output-denied',
      undefined,
      new Map()
    ).chunks;

    const event = chunks.find(
      (chunk) => (chunk as { event?: { kind?: string } }).event?.kind === 'tool.failed'
    ) as { event: { durationMs?: number } } | undefined;

    expect(event?.event.durationMs).toBe(0);
  });
});
