import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import type { ScopedLogger } from '@brainstrike/logging';
import { describe, expect, it } from 'vitest';
import { createDelegationConfig, createDelegationOutcomeCapture } from '../subagent-delegation';

const logger = {
  debug: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  info: () => undefined,
  trace: () => undefined,
  warn: () => undefined,
} as unknown as ScopedLogger;

const persona: AssistantPersonaDefinition = {
  allowedToolIds: [],
  description: 'Inspect',
  id: 'explore',
  instructions: 'Inspect.',
  label: 'Explorer',
  maxSteps: 8,
};

function failedContext(error: Error) {
  return {
    bail: () => undefined,
    duration: 10,
    error,
    iteration: 1,
    messages: [],
    parentAgentId: 'parent',
    parentAgentName: 'Parent',
    primitiveId: 'explore',
    primitiveType: 'agent' as const,
    prompt: 'inspect',
    result: { text: '' },
    runId: 'parent-run',
    success: false,
    toolCallId: 'delegation-call',
  };
}

describe('delegation Stop causality', () => {
  it('does not hide an unrelated AbortError that races an explicit Stop', async () => {
    const externalStop = new AbortController();
    const attempt = new AbortController();
    const reason = new Error('selected Stop');
    externalStop.abort(reason);
    attempt.abort(reason);
    const outcomes = createDelegationOutcomeCapture();
    const config = createDelegationConfig({
      abortSignal: attempt.signal,
      delegationOutcomes: outcomes,
      externalStopSignal: externalStop.signal,
      logger,
      personasById: new Map([['explore', persona]]),
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    const unrelated = new Error('provider aborted independently');
    unrelated.name = 'AbortError';

    const result = await config.onDelegationComplete?.(failedContext(unrelated));

    expect(result).toMatchObject({
      resultText: expect.stringContaining('failed before completing'),
    });
    expect(outcomes.failed('delegation-call', 'parent-run')).toBe(true);
  });

  it('recognizes the exact Stop reason through a wrapper cause', async () => {
    const externalStop = new AbortController();
    const attempt = new AbortController();
    const reason = new Error('selected Stop');
    externalStop.abort(reason);
    attempt.abort(reason);
    const outcomes = createDelegationOutcomeCapture();
    const config = createDelegationConfig({
      abortSignal: attempt.signal,
      delegationOutcomes: outcomes,
      externalStopSignal: externalStop.signal,
      logger,
      personasById: new Map([['explore', persona]]),
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });

    const result = await config.onDelegationComplete?.(
      failedContext(new Error('wrapped Stop', { cause: reason }))
    );

    expect(result).toBeUndefined();
    expect(outcomes.failed('delegation-call', 'parent-run')).toBe(false);
  });
});
