import {
  ASSISTANT_ACTIVE_RUN_PATH,
  ASSISTANT_RUN_STATUS_PATH,
  ASSISTANT_STREAM_EVENT_ID_HEADER,
  ASSISTANT_STREAM_MESSAGE_ID_HEADER,
  ASSISTANT_STREAM_RESUME_PATH,
  type AssistantActiveRunSession,
  type AssistantDiscoveredRun,
  isAssistantActiveRunDiscoveryResponse,
  isAssistantRunStatusResponse,
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
  type CancelledAssistantRun,
} from './data-stream-runtime';
import { hasUndecidedPauseNotice } from './undecided-pause-notices';

type PreparedRequestStatus = 'cancelled' | 'completed' | 'failed';

interface UseAssistantServerRunSessionOptions {
  readonly api: string;
  readonly authHeaders?: (() => Promise<Record<string, string>>) | undefined;
  readonly completePreparedRequest?:
    | ((
        requestData: Record<string, unknown> | undefined,
        status: PreparedRequestStatus,
        error?: string,
        hostOwnsRun?: boolean
      ) => Promise<void> | void)
    | undefined;
  /**
   * Called after a SUCCESSFUL server cancel whose run still showed a pause
   * notice without a durable decision. The host cancelled that paused work;
   * its decision state reaches the renderer only through rediscovery, so the
   * caller must re-read history.
   */
  readonly onPausesCancelled?: (() => void) | undefined;
  readonly prepareLocalModel?: ((abortSignal?: AbortSignal) => Promise<void>) | undefined;
  readonly prepareRequestData?:
    | ((
        abortSignal?: AbortSignal,
        turnAnchorMessageId?: string | null,
        runConfig?: unknown
      ) => Promise<Record<string, unknown> | undefined>)
    | undefined;
  readonly resourceId?: string | undefined;
  readonly threadKey?: string | undefined;
}

interface AssistantServerRunSessionController {
  readonly activeRunSession: AssistantActiveRunSession | undefined;
  readonly discoveredRun: AssistantDiscoveredRun | undefined;
  readonly isRecovering: boolean;
  readonly onCancel: (cancelled: CancelledAssistantRun) => void;
  readonly onError: (error: Error) => void;
  readonly onFinish: () => void;
  readonly onReplayError: (error: Error, eventId?: string) => void;
  readonly onResponse: (response: Response, parentMessageId?: string | null) => void;
  readonly prepareRequest: (
    abortSignal?: AbortSignal,
    turnAnchorMessageId?: string | null,
    runConfig?: unknown
  ) => Promise<Record<string, unknown> | undefined>;
  readonly prepareRequestWarmup?: ((abortSignal: AbortSignal) => Promise<void>) | undefined;
  readonly recoveryError: Error | undefined;
  readonly replayEligible: boolean;
  readonly replayRetryToken: number;
  readonly resumeApi: string | undefined;
  readonly retryRecovery: () => void;
}

const MAX_ASSISTANT_REPLAY_RETRIES = 2;

/**
 * Reconcile a stored reattachment record against the durable run row — the
 * same authority the Threads-panel projection uses (BST-1244). The record is
 * an ephemeral HINT; a terminal (or missing) durable run proves it stale.
 * Probe failures return `false` so the guard stays in place — reclaiming on
 * an unreachable server would be a silent fallback.
 */
/**
 * 2026-08-18 field failure: a dev-mode renderer reload mid-stream left a
 * record behind whose durable run finished seconds later; the unconditional
 * guard then blocked every new run until app restart. The record is a hint —
 * the durable run row is the authority. Throws the guard error when the
 * record must be kept; clears it (visibly) when it is provably stale.
 */
async function reconcileStoredRunSessionGuard(args: {
  readonly authHeaders?: (() => Promise<Record<string, string>>) | undefined;
  readonly baseUrl: string | undefined;
  readonly clear: () => void;
  readonly runId: string;
}): Promise<void> {
  const stale =
    args.baseUrl === undefined
      ? false
      : await isStoredRunSessionStale({
          authHeaders: args.authHeaders,
          baseUrl: args.baseUrl,
          runId: args.runId,
        });
  if (!stale) {
    throw new Error(
      'Cannot start a hosted assistant run while an existing run is awaiting stream reattachment.'
    );
  }
  assistantEndpointLogger.warn(
    'Reclaimed a stale assistant run reattachment record; the durable run is no longer running',
    { runId: args.runId }
  );
  args.clear();
}

