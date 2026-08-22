import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { ScopedLogger } from '@brainstrike/logging';
import type { DelegationStartContext } from '@mastra/core/agent';
import { describe, expect, it, vi } from 'vitest';
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
    const config = createDelegationConfig({ logger: silentLogger, personasById });
    const result = config.onDelegationStart?.(startContext({ params: { maxSteps: 50 } }));
    expect(result).toEqual({ modifiedMaxSteps: 8, proceed: true });
  });

  it('defaults modifiedMaxSteps to the persona cap when the model requests none', () => {
    const config = createDelegationConfig({ logger: silentLogger, personasById });
    const result = config.onDelegationStart?.(startContext());
    expect(result).toEqual({ modifiedMaxSteps: 8, proceed: true });
  });

  it('rejects a delegation to an unknown persona (no silent fallback)', () => {
    const config = createDelegationConfig({ logger: silentLogger, personasById });
    const result = config.onDelegationStart?.(startContext({ primitiveId: 'ghost' }));
    expect(result).toMatchObject({ proceed: false });
  });

  it('rejects the 3rd concurrent start while 2 are in flight', () => {
    const config = createDelegationConfig({ logger: silentLogger, personasById });
    expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
    expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
    expect(MAX_CONCURRENT_DELEGATIONS).toBe(2);
    expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: false });
  });

  it('a completed delegation frees a concurrency slot', () => {
    const config = createDelegationConfig({ logger: silentLogger, personasById });
    config.onDelegationStart?.(startContext());
    config.onDelegationStart?.(startContext());
    config.onDelegationComplete?.(completeContext());
    expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
  });

  it('a rejected start does NOT consume a slot', () => {
    const config = createDelegationConfig({ logger: silentLogger, personasById });
    // Unknown persona rejected — must not increment inFlight.
    config.onDelegationStart?.(startContext({ primitiveId: 'ghost' }));
    expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
    expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
    // Now 2 in flight; the 3rd is rejected by concurrency, proving the earlier
    // ghost rejection consumed nothing.
    expect(config.onDelegationStart?.(startContext())).toMatchObject({ proceed: false });
  });

  it('enforces the per-run total cap across completed delegations', () => {
    const config = createDelegationConfig({ logger: silentLogger, personasById });
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
    const config = createDelegationConfig({ logger: silentLogger, personasById });
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
    const config = createDelegationConfig({ logger: silentLogger, personasById });
    config.onDelegationStart?.(startContext());
    const result = await config.onDelegationComplete?.(
      completeContext({ result: { subAgentToolResults: [], text: '   ' } })
    );

    expect(result).toMatchObject({ resultText: expect.stringContaining('no tool calls') });
  });

  it('leaves a real answer untouched', async () => {
    const config = createDelegationConfig({ logger: silentLogger, personasById });
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

  it('prefers a forced synthesis answer over the no-answer reason', async () => {
    const outcomes = createDelegationOutcomeCapture();
    const config = createDelegationConfig({
      delegationOutcomes: outcomes,
      logger: silentLogger,
      personasById,
      synthesizeChildAnswer: () => Promise.resolve('  Three matches under src/.  '),
    });
    config.onDelegationStart?.(startContext());
    const result = await config.onDelegationComplete?.(
      completeContext({
        result: { subAgentToolResults: [{ toolCallId: 'c1' }], text: '' },
        toolCallId: 'call-synth',
      })
    );

    expect(result).toEqual({ resultText: 'Three matches under src/.' });
    // A delegation that ended up answering is NOT flagged for the timeline.
    expect(outcomes.returnedNoAnswer('call-synth')).toBe(false);
  });

  it('falls through to the no-answer reason when synthesis fails, and still flags it', async () => {
    // Not a silent fallback: the failure is logged with its own code, and the
    // text the parent receives still says truthfully that nothing was analysed.
    // What must never happen is a synthesis error taking down the parent run.
    const outcomes = createDelegationOutcomeCapture();
    const config = createDelegationConfig({
      delegationOutcomes: outcomes,
      logger: silentLogger,
      personasById,
      synthesizeChildAnswer: () => Promise.reject(new Error('provider exploded')),
    });
    config.onDelegationStart?.(startContext());
    const result = await config.onDelegationComplete?.(
      completeContext({
        result: { subAgentToolResults: [{ toolCallId: 'c1' }], text: '' },
        toolCallId: 'call-synth-failed',
      })
    );

    expect(result).toMatchObject({
      resultText: expect.stringContaining('never wrote its summary'),
    });
    expect(outcomes.returnedNoAnswer('call-synth-failed')).toBe(true);
  });

  it('does not attempt synthesis when the child gathered nothing to summarise', async () => {
    const synthesize = vi.fn(() => Promise.resolve('should not be called'));
    const config = createDelegationConfig({
      logger: silentLogger,
      personasById,
      synthesizeChildAnswer: synthesize,
    });
    config.onDelegationStart?.(startContext());
    await config.onDelegationComplete?.(
      completeContext({ result: { subAgentToolResults: [], text: '' } })
    );

    expect(synthesize).not.toHaveBeenCalled();
  });

  it('treats a blank synthesis answer as no answer', async () => {
    const config = createDelegationConfig({
      logger: silentLogger,
      personasById,
      synthesizeChildAnswer: () => Promise.resolve('   \n  '),
    });
    config.onDelegationStart?.(startContext());
    const result = await config.onDelegationComplete?.(
      completeContext({ result: { subAgentToolResults: [{ toolCallId: 'c1' }], text: '' } })
    );

    expect(result).toMatchObject({
      resultText: expect.stringContaining('never wrote its summary'),
    });
  });

  it('still frees the concurrency slot for an empty delegation', () => {
    const config = createDelegationConfig({ logger: silentLogger, personasById });
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
