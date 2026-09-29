import { describe, expect, it } from 'vitest';
import {
  ACTION_PAUSED_OWNER_MESSAGE_ID_KEY,
  readActionMessageHostRunId,
  readActionMessagePausedOwnerId,
} from '../approval-action-message.js';
import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '../tool-approval.js';
import { TOOL_SUSPEND_RUN_CONFIG_KEY } from '../tool-suspend.js';

function echo(custom: Record<string, unknown>, role = 'user'): unknown {
  return { id: 'echo-1', metadata: { custom }, role };
}

// The native Mastra run id the runtime actually puts on a root pause: minted
// by Mastra, never a `brainstrike_assistant_thread_runs` id.
const NATIVE_RUN_ID = '2cc9a50d-0a91-45b6-b6b2-9e8b42f47039';

describe('readActionMessageHostRunId', () => {
  it('reads the host leg of a valid approval echo, never its native run id', () => {
    expect(
      readActionMessageHostRunId(
        echo({
          [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
            action: 'approve',
            hostRunId: 'run-host-leg-1',
            runId: NATIVE_RUN_ID,
            toolCallId: 'call-1',
          },
        })
      )
    ).toBe('run-host-leg-1');
  });

  it('reads the host leg of a valid typed-resume echo', () => {
    expect(
      readActionMessageHostRunId(
        echo({
          [TOOL_SUSPEND_RUN_CONFIG_KEY]: {
            hostRunId: 'run-host-leg-2',
            resumeData: { answer: 'us-east-1' },
            runId: NATIVE_RUN_ID,
            toolCallId: 'call-2',
          },
        })
      )
    ).toBe('run-host-leg-2');
  });

  it('is undefined for an action echo whose pause named no host leg', () => {
    expect(
      readActionMessageHostRunId(
        echo({
          [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
            action: 'approve',
            runId: NATIVE_RUN_ID,
            toolCallId: 'call-1',
          },
        })
      )
    ).toBeUndefined();
  });

  it('is undefined for an invalid marker and for a non-user message', () => {
    const marker = {
      action: 'approve',
      hostRunId: '   ',
      runId: NATIVE_RUN_ID,
      toolCallId: 'call-1',
    };
    expect(
      readActionMessageHostRunId(echo({ [TOOL_APPROVAL_RUN_CONFIG_KEY]: marker }))
    ).toBeUndefined();
    expect(
      readActionMessageHostRunId(
        echo(
          { [TOOL_APPROVAL_RUN_CONFIG_KEY]: { ...marker, hostRunId: 'run-host-leg-1' } },
          'assistant'
        )
      )
    ).toBeUndefined();
  });
});

describe('readActionMessagePausedOwnerId', () => {
  const marker = { action: 'approve', runId: NATIVE_RUN_ID, toolCallId: 'call-1' };

  it('reads the bounded owner from an action echo without changing the action marker', () => {
    expect(
      readActionMessagePausedOwnerId(
        echo({
          [ACTION_PAUSED_OWNER_MESSAGE_ID_KEY]: 'resumed-assistant-1',
          [TOOL_APPROVAL_RUN_CONFIG_KEY]: marker,
        })
      )
    ).toBe('resumed-assistant-1');
  });

  it('rejects a malformed owner and ignores ordinary messages', () => {
    expect(() =>
      readActionMessagePausedOwnerId(
        echo({ [ACTION_PAUSED_OWNER_MESSAGE_ID_KEY]: ' ', [TOOL_APPROVAL_RUN_CONFIG_KEY]: marker })
      )
    ).toThrow('invalid paused owner');
    expect(
      readActionMessagePausedOwnerId(echo({ [ACTION_PAUSED_OWNER_MESSAGE_ID_KEY]: 'other' }))
    ).toBeUndefined();
  });
});
