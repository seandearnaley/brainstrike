/**
 * Stale stream-reattachment record reclaim (2026-08-18 field failure).
 *
 * A dev-mode renderer reload mid-stream left a thread-scoped sessionStorage
 * reattachment record behind while the main-process stream finished into a
 * suspend pause (durable run row `completed` at 03:53:37). The record was
 * never consumed or cleared, so every later send threw "Cannot start a
 * hosted assistant run while an existing run is awaiting stream
 * reattachment." until the app was closed — a permanent wedge from an
 * ephemeral hint.
 *
 * The contract pinned here: the ephemeral record is a HINT; the durable run
 * row is the authority (same as the BST-1244 Threads-panel projection).
 * prepareRequest reconciles the two at the moment of conflict — a record
 * whose durable run is terminal (or unknown) is reclaimed VISIBLY and the
 * new run proceeds; only a genuinely running durable run keeps the guard.
 * A failed probe keeps the guard (fail-safe, never silent).
 */
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
const BASE = 'http://127.0.0.1:43110';
const THREAD_KEY = 'thread-reclaim-test';
const STORAGE_KEY = `brainstrike.assistant.active-run:${THREAD_KEY}`;

const RECORD = {
  assistantMessageId: 'assistant-1',
  eventId: 'sess_abc:41',
  runId: 'run-stuck-1',
} as const;