async function isStoredRunSessionStale(args: {
  readonly authHeaders?: (() => Promise<Record<string, string>>) | undefined;
  readonly baseUrl: string;
  readonly runId: string;
}): Promise<boolean> {
  try {
    const headers = new Headers((await args.authHeaders?.()) ?? {});
    const response = await fetch(
      `${args.baseUrl}${ASSISTANT_RUN_STATUS_PATH}?runId=${encodeURIComponent(args.runId)}`,
      { headers, method: 'GET' }
    );
    if (!response.ok) {
      assistantEndpointLogger.warn('Assistant run-status probe returned a non-OK response', {
        runId: args.runId,
        status: response.status,
      });
      return false;
    }
    const payload: unknown = await response.json();
    if (!isAssistantRunStatusResponse(payload) || payload.runId !== args.runId) {
      assistantEndpointLogger.warn('Assistant run-status probe returned a malformed payload', {
        runId: args.runId,
      });
      return false;
    }
    return payload.status !== 'running' && payload.status !== 'cancelling';
  } catch (error: unknown) {
    assistantEndpointLogger.warn('Assistant run-status probe failed; keeping reattachment guard', {
      error,
      runId: args.runId,
    });
    return false;
  }
}

interface DiscoveryReconciliation {
  readonly authHeaders?: (() => Promise<Record<string, string>>) | undefined;
  readonly baseUrl: string;
  readonly clearSession: () => void;
  readonly currentSession: () => AssistantActiveRunSession | undefined;
  readonly replaceSession: (record: AssistantActiveRunSession) => void;
  readonly signal: AbortSignal;
}

async function waitForDiscoveryPoll(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, 250);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchDiscoveredRun(args: {
  readonly authHeaders?: (() => Promise<Record<string, string>>) | undefined;
  readonly baseUrl: string;
  readonly resourceId: string;
  readonly signal: AbortSignal;
  readonly threadKey: string;
}): Promise<AssistantDiscoveredRun | null> {
  const headers = new Headers((await args.authHeaders?.()) ?? {});
  const url = new URL(`${args.baseUrl}${ASSISTANT_ACTIVE_RUN_PATH}`);
  url.searchParams.set('resourceId', args.resourceId);
  url.searchParams.set('threadId', args.threadKey);
  while (true) {
    args.signal.throwIfAborted();
    const response = await fetch(url, { headers, method: 'GET', signal: args.signal });
    if (!response.ok) {
      throw new Error(`Assistant run discovery failed with status ${response.status}.`);
    }
    const candidate: unknown = await response.json();
    if (!isAssistantActiveRunDiscoveryResponse(candidate)) {
      throw new Error('Assistant run discovery returned a malformed response.');
    }
    if (!('initializing' in candidate && candidate.initializing)) {
      return candidate.activeRun;
    }
    await waitForDiscoveryPoll(args.signal);
  }
}

async function reconcileClosedDiscoveredRun(
  run: AssistantDiscoveredRun | null,
  context: DiscoveryReconciliation
): Promise<AssistantDiscoveredRun | null> {
  if (run?.state !== 'closed') {
    return run;
  }
  const settled = await isStoredRunSessionStale({
    authHeaders: context.authHeaders,
    baseUrl: context.baseUrl,
    runId: run.runId,
  });
  context.signal.throwIfAborted();
  if (!settled) {
    return run;
  }
  if (context.currentSession()?.runId === run.runId) {
    context.clearSession();
  }
  return null;
}

