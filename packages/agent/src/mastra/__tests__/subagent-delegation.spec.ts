import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { ScopedLogger } from '@brainstrike/logging';
import type { DelegationStartContext } from '@mastra/core/agent';
import { describe, expect, it } from 'vitest';
import {
  createDelegationConfig,
  createDelegationLifecycleTracker,
  createDelegationOutcomeCapture,
  MAX_CONCURRENT_DELEGATIONS,
  MAX_DELEGATIONS_PER_RUN,
  shouldEnablePersonas,
} from '../subagent-delegation';

const silentLogger: ScopedLogger = {
  debug: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  info: () => undefined,
  trace: () => undefined,
  warn: () => undefined,
} as unknown as ScopedLogger;

const persona: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.grepSearch'],
  description: 'Explore',
  id: 'explore',
  instructions: 'Explore.',
  label: 'Explorer',
  maxSteps: 8,
};

const personasById = new Map([['explore', persona]]);

function startContext(overrides: Partial<DelegationStartContext> = {}): DelegationStartContext {
  return {
    iteration: 1,
    messages: [],
    params: {},
    parentAgentId: 'parent',
    parentAgentName: 'Parent',
    primitiveId: 'explore',
    primitiveType: 'agent',
    prompt: 'find the flag',
    runId: 'run-1',
    toolCallId: 'call-1',
    ...overrides,
  };
}

function completeContext(overrides: Record<string, unknown> = {}) {
  return {
    bail: () => undefined,
    duration: 10,
    iteration: 1,
    messages: [],
    parentAgentId: 'parent',
    parentAgentName: 'Parent',
    primitiveId: 'explore',
    primitiveType: 'agent' as const,
    prompt: 'find the flag',
    result: { text: 'done' },
    runId: 'run-1',
    success: true,
    toolCallId: 'call-1',
    ...overrides,
  };
}

describe('createDelegationConfig', () => {
  it('proceeds for a known persona and clamps a model-supplied maxSteps to the cap', () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
    });
    const result = config.onDelegationStart?.(startContext({ params: { maxSteps: 50 } }));
    expect(result).toEqual({ modifiedMaxSteps: 8, proceed: true });
  });

  it('defaults modifiedMaxSteps to the persona cap when the model requests none', () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
    });
    const result = config.onDelegationStart?.(startContext());
    expect(result).toEqual({ modifiedMaxSteps: 8, proceed: true });
  });

  it('rejects a delegation to an unknown persona (no silent fallback)', () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
    });
    const result = config.onDelegationStart?.(startContext({ primitiveId: 'ghost' }));
    expect(result).toMatchObject({ proceed: false });
  });

  it('rejects the 3rd concurrent start while 2 are in flight', () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
    });
    expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
    expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
    expect(MAX_CONCURRENT_DELEGATIONS).toBe(2);
    expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: false });
  });

  it('a completed delegation frees a concurrency slot', () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
    });
    config.onDelegationStart?.(startContext());
    config.onDelegationStart?.(startContext());
    config.onDelegationComplete?.(completeContext());
    expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
  });

  it('a rejected start does NOT consume a slot', () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
    });
    // Unknown persona rejected — must not increment inFlight.
    config.onDelegationStart?.(startContext({ primitiveId: 'ghost' }));
    expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
    expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
    // Now 2 in flight; the 3rd is rejected by concurrency, proving the earlier
    // ghost rejection consumed nothing.
    expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: false });
  });

  it('enforces the per-run total cap across completed delegations', () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
    });
    for (let index = 0; index < MAX_DELEGATIONS_PER_RUN; index += 1) {
      expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
      config.onDelegationComplete?.(completeContext());
    }
    // The (MAX+1)th start is rejected even though nothing is in flight.
    expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: false });
  });
});

