import { type ReactNode, use, useCallback, useMemo, useState } from 'react';
import { ActiveThreadKeyContext } from './active-thread-key-context';
import {
  type ApprovalSendFailure,
  type ApprovalSubmission,
  ApprovalSubmissionContext,
} from './approval-submission-context';

/** One transient submission state for every view of a decision in this thread. */
export function ApprovalSubmissionProvider({ children }: { children: ReactNode }) {
  const threadKey = use(ActiveThreadKeyContext);
  const [state, setState] = useState(() => ({
    failures: new Map<string, ApprovalSendFailure>(),
    submissions: new Map<string, ApprovalSubmission>(),
    threadKey,
  }));
  if (state.threadKey !== threadKey) {
    setState({ failures: new Map(), submissions: new Map(), threadKey });
  }
  const setSubmission = useCallback(
    (identityKey: string, value: ApprovalSubmission | null) => {
      setState((current) => {
        if (current.threadKey !== threadKey) {
          return current;
        }
        const submissions = new Map(current.submissions);
        if (value) {
          submissions.set(identityKey, value);
        } else {
          submissions.delete(identityKey);
        }
        return { ...current, submissions };
      });
    },
    [threadKey]
  );
  const setFailure = useCallback(
    (identityKey: string, value: ApprovalSendFailure | null) => {
      setState((current) => {
        if (current.threadKey !== threadKey) {
          return current;
        }
        const failures = new Map(current.failures);
        if (value) {
          failures.set(identityKey, value);
        } else {
          failures.delete(identityKey);
        }
        return { ...current, failures };
      });
    },
    [threadKey]
  );
  const value = useMemo(
    () => ({ failures: state.failures, setFailure, setSubmission, submissions: state.submissions }),
    [state.submissions, state.failures, setSubmission, setFailure]
  );
  return <ApprovalSubmissionContext value={value}>{children}</ApprovalSubmissionContext>;
}
