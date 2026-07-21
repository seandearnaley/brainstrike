import { describe, expect, it } from 'vitest';
import { collectToolArgumentsByCallId } from '../tool-arguments';

describe('collectToolArgumentsByCallId', () => {
  it('keeps the approved input when the resumed copy of the call has empty args', () => {
    const remembered = collectToolArgumentsByCallId([
      {
        content: [
          {
            args: { command: 'printf BST651_OK' },
            argsText: '{"command":"printf BST651_OK"}',
            toolCallId: 'call-approved',
            toolName: 'brainstrike.executeCommand',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            args: {},
            argsText: '{}',
            isError: true,
            result: { error: 'aborted' },
            toolCallId: 'call-approved',
            toolName: 'brainstrike.executeCommand',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
    ]);

    expect(remembered.get('call-approved')).toEqual({
      args: { command: 'printf BST651_OK' },
      argsText: '{"command":"printf BST651_OK"}',
    });
  });

  it('does not invent arguments for a genuinely empty-input tool', () => {
    const remembered = collectToolArgumentsByCallId([
      {
        content: [
          {
            args: {},
            argsText: '{}',
            toolCallId: 'call-empty',
            toolName: 'brainstrike.listWorkspaceContext',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
    ]);

    expect(remembered.has('call-empty')).toBe(false);
  });
});
