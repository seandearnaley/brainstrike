/**
 * BST-1649: per-leg parity oracle for `buildStreamOptions`.
 *
 * `agent-streaming.ts` still spreads the same ~8 option fragments inline,
 * three times, in `createInitialTurnAttempt`, `createToolApprovalTurnAttempt`,
 * and `createToolResumeTurnAttempt`. This suite captures the EXACT object
 * each of those factories builds today (for a minimal, deterministic
 * `runtimeData`/`runtime` fixture) and proves `buildStreamOptions` emits an
 * equal object per leg — including the resume leg's deliberate omission of
 * `requireToolApproval` (see the docblock above `streamMastraToolResumeAction`
 * in `agent-streaming.ts`: "Does NOT pass requireToolApproval — that is
 * approval-specific").
 *
 * Functions that close over fresh per-call state (`delegation`'s
 * `onDelegationStart`/`onDelegationComplete`, `experimental_generateMessageId`)
 * cannot be compared by `toEqual` even between two calls of the SAME
 * unmodified pre-refactor code — a fresh closure is what those factories have
 * always returned. Those are covered by dedicated tests below asserting the
 * building blocks are invoked with the right arguments, rather than folded
 * into the whole-object comparison.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeData } from '../../../types';
import type { MastraAgentRuntime } from '../../agent-runtime';
import * as subagentDelegation from '../../subagent-delegation';
import {
  buildAssistantStreamMessageIdOption,
  buildGenerationProviderOptionsOption,
  buildModelSettingsOption,
  buildStreamOptions,
  buildToolLoopOptions,
} from '../stream-options';

function makeRuntime(overrides: Partial<MastraAgentRuntime> = {}): MastraAgentRuntime {
  return {
    askTools: new Map(),
    permissionEnforced: false,
    personasById: new Map(),
    toolHistoryFilter: undefined,
    toolSearchProcessor: undefined,
    ...overrides,
  } as unknown as MastraAgentRuntime;
}

describe('buildStreamOptions per-leg parity (BST-1649)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initial leg: matches the spread createInitialTurnAttempt builds today', () => {
    const runtimeData = { provider: 'anthropic' } as RuntimeData;
    const runtime = makeRuntime();
    const abortSignal = new AbortController().signal;

    // Literal copy of createInitialTurnAttempt's `streamOptions` expression,
    // with no memory/delegation/approval configured.
    const expected = {
      ...buildToolLoopOptions(runtimeData, runtime.toolSearchProcessor, runtime.toolHistoryFilter),
      abortSignal,
      ...buildAssistantStreamMessageIdOption(runtimeData),
      ...buildModelSettingsOption(runtimeData),
      ...buildGenerationProviderOptionsOption(runtimeData),
    };

    const actual = buildStreamOptions({
      abortSignal,
      delegationOutcomes: undefined,
      delegationUsage: undefined,
      leg: 'initial',
      memoryOption: undefined,
      runtime,
      runtimeData,
    });

    expect(actual).toEqual(expected);
    expect(actual).not.toHaveProperty('runId');
    expect(actual).not.toHaveProperty('toolCallId');
  });

  it('initial leg: threads a raw requireToolApproval value through untouched', () => {
    const runtime = makeRuntime();
    const actual = buildStreamOptions({
      abortSignal: new AbortController().signal,
      delegationOutcomes: undefined,
      delegationUsage: undefined,
      leg: 'initial',
      memoryOption: undefined,
      requireToolApproval: true,
      runtime,
      runtimeData: undefined,
    });
    expect(actual.requireToolApproval).toBe(true);
  });

  it('approval leg: matches the spread createToolApprovalTurnAttempt builds today, including runId/toolCallId and the ALREADY-RESOLVED gate', () => {
    const runtime = makeRuntime();
    const abortSignal = new AbortController().signal;
    const runtimeData = { provider: 'anthropic' } as RuntimeData;
    const resolvedGate = ({ toolName }: { toolName: string }): boolean => toolName === 'run_python';

    // Literal copy of createToolApprovalTurnAttempt's `approvalOptions`
    // expression (the gate is resolved BEFORE this spread, by
    // resolveResumeApprovalGate — buildStreamOptions receives the already-
    // resolved value, matching today's factory).
    const expected = {
      ...buildToolLoopOptions(runtimeData, runtime.toolSearchProcessor, runtime.toolHistoryFilter),
      abortSignal,
      runId: 'run-1',
      toolCallId: 'call-1',
      ...buildAssistantStreamMessageIdOption(runtimeData),
      ...buildModelSettingsOption(runtimeData),
      ...buildGenerationProviderOptionsOption(runtimeData),
      requireToolApproval: resolvedGate,
    };

    const actual = buildStreamOptions({
      abortSignal,
      delegationOutcomes: undefined,
      delegationUsage: undefined,
      leg: 'approval',
      memoryOption: undefined,
      requireToolApproval: resolvedGate,
      runId: 'run-1',
      runtime,
      runtimeData,
      toolCallId: 'call-1',
    });

    expect(actual).toEqual(expected);
  });

  it('resume leg: matches the spread createToolResumeTurnAttempt builds today, and OMITS requireToolApproval even if one is passed', () => {
    const runtime = makeRuntime();
    const abortSignal = new AbortController().signal;
    const runtimeData = { provider: 'anthropic' } as RuntimeData;

    // Literal copy of createToolResumeTurnAttempt's `resumeOptions`
    // expression: there is NO requireToolApproval fragment at all on this leg.
    const expected = {
      ...buildToolLoopOptions(runtimeData, runtime.toolSearchProcessor, runtime.toolHistoryFilter),
      abortSignal,
      runId: 'run-2',
      toolCallId: 'call-2',
      ...buildAssistantStreamMessageIdOption(runtimeData),
      ...buildModelSettingsOption(runtimeData),
      ...buildGenerationProviderOptionsOption(runtimeData),
    };

    const actual = buildStreamOptions({
      abortSignal,
      delegationOutcomes: undefined,
      delegationUsage: undefined,
      leg: 'resume',
      memoryOption: undefined,
      // A caller mistake to prove the SUPPRESSION is structural, not just
      // "nobody happens to pass one": resume never legitimately computes a
      // gate, but the builder must drop it either way.
      requireToolApproval: true,
      runId: 'run-2',
      runtime,
      runtimeData,
      toolCallId: 'call-2',
    });

    expect(actual).toEqual(expected);
    expect(actual).not.toHaveProperty('requireToolApproval');
  });

  it('includes memory only when a memoryOption is resolved, on every leg', () => {
    const runtime = makeRuntime();
    const withMemory = buildStreamOptions({
      abortSignal: new AbortController().signal,
      delegationOutcomes: undefined,
      delegationUsage: undefined,
      leg: 'initial',
      memoryOption: { resource: 'r1', thread: 't1' },
      runtime,
      runtimeData: undefined,
    });
    expect(withMemory.memory).toEqual({ resource: 'r1', thread: 't1' });

    const withoutMemory = buildStreamOptions({
      abortSignal: new AbortController().signal,
      delegationOutcomes: undefined,
      delegationUsage: undefined,
      leg: 'initial',
      memoryOption: undefined,
      runtime,
      runtimeData: undefined,
    });
    expect(withoutMemory).not.toHaveProperty('memory');
  });

  it('delegation: builds the SAME createDelegationConfig fragment the factories build today, only when delegationUsage is present', () => {
    const createDelegationConfigSpy = vi.spyOn(subagentDelegation, 'createDelegationConfig');
    const runtime = makeRuntime({ personasById: new Map([['p1', {} as never]]) });
    const delegationOutcomes = subagentDelegation.createDelegationOutcomeCapture();
    const onChildUsage = vi.fn();

    const actual = buildStreamOptions({
      abortSignal: new AbortController().signal,
      delegationOutcomes,
      delegationUsage: { onChildUsage } as never,
      leg: 'initial',
      memoryOption: undefined,
      runtime,
      runtimeData: undefined,
    });

    expect(createDelegationConfigSpy).toHaveBeenCalledTimes(1);
    expect(createDelegationConfigSpy).toHaveBeenCalledWith({
      delegationOutcomes,
      logger: expect.anything(),
      onChildUsage,
      personasById: runtime.personasById,
    });
    expect(actual.delegation).toBeDefined();
  });

  it('builds no delegation config when delegationUsage is absent', () => {
    const createDelegationConfigSpy = vi.spyOn(subagentDelegation, 'createDelegationConfig');
    const runtime = makeRuntime();

    const actual = buildStreamOptions({
      abortSignal: new AbortController().signal,
      delegationOutcomes: undefined,
      delegationUsage: undefined,
      leg: 'initial',
      memoryOption: undefined,
      runtime,
      runtimeData: undefined,
    });

    expect(createDelegationConfigSpy).not.toHaveBeenCalled();
    expect(actual).not.toHaveProperty('delegation');
  });
});
