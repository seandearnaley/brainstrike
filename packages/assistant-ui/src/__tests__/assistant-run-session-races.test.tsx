import {
  ASSISTANT_RUN_STATUS_PATH,
  ASSISTANT_STREAM_EVENT_ID_HEADER,
  ASSISTANT_STREAM_MESSAGE_ID_HEADER,
} from '@brainstrike/assistant-contract';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeAssistantActiveRunSession } from '../assistant-run-reattachment';
import { useAssistantServerRunSession } from '../use-assistant-server-run-session';

const API = 'http://127.0.0.1:43110/assistant';
const THREAD_KEY = 'thread-run-race';
const STORAGE_KEY = `brainstrike.assistant.active-run:${THREAD_KEY}`;
const OLD_RUN_ID = 'run-old';
const NEW_RUN_ID = 'run-new';
const ACTIVE_NEW_RUN = {
  assistantMessageId: 'assistant-new',
  eventId: 'session-new:-1',
  inputMessage: null,
  inputParentMessageId: null,
  parentMessageId: null,
  runId: NEW_RUN_ID,
  state: 'active',
} as const;

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function terminalStatus(runId = OLD_RUN_ID): Response {
  return new Response(JSON.stringify({ runId, status: 'completed' }), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}

function admitNewRun(onResponse: (response: Response, parentMessageId: string) => void): void {
  onResponse(
    new Response(null, {
      headers: {
        [ASSISTANT_STREAM_EVENT_ID_HEADER]: 'session-new:0',
        [ASSISTANT_STREAM_MESSAGE_ID_HEADER]: 'assistant-new',
      },
    }),
    'user-new'
  );
}

describe('assistant run session asynchronous reconciliation', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    (window as unknown as { assistant: object }).assistant = {};
    writeAssistantActiveRunSession(THREAD_KEY, {
      assistantMessageId: 'assistant-old',
      eventId: 'session-old:0',
      runId: OLD_RUN_ID,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'assistant');
  });

  it('keeps a newer cursor when an exhausted replay probe for the old run finishes late', async () => {
    const oldReplayProbe = deferredResponse();
    let statusCallCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        expect(String(input)).toContain(ASSISTANT_RUN_STATUS_PATH);
        statusCallCount += 1;
        return statusCallCount === 1 ? oldReplayProbe.promise : Promise.resolve(terminalStatus());
      })
    );
    const { result } = renderHook(() =>
      useAssistantServerRunSession({
        api: API,
        prepareRequestData: async () => ({ memory: { runId: NEW_RUN_ID } }),
        threadKey: THREAD_KEY,
      })
    );

    act(() => {
      result.current.onReplayError(new Error('replay failed 1'));
      result.current.onReplayError(new Error('replay failed 2'));
      result.current.onReplayError(new Error('replay failed 3'));
    });
    await waitFor(() => expect(statusCallCount).toBe(1));

    await act(async () => {
      await result.current.prepareRequest();
    });
    act(() => admitNewRun(result.current.onResponse));
    expect(result.current.activeRunSession?.runId).toBe(NEW_RUN_ID);

    await act(async () => oldReplayProbe.resolve(terminalStatus()));
    expect(result.current.activeRunSession?.runId).toBe(NEW_RUN_ID);
    expect(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null').runId).toBe(NEW_RUN_ID);
  });

  it('does not let an older send preflight erase a newly admitted run', async () => {
    const oldPreflight = deferredResponse();
    let statusCallCount = 0;
    const prepareRequestData = vi.fn(async () => ({ memory: { runId: NEW_RUN_ID } }));
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        expect(String(input)).toContain(ASSISTANT_RUN_STATUS_PATH);
        statusCallCount += 1;
        return statusCallCount === 1 ? oldPreflight.promise : Promise.resolve(terminalStatus());
      })
    );
    const { result } = renderHook(() =>
      useAssistantServerRunSession({ api: API, prepareRequestData, threadKey: THREAD_KEY })
    );

    const firstSend = expect(result.current.prepareRequest()).rejects.toThrow('another run');
    await waitFor(() => expect(statusCallCount).toBe(1));
    await act(async () => {
      await result.current.prepareRequest();
    });
    act(() => admitNewRun(result.current.onResponse));

    await act(async () => oldPreflight.resolve(terminalStatus()));
    await firstSend;
    expect(result.current.activeRunSession?.runId).toBe(NEW_RUN_ID);
    expect(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null').runId).toBe(NEW_RUN_ID);
    expect(prepareRequestData).toHaveBeenCalledTimes(1);
  });

  it('allows replay only after a fresh hosted response loses its transport', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => terminalStatus())
    );
    const { result } = renderHook(() =>
      useAssistantServerRunSession({
        api: API,
        prepareRequestData: async () => ({ memory: { runId: NEW_RUN_ID } }),
        threadKey: THREAD_KEY,
      })
    );

    expect(result.current.replayEligible).toBe(true);
    await act(async () => {
      await result.current.prepareRequest();
    });
    act(() => admitNewRun(result.current.onResponse));
    expect(result.current.replayEligible).toBe(false);

    act(() => result.current.onError(new Error('transport detached')));
    expect(result.current.replayEligible).toBe(true);

    act(() => result.current.onFinish());
    expect(result.current.replayEligible).toBe(false);
    expect(result.current.activeRunSession).toBeUndefined();
  });

  it('keeps a newer cursor when cancellation of the old run finishes late', async () => {
    const oldCancellation = deferredResponse();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/assistant/cancel')) {
        return oldCancellation.promise;
      }
      expect(url).toContain(ASSISTANT_RUN_STATUS_PATH);
      return Promise.resolve(terminalStatus());
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() =>
      useAssistantServerRunSession({
        api: API,
        prepareRequestData: async () => ({ memory: { runId: NEW_RUN_ID } }),
        threadKey: THREAD_KEY,
      })
    );

    act(() => result.current.onCancel({ messages: [] }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(new URL('/assistant/cancel', API), expect.any(Object))
    );
    await act(async () => {
      await result.current.prepareRequest();
    });
    act(() => admitNewRun(result.current.onResponse));
    expect(result.current.activeRunSession?.runId).toBe(NEW_RUN_ID);

    await act(async () => oldCancellation.resolve(new Response(null, { status: 200 })));
    expect(result.current.activeRunSession?.runId).toBe(NEW_RUN_ID);
    expect(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null').runId).toBe(NEW_RUN_ID);
  });

  it('exposes a recovery error, blocks sends, and retries discovery explicitly', async () => {
    let discoveryAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/assistant/active-run')) {
          discoveryAttempts += 1;
          return Promise.resolve(
            discoveryAttempts === 1
              ? new Response(null, { status: 503 })
              : new Response(JSON.stringify({ activeRun: null }), { status: 200 })
          );
        }
        expect(url).toContain(ASSISTANT_RUN_STATUS_PATH);
        return Promise.resolve(terminalStatus());
      })
    );
    const { result } = renderHook(() =>
      useAssistantServerRunSession({
        api: API,
        prepareRequestData: async () => ({ memory: { runId: NEW_RUN_ID } }),
        resourceId: 'resource-1',
        threadKey: THREAD_KEY,
      })
    );

    await waitFor(() => expect(result.current.recoveryError?.message).toContain('503'));
    await act(async () => {
      await expect(result.current.prepareRequest()).rejects.toThrow('503');
    });
    act(() => result.current.retryRecovery());
    await waitFor(() => {
      expect(result.current.isRecovering).toBe(false);
      expect(result.current.recoveryError).toBeUndefined();
    });
    expect(discoveryAttempts).toBe(2);
    await act(async () => {
      await expect(result.current.prepareRequest()).resolves.toEqual({
        memory: { runId: NEW_RUN_ID },
      });
    });
  });

  it.each(['auth', 'fetch'] as const)(
    'times out discovery when %s never resolves',
    async (hangingStage) => {
      vi.useFakeTimers();
      const never = new Promise<Response>(() => undefined);
      const fetchMock = vi.fn(() => never);
      vi.stubGlobal('fetch', fetchMock);
      const authHeaders =
        hangingStage === 'auth'
          ? () => new Promise<Record<string, string>>(() => undefined)
          : undefined;
      const { result } = renderHook(() =>
        useAssistantServerRunSession({
          api: API,
          ...(authHeaders ? { authHeaders } : {}),
          resourceId: 'resource-1',
          threadKey: THREAD_KEY,
        })
      );

      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(result.current.recoveryError?.message).toContain('timed out');
      expect(result.current.isRecovering).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(hangingStage === 'fetch' ? 1 : 0);
    }
  );

  it('does not clear the selected thread when an old thread status probe resolves late', async () => {
    const oldThreadStatus = deferredResponse();
    const newThreadKey = 'thread-run-race-new';
    const newStorageKey = `brainstrike.assistant.active-run:${newThreadKey}`;
    let oldProbeStarted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === '/assistant/active-run') {
          return Promise.resolve(
            new Response(JSON.stringify({ activeRun: null }), { status: 200 })
          );
        }
        expect(url.pathname).toBe(ASSISTANT_RUN_STATUS_PATH);
        oldProbeStarted = true;
        return oldThreadStatus.promise;
      })
    );
    const { result, rerender } = renderHook(
      ({ threadKey }) =>
        useAssistantServerRunSession({
          api: API,
          prepareRequestData: async () => ({ memory: { runId: NEW_RUN_ID } }),
          resourceId: 'resource-1',
          threadKey,
        }),
      { initialProps: { threadKey: THREAD_KEY } }
    );
    await waitFor(() => expect(oldProbeStarted).toBe(true));

    rerender({ threadKey: newThreadKey });
    await waitFor(() => expect(result.current.isRecovering).toBe(false));
    await act(async () => {
      await result.current.prepareRequest();
    });
    act(() => admitNewRun(result.current.onResponse));

    await act(async () => oldThreadStatus.resolve(terminalStatus()));
    expect(result.current.activeRunSession?.runId).toBe(NEW_RUN_ID);
    expect(JSON.parse(window.sessionStorage.getItem(newStorageKey) ?? 'null').runId).toBe(
      NEW_RUN_ID
    );
  });

  it('restarts discovery when a status probe loses its session identity', async () => {
    const oldStatus = deferredResponse();
    let discoveries = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === '/assistant/active-run') {
          discoveries += 1;
          return Promise.resolve(
            new Response(JSON.stringify({ activeRun: discoveries === 1 ? ACTIVE_NEW_RUN : null }), {
              status: 200,
            })
          );
        }
        expect(url.pathname).toBe(ASSISTANT_RUN_STATUS_PATH);
        return oldStatus.promise;
      })
    );
    const { result } = renderHook(() =>
      useAssistantServerRunSession({ api: API, resourceId: 'resource-1', threadKey: THREAD_KEY })
    );
    await waitFor(() => expect(discoveries).toBe(1));
    act(() => result.current.onFinish());
    await act(async () => oldStatus.resolve(terminalStatus()));

    await waitFor(() => expect(discoveries).toBe(2));
    await waitFor(() => expect(result.current.isRecovering).toBe(false));
    expect(result.current.recoveryError).toBeUndefined();
  });

  it('replaces a terminal stored hint with the host active run in the same thread', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === '/assistant/active-run') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                activeRun: ACTIVE_NEW_RUN,
              }),
              { status: 200 }
            )
          );
        }
        expect(url.pathname).toBe(ASSISTANT_RUN_STATUS_PATH);
        expect(url.searchParams.get('runId')).toBe(OLD_RUN_ID);
        return Promise.resolve(terminalStatus());
      })
    );
    const { result } = renderHook(() =>
      useAssistantServerRunSession({ api: API, resourceId: 'resource-1', threadKey: THREAD_KEY })
    );

    await waitFor(() => expect(result.current.isRecovering).toBe(false));
    expect(result.current.recoveryError).toBeUndefined();
    expect(result.current.activeRunSession?.runId).toBe(NEW_RUN_ID);
    expect(result.current.discoveredRun?.runId).toBe(NEW_RUN_ID);
    expect(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null').runId).toBe(NEW_RUN_ID);
  });

  it.each([
    { runId: OLD_RUN_ID, status: 'running' },
    { runId: NEW_RUN_ID, status: 'completed' },
  ])('preserves stored A when its status probe cannot prove A terminal: %j', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === '/assistant/active-run') {
          return Promise.resolve(
            new Response(JSON.stringify({ activeRun: ACTIVE_NEW_RUN }), { status: 200 })
          );
        }
        expect(url.searchParams.get('runId')).toBe(OLD_RUN_ID);
        return Promise.resolve(new Response(JSON.stringify(status), { status: 200 }));
      })
    );
    const { result } = renderHook(() =>
      useAssistantServerRunSession({ api: API, resourceId: 'resource-1', threadKey: THREAD_KEY })
    );

    await waitFor(() => expect(result.current.recoveryError).toBeDefined());
    expect(result.current.activeRunSession?.runId).toBe(OLD_RUN_ID);
    expect(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null').runId).toBe(OLD_RUN_ID);
  });
});
