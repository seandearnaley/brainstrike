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
  const { setFailure: setKeyedFailure, setSubmission: setKeyedSubmission } = state;
  const setSubmission = (value: ApprovalSubmission | null) =>
    setKeyedSubmission(identityKey, value);
  const setFailure = useCallback(
    (value: ApprovalSendFailure | null) => setKeyedFailure(identityKey, value),
    [identityKey, setKeyedFailure]
  );
  return {
    sendFailure: state.failures.get(identityKey) ?? null,
    setSendFailure: setFailure,
    setSubmittedDecision: setSubmission,
    submittedDecision: state.submissions.get(identityKey) ?? null,
  };
}
