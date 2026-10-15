// @vitest-environment jsdom
import { act, type RenderHookResult, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalRuntimeLoadingProgress } from '../local-runtime-desktop-host';
import { useLocalModelLoading } from '../use-local-model-loading';

const { warmDesktopLocalModelMock } = vi.hoisted(() => ({
  warmDesktopLocalModelMock: vi.fn(
    async (_options?: {
      modelId?: string;
      onLoadingProgress?: (progress: LocalRuntimeLoadingProgress) => void;
      signal?: AbortSignal;
    }): Promise<void> => undefined
  ),
}));

vi.mock('../local-runtime-desktop-host', () => ({
  warmDesktopLocalModel: warmDesktopLocalModelMock,
}));

type ProgressListener = (report: unknown) => void;
type LoadingHook = ReturnType<typeof useLocalModelLoading>;

/**
 * Drive the hook the way production does: start a warmup that stays in flight
 * and push host progress through the `onLoadingProgress` callback the hook
 * hands to `warmDesktopLocalModel`. Keeping the warmup pending means the
 * badge reflects mid-load reports instead of jumping straight to "ready".
 */
function renderWarmingHook(): {
  emit: (progress: LocalRuntimeLoadingProgress) => void;
  result: RenderHookResult<LoadingHook, unknown>['result'];
} {
  let onLoadingProgress: ((progress: LocalRuntimeLoadingProgress) => void) | undefined;
  warmDesktopLocalModelMock.mockImplementation((options) => {
    onLoadingProgress = options?.onLoadingProgress;
    return new Promise<void>(() => undefined);
  });

  const { result } = renderHook(() =>
    useLocalModelLoading({ localViaDataStream: true, modelName: 'gemma' })
  );

  act(() => {
    void result.current.prepareLocalModel?.()?.catch(() => undefined);
  });

  return {
    emit: (progress: LocalRuntimeLoadingProgress) => {
      act(() => {
        onLoadingProgress?.(progress);
      });
    },
    result,
  };
}

