import { describe, expect, it } from 'vitest';
import { isAssistantActiveRunDiscoveryResponse } from './assistant-stream-session';

const activeRun = {
  assistantMessageId: 'assistant-1',
  eventId: 'session-1:-1',
  inputMessage: { id: 'user-1', parts: [{ text: 'Hi', type: 'text' }], role: 'user' },
  inputParentMessageId: null,
  parentMessageId: 'user-1',
  runId: 'run-1',
  state: 'active',
};

describe('active run discovery response', () => {
  it('accepts exact active, retained and initializing responses', () => {
    expect(isAssistantActiveRunDiscoveryResponse({ activeRun })).toBe(true);
    expect(
      isAssistantActiveRunDiscoveryResponse({ activeRun: { ...activeRun, state: 'closed' } })
    ).toBe(true);
    expect(isAssistantActiveRunDiscoveryResponse({ activeRun: null })).toBe(true);
    expect(isAssistantActiveRunDiscoveryResponse({ activeRun: null, initializing: true })).toBe(
      true
    );
    const { parentMessageId: _parentMessageId, ...actionRun } = activeRun;
    expect(
      isAssistantActiveRunDiscoveryResponse({
        activeRun: { ...actionRun, inputMessage: null, inputParentMessageId: null },
      })
    ).toBe(true);
  });

  it('rejects malformed topology and unknown states', () => {
    expect(
      isAssistantActiveRunDiscoveryResponse({
        activeRun: { ...activeRun, inputMessage: { ...activeRun.inputMessage, id: 'other' } },
      })
    ).toBe(false);
    expect(isAssistantActiveRunDiscoveryResponse({ activeRun: { ...activeRun, state: {} } })).toBe(
      false
    );
    expect(isAssistantActiveRunDiscoveryResponse({ activeRun: null, initializing: false })).toBe(
      false
    );
    expect(
      isAssistantActiveRunDiscoveryResponse({ activeRun: { ...activeRun, inputMessage: {} } })
    ).toBe(false);
    const { parentMessageId: _parentMessageId, ...missingParent } = activeRun;
    expect(isAssistantActiveRunDiscoveryResponse({ activeRun: missingParent })).toBe(false);
  });

  it('accepts a typed immutable action prefix only without a synthetic parent', () => {
    const { parentMessageId: _parentMessageId, ...actionRun } = activeRun;
    const actionReplay = {
      pausedMessageId: 'assistant-paused',
      pausedParentMessageId: 'user-before-pause',
      prefixContent: [
        { text: 'before approval', type: 'text' },
        { args: {}, argsText: '{}', toolCallId: 'call-1', toolName: 'tool', type: 'tool-call' },
      ],
      syntheticPauseMessageId: 'suspended-approval:run-1:call-1',
    };
    const discovered = {
      ...actionRun,
      actionReplay,
      inputMessage: null,
      inputParentMessageId: null,
    };
    expect(isAssistantActiveRunDiscoveryResponse({ activeRun: discovered })).toBe(true);
    expect(
      isAssistantActiveRunDiscoveryResponse({ activeRun: { ...discovered, parentMessageId: null } })
    ).toBe(false);
    expect(
      isAssistantActiveRunDiscoveryResponse({
        activeRun: { ...discovered, actionReplay: { ...actionReplay, prefixContent: [{}] } },
      })
    ).toBe(false);
  });
});
