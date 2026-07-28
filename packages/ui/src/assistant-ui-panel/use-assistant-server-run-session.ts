import {
  ASSISTANT_STREAM_EVENT_ID_HEADER,
  ASSISTANT_STREAM_MESSAGE_ID_HEADER,
  ASSISTANT_STREAM_RESUME_PATH,
  type AssistantActiveRunSession,
} from '@brainstrike/assistant-contract';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assistantEndpointLogger, resolveDesktopAssistantBaseUrl } from './assistant-endpoint';
import { readPreparedRunId, requestAssistantRunCancel } from './assistant-run-cancel';
import {
  clearAssistantActiveRunSession,
  readAssistantActiveRunSession,
  writeAssistantActiveRunSession,
} from './assistant-run-reattachment';
import {
  AssistantRequestPreparationTimeoutError,
  AssistantStreamReplayUnavailableError,
} from './data-stream-runtime';

type PreparedRequestStatus = 'cancelled' | 'completed' | 'failed';

interface UseAssistantServerRunSessionOptions {
  readonly api: string;
  readonly authHeaders?: (() => Promise<Record<string, string>>) | undefined;
  readonly completePreparedRequest?:
    | ((
        requestData: Record<string, unknown> | undefined,
        status: PreparedRequestStatus,
        error?: string
      ) => Promise<void> | void)
    | undefined;
  readonly prepareLocalModel?: ((abortSignal?: AbortSignal) => Promise<void>) | undefined;
  readonly prepareRequestData?:
    | ((abortSignal?: AbortSignal) => Promise<Record<string, unknown> | undefined>)
    | undefined;
  readonly threadKey?: string | undefined;
}

interface AssistantServerRunSessionController {
  readonly activeRunSession: AssistantActiveRunSession | undefined;
  readonly onCancel: () => void;
  readonly onError: (error: Error) => void;
  readonly onFinish: () => void;
  readonly onReplayError: (error: Error) => void;
  readonly onResponse: (response: Response) => void;
  readonly prepareRequest: (
    abortSignal?: AbortSignal
  ) => Promise<Record<string, unknown> | undefined>;
  readonly prepareRequestWarmup?: ((abortSignal: AbortSignal) => Promise<void>) | undefined;
  readonly replayRetryToken: number;
  readonly resumeApi: string | undefined;
}

const MAX_ASSISTANT_REPLAY_RETRIES = 2;

