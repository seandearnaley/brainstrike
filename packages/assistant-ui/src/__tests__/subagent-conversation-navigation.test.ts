// @vitest-environment node
import { expect, it } from 'vitest';
import {
  readSubagentConversationAddress,
  readSubagentInvocationRun,
} from '../subagent-conversation-navigation';

it('reads a completed delegation’s child thread from its result after reload', () => {
  expect(readSubagentConversationAddress({ subAgentThreadId: 'cedar' })).toEqual({
    kind: 'available',
    threadId: 'cedar',
  });
  expect(readSubagentConversationAddress({ subAgentThreadId: '' }).kind).toBe('invalid');
  expect(readSubagentConversationAddress(undefined)).toEqual({ kind: 'unavailable' });
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

it('reads the agent host child thread from its delegation result and rejects a conflicting address', () => {
  const started = { childThreadId: 'cedar', status: 'started', text: 'Background task started.' };
  expect(readSubagentConversationAddress(started)).toEqual({
    kind: 'available',
    threadId: 'cedar',
  });
  expect(readSubagentConversationAddress({ ...started, childThreadId: '' }).kind).toBe('invalid');
  expect(readSubagentConversationAddress({ ...started, subAgentThreadId: 'willow' })).toEqual({
    error: 'Conflicting child conversation addresses.',
    kind: 'invalid',
  });
});

it('resolves an agent host invocation from the run its message answers', () => {
  const host = { custom: { hostRunId: 'host-run' } };
  expect(readSubagentInvocationRun([], 'a', host)).toEqual({
    kind: 'available',
    parentRuntimeRunId: 'host-run',
  });
  expect(readSubagentInvocationRun([], 'a', { custom: {} })).toEqual({ kind: 'unavailable' });
  expect(readSubagentInvocationRun([], 'a', { custom: { hostRunId: '' } }).kind).toBe('invalid');
});
