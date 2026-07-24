import {
  ASSISTANT_STREAM_EVENT_ID_HEADER,
  ASSISTANT_STREAM_RESUME_PATH,
  type AssistantActiveRunSession,
} from '@brainstrike/assistant-contract';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { assistantEndpointLogger, resolveDesktopAssistantBaseUrl } from './assistant-endpoint';
import { readPreparedRunId, requestAssistantRunCancel } from './assistant-run-cancel';
import {
  clearAssistantActiveRunSession,
  readAssistantActiveRunSession,
  writeAssistantActiveRunSession,
} from './assistant-run-reattachment';
import { AssistantStreamReplayUnavailableError } from './data-stream-runtime';

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
  readonly prepareLocalModel?: (() => Promise<void>) | undefined;
  readonly prepareRequestData?: (() => Promise<Record<string, unknown> | undefined>) | undefined;
  readonly threadKey?: string | undefined;
}

interface AssistantServerRunSessionController {
  readonly activeRunSession: AssistantActiveRunSession | undefined;
  readonly onCancel: () => void;
  readonly onError: (error: Error) => void;
  readonly onFinish: () => void;
  readonly onResponse: (response: Response) => void;
  readonly prepareRequest: () => Promise<Record<string, unknown> | undefined>;
  readonly resumeApi: string | undefined;
}

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

  const prepareRequest = useCallback(async (): Promise<Record<string, unknown> | undefined> => {
    if (preparedRequestRef.current) {
      throw new Error('Cannot start a hosted assistant run while another run is in progress.');
    }
    if (activeRunSessionRef.current) {
      throw new Error(
        'Cannot start a hosted assistant run while an existing run is awaiting stream reattachment.'
      );
    }
    await prepareLocalModel?.();
    const data = await prepareRequestData?.();
    preparedRequestRef.current = { data };
    return data;
  }, [prepareLocalModel, prepareRequestData]);

  const onCancel = useCallback((): void => {
    const runId =
      readPreparedRunId(preparedRequestRef.current?.data) ?? activeRunSessionRef.current?.runId;
    if (!(desktopAssistantBaseUrl && runId)) {
      void completeLatestPreparedRequest('cancelled');
      return;
    }
    void requestAssistantRunCancel({
      authHeaders,
      baseUrl: desktopAssistantBaseUrl,
      runId,
    })
      .then(() => {
        clearActiveRunSession();
        return completeLatestPreparedRequest('cancelled');
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assistantEndpointLogger.error('Failed to cancel server-owned assistant run', { error });
        return completeLatestPreparedRequest('failed', message);
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

  const onResponse = useCallback(
    (response: Response): void => {
      if (!(threadKey && resumeApi)) {
        return;
      }
      const eventId = response.headers.get(ASSISTANT_STREAM_EVENT_ID_HEADER)?.trim();
      const runId = readPreparedRunId(preparedRequestRef.current?.data);
      if (!(eventId && runId)) {
        throw new Error(
          'Desktop assistant response is missing the active-run replay cursor or run id.'
        );
      }
      const record = { eventId, runId };
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
    onResponse,
    prepareRequest,
    resumeApi,
  };
}
