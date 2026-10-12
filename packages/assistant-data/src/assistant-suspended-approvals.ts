import type { SuspendedRunDiscoveryError } from '@brainstrike/assistant-contract';
import type { RediscoveredToolApproval } from '@brainstrike/assistant-contract/tool-approval';
import type { RediscoveredToolSuspend } from '@brainstrike/assistant-contract/tool-suspend';

export interface SuspendedRunDiscoveryResult {
  readonly approvals: readonly RediscoveredToolApproval[];
  readonly error?: SuspendedRunDiscoveryError;
  /** Non-approval suspend() pauses (BST-1084) — plan/question cards. */
  readonly suspends: readonly RediscoveredToolSuspend[];
}

/**
 * Rediscover pending tool approvals AND suspend() pauses for a thread. A
 * transport or validation failure is explicit so hydration can retain the
 * conversation and show that pending decisions could not be completely
 * recovered. No shell supplies one since the desktop assistant server's
 * `/assistant/suspended-runs` route was retired.
 */
export type SuspendedRunDiscovery = (
  threadId: string,
  resourceId: string
) => Promise<SuspendedRunDiscoveryResult>;
