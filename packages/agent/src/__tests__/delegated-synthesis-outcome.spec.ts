import { SUBAGENT_TRUNCATED_OUTCOME } from '@brainstrike/assistant-contract/personas';
import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import type { ScopedLogger } from '@brainstrike/logging';
import { describe, expect, it } from 'vitest';
import {
  createDelegatedSynthesisOutcomes,
  type DelegatedSynthesisOutcome,
} from '../mastra/delegated-synthesis-outcomes';
import {
  createDelegationConfig,
  createDelegationOutcomeCapture,
} from '../mastra/subagent-delegation';
import { makeTerminalRunEvent, mapToolLifecyclePart } from '../mastra/tool-lifecycle-processors';
import { createTurnAttemptLifecycleState } from '../mastra/turn-attempts';

const silentLogger = {
  debug: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  info: () => undefined,
  trace: () => undefined,
  warn: () => undefined,
} as unknown as ScopedLogger;

const finish = (finishReason: string) => ({
  finishReason,
  payload: { output: { usage: { inputTokens: 10, outputTokens: 512 } } },
  type: 'finish',
});

function outcome(overrides: Partial<DelegatedSynthesisOutcome> = {}): DelegatedSynthesisOutcome {
  return {
    cap: 'steps',
    limit: 32,
    outputTokens: 512,
    reservedOutputTokens: 2048,
    truncated: true,
    used: 31,
    ...overrides,
  };
}

function childState(threadId: string) {
  return createTurnAttemptLifecycleState({ memory: { threadId } }, undefined, undefined);
}

describe('a length finish on the reserved synthesis step', () => {
  it('is a truncated completion for the child that recorded one', () => {
    const outcomes = createDelegatedSynthesisOutcomes();
    outcomes.record('child', outcome());
    const state = childState('child');
    state.synthesisOutcomes = outcomes;
    expect(makeTerminalRunEvent(finish('length'), state)).toMatchObject({
      event: {
        kind: 'run.finished',
        metadata: {
          finishReason: 'length',
          outcome: SUBAGENT_TRUNCATED_OUTCOME,
          reservedOutputTokens: 2048,
        },
        status: 'completed',
      },
      type: 'run-event',
    });
  });

  it('stays a failure mid-run (no synthesis recorded), for a sibling, and on the root', () => {
    const outcomes = createDelegatedSynthesisOutcomes();
    const child = childState('child');
    child.synthesisOutcomes = outcomes;
    expect(makeTerminalRunEvent(finish('length'), child)).toMatchObject({
      event: { kind: 'run.failed', label: 'Assistant run reached the model output token limit' },
    });
    outcomes.record('sibling', outcome({ outputTokens: 1 }));
    expect(makeTerminalRunEvent(finish('length'), child)).toMatchObject({
      event: { kind: 'run.failed' },
    });
    expect(makeTerminalRunEvent(finish('length'), childState('root'))).toMatchObject({
      event: { kind: 'run.failed' },
    });
  });

  it('a synthesis that was NOT truncated leaves a length finish as a failure', () => {
    const outcomes = createDelegatedSynthesisOutcomes();
    outcomes.record('child', outcome({ outputTokens: 5, truncated: false }));
    const state = childState('child');
    state.synthesisOutcomes = outcomes;
    expect(makeTerminalRunEvent(finish('length'), state)).toMatchObject({
      event: { kind: 'run.failed' },
    });
  });
});

