import { createContext, use } from 'react';
import {
  type AnsweredApprovalsIndex,
  EMPTY_ANSWERED_APPROVALS_INDEX,
} from './answered-approvals-index-model';

/**
 * The thread's answered-approvals index, provided by `AnsweredApprovalsProvider`
 * (`answered-approvals-index.tsx`). Component-free so the provider file keeps
 * its Fast Refresh boundary (react-refresh `only-export-components`).
 */
export const AnsweredApprovalsContext = createContext<AnsweredApprovalsIndex>(
  EMPTY_ANSWERED_APPROVALS_INDEX
);

/** The thread's answered-approvals index; empty when no provider is mounted. */
export function useAnsweredApprovals(): AnsweredApprovalsIndex {
  return use(AnsweredApprovalsContext);
}