export function useAssistantServerRunSession({
  api,
  authHeaders,
  completePreparedRequest,
  prepareLocalModel,
  prepareRequestData,
  threadKey,
}: UseAssistantServerRunSessionOptions): AssistantServerRunSessionController {
  const desktopAssistantBaseUrl = resolveDesktopAssistantBaseUrl(api);
  const resumeApi = desktopAssistantBaseUrl
    ? `${desktopAssistantBaseUrl}${ASSISTANT_STREAM_RESUME_PATH}`
    : undefined;
  const activeRunSession = useMemo<AssistantActiveRunSession | undefined>(
    () => (threadKey && resumeApi ? readAssistantActiveRunSession(threadKey) : undefined),
    [resumeApi, threadKey]
  );
  const activeRunSessionRef = useRef<AssistantActiveRunSession | undefined>(activeRunSession);
  const preparedRequestRef = useRef<{ readonly data: Record<string, unknown> | undefined } | null>(
    null
  );
  const completePreparedRequestRef = useRef(completePreparedRequest);
  const replayRetryCountRef = useRef(0);
  const [replayRetryToken, setReplayRetryToken] = useState(0);

  useEffect(() => {
    activeRunSessionRef.current = activeRunSession;
  }, [activeRunSession]);

  useEffect(() => {
    completePreparedRequestRef.current = completePreparedRequest;
  }, [completePreparedRequest]);

  const clearActiveRunSession = useCallback((): void => {
    if (threadKey && resumeApi) {
      clearAssistantActiveRunSession(threadKey);
    }
    activeRunSessionRef.current = undefined;
  }, [resumeApi, threadKey]);

  const completeLatestPreparedRequest = useCallback(
    async (status: PreparedRequestStatus, error?: string): Promise<void> => {
      const preparedRequest = preparedRequestRef.current;
      if (!preparedRequest) {
        return;
      }
      preparedRequestRef.current = null;
      await completePreparedRequestRef.current?.(preparedRequest.data, status, error);
    },
    []
  );

  const prepareRequest = useCallback(
    async (abortSignal?: AbortSignal): Promise<Record<string, unknown> | undefined> => {
      if (preparedRequestRef.current) {
        throw new Error('Cannot start a hosted assistant run while another run is in progress.');
      }
      if (activeRunSessionRef.current) {
        throw new Error(
          'Cannot start a hosted assistant run while an existing run is awaiting stream reattachment.'
        );
      }
      const preparationSignal = abortSignal ?? new AbortController().signal;
      preparationSignal.throwIfAborted();
      const data = await prepareRequestData?.(preparationSignal);
      if (preparationSignal.aborted) {
        const reason = preparationSignal.reason;
        const timedOut = reason instanceof AssistantRequestPreparationTimeoutError;
        try {
          await completePreparedRequestRef.current?.(
            data,
            timedOut ? 'failed' : 'cancelled',
            timedOut ? reason.message : undefined
          );
        } catch (error: unknown) {
          assistantEndpointLogger.error('Failed to complete abandoned assistant preparation', {
            error,
            reason,
          });
        }
        throw reason;
      }
      preparedRequestRef.current = { data };
      return data;
    },
    [prepareRequestData]
  );

  const onCancel = useCallback((): void => {
    const runId =
      readPreparedRunId(preparedRequestRef.current?.data) ?? activeRunSessionRef.current?.runId;
    if (!(desktopAssistantBaseUrl && runId)) {
      void completeLatestPreparedRequest('cancelled');
      return;
    }
    void completeLatestPreparedRequest('cancelled');
    void requestAssistantRunCancel({
      authHeaders,
      baseUrl: desktopAssistantBaseUrl,
      runId,
    })
      .then(() => {
        clearActiveRunSession();
      })
      .catch((error: unknown) => {
        assistantEndpointLogger.error('Failed to cancel server-owned assistant run', { error });
      });
  }, [authHeaders, clearActiveRunSession, completeLatestPreparedRequest, desktopAssistantBaseUrl]);

  const onError = useCallback(
    (error: Error): void => {
      if (error instanceof AssistantStreamReplayUnavailableError) {
        clearActiveRunSession();
      }
      void completeLatestPreparedRequest('failed', error.message);
    },
    [clearActiveRunSession, completeLatestPreparedRequest]
  );

  const onFinish = useCallback((): void => {
    clearActiveRunSession();
    void completeLatestPreparedRequest('completed');
  }, [clearActiveRunSession, completeLatestPreparedRequest]);

  const onReplayError = useCallback((error: Error): void => {
    if (error instanceof AssistantStreamReplayUnavailableError) {
      return;
    }
    if (replayRetryCountRef.current >= MAX_ASSISTANT_REPLAY_RETRIES) {
      assistantEndpointLogger.error('Assistant stream replay exhausted its retry budget', {
        error,
        retryCount: replayRetryCountRef.current,
      });
      return;
    }
    replayRetryCountRef.current += 1;
    setReplayRetryToken((current) => current + 1);
  }, []);

  const onResponse = useCallback(
    (response: Response): void => {
      if (!(threadKey && resumeApi)) {
        return;
      }
      const eventId = response.headers.get(ASSISTANT_STREAM_EVENT_ID_HEADER)?.trim();
      const assistantMessageId = response.headers.get(ASSISTANT_STREAM_MESSAGE_ID_HEADER)?.trim();
      const runId = readPreparedRunId(preparedRequestRef.current?.data);
      if (!(assistantMessageId && eventId && runId)) {
        throw new Error(
          'Desktop assistant response is missing the active-run replay cursor or run id.'
        );
      }
      const record = { assistantMessageId, eventId, runId };
      writeAssistantActiveRunSession(threadKey, record);
      activeRunSessionRef.current = record;
    },
    [resumeApi, threadKey]
  );

  return {
    activeRunSession,
    onCancel,
    onError,
    onFinish,
    onReplayError,
    onResponse,
    ...(prepareLocalModel ? { prepareRequestWarmup: prepareLocalModel } : {}),
    prepareRequest,
    replayRetryToken,
    resumeApi,
  };
}
