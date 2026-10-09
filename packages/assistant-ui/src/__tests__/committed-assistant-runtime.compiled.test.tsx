// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCommittedAssistantRuntime } from '../use-committed-assistant-runtime';
import { PublishedConversation, viewMessage } from './committed-assistant-test-support';

afterEach(cleanup);

describe('committed runtime under the React Compiler', () => {
  it('restores the canonical head after a branch command is refused synchronously', () => {
    const user = viewMessage('user', 'Question', 'user');
    const answer = viewMessage('answer', 'Answer');
    const sibling = viewMessage('sibling', 'Sibling');
    const source = new PublishedConversation('root', [user, answer]);
    const repository = {
      headId: answer.id,
      messages: [
        { message: user, parentId: null },
        { message: answer, parentId: user.id },
        { message: sibling, parentId: user.id },
      ],
    };
    source.publish({ repository });
    const onCommandError = vi.fn();
    const { result } = renderHook(() =>
      useCommittedAssistantRuntime({
        commands: {
          onNew: vi.fn(),
          setMessages: () => {
            throw new Error('Branch command rejected');
          },
        },
        onCommandError,
        store: source,
      })
    );
    act(() => {
      expect(() =>
        result.current.thread.getMessageById(answer.id).switchToBranch({ branchId: sibling.id })
      ).toThrow('Branch command rejected');
    });
    expect(onCommandError).toHaveBeenCalledOnce();
    expect(result.current.thread.export()).toEqual(repository);
    expect(result.current.thread.getState().messages).toEqual([user, answer]);
  });
});
