import type { AssistantToolApprovalDecision } from '@brainstrike/assistant-contract/tool-approval';
import { createContext, use, useCallback } from 'react';

export interface ApprovalSubmission {
  readonly action: AssistantToolApprovalDecision;
  readonly outcomeKey: string;
}

export interface ApprovalSendFailure {
  readonly message: string;
  readonly outcomeKey: string;
}

export interface ApprovalSubmissionState {
  readonly failures: ReadonlyMap<string, ApprovalSendFailure>;
  readonly setFailure: (identityKey: string, value: ApprovalSendFailure | null) => void;
  readonly setSubmission: (identityKey: string, value: ApprovalSubmission | null) => void;
  readonly submissions: ReadonlyMap<string, ApprovalSubmission>;
}

export const ApprovalSubmissionContext = createContext<ApprovalSubmissionState | null>(null);

export function useApprovalSubmission(identityKey: string) {
  const state = use(ApprovalSubmissionContext);
  if (!state) {
    throw new Error('Approval controls require ApprovalSubmissionProvider.');
  }
  const setSubmission = useCallback(
    (value: ApprovalSubmission | null) => state.setSubmission(identityKey, value),
    [identityKey, state.setSubmission]
  );
  const setFailure = useCallback(
    (value: ApprovalSendFailure | null) => state.setFailure(identityKey, value),
    [identityKey, state.setFailure]
  );
  return {
    sendFailure: state.failures.get(identityKey) ?? null,
    setSendFailure: setFailure,
    setSubmittedDecision: setSubmission,
    submittedDecision: state.submissions.get(identityKey) ?? null,
  };
}
