import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantRunAdmissionRejectedError } from '../data-stream-runtime';
import { useWebAssistantRequestSession } from '../use-web-assistant-request-session';

const NEW_RUN_ID = 'run-new';

describe('rejected hosted assistant admission', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('releases only the new prepared run after a definitive pre-admission rejection', async () => {
    window.sessionStorage.clear();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).pathname).toBe('/assistant/active-run');
      return new Response(JSON.stringify({ activeRun: null }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const completePreparedRequest = vi.fn(() => completion);
    const prepareRequestData = vi.fn(async () => ({ memory: { runId: NEW_RUN_ID } }));
    const { result } = renderHook(() =>
      useWebAssistantRequestSession({
        completePreparedRequest,
        prepareRequestData,
      })
    );
    await waitFor(() => expect(result.current.isRecovering).toBe(false));
    await act(async () => result.current.prepareRequest());
    act(() =>
      result.current.onError(
        new AssistantRunAdmissionRejectedError('Status 500: assistant_admission_rejected')
      )
    );
    await waitFor(() =>
      expect(completePreparedRequest).toHaveBeenCalledWith(
        { memory: { runId: NEW_RUN_ID } },
        'failed',
        'Status 500: assistant_admission_rejected',
        false
      )
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(result.current.prepareRequest()).rejects.toThrow('recovery is still in progress');
    await act(async () => resolveCompletion());
    await waitFor(() => expect(result.current.isRecovering).toBe(false));
    await act(async () => result.current.prepareRequest());
    expect(prepareRequestData).toHaveBeenCalledTimes(2);
  });

  it('keeps the rejected admission guarded when its completion write fails, then retries it once', async () => {
    window.sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ activeRun: null }), { status: 200 }))
    );
    const completePreparedRequest = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('completion write failed'))
      .mockResolvedValueOnce(undefined);
    const replacementCompletion = vi.fn();
    let completionCallback: typeof completePreparedRequest | typeof replacementCompletion =
      completePreparedRequest;
    const prepareRequestData = vi.fn(async () => ({ memory: { runId: NEW_RUN_ID } }));
    const { rerender, result } = renderHook(() =>
      useWebAssistantRequestSession({
        completePreparedRequest: completionCallback,
        prepareRequestData,
      })
    );
    await waitFor(() => expect(result.current.isRecovering).toBe(false));
    await act(async () => result.current.prepareRequest());
    act(() => result.current.onError(new AssistantRunAdmissionRejectedError('admission rejected')));
    await waitFor(() =>
      expect(result.current.recoveryError?.message).toBe('completion write failed')
    );
    await expect(result.current.prepareRequest()).rejects.toThrow('completion write failed');
    completionCallback = replacementCompletion;
    rerender();
    act(() => result.current.retryRecovery());
    await waitFor(() => expect(completePreparedRequest).toHaveBeenCalledTimes(2));
    expect(replacementCompletion).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.recoveryError).toBeUndefined());
    await act(async () => result.current.prepareRequest());
    expect(prepareRequestData).toHaveBeenCalledTimes(2);
  });

  it('settles a late rejection through the completion owner captured before a scope switch', async () => {
    window.sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ activeRun: null }), { status: 200 }))
    );
    const completionA = vi.fn();
    const completionB = vi.fn();
    let completion = completionA;
    const { rerender, result } = renderHook(() =>
      useWebAssistantRequestSession({
        completePreparedRequest: completion,
        prepareRequestData: async () => ({ memory: { runId: NEW_RUN_ID } }),
      })
    );
    await waitFor(() => expect(result.current.isRecovering).toBe(false));
    await act(async () => result.current.prepareRequest());

    completion = completionB;
    rerender();
    act(() => result.current.onError(new AssistantRunAdmissionRejectedError('admission rejected')));

    await waitFor(() => expect(completionA).toHaveBeenCalledTimes(1));
    expect(completionB).not.toHaveBeenCalled();
    expect(completionA).toHaveBeenCalledWith(
      { memory: { runId: NEW_RUN_ID } },
      'failed',
      'admission rejected',
      false
    );
  });
});