describe('the delegation hook on a truncated child', () => {
  const persona = {
    allowedToolIds: ['brainstrike.grepSearch'],
    description: 'Read evidence',
    id: 'explore',
    instructions: 'Read evidence',
    label: 'Explorer',
    maxSteps: 32,
  };

  function completeContext(result: Record<string, unknown>) {
    return {
      bail: () => undefined,
      duration: 10,
      iteration: 1,
      messages: [],
      parentAgentId: 'parent',
      parentAgentName: 'Parent',
      primitiveId: 'explore',
      primitiveType: 'agent' as const,
      prompt: 'Survey',
      result: { text: '', ...result },
      runId: 'run',
      success: true,
      toolCallId: 'call',
    };
  }

  function configWith(recorded: DelegatedSynthesisOutcome) {
    const outcomes = createDelegatedSynthesisOutcomes();
    outcomes.record('child-thread', recorded);
    const capture = createDelegationOutcomeCapture();
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      delegationOutcomes: capture,
      logger: silentLogger,
      personasById: new Map([[persona.id, persona]]),
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
      synthesisOutcomes: outcomes,
    });
    return { capture, config };
  }

  it('discloses charged overage alongside partial findings', async () => {
    const { config } = configWith(outcome({ outputTokens: 1999, reservedOutputTokens: 1024 }));
    const result = await config.onDelegationComplete?.(
      completeContext({
        finishReason: 'length',
        subAgentResourceId: 'r',
        subAgentThreadId: 'child-thread',
        text: 'PARTIAL',
      })
    );
    expect(result?.resultText).toContain('PARTIAL');
    expect(result?.resultText).toContain(
      '1999 total output tokens, exceeding the 1024-token reservation'
    );
    expect(result?.resultText).toContain(
      'All reported tokens remain charged; no further child work is allowed.'
    );
  });

  it('appends the truncation note to the parent-facing text and records the outcome', async () => {
    const { capture, config } = configWith(outcome());
    const result = await config.onDelegationComplete?.(
      completeContext({
        finishReason: 'length',
        subAgentResourceId: 'r',
        subAgentThreadId: 'child-thread',
        text: 'PARTIAL',
      })
    );
    expect(result?.resultText).toMatch(
      /^PARTIAL\n\n\[Truncated summary\] The explore subagent exhausted its step budget/
    );
    expect(capture.truncated('call', 'run')).toBe(true);
    expect(capture.returnedNoAnswer('call', 'run')).toBe(false);
  });

  it('leaves an ordinary answer untouched when the synthesis finished normally', async () => {
    const { capture, config } = configWith(outcome({ truncated: false }));
    const result = await config.onDelegationComplete?.(
      completeContext({ subAgentResourceId: 'r', subAgentThreadId: 'child-thread', text: 'FULL' })
    );
    expect(result).toBeUndefined();
    expect(capture.truncated('call', 'run')).toBe(false);
  });

  it('a truncated child with EMPTY text is still a no-answer, never a truncated success', async () => {
    const { capture, config } = configWith(outcome({ outputTokens: 0 }));
    const result = await config.onDelegationComplete?.(
      completeContext({ subAgentResourceId: 'r', subAgentThreadId: 'child-thread', text: '' })
    );
    expect(result?.resultText).toMatch(/returned no answer/);
    expect(capture.returnedNoAnswer('call', 'run')).toBe(true);
    expect(capture.truncated('call', 'run')).toBe(false);
  });
});

describe('the delegation lifecycle chunk for a truncated child', () => {
  it('is subagent.finished (completed) carrying outcome truncated', () => {
    const capture = createDelegationOutcomeCapture();
    capture.recordTruncation('call', 'run');
    const state = createTurnAttemptLifecycleState(
      { memory: { threadId: 'root' } },
      capture,
      undefined
    );
    const toolNames = new Map([['call', 'agent-explore']]);
    const personas = new Map([['agent-explore', 'explore']]);
    mapToolLifecyclePart(
      {
        payload: { args: { prompt: 'Survey' }, toolCallId: 'call', toolName: 'agent-explore' },
        runId: 'run',
        type: 'tool-call',
      },
      toolNames,
      state,
      'tool-call',
      undefined,
      personas
    );
    const result = mapToolLifecyclePart(
      {
        payload: { result: 'PARTIAL', toolCallId: 'call', toolName: 'agent-explore' },
        runId: 'run',
        type: 'tool-result',
      },
      toolNames,
      state,
      'tool-result',
      undefined,
      personas
    );
    expect(result.chunks.at(-1)).toMatchObject({
      event: {
        kind: 'subagent.finished',
        label: 'Subagent completed with a truncated summary',
        metadata: { outcome: SUBAGENT_TRUNCATED_OUTCOME, parentToolCallId: 'call' },
        status: 'completed',
      },
      type: 'run-event',
    });
  });
});
