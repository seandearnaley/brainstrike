import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { ScopedLogger } from '@brainstrike/utils';
import type { DelegationStartContext } from '@mastra/core/agent';
import { describe, expect, it } from 'vitest';
import {
  createDelegationConfig,
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
