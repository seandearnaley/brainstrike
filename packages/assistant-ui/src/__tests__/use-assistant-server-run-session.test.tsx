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
import { ASSISTANT_RUN_STATUS_PATH } from '@brainstrike/assistant-contract';
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

  it('keeps the guard while the durable run is still running', async () => {
    stubRunStatusFetch({ body: { runId: RECORD.runId, status: 'running' }, status: 200 });
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