describe('useLocalModelLoading', () => {
  let progressListener: ProgressListener | null = null;
  const unsubscribeMock = vi.fn();

  beforeEach(() => {
    progressListener = null;
    unsubscribeMock.mockReset();
    warmDesktopLocalModelMock.mockReset();
    warmDesktopLocalModelMock.mockResolvedValue(undefined);
    (window as Window & { llmHost?: unknown }).llmHost = {
      onProgress: (listener: ProgressListener) => {
        progressListener = listener;
        return unsubscribeMock;
      },
    };
  });

  afterEach(() => {
    (window as Window & { llmHost?: unknown }).llmHost = undefined;
  });

  it('keeps loading progress monotonic within a session (no backwards jumps)', () => {
    vi.useFakeTimers();
    try {
      const { emit, result } = renderWarmingHook();

      emit({ message: 'Loading model.onnx', progress: 60, stage: 'loading' });
      act(() => {
        // Each unkeyed artifact report runs 0→100 of its own; the badge must
        // not jump backwards (the "fast layout shift" jank).
        emit({ message: 'Loading tokenizer.json', progress: 5, stage: 'loading' });
        vi.advanceTimersByTime(300);
      });

      expect(result.current.localLoadingState).toMatchObject({
        message: 'Loading tokenizer.json',
        progress: 60,
        stage: 'loading',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('aggregates parallel per-file reports instead of mirroring the loudest file', () => {
    // Transformers.js loads many artifacts in parallel; raw interleaved
    // reports made the badge flash between file names with the percent pinned
    // at 100 as soon as ANY small file completed.
    vi.useFakeTimers();
    try {
      const { emit, result } = renderWarmingHook();

      act(() => {
        emit({
          file: 'config.json',
          message: 'Loading config.json',
          progress: 100,
          stage: 'loading',
        });
        emit({
          file: 'onnx/decoder_model_merged_q4f16.onnx_data',
          message: 'Loading onnx/decoder_model_merged_q4f16.onnx_data',
          progress: 20,
          stage: 'loading',
        });
        emit({
          file: 'onnx/embed_tokens_q4f16.onnx',
          message: 'Loading onnx/embed_tokens_q4f16.onnx',
          progress: 100,
          stage: 'loading',
        });
        vi.advanceTimersByTime(300);
      });

      // Mean of {100, 20, 100}, never pinned to a single file's 100.
      expect(result.current.localLoadingState).toMatchObject({
        // The label sticks to the laggard (the file users are waiting on),
        // not whichever file reported last.
        file: 'onnx/decoder_model_merged_q4f16.onnx_data',
        message: 'Loading model files (2/3)',
        progress: 73,
        stage: 'loading',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('throttles same-stage report bursts to the latest aggregate', () => {
    vi.useFakeTimers();
    try {
      const { emit, result } = renderWarmingHook();

      emit({ file: 'a.onnx', message: 'Loading a.onnx', progress: 10, stage: 'loading' });
      // First report of the stage applies immediately.
      expect(result.current.localLoadingState).toMatchObject({ progress: 10 });

      act(() => {
        emit({ file: 'a.onnx', message: 'Loading a.onnx', progress: 50, stage: 'loading' });
        emit({ file: 'a.onnx', message: 'Loading a.onnx', progress: 90, stage: 'loading' });
      });
      // Burst inside the throttle window: the badge has not flashed through
      // the intermediate values.
      expect(result.current.localLoadingState).toMatchObject({ progress: 10 });

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(result.current.localLoadingState).toMatchObject({ progress: 90 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the monotonic floor when a session completes', () => {
    const { emit, result } = renderWarmingHook();

    emit({ message: 'Loading model', progress: 90, stage: 'loading' });
    emit({ message: 'Model ready', progress: 100, stage: 'ready' });
    emit({ message: 'Loading model', progress: 10, stage: 'loading' });

    expect(result.current.localLoadingState).toMatchObject({ progress: 10, stage: 'loading' });
  });

  it('surfaces main-initiated host loading progress (cold memory warmups) and resolves to ready', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useLocalModelLoading({ localViaDataStream: true, modelName: 'gemma' })
      );
      expect(progressListener).not.toBeNull();

      act(() => {
        progressListener?.({
          payload: {
            file: 'model.onnx',
            kind: 'loading',
            message: 'Downloading model',
            progress: 37,
          },
          requestId: 'main:abc',
          runtimeId: 'llm-host:runtime',
          type: 'progress',
        });
      });
      expect(result.current.localLoadingState).toMatchObject({
        file: 'model.onnx',
        progress: 37,
        stage: 'loading',
      });

      act(() => {
        progressListener?.({
          payload: { kind: 'loading', message: 'Model loaded', progress: 100 },
          requestId: 'main:warmup-complete',
          runtimeId: 'llm-host:runtime',
          type: 'progress',
        });
      });
      expect(result.current.localLoadingState).toMatchObject({ progress: 100, stage: 'ready' });

      act(() => {
        vi.advanceTimersByTime(1300);
      });
      expect(result.current.localLoadingState).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores non-loading host progress (generation snapshots) and unsubscribes on unmount', () => {
    const { result, unmount } = renderHook(() =>
      useLocalModelLoading({ localViaDataStream: true, modelName: 'gemma' })
    );

    act(() => {
      progressListener?.({
        payload: { kind: 'text', text: 'partial answer' },
        requestId: 'main:gen',
        runtimeId: 'llm-host:runtime',
        type: 'progress',
      });
    });
    expect(result.current.localLoadingState).toBeUndefined();

    unmount();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  // The built-in local provider has exactly one transport now, but a panel on
  // a hosted provider must not warm the local model on every request.
  it('offers no warmup when the local provider is not selected', () => {
    const { result } = renderHook(() =>
      useLocalModelLoading({ localViaDataStream: false, modelName: 'gemma' })
    );

    expect(result.current.prepareLocalModel).toBeUndefined();
  });

  it('forwards the request-preparation signal to the local-model warmup', async () => {
    const abortController = new AbortController();
    const { result } = renderHook(() =>
      useLocalModelLoading({ localViaDataStream: true, modelName: 'gemma' })
    );

    await act(async () => {
      await result.current.prepareLocalModel?.(abortController.signal);
    });

    expect(warmDesktopLocalModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'gemma',
        signal: abortController.signal,
      })
    );
  });

  it('renders a failed warmup as a visible model-load error', async () => {
    warmDesktopLocalModelMock.mockRejectedValueOnce(
      new Error('Desktop llm host bridge is unavailable; cannot warm the local model.')
    );
    const { result } = renderHook(() =>
      useLocalModelLoading({ localViaDataStream: true, modelName: 'gemma' })
    );

    await act(async () => {
      await expect(result.current.prepareLocalModel?.()).rejects.toThrow(
        'Desktop llm host bridge is unavailable'
      );
    });

    expect(result.current.localLoadingState).toMatchObject({
      message: 'Desktop llm host bridge is unavailable; cannot warm the local model.',
      stage: 'error',
    });
  });

  it('does not render Stop-detached local warmup as a model-load error', async () => {
    const abortController = new AbortController();
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    warmDesktopLocalModelMock.mockImplementationOnce(
      (options?: { signal?: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(abortError), { once: true });
        })
    );
    const { result } = renderHook(() =>
      useLocalModelLoading({ localViaDataStream: true, modelName: 'gemma' })
    );

    await act(async () => {
      const warmup = result.current.prepareLocalModel?.(abortController.signal);
      abortController.abort(abortError);
      await expect(warmup).rejects.toBe(abortError);
    });

    expect(result.current.localLoadingState?.stage).not.toBe('error');
  });
});