function stubRunStatusFetch(
  result: { status: number; body: unknown } | Error
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith(`${BASE}${ASSISTANT_RUN_STATUS_PATH}`)) {
      return Promise.reject(new Error(`Unexpected fetch in test: ${url}`));
    }
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    return Promise.resolve(
      new Response(JSON.stringify(result.body), {
        headers: { 'content-type': 'application/json' },
        status: result.status,
      })
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('useAssistantServerRunSession stale-record reclaim', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    (window as unknown as { assistant: object }).assistant = {};
    writeAssistantActiveRunSession(THREAD_KEY, RECORD);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'assistant');
  });

  it.each(['error', 'finish'] as const)(
    'releases an admitted host run on %s without transferring terminal ownership',
    async (event) => {
      window.sessionStorage.clear();
      const completePreparedRequest = vi.fn();
      const data = { memory: { runId: 'host-owned' } };
      const { result } = renderHook(() =>
        useAssistantServerRunSession({
          api: API,
          completePreparedRequest,
          prepareRequestData: async () => data,
          threadKey: THREAD_KEY,
        })
      );
      await act(async () => {
        await result.current.prepareRequest();
      });
      act(() =>
        result.current.onResponse(
          new Response(null, {
            headers: {
              [ASSISTANT_STREAM_EVENT_ID_HEADER]: 'session:0',
              [ASSISTANT_STREAM_MESSAGE_ID_HEADER]: 'message',
            },
          }),
          'user-parent'
        )
      );
      await act(async () => {
        if (event === 'error') {
          result.current.onError(new Error('network error'));
        } else {
          result.current.onFinish();
        }
      });
      expect(completePreparedRequest).toHaveBeenCalledWith(
        data,
        event === 'error' ? 'failed' : 'completed',
        event === 'error' ? 'network error' : undefined,
        true
      );
      if (event === 'error') {
        expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
      }
    }
  );

  it('keeps renderer ownership when the request fails before host admission', async () => {
    window.sessionStorage.clear();
    const completePreparedRequest = vi.fn();
    const data = { memory: { runId: 'not-admitted' } };
    const { result } = renderHook(() =>
      useAssistantServerRunSession({
        api: API,
        completePreparedRequest,
        prepareRequestData: async () => data,
        threadKey: THREAD_KEY,
      })
    );
    await act(async () => {
      await result.current.prepareRequest();
      result.current.onError(new Error('connection refused'));
    });
    expect(completePreparedRequest).toHaveBeenCalledWith(
      data,
      'failed',
      'connection refused',
      false
    );
  });

  it('publishes an admitted live cursor for replay after the stream detaches', async () => {
    window.sessionStorage.clear();
    const { result } = renderHook(() =>
      useAssistantServerRunSession({
        api: API,
        prepareRequestData: async () => ({ memory: { runId: 'run-live' } }),
        threadKey: THREAD_KEY,
      })
    );
    await act(async () => {
      await result.current.prepareRequest();
    });
    act(() => {
      result.current.onResponse(
        new Response(null, {
          headers: {
            [ASSISTANT_STREAM_EVENT_ID_HEADER]: 'session:0',
            [ASSISTANT_STREAM_MESSAGE_ID_HEADER]: 'assistant-live',
          },
        }),
        'user-parent'
      );
    });
    expect(result.current.activeRunSession).toEqual({
      assistantMessageId: 'assistant-live',
      eventId: 'session:0',
      parentMessageId: 'user-parent',
      runId: 'run-live',
    });
    act(() => result.current.onError(new Error('socket dropped')));
    expect(result.current.activeRunSession).toEqual(
      JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null')
    );
  });

  it('discovers a running host stream in a replacement window with no sessionStorage cursor', async () => {
    window.sessionStorage.clear();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/assistant/active-run');
      expect(url.searchParams.get('resourceId')).toBe('resource-1');
      expect(url.searchParams.get('threadId')).toBe(THREAD_KEY);
      return new Response(
        JSON.stringify({
          activeRun: {
            assistantMessageId: 'assistant-live',
            eventId: 'session:0',
            inputMessage: {
              id: 'user-1',
              parts: [{ text: 'first prompt', type: 'text' }],
              role: 'user',
            },
            inputParentMessageId: null,
            parentMessageId: 'user-1',
            runId: 'run-live',
            state: 'active',
          },
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() =>
      useAssistantServerRunSession({
        api: API,
        resourceId: 'resource-1',
        threadKey: THREAD_KEY,
      })
    );
    await waitFor(() => expect(result.current.isRecovering).toBe(false));
    expect(result.current.recoveryError).toBeUndefined();
    expect(result.current.activeRunSession?.runId).toBe('run-live');
    expect(result.current.discoveredRun?.inputMessage?.id).toBe('user-1');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('retains cancelled-request authority on HTTP failure and reclaims only a terminal server run', async () => {
    window.sessionStorage.clear();
    let status = 'running';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/assistant/cancel')
        ? new Response(null, { status: 503 })
        : new Response(JSON.stringify({ runId: 'cancel-retry', status }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const completePreparedRequest = vi.fn();
    const { result } = renderHook(() =>
      useAssistantServerRunSession({
        api: API,
        completePreparedRequest,
        prepareRequestData: async () => ({ memory: { runId: 'cancel-retry' } }),
        threadKey: THREAD_KEY,
      })
    );
    await act(async () => {
      await result.current.prepareRequest();
    });
    await act(async () => {
      result.current.onCancel({ messages: [] });
      result.current.onError(new Error('abort'));
    });
    expect(completePreparedRequest).not.toHaveBeenCalled();
    await act(async () => {
      await expect(result.current.prepareRequest()).rejects.toThrow(/awaiting stream reattachment/);
    });
    status = 'cancelled';
    await act(async () => {
      await expect(result.current.prepareRequest()).resolves.toEqual({
        memory: { runId: 'cancel-retry' },
      });
    });
    expect(completePreparedRequest).not.toHaveBeenCalled();
  });

  it('reclaims the record and proceeds when the durable run is terminal', async () => {
    const fetchMock = stubRunStatusFetch({
      body: { runId: RECORD.runId, status: 'completed' },
      status: 200,
    });
    const { result } = renderHook(() =>
      useAssistantServerRunSession({
        api: API,
        prepareRequestData: () => Promise.resolve({ runId: 'run-new' }),
        threadKey: THREAD_KEY,
      })
    );

    await act(async () => {
      await expect(result.current.prepareRequest()).resolves.toEqual({ runId: 'run-new' });
    });

    // The wedge: this record used to survive forever. Reclaim must remove it.
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    const probeUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(probeUrl).toContain(`${ASSISTANT_RUN_STATUS_PATH}?runId=${RECORD.runId}`);
  });

  it('reclaims the record when the durable run row is unknown', async () => {
    stubRunStatusFetch({ body: { runId: RECORD.runId, status: 'unknown' }, status: 200 });
    const { result } = renderHook(() =>
      useAssistantServerRunSession({
        api: API,
        prepareRequestData: () => Promise.resolve({ runId: 'run-new' }),
        threadKey: THREAD_KEY,
      })
    );

    await act(async () => {
      await expect(result.current.prepareRequest()).resolves.toEqual({ runId: 'run-new' });
    });
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it.each(['running', 'cancelling'])(
    'keeps the guard while the durable run is %s',
    async (status) => {
      stubRunStatusFetch({ body: { runId: RECORD.runId, status }, status: 200 });
      const { result } = renderHook(() =>
        useAssistantServerRunSession({
          api: API,
          prepareRequestData: () => Promise.resolve({}),
          threadKey: THREAD_KEY,
        })
      );

      await act(async () => {
        await expect(result.current.prepareRequest()).rejects.toThrow(
          /awaiting stream reattachment/
        );
      });
      expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
    }
  );

  it('keeps the guard when the status probe fails (fail-safe, never silent reclaim)', async () => {
    stubRunStatusFetch(new Error('connection refused'));
    const { result } = renderHook(() =>
      useAssistantServerRunSession({
        api: API,
        prepareRequestData: () => Promise.resolve({}),
        threadKey: THREAD_KEY,
      })
    );

    await act(async () => {
      await expect(result.current.prepareRequest()).rejects.toThrow(/awaiting stream reattachment/);
    });
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('releases the record after exhausted replays when the durable run is over', async () => {
    stubRunStatusFetch({ body: { runId: RECORD.runId, status: 'completed' }, status: 200 });
    const { result } = renderHook(() =>
      useAssistantServerRunSession({
        api: API,
        prepareRequestData: () => Promise.resolve({}),
        threadKey: THREAD_KEY,
      })
    );

    act(() => {
      result.current.onReplayError(new Error('replay interrupted 1'));
      result.current.onReplayError(new Error('replay interrupted 2'));
      // Third failure exceeds MAX_ASSISTANT_REPLAY_RETRIES (2): the record
      // must be reconciled against the durable run row and released here,
      // so the thread can start new runs again.
      result.current.onReplayError(new Error('replay interrupted 3'));
    });

    await waitFor(() => {
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  it('keeps the record after exhausted replays while the durable run still runs', async () => {
    // Codex review on #2510: the main-process stream continues after renderer
    // detachment. Clearing unconditionally on exhaustion would let the next
    // send start a SECOND turn concurrently with the still-running orphan —
    // the exact hazard the guard exists to prevent. The prepareRequest
    // reconcile heals the thread once the run actually ends, so keeping the
    // record here no longer wedges anything.
    const fetchMock = stubRunStatusFetch({
      body: { runId: RECORD.runId, status: 'running' },
      status: 200,
    });
    const { result } = renderHook(() =>
      useAssistantServerRunSession({
        api: API,
        prepareRequestData: () => Promise.resolve({}),
        threadKey: THREAD_KEY,
      })
    );

    act(() => {
      result.current.onReplayError(new Error('replay interrupted 1'));
      result.current.onReplayError(new Error('replay interrupted 2'));
      result.current.onReplayError(new Error('replay interrupted 3'));
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });
});
