import { describe, expect, it } from 'vitest';
import { makeStepFinishedMetadata } from '../tool-lifecycle-processors';
import { createTurnAttemptLifecycleState } from '../turn-attempts';

/**
 * Mastra 1.64's agent-level `step-finish` chunk (create-durable-agent): the
 * step's reason rides `payload.stepResult.reason` and its usage rides
 * `payload.output.usage` — the runtime shape, not a top-level fixture.
 */
function stepFinish(reason: string | undefined): unknown {
  return {
    payload: {
      output: { usage: { inputTokens: 10, outputTokens: 5 } },
      ...(reason === undefined ? {} : { stepResult: { isContinued: false, reason } }),
    },
    type: 'step-finish',
  };
}

function freshState() {
  return createTurnAttemptLifecycleState(undefined, undefined, undefined);
}

describe('makeStepFinishedMetadata', () => {
  it('carries the step finish reason so a length-cut step is visible without the terminal event', () => {
    expect(makeStepFinishedMetadata(stepFinish('length'), freshState())).toEqual({
      completionTokens: 5,
      finishReason: 'length',
      promptTokens: 10,
    });
  });

  it('normalizes a provider spelling exactly like the terminal event', () => {
    expect(makeStepFinishedMetadata(stepFinish('tool_calls'), freshState())).toMatchObject({
      finishReason: 'tool-calls',
    });
  });

  it('omits finishReason when the part carries none, never writing the absent sentinel', () => {
    expect(makeStepFinishedMetadata(stepFinish(undefined), freshState())).toEqual({
      completionTokens: 5,
      promptTokens: 10,
    });
  });

  it('stays undefined for a part that carries nothing worth recording', () => {
    expect(makeStepFinishedMetadata({ type: 'step-finish' }, freshState())).toBeUndefined();
  });
});
