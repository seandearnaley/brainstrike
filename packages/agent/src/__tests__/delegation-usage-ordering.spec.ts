import { describe, expect, it } from 'vitest';
import { createDelegationUsageCapture } from '../mastra/tool-lifecycle-processors';

const delegation = {
  parentRuntimeRunId: 'parent-run',
  parentToolCallId: 'delegate-call',
  resourceId: 'child-resource',
  threadId: 'child-thread',
};

describe('bound delegation usage ordering', () => {
  it('holds an early completion until its parent result, without draining a concurrent child', () => {
    const capture = createDelegationUsageCapture(new Map(), { model: 'test', provider: 'openai' });
    capture.onChildUsage({ delegation, inputTokens: 2, outputTokens: 3, personaId: 'explore' });
    capture.onChildUsage({
      delegation: { ...delegation, parentToolCallId: 'other-call' },
      inputTokens: 5,
      outputTokens: 8,
      personaId: 'explore',
    });
    expect(capture.drain({ runId: 'parent-run', type: 'start' })).toEqual([]);
    expect(
      capture.drain({
        payload: { output: { type: 'tool-result' }, toolCallId: 'delegate-call' },
        runId: 'parent-run',
        type: 'tool-output',
      })
    ).toEqual([]);
    expect(
      capture.drain({
        payload: { toolCallId: 'delegate-call' },
        runId: 'another-run',
        type: 'tool-result',
      })
    ).toEqual([]);
    expect(
      capture.drain({
        payload: { toolCallId: 'delegate-call' },
        runId: 'parent-run',
        type: 'tool-result',
      })
    ).toEqual([
      {
        type: 'child-run-usage',
        value: {
          delegation,
          estimated: false,
          inputTokens: 2,
          model: 'test',
          outputTokens: 3,
          personaId: 'explore',
          provider: 'openai',
          source: 'subagent',
        },
      },
    ]);
    expect(capture.drain({ runId: 'parent-run', type: 'finish' })).toHaveLength(1);
    expect(capture.drain()).toEqual([]);
  });

  it('preserves legacy unbound delivery and a terminal drain', () => {
    const capture = createDelegationUsageCapture(new Map(), undefined);
    capture.onChildUsage({ inputTokens: 1, outputTokens: 2, personaId: 'explore' });
    expect(capture.drain({ type: 'start' })).toHaveLength(1);
    capture.onChildUsage({ delegation, inputTokens: 3, outputTokens: 4, personaId: 'explore' });
    expect(capture.drain()).toHaveLength(1);
  });
});
