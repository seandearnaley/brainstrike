import { DELEGATED_CONVERSATION_DATA_NAME } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  readSubagentConversationAddress,
  readSubagentConversationThread,
  readSubagentInvocationRun,
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

it('retains the native completed delegation address after reload and rejects conflicting live identity', () => {
  expect(readSubagentConversationAddress([], 'a', { subAgentThreadId: 'cedar' })).toEqual({
    kind: 'available',
    threadId: 'cedar',
  });
  expect(
    readSubagentConversationAddress([part('a', 'willow')], 'a', { subAgentThreadId: 'cedar' })
  ).toEqual({ error: 'Conflicting child conversation addresses.', kind: 'invalid' });
  expect(readSubagentConversationAddress([], 'a', { subAgentThreadId: '' }).kind).toBe('invalid');
});

it('resolves the exact persisted native invocation across pending child history and rejects contradictory runs', () => {
  const event = (run: string, call: string) => ({
    data: {
      id: `${run}:${call}`,
      kind: 'subagent.started',
      label: 'Started',
      metadata: { parentRuntimeRunId: run, parentToolCallId: call },
      status: 'running',
      timestamp: '2026-09-11T08:00:00Z',
    },
    name: 'brainstrike.run-event',
    type: 'data',
  });
  expect(
    readSubagentInvocationRun([event('native-parent', 'a'), event('sibling', 'b')], 'a')
  ).toEqual({ kind: 'available', parentRuntimeRunId: 'native-parent' });
  expect(readSubagentInvocationRun([event('sibling', 'b')], 'a')).toEqual({ kind: 'unavailable' });
  expect(
    readSubagentInvocationRun([event('native-parent', 'a'), event('wrong-parent', 'a')], 'a')
  ).toEqual({ error: 'Conflicting native invocation addresses.', kind: 'invalid' });
});
