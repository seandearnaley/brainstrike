import type { ThreadMessage } from '@assistant-ui/react';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_SUSPEND_DATA_NAME } from '@brainstrike/assistant-contract/tool-suspend';
import { readRediscoveredPauseDisplay } from './rediscovered-pause-display';
import {
  isAssistantToolApprovalRequest,
  isAssistantToolSuspendRequest,
} from './tool-decision-run-outcome';

/**
 * True when the messages still show an approval or suspend pause without a
 * durable decision state. Only such a notice can be left stale by a root
 * Stop: the host cancels the turn's paused work before it answers, but the
 * part stays in the cancelled message, and its durable state reaches the
 * renderer only through rediscovery on history load. This decides whether a
 * re-read is needed; the answer itself always comes from the host ledger.
 */
export function hasUndecidedPauseNotice(messages: readonly ThreadMessage[]): boolean {
  return messages.some((message) =>
    message.content.some((part) => {
      if (part.type !== 'data') {
        return false;
      }
      const isPause =
        (part.name === TOOL_APPROVAL_DATA_NAME && isAssistantToolApprovalRequest(part.data)) ||
        (part.name === TOOL_SUSPEND_DATA_NAME && isAssistantToolSuspendRequest(part.data));
      return isPause && readRediscoveredPauseDisplay(part.data)?.decisionState === undefined;
    })
  );
}
