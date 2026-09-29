/**
 * Re-export seam: the approval/suspend ACTION MESSAGE recognizers moved to
 * `@brainstrike/assistant-contract/approval-action-message` (BST-1243) so the
 * transport exclusion (this package), the chip renderer, AND the history
 * topology adapter (packages/assistant-data) all share ONE strict guard and
 * can never drift. Keep importing from this module inside the UI package;
 * add new consumers against the contract subpath directly.
 */
export {
  ACTION_MESSAGE_RUN_CONFIG_KEYS,
  ACTION_PAUSED_OWNER_MESSAGE_ID_KEY,
  excludeApprovalActionMessages,
  isActionRunConfig,
  isApprovalActionMessage,
  readActionMessageHostRunId,
} from '@brainstrike/assistant-contract/approval-action-message';
