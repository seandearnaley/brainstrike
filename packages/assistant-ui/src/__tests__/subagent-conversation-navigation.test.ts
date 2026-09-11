import { DELEGATED_CONVERSATION_DATA_NAME } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  readSubagentConversationAddress,
  readSubagentConversationThread,
} from '../subagent-conversation-navigation';

const part = (call: string, child: string) => ({
  data: { baseline: { threadId: child }, identity: { parentToolCallId: call } },
  name: DELEGATED_CONVERSATION_DATA_NAME,
  type: 'data',
});

describe('subagent card conversation identity', () => {
  it('uses the host thread address for this exact call, not the persona or another child', () => {
    const parts = [part('a', 'cedar'), part('b', 'willow')];
    expect(readSubagentConversationThread(parts, 'a')).toBe('cedar');
    expect(readSubagentConversationThread(parts, 'b')).toBe('willow');
    expect(readSubagentConversationThread(parts, 'missing')).toBeUndefined();
  });
  it('refuses conflicting addresses instead of choosing a conversation', () => {
    expect(() =>
      readSubagentConversationThread([part('a', 'cedar'), part('a', 'willow')], 'a')
    ).toThrow();
    expect(readSubagentConversationThread([part('a', 'cedar'), part('a', 'cedar')], 'a')).toBe(
      'cedar'
    );
  });
});

it('returns an explicit renderable failure for conflicting addresses', () => {
  expect(readSubagentConversationAddress([part('a', 'cedar'), part('a', 'willow')], 'a')).toEqual({
    error: 'Conflicting child conversation addresses.',
    kind: 'invalid',
  });
  expect(readSubagentConversationAddress([part('a', 'cedar')], 'a')).toEqual({
    kind: 'available',
    threadId: 'cedar',
  });
  expect(readSubagentConversationAddress([], 'a')).toEqual({ kind: 'unavailable' });
});
