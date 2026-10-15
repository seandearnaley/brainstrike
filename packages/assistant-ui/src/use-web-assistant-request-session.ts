import { createLogger } from '@brainstrike/logging';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AssistantRequestPreparationTimeoutError,
  AssistantRunAdmissionRejectedError,
} from './data-stream-runtime';

export const webAssistantRequestLogger = createLogger('AssistantRequestSession');
type PreparedRequestStatus = 'cancelled' | 'completed' | 'failed';
interface UseWebAssistantRequestSessionOptions {
  readonly completePreparedRequest?:
    | ((
        data: Record<string, unknown> | undefined,
        status: PreparedRequestStatus,
        error?: string,
        hostOwnsRun?: boolean
      ) => Promise<void> | void)
    | undefined;
  readonly prepareRequestData?:
    | ((
        abortSignal?: AbortSignal,
        turnAnchorMessageId?: string | null,
        runConfig?: unknown
      ) => Promise<Record<string, unknown> | undefined>)
    | undefined;
}
interface PreparedRequest {
  readonly complete: UseWebAssistantRequestSessionOptions['completePreparedRequest'];
  readonly data: Record<string, unknown> | undefined;
}

async function completeAbortedPreparation(
  data: Record<string, unknown> | undefined,
  signal: AbortSignal,
  complete?: UseWebAssistantRequestSessionOptions['completePreparedRequest']
): Promise<never> {
  const reason: unknown = signal.reason;
  const timedOut = reason instanceof AssistantRequestPreparationTimeoutError;
  try {
    await complete?.(
      data,
      timedOut ? 'failed' : 'cancelled',
      timedOut ? reason.message : undefined
    );
  } catch (error: unknown) {
    webAssistantRequestLogger.error('Failed to complete abandoned assistant preparation', {
      error,
      reason,
    });
  }
  throw reason;
}

interface WebAssistantRequestSession {
  readonly isRecovering: boolean;
  readonly onCancel: () => void;
  readonly onError: (error: Error) => void;
  readonly onFinish: () => void;
  readonly prepareRequest: (
    abortSignal?: AbortSignal,
    turnAnchorMessageId?: string | null,
    runConfig?: unknown
  ) => Promise<Record<string, unknown> | undefined>;
  readonly recoveryError: Error | undefined;
  readonly retryRecovery: () => void;
}

/** Own only web request preparation/completion. Desktop runs belong to the agent host. */
export function useWebAssistantRequestSession({
  completePreparedRequest,
  prepareRequestData,
}: UseWebAssistantRequestSessionOptions): WebAssistantRequestSession {
  const preparedRequestRef = useRef<PreparedRequest | null>(null);
  const rejectedAdmissionRef = useRef<{ error: Error; request: PreparedRequest } | null>(null);
  const rejectedAdmissionCompletionRef = useRef<Promise<void> | null>(null);
  const [rejectedAdmissionState, setRejectedAdmissionState] = useState<'pending' | Error | null>(
    null
  );
  const completePreparedRequestRef = useRef(completePreparedRequest);
  useEffect(() => {
    completePreparedRequestRef.current = completePreparedRequest;
  }, [completePreparedRequest]);
  const isRecovering = rejectedAdmissionState === 'pending';
  const recoveryError =
    rejectedAdmissionState instanceof Error ? rejectedAdmissionState : undefined;
  const settleRejectedAdmission = useCallback((): void => {
    const rejected = rejectedAdmissionRef.current;
    if (!rejected || rejectedAdmissionCompletionRef.current) {
      return;
    }
    setRejectedAdmissionState('pending');
    const completion = Promise.resolve().then(() =>
      rejected.request.complete?.(rejected.request.data, 'failed', rejected.error.message, false)
    );
    rejectedAdmissionCompletionRef.current = completion;
    void completion.then(
      () => {
        if (preparedRequestRef.current === rejected.request) {
          preparedRequestRef.current = null;
        }
        if (rejectedAdmissionRef.current === rejected) {
          rejectedAdmissionRef.current = null;
          setRejectedAdmissionState(null);
        }
        rejectedAdmissionCompletionRef.current = null;
      },
      (error: unknown) => {
        rejectedAdmissionCompletionRef.current = null;
        const completionError =
          error instanceof Error ? error : new Error('Failed to settle rejected assistant run.');
        webAssistantRequestLogger.error('Failed to settle rejected assistant admission', {
          error: completionError,
        });
        setRejectedAdmissionState(completionError);
      }
    );
  }, []);

  const completeLatestPreparedRequest = useCallback(
    async (status: PreparedRequestStatus, error?: string): Promise<void> => {
      const request = preparedRequestRef.current;
      if (!request) {
        return;
      }
      preparedRequestRef.current = null;
      await completePreparedRequestRef.current?.(request.data, status, error, false);
    },
    []
  );
  const prepareRequest = useCallback(
    async (
      abortSignal?: AbortSignal,
      turnAnchorMessageId?: string | null,
      runConfig?: unknown
    ): Promise<Record<string, unknown> | undefined> => {
      if (isRecovering || recoveryError) {
        throw recoveryError ?? new Error('Assistant run recovery is still in progress.');
      }
      if (preparedRequestRef.current) {
        throw new Error('Cannot start a hosted assistant run while another run is in progress.');
      }
      const completion = completePreparedRequestRef.current;
      const signal = abortSignal ?? new AbortController().signal;
      signal.throwIfAborted();
      const data = await prepareRequestData?.(signal, turnAnchorMessageId ?? null, runConfig);
      if (signal.aborted) {
        return completeAbortedPreparation(data, signal, completePreparedRequestRef.current);
      }
      preparedRequestRef.current = { complete: completion, data };
      return data;
    },
    [isRecovering, recoveryError, prepareRequestData]
  );
  const onCancel = useCallback((): void => {
    void completeLatestPreparedRequest('cancelled');
  }, [completeLatestPreparedRequest]);
  const onFinish = useCallback((): void => {
    void completeLatestPreparedRequest('completed');
  }, [completeLatestPreparedRequest]);
  const onError = useCallback(
    (error: Error): void => {
      if (error instanceof AssistantRunAdmissionRejectedError) {
        const request = preparedRequestRef.current;
        if (request && !rejectedAdmissionRef.current) {
          rejectedAdmissionRef.current = { error, request };
          settleRejectedAdmission();
        }
        return;
      }
      void completeLatestPreparedRequest('failed', error.message);
    },
    [completeLatestPreparedRequest, settleRejectedAdmission]
  );
  return {
    isRecovering,
    onCancel,
    onError,
    onFinish,
    prepareRequest,
    recoveryError,
    retryRecovery: settleRejectedAdmission,
  };
}
