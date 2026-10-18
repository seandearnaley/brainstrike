import { createContext, use } from 'react';

const NO_STOPPED_APPROVALS: ReadonlySet<string> = new Set();

/**
 * The approval identity keys of this message's inline cards whose pause was
 * stopped before any committed answer (BST-2185, case B), provided by
 * `AssistantActivityParts` from `stoppedApprovalKeys` (`approval-history.ts`),
 * the same derivation that decides the call's chrome. Component-free so the
 * provider's file keeps its Fast Refresh boundary.
 */
export const StoppedApprovalsContext = createContext<ReadonlySet<string>>(NO_STOPPED_APPROVALS);

/** Whether the approval with this identity key was stopped unanswered; false outside a message. */
export function useIsStoppedApproval(identityKey: string): boolean {
  return use(StoppedApprovalsContext).has(identityKey);
}
