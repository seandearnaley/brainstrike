import { SHELL_OUTPUT_DATA_NAME } from '@brainstrike/assistant-contract';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useChainActivityDerivations } from '../use-chain-activity-derivations';

const slice = (toolCallId: string, chunk: string) => ({
  data: { chunk, stream: 'stdout', toolCallId },
  name: SHELL_OUTPUT_DATA_NAME,
  type: 'data',
});

describe('useChainActivityDerivations under the React Compiler', () => {
  it('accumulates the next message’s shell output, not the previous message’s', () => {
    const { result, rerender } = renderHook(
      ({ messageId, parts }: { messageId: string; parts: readonly unknown[] }) =>
        useChainActivityDerivations(parts, messageId, []),
      { initialProps: { messageId: 'message-a', parts: [slice('call-a', 'first\n')] } }
    );
    expect(result.current.shellOutputs).toEqual({
      'call-a': { text: 'first\n', truncated: false },
    });

    rerender({ messageId: 'message-b', parts: [slice('call-b', 'second\n')] });

    expect(result.current.shellOutputs).toEqual({
      'call-b': { text: 'second\n', truncated: false },
    });
  });
});
