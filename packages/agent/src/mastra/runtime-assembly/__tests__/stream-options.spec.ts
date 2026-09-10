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
      requireToolApproval: undefined,
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
      requireToolApproval: undefined,
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
      requireToolApproval: undefined,
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
    const abortSignal = new AbortController().signal;

    const actual = buildStreamOptions({
      abortSignal,
      delegationOutcomes,
      delegationUsage: { onChildUsage } as never,
      leg: 'initial',
      memoryOption: undefined,
      requireToolApproval: undefined,
      runtime,
      runtimeData: undefined,
    });

    expect(createDelegationConfigSpy).toHaveBeenCalledTimes(1);
    expect(createDelegationConfigSpy).toHaveBeenCalledWith({
      abortSignal,
      delegationOutcomes,
      logger: expect.anything(),
      onChildUsage,
      personasById: runtime.personasById,
      turnPersistence: runtime.delegatedTurnPersistence,
    });
    expect(actual.delegation).toBeDefined();
  });

  /**
   * BST-1649 review finding 2, second half: the per-leg parity cases run on a
   * `{ provider: 'anthropic' }` fixture, and several fragments return `{}` for
   * it. A fragment that contributes nothing is a fragment the whole-object
   * comparison cannot see — deleting
   * `...buildGenerationProviderOptionsOption(runtimeData)` from
   * `buildStreamOptions` left the entire suite green, because both sides were
   * spreading the same empty object.
   *
   * This case runs the comparison on a fixture where every data-valued fragment
   * yields a distinguishable key, and attributes each key to the fragment that
   * produced it before comparing. Pinning only the merged key SET would let the
   * vacuity return by another door: a fragment could regress to `{}` while
   * another grew the key it lost, and the set would still match. What the
   * assertions defend against is implementation drift — a fragment's shape
   * changing under a fixture that no longer satisfies it — not edits to this
   * literal, which is local to this block.
   *
   * The closure-valued fragments (`experimental_generateMessageId`,
   * `delegation`) contribute nothing for THIS input, which is what lets the
   * comparison be a whole-object `toEqual`; a fixture that made either appear
   * would need `objectContaining`, since a fresh closure never equals another.
   */
  it.each(['approval', 'initial', 'resume'] as const)(
    'compares an object every data-valued fragment actually contributes to (%s leg)',
    (leg) => {
      const runtimeData = {
        agentLoop: { inputTokenLimit: 4096, maxSteps: 7 },
        modelSettings: { temperature: 0.3 },
        provider: 'anthropic',
        providerOptions: { anthropic: { thinking: { budgetTokens: 1024, type: 'enabled' } } },
      } satisfies Partial<RuntimeData> as RuntimeData;
      const runtime = makeRuntime();
      const abortSignal = new AbortController().signal;
      const memoryOption = { resource: 'thread-1', thread: 'thread-1' };

      // Each fragment must own its key. A merged-set assertion cannot tell a
      // fragment that went empty from one whose key another fragment now supplies.
      expect(
        Object.keys(
          buildToolLoopOptions(runtimeData, runtime.toolSearchProcessor, runtime.toolHistoryFilter)
        ).sort()
      ).toEqual(['inputProcessors', 'maxSteps']);
      expect(Object.keys(buildModelSettingsOption(runtimeData))).toEqual(['modelSettings']);
      expect(Object.keys(buildGenerationProviderOptionsOption(runtimeData))).toEqual([
        'providerOptions',
      ]);

      const expected = {
        ...buildToolLoopOptions(
          runtimeData,
          runtime.toolSearchProcessor,
          runtime.toolHistoryFilter
        ),
        abortSignal,
        memory: memoryOption,
        ...buildModelSettingsOption(runtimeData),
        ...buildGenerationProviderOptionsOption(runtimeData),
      };

      const actual = buildStreamOptions({
        abortSignal,
        delegationOutcomes: undefined,
        delegationUsage: undefined,
        leg,
        memoryOption,
        requireToolApproval: undefined,
        runtime,
        runtimeData,
      });

      // Every leg composes the same data-valued fragments; only `requireToolApproval`
      // is leg-dependent, and it is absent here. A composition that ever went
      // leg-dependent would surface as one parameterisation failing.
      expect(actual).toEqual(expected);
    }
  );

  it('builds no delegation config when delegationUsage is absent', () => {
    const createDelegationConfigSpy = vi.spyOn(subagentDelegation, 'createDelegationConfig');
    const runtime = makeRuntime();

    const actual = buildStreamOptions({
      abortSignal: new AbortController().signal,
      delegationOutcomes: undefined,
      delegationUsage: undefined,
      leg: 'initial',
      memoryOption: undefined,
      requireToolApproval: undefined,
      runtime,
      runtimeData: undefined,
    });

    expect(createDelegationConfigSpy).not.toHaveBeenCalled();
    expect(actual).not.toHaveProperty('delegation');
  });
});

/**
 * BST-1699. `buildModelSettingsOption` is the LAST Brainstrike-owned seam
 * before Mastra hands `modelSettings` to the AI SDK adapter, and the only one
 * that ADDS to what the client sent (the OpenRouter and local
 * `maxOutputTokens` backstops). OpenAI `gpt-6-astra`, the latest Gemini models
 * and Anthropic Opus 4.7+ (including its Bedrock Fable 5.1 route) reject or
 * deprecate non-default `temperature` / `top_p` / `top_k`, so a backstop that
 * ever grew a sampling default would 400 every one of those models at once.
 *
 * The assertion is on the KEY SET, per provider, for a default request: an
 * added sampling key fails even if its value looks innocuous. The adapter half
 * of the proof — that no AI SDK provider package injects a sampling default of
 * its own once these options are empty — lives in
 * `src/__tests__/sampling-params-wire.spec.ts`.
 */
describe('buildModelSettingsOption emits no sampling params by default (BST-1699)', () => {
  const samplingKeys = ['temperature', 'topP', 'top_p', 'topK', 'top_k'];

  it.each(['anthropic', 'bedrock', 'google', 'openai', 'openrouter'] as const)(
    '%s: a default request carries no temperature/top_p/top_k',
    (provider) => {
      const option = buildModelSettingsOption({ provider } as RuntimeData);
      const keys = Object.keys(option.modelSettings ?? {});
      expect(keys.filter((key) => samplingKeys.includes(key))).toEqual([]);
      // OpenRouter is the only one of the five that gets a backstop, and it is
      // an output budget — pinned so "no sampling params" cannot be satisfied
      // by the option going empty for the wrong reason.
      expect(keys).toEqual(provider === 'openrouter' ? ['maxOutputTokens'] : []);
    }
  );

  it('adds no sampling key to a client-sent output budget', () => {
    const option = buildModelSettingsOption({
      modelSettings: { maxOutputTokens: 4096 },
      provider: 'anthropic',
    } as RuntimeData);
    expect(option.modelSettings).toEqual({ maxOutputTokens: 4096 });
  });
});