async function adoptDiscoveredRun(
  run: AssistantDiscoveredRun,
  context: DiscoveryReconciliation
): Promise<boolean> {
  const stored = context.currentSession();
  if (stored && stored.runId !== run.runId) {
    const stale = await isStoredRunSessionStale({
      authHeaders: context.authHeaders,
      baseUrl: context.baseUrl,
      runId: stored.runId,
    });
    context.signal.throwIfAborted();
    if (context.currentSession() !== stored) {
      return false;
    }
    if (!stale) {
      throw new Error('Assistant run discovery disagrees with the stored active run.');
    }
    assistantEndpointLogger.warn('Replacing a terminal stored run with the host active run', {
      oldRunId: stored.runId,
      runId: run.runId,
    });
  }
  context.replaceSession({
    assistantMessageId: run.assistantMessageId,
    eventId: run.eventId,
    ...(run.parentMessageId === undefined ? {} : { parentMessageId: run.parentMessageId }),
    runId: run.runId,
  });
  return true;
}

async function releaseMissingDiscoveredRun(
  storedAtDiscoveryStart: AssistantActiveRunSession | undefined,
  context: DiscoveryReconciliation
): Promise<boolean> {
  if (!storedAtDiscoveryStart || context.currentSession() !== storedAtDiscoveryStart) {
    return true;
  }
  const stale = await isStoredRunSessionStale({
    authHeaders: context.authHeaders,
    baseUrl: context.baseUrl,
    runId: storedAtDiscoveryStart.runId,
  });
  context.signal.throwIfAborted();
  if (context.currentSession() !== storedAtDiscoveryStart) {
    return false;
  }
  if (!stale) {
    throw new Error('Assistant host has a running run but no replayable stream.');
  }
  context.clearSession();
  return true;
}

async function completeAbortedPreparation(
  data: Record<string, unknown> | undefined,
  signal: AbortSignal,
  complete?: UseAssistantServerRunSessionOptions['completePreparedRequest']
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
    assistantEndpointLogger.error('Failed to complete abandoned assistant preparation', {
      error,
      reason,
    });
  }
  throw reason;
}

