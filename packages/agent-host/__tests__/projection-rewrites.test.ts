import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import type { HostProjectionRewrite } from '../src/ports.js';
import { applyProjectionRewrites } from '../src/projection-rewrites.js';

function call(toolCallId: string, value: string): ModelMessage[] {
  return [
    {
      content: [
        { input: {}, toolCallId, toolName: 'brainstrike_readWorkspaceFile', type: 'tool-call' },
      ],
      role: 'assistant',
    },
    {
      content: [
        {
          output: { type: 'text', value },
          toolCallId,
          toolName: 'brainstrike_readWorkspaceFile',
          type: 'tool-result',
        },
      ],
      role: 'tool',
    },
  ];
}

const superseded: HostProjectionRewrite = {
  kind: 'supersession',
  markerText: 'read a.ts [superseded]',
  supersededByToolCallId: 'later',
  toolCallId: 'earlier',
};

function output(messages: readonly ModelMessage[], toolCallId: string): unknown {
  for (const message of messages) {
    if (message.role === 'tool') {
      const part = message.content.find(
        (candidate) => candidate.type === 'tool-result' && candidate.toolCallId === toolCallId
      );
      if (part?.type === 'tool-result') {
        return part.output;
      }
    }
  }
  return undefined;
}

describe('applyProjectionRewrites', () => {
  it('replaces a superseded result while its superseding call is in the same messages', () => {
    const messages = [...call('earlier', 'old body'), ...call('later', 'new body')];
    const rewritten = applyProjectionRewrites(messages, new Map([['earlier', superseded]]));
    expect(output(rewritten, 'earlier')).toEqual({ type: 'text', value: superseded.markerText });
    expect(output(rewritten, 'later')).toEqual({ type: 'text', value: 'new body' });
  });

  it('keeps a superseded result whose superseding call is not in the messages', () => {
    const messages = call('earlier', 'old body');
    const rewritten = applyProjectionRewrites(messages, new Map([['earlier', superseded]]));
    expect(output(rewritten, 'earlier')).toEqual({ type: 'text', value: 'old body' });
  });
});
