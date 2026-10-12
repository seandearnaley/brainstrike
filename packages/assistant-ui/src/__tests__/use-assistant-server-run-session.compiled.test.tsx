import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeAssistantActiveRunSession } from '../assistant-run-reattachment';
import { useAssistantServerRunSession } from '../use-assistant-server-run-session';

const API = 'http://127.0.0.1:43110/assistant';

describe('useAssistantServerRunSession under the React Compiler', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    (window as unknown as { assistant: object }).assistant = {};
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'assistant');
  });

  it('runs discovery again when recovery is retried', async () => {
    let discoveryAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.includes('/assistant/active-run')) {
          return Promise.reject(new Error(`Unexpected fetch in test: ${url}`));
        }
        discoveryAttempts += 1;
        return Promise.resolve(
          discoveryAttempts === 1
            ? new Response(null, { status: 503 })
            : new Response(JSON.stringify({ activeRun: null }), { status: 200 })
        );
      })
    );
    const { result } = renderHook(() =>
      useAssistantServerRunSession({
        api: API,
        prepareRequestData: async () => ({}),
        resourceId: 'resource-1',
        threadKey: 'thread-retry',
      })
    );
    await waitFor(() => expect(result.current.recoveryError?.message).toContain('503'));

    act(() => result.current.retryRecovery());

    await waitFor(() => expect(result.current.recoveryError).toBeUndefined());
    expect(result.current.isRecovering).toBe(false);
    expect(discoveryAttempts).toBe(2);
  });

  it("shows the next thread's stored run, not the previous thread's cleared one", async () => {
    const nextRun = { assistantMessageId: 'assistant-b', eventId: 'sess_b:3', runId: 'run-b' };
    writeAssistantActiveRunSession('thread-a', {
      assistantMessageId: 'assistant-a',
      eventId: 'sess_a:7',
      runId: 'run-a',
    });
    writeAssistantActiveRunSession('thread-b', nextRun);
    const { result, rerender } = renderHook(
      ({ threadKey }: { threadKey: string }) =>
        useAssistantServerRunSession({
          api: API,
          completePreparedRequest: vi.fn(),
          prepareRequestData: async () => ({}),
          threadKey,
        }),
      { initialProps: { threadKey: 'thread-a' } }
    );
    expect(result.current.activeRunSession?.runId).toBe('run-a');
    await act(async () => {
      result.current.onFinish();
    });
    expect(result.current.activeRunSession).toBeUndefined();

    rerender({ threadKey: 'thread-b' });

    expect(result.current.activeRunSession).toEqual(nextRun);
  });
});