export function useAssistantServerRunSession({
  api,
  authHeaders,
  completePreparedRequest,
  onPausesCancelled,
  prepareLocalModel,
  prepareRequestData,
  resourceId,
  threadKey,
}: UseAssistantServerRunSessionOptions): AssistantServerRunSessionController {
  const desktopAssistantBaseUrl = resolveDesktopAssistantBaseUrl(api);
  const resumeApi = desktopAssistantBaseUrl
    ? `${desktopAssistantBaseUrl}${ASSISTANT_STREAM_RESUME_PATH}`
    : undefined;
  const initialActiveRunSession = useMemo<AssistantActiveRunSession | undefined>(
    () => (threadKey && resumeApi ? readAssistantActiveRunSession(threadKey) : undefined),
    [resumeApi, threadKey]
  );
  const [activeSessionState, setActiveSessionState] = useState(() => ({
    record: initialActiveRunSession,
    replayEligible: initialActiveRunSession !== undefined,
    resumeApi,
    threadKey,
  }));
  const activeRunSession =
    activeSessionState.threadKey === threadKey && activeSessionState.resumeApi === resumeApi
      ? activeSessionState.record
      : initialActiveRunSession;
  const replayEligible =
    activeSessionState.threadKey === threadKey && activeSessionState.resumeApi === resumeApi
      ? activeSessionState.replayEligible
      : initialActiveRunSession !== undefined;
  const activeRunSessionRef = useRef<AssistantActiveRunSession | undefined>(activeRunSession);
  const preparedRequestRef = useRef<{
    readonly data: Record<string, unknown> | undefined;
    cancelRequested?: boolean;
    hostOwnsRun?: boolean;
  } | null>(null);
  const completePreparedRequestRef = useRef(completePreparedRequest);
  const replayRetryCountRef = useRef(0);
  const [replayRetryToken, setReplayRetryToken] = useState(0);
  const [recoveryRetryToken, setRecoveryRetryToken] = useState(0);
  const discoveryKey =
    desktopAssistantBaseUrl && resourceId && threadKey
      ? `${desktopAssistantBaseUrl}:${resourceId}:${threadKey}`
      : undefined;
  const [discovery, setDiscovery] = useState<{
    key: string | undefined;
    status: 'pending' | 'ready' | 'error';
    run?: AssistantDiscoveredRun | undefined;
    error?: Error | undefined;
  }>(() => ({ key: discoveryKey, status: discoveryKey ? 'pending' : 'ready' }));
  const isRecovering =
    Boolean(discoveryKey) && (discovery.key !== discoveryKey || discovery.status === 'pending');
  const recoveryError = discovery.key === discoveryKey ? discovery.error : undefined;
  const discoveredRun =
    discovery.key === discoveryKey && discovery.run?.runId === activeRunSession?.runId
      ? discovery.run
      : undefined;

  useEffect(() => {
    if (!(discoveryKey && desktopAssistantBaseUrl && resourceId && threadKey)) {
      setDiscovery({ key: undefined, status: 'ready' });
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    const storedAtDiscoveryStart = activeRunSessionRef.current;
    setDiscovery({ key: discoveryKey, status: 'pending' });
    const reconciliation: DiscoveryReconciliation = {
      authHeaders,
      baseUrl: desktopAssistantBaseUrl,
      clearSession: () => {
        clearAssistantActiveRunSession(threadKey);
        activeRunSessionRef.current = undefined;
        setActiveSessionState({ record: undefined, replayEligible: false, resumeApi, threadKey });
      },
      currentSession: () => activeRunSessionRef.current,
      replaceSession: (record) => {
        writeAssistantActiveRunSession(threadKey, record);
        activeRunSessionRef.current = record;
        setActiveSessionState({ record, replayEligible: true, resumeApi, threadKey });
      },
      signal: controller.signal,
    };
    const discoveryTask = (async () => {
      let run = await fetchDiscoveredRun({
        authHeaders,
        baseUrl: desktopAssistantBaseUrl,
        resourceId,
        signal: controller.signal,
        threadKey,
      });
      controller.signal.throwIfAborted();
      run = await reconcileClosedDiscoveredRun(run, reconciliation);
      const reconciled = run
        ? await adoptDiscoveredRun(run, reconciliation)
        : await releaseMissingDiscoveredRun(storedAtDiscoveryStart, reconciliation);
      if (!reconciled) {
        return;
      }
      controller.signal.throwIfAborted();
      setDiscovery({ key: discoveryKey, status: 'ready', ...(run ? { run } : {}) });
    })();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Assistant run discovery timed out.'));
      }, 30_000);
    });
    void Promise.race([discoveryTask, timeoutTask])
      .catch((error: unknown) => {
        if (!cancelled) {
          const recoveryError = error instanceof Error ? error : new Error(String(error));
          assistantEndpointLogger.error('Assistant run discovery failed', { error: recoveryError });
          setDiscovery({ error: recoveryError, key: discoveryKey, status: 'error' });
        }
      })
      .finally(() => {
        if (timeout) {
          clearTimeout(timeout);
        }
      });
    return () => {
      cancelled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      controller.abort();
    };
  }, [
    authHeaders,
    desktopAssistantBaseUrl,
    discoveryKey,
    recoveryRetryToken,
    resourceId,
    resumeApi,
    threadKey,
  ]);

  const retryRecovery = useCallback((): void => {
    setRecoveryRetryToken((current) => current + 1);
  }, []);

  useEffect(() => {
    activeRunSessionRef.current = initialActiveRunSession;
    setActiveSessionState({
      record: initialActiveRunSession,
      replayEligible: initialActiveRunSession !== undefined,
      resumeApi,
      threadKey,
    });
  }, [initialActiveRunSession, resumeApi, threadKey]);

  useEffect(() => {
    completePreparedRequestRef.current = completePreparedRequest;
  }, [completePreparedRequest]);

  const clearActiveRunSession = useCallback((): void => {
    if (threadKey && resumeApi) {
      clearAssistantActiveRunSession(threadKey);
    }
    activeRunSessionRef.current = undefined;
    setActiveSessionState({ record: undefined, replayEligible: false, resumeApi, threadKey });
  }, [resumeApi, threadKey]);

  const completeLatestPreparedRequest = useCallback(
    async (status: PreparedRequestStatus, error?: string): Promise<void> => {
      const preparedRequest = preparedRequestRef.current;
      if (!preparedRequest || preparedRequest.cancelRequested) {
        return;
      }
      preparedRequestRef.current = null;
      await completePreparedRequestRef.current?.(
        preparedRequest.data,
        status,
        error,
        preparedRequest.hostOwnsRun === true
      );
    },
    []
  );

  const reconcilePendingCancellation = useCallback(async (): Promise<void> => {
    const pendingCancellation = preparedRequestRef.current;
    const cancelledRunId = readPreparedRunId(pendingCancellation?.data);
    if (pendingCancellation?.cancelRequested && cancelledRunId) {
      const cancellingSession = activeRunSessionRef.current;
      await reconcileStoredRunSessionGuard({
        authHeaders,
        baseUrl: desktopAssistantBaseUrl,
        clear: () => {
          if (activeRunSessionRef.current !== cancellingSession) {
            throw new Error('Cannot prepare another run after the active assistant run changed.');
          }
          clearActiveRunSession();
        },
        runId: cancelledRunId,
      });
      if (preparedRequestRef.current === pendingCancellation) {
        preparedRequestRef.current = null;
      }
    }
  }, [authHeaders, clearActiveRunSession, desktopAssistantBaseUrl]);

  const prepareRequest = useCallback(
    async (
      abortSignal?: AbortSignal,
      turnAnchorMessageId?: string | null,
      runConfig?: unknown
    ): Promise<Record<string, unknown> | undefined> => {
      await reconcilePendingCancellation();
      if (isRecovering || recoveryError) {
        throw recoveryError ?? new Error('Assistant run recovery is still in progress.');
      }
      if (preparedRequestRef.current) {
        throw new Error('Cannot start a hosted assistant run while another run is in progress.');
      }
      const storedRunSession = activeRunSessionRef.current;
      if (storedRunSession) {
        await reconcileStoredRunSessionGuard({
          authHeaders,
          baseUrl: desktopAssistantBaseUrl,
          clear: () => {
            if (activeRunSessionRef.current !== storedRunSession) {
              throw new Error('Cannot prepare another run after the active assistant run changed.');
            }
            clearActiveRunSession();
          },
          runId: storedRunSession.runId,
        });
      }
      if (preparedRequestRef.current) {
        throw new Error('Cannot start a hosted assistant run while another run is in progress.');
      }
      const preparationSignal = abortSignal ?? new AbortController().signal;
      preparationSignal.throwIfAborted();
      const data = await prepareRequestData?.(
        preparationSignal,
        turnAnchorMessageId ?? null,
        runConfig
      );
      if (preparationSignal.aborted) {
        return completeAbortedPreparation(
          data,
          preparationSignal,
          completePreparedRequestRef.current
        );
      }
      preparedRequestRef.current = { data };
      return data;
    },
    [
      authHeaders,
      clearActiveRunSession,
      desktopAssistantBaseUrl,
      isRecovering,
      prepareRequestData,
      reconcilePendingCancellation,
      recoveryError,
    ]
  );

  const onCancel = useCallback(
    (cancelled: CancelledAssistantRun): void => {
      const runId =
        readPreparedRunId(preparedRequestRef.current?.data) ?? activeRunSessionRef.current?.runId;
      if (!(desktopAssistantBaseUrl && runId)) {
        void completeLatestPreparedRequest('cancelled');
        return;
      }
      const cancellingRequest = preparedRequestRef.current;
      const cancellingSession = activeRunSessionRef.current;
      if (cancellingRequest) {
        cancellingRequest.cancelRequested = true;
      }
      // Read at abort time: the thread the user stopped, not whatever a
      // later render shows by the time the host answers.
      const pausesMayBeCancelled = hasUndecidedPauseNotice(cancelled.messages);
      void requestAssistantRunCancel({
        authHeaders,
        baseUrl: desktopAssistantBaseUrl,
        runId,
      })
        .then(async () => {
          if (cancellingRequest && preparedRequestRef.current === cancellingRequest) {
            preparedRequestRef.current = null;
            await completePreparedRequestRef.current?.(
              cancellingRequest.data,
              'cancelled',
              undefined,
              true
            );
          }
          if (activeRunSessionRef.current === cancellingSession) {
            clearActiveRunSession();
          }
          // The host cancelled the turn's paused work before answering; only
          // rediscovery carries that decision state to the renderer.
          if (pausesMayBeCancelled) {
            onPausesCancelled?.();
          }
        })
        .catch((error: unknown) => {
          assistantEndpointLogger.error('Failed to cancel server-owned assistant run', { error });
        });
    },
    [
      authHeaders,
      clearActiveRunSession,
      completeLatestPreparedRequest,
      desktopAssistantBaseUrl,
      onPausesCancelled,
    ]
  );

  const onError = useCallback(
    (error: Error): void => {
      const record = activeRunSessionRef.current;
      if (record) {
        setActiveSessionState({ record, replayEligible: true, resumeApi, threadKey });
      }
      void completeLatestPreparedRequest('failed', error.message);
    },
    [completeLatestPreparedRequest, resumeApi, threadKey]
  );

  const onFinish = useCallback((): void => {
    clearActiveRunSession();
    void completeLatestPreparedRequest('completed');
  }, [clearActiveRunSession, completeLatestPreparedRequest]);

  const onReplayError = useCallback(
    (error: Error, eventId?: string): void => {
      if (eventId && activeRunSessionRef.current?.eventId !== eventId) {
        return;
      }
      if (error instanceof AssistantStreamReplayUnavailableError) {
        clearActiveRunSession();
        return;
      }
      if (replayRetryCountRef.current >= MAX_ASSISTANT_REPLAY_RETRIES) {
        assistantEndpointLogger.error('Assistant stream replay exhausted its retry budget', {
          error,
          retryCount: replayRetryCountRef.current,
        });
        // Release the record ONLY when the durable run is provably over.
        // Clearing unconditionally would let the next send start a second
        // turn concurrently with a still-running detached stream (Codex
        // review on #2510); keeping it can no longer wedge the thread,
        // because prepareRequest reconciles against the durable run row on
        // the next send.
        const storedRunSession = activeRunSessionRef.current;
        if (storedRunSession && desktopAssistantBaseUrl) {
          void isStoredRunSessionStale({
            authHeaders,
            baseUrl: desktopAssistantBaseUrl,
            runId: storedRunSession.runId,
          }).then((stale) => {
            if (stale && activeRunSessionRef.current === storedRunSession) {
              assistantEndpointLogger.warn(
                'Released the reattachment record after exhausted replays; the durable run is no longer running',
                { runId: storedRunSession.runId }
              );
              clearActiveRunSession();
            }
          });
        }
        return;
      }
      replayRetryCountRef.current += 1;
      setReplayRetryToken((current) => current + 1);
    },
    [authHeaders, clearActiveRunSession, desktopAssistantBaseUrl]
  );

  const onResponse = useCallback(
    (response: Response, parentMessageId?: string | null): void => {
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
      // A valid desktop session response transfers durable completion to the host.
      // Renderer callbacks still release local activity, including on disconnect.
      if (preparedRequestRef.current) {
        preparedRequestRef.current.hostOwnsRun = true;
      }
      const record = {
        assistantMessageId,
        eventId,
        ...(parentMessageId === undefined ? {} : { parentMessageId }),
        runId,
      };
      writeAssistantActiveRunSession(threadKey, record);
      activeRunSessionRef.current = record;
      replayRetryCountRef.current = 0;
      setActiveSessionState({ record, replayEligible: false, resumeApi, threadKey });
    },
    [resumeApi, threadKey]
  );

  return {
    activeRunSession,
    discoveredRun,
    isRecovering,
    onCancel,
    onError,
    onFinish,
    onReplayError,
    onResponse,
    recoveryError,
    replayEligible,
    retryRecovery,
    ...(prepareLocalModel ? { prepareRequestWarmup: prepareLocalModel } : {}),
    prepareRequest,
    replayRetryToken,
    resumeApi,
  };
}
