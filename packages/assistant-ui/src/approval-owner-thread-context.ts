import { createContext, use } from 'react';

/**
 * The owning root thread of a delegated child view: the public assistant-ui
 * thread runtime the host registered for that root (`getState` / `subscribe`).
 * The host answers a child's approval on the ROOT leg only, so the child's
 * approvals index folds in this thread's answers
 * (`answered-approvals-index.tsx`, CHILD VIEWS READ THE ROOT'S ANSWERS).
 */
export interface ApprovalOwnerThread {
  getState(): { readonly messages: readonly unknown[] };
  subscribe(listener: () => void): () => void;
}

/** Present only inside a delegated child view; a root thread has no owner. */
export const ApprovalOwnerThreadContext = createContext<ApprovalOwnerThread | null>(null);

const NO_OWNER_MESSAGES: readonly unknown[] = [];
export const ApprovalOwnerMessagesContext = createContext<readonly unknown[]>(NO_OWNER_MESSAGES);

/** Root messages from the provider's single public-runtime subscription. */
export function useApprovalOwnerMessages(): readonly unknown[] {
  return use(ApprovalOwnerMessagesContext);
}