describe('createDelegationConfig: a child that returned no answer', () => {
  // BST-1410. Both delegations in run-7eb0e370 used exactly 8 step clusters
  // (the explore persona's cap) and returned `text: ""` with `success: true`.
  // The supervisor read that as a successful-but-empty delegation and abandoned
  // delegation for the rest of the turn. Mastra's own `resultText` docs name
  // this exact case as what the seam exists for.

  it('replaces an empty result with an explicit reason naming the tool-call count', async () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
    });
    config.onDelegationStart?.(startContext());
    const result = await config.onDelegationComplete?.(
      completeContext({
        result: {
          subAgentToolResults: Array.from({ length: 30 }, (_unused, index) => ({
            toolCallId: `child-${index}`,
            toolName: 'brainstrike.grepSearch',
          })),
          text: '',
        },
      })
    );

    expect(result).toMatchObject({
      resultText: expect.stringContaining('30 tool call'),
    });
    // The step cap is context the supervisor needs to re-scope its next
    // delegation; it is NOT asserted as the proven cause, because the hook
    // never sees a finishReason.
    expect((result as { resultText: string }).resultText).toContain('8');
    expect((result as { resultText: string }).resultText).not.toContain('undefined');
  });

  it('distinguishes a child that did nothing at all from one that ran out of steps', async () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
    });
    config.onDelegationStart?.(startContext());
    const result = await config.onDelegationComplete?.(
      completeContext({ result: { subAgentToolResults: [], text: '   ' } })
    );

    expect(result).toMatchObject({ resultText: expect.stringContaining('no tool calls') });
  });

  it('leaves a real answer untouched', async () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
    });
    config.onDelegationStart?.(startContext());
    const result = await config.onDelegationComplete?.(
      completeContext({
        result: { subAgentToolResults: [{ toolCallId: 'c1' }], text: 'Found it.' },
      })
    );

    expect(result).toBeUndefined();
  });

  it('records the under-delivering delegation so the timeline can show it', async () => {
    const outcomes = createDelegationOutcomeCapture();
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      delegationOutcomes: outcomes,
      logger: silentLogger,
      personasById,
    });
    config.onDelegationStart?.(startContext());
    await config.onDelegationComplete?.(
      completeContext({ result: { text: '' }, toolCallId: 'call-empty' })
    );
    config.onDelegationStart?.(startContext());
    await config.onDelegationComplete?.(
      completeContext({ result: { text: 'Found it.' }, toolCallId: 'call-answered' })
    );

    expect(outcomes.returnedNoAnswer('call-empty')).toBe(true);
    expect(outcomes.returnedNoAnswer('call-answered')).toBe(false);
  });

  it('leaves a FAILED delegation alone instead of diagnosing a step cap', async () => {
    // The hook fires for failures too, and a child that threw plausibly arrives
    // with empty text. Handing it the step-cap narrative would be a confident,
    // wrong diagnosis of a provider error.
    const outcomes = createDelegationOutcomeCapture();
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      delegationOutcomes: outcomes,
      logger: silentLogger,
      personasById,
    });
    config.onDelegationStart?.(startContext());
    const result = await config.onDelegationComplete?.(
      completeContext({
        error: new Error('provider exploded'),
        result: { subAgentToolResults: [{ toolCallId: 'c1' }], text: '' },
        success: false,
        toolCallId: 'call-failed',
      })
    );

    expect(result).toBeUndefined();
    expect(outcomes.returnedNoAnswer('call-failed')).toBe(false);
  });

  it('survives a delegation result whose text is not a string', async () => {
    // The exported type says `string`, but the path most likely to carry an
    // unexpected shape is the one that just went wrong.
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
    });
    config.onDelegationStart?.(startContext());
    const result = await config.onDelegationComplete?.(
      completeContext({ result: { subAgentToolResults: [], text: undefined } })
    );

    expect(result).toMatchObject({ resultText: expect.stringContaining('no tool calls') });
  });

  it('says the tool activity is UNKNOWN rather than claiming there was none', async () => {
    // Absence is legitimate — core's v1/legacy delegation path returns `{ text }`
    // with no `subAgentToolResults` — so this must read as a reportable unknown,
    // never as "the child did nothing", which would steer the supervisor to redo
    // work that may already be done.
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
    });
    config.onDelegationStart?.(startContext());
    const result = await config.onDelegationComplete?.(completeContext({ result: { text: '' } }));

    expect(result).toMatchObject({
      resultText: expect.stringContaining('tool activity could not be determined'),
    });
    expect((result as { resultText: string }).resultText).not.toContain('made no tool calls');
  });

  it('still frees the concurrency slot for an empty delegation', () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
    });
    config.onDelegationStart?.(startContext());
    config.onDelegationStart?.(startContext());
    config.onDelegationComplete?.(completeContext({ result: { text: '' } }));
    expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
  });
});

describe('createDelegationLifecycleTracker', () => {
  it('drains the metadata of a started-but-never-settled delegation (abort orphan)', () => {
    const tracker = createDelegationLifecycleTracker();
    tracker.started('delegation-1', { personaId: 'explore', toolName: 'agent-explore' });
    tracker.started('delegation-2', { personaId: 'analyze', toolName: 'agent-analyze' });
    // delegation-2 reached a terminal event; only delegation-1 is orphaned.
    tracker.settled('delegation-2');

    const orphans = tracker.drainInFlight();
    expect(orphans).toEqual([{ personaId: 'explore', toolName: 'agent-explore' }]);
  });

  it('drains nothing when every started delegation settled', () => {
    const tracker = createDelegationLifecycleTracker();
    tracker.started('delegation-1', { personaId: 'explore', toolName: 'agent-explore' });
    tracker.settled('delegation-1');
    expect(tracker.drainInFlight()).toEqual([]);
  });

  it('drains each in-flight delegation exactly once', () => {
    const tracker = createDelegationLifecycleTracker();
    tracker.started('delegation-1', { personaId: 'explore', toolName: 'agent-explore' });
    expect(tracker.drainInFlight()).toHaveLength(1);
    // A second drain (e.g. the finally block after the abort branch) yields nothing.
    expect(tracker.drainInFlight()).toEqual([]);
  });
});

describe('shouldEnablePersonas', () => {
  it('is false for the local provider even with personas', () => {
    expect(shouldEnablePersonas('local', [persona])).toBe(false);
  });

  it('is false when there are no personas', () => {
    expect(shouldEnablePersonas('openai', [])).toBe(false);
    expect(shouldEnablePersonas('openai', undefined)).toBe(false);
  });

  it('is true for a hosted provider with personas', () => {
    expect(shouldEnablePersonas('openai', [persona])).toBe(true);
  });
});
