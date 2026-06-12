import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocalModelLoading } from '../assistant-ui-panel/use-local-model-loading';

type ProgressListener = (report: unknown) => void;

describe('useLocalModelLoading', () => {
  let progressListener: ProgressListener | null = null;
  const unsubscribeMock = vi.fn();

  beforeEach(() => {
    progressListener = null;
    unsubscribeMock.mockReset();
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
      const { result } = renderHook(() =>
        useLocalModelLoading({ localViaDataStream: false, modelName: 'gemma' })
      );

      act(() => {
        result.current.handleLocalLoadingStateChange({
          stage: 'downloading',
          progress: 60,
          message: 'Downloading model.onnx',
        });
      });
      act(() => {
        // Per-file progress resets to 0 for each artifact; the badge must not
        // jump backwards (the "fast layout shift" jank).
        result.current.handleLocalLoadingStateChange({
          stage: 'downloading',
          progress: 5,
          message: 'Downloading tokenizer.json',
        });
        vi.advanceTimersByTime(300);
      });

      expect(result.current.localLoadingState).toMatchObject({
        stage: 'downloading',
        progress: 60,
        message: 'Downloading tokenizer.json',
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
      const { result } = renderHook(() =>
        useLocalModelLoading({ localViaDataStream: false, modelName: 'gemma' })
      );

      act(() => {
        result.current.handleLocalLoadingStateChange({
          stage: 'loading',
          progress: 100,
          message: 'Loading config.json',
          file: 'config.json',
        });
        result.current.handleLocalLoadingStateChange({
          stage: 'loading',
          progress: 20,
          message: 'Loading onnx/decoder_model_merged_q4f16.onnx_data',
          file: 'onnx/decoder_model_merged_q4f16.onnx_data',
        });
        result.current.handleLocalLoadingStateChange({
          stage: 'loading',
          progress: 100,
          message: 'Loading onnx/embed_tokens_q4f16.onnx',
          file: 'onnx/embed_tokens_q4f16.onnx',
        });
        vi.advanceTimersByTime(300);
      });

      // Mean of {100, 20, 100}, never pinned to a single file's 100.
      expect(result.current.localLoadingState).toMatchObject({
        stage: 'loading',
        progress: 73,
        // The label sticks to the laggard (the file users are waiting on),
        // not whichever file reported last.
        file: 'onnx/decoder_model_merged_q4f16.onnx_data',
        message: 'Loading model files (2/3)',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('throttles same-stage report bursts to the latest aggregate', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useLocalModelLoading({ localViaDataStream: false, modelName: 'gemma' })
      );

      act(() => {
        result.current.handleLocalLoadingStateChange({
          stage: 'loading',
          progress: 10,
          message: 'Loading a.onnx',
          file: 'a.onnx',
        });
      });
      // First report of the stage applies immediately.
      expect(result.current.localLoadingState).toMatchObject({ progress: 10 });

      act(() => {
        result.current.handleLocalLoadingStateChange({
          stage: 'loading',
          progress: 50,
          message: 'Loading a.onnx',
          file: 'a.onnx',
        });
        result.current.handleLocalLoadingStateChange({
          stage: 'loading',
          progress: 90,
          message: 'Loading a.onnx',
          file: 'a.onnx',
        });
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
    const { result } = renderHook(() =>
      useLocalModelLoading({ localViaDataStream: false, modelName: 'gemma' })
    );

    act(() => {
      result.current.handleLocalLoadingStateChange({
        stage: 'loading',
        progress: 90,
        message: 'Loading model',
      });
    });
    act(() => {
      result.current.handleLocalLoadingStateChange({
        stage: 'ready',
        progress: 100,
        message: 'Model ready',
      });
    });
    act(() => {
      result.current.handleLocalLoadingStateChange({
        stage: 'loading',
        progress: 10,
        message: 'Loading model',
      });
    });

    expect(result.current.localLoadingState).toMatchObject({ stage: 'loading', progress: 10 });
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
          type: 'progress',
          requestId: 'main:abc',
          runtimeId: 'llm-host:runtime',
          payload: {
            kind: 'loading',
            progress: 37,
            message: 'Downloading model',
            file: 'model.onnx',
          },
        });
      });
      expect(result.current.localLoadingState).toMatchObject({
        stage: 'loading',
        progress: 37,
        file: 'model.onnx',
      });

      act(() => {
        progressListener?.({
          type: 'progress',
          requestId: 'main:warmup-complete',
          runtimeId: 'llm-host:runtime',
          payload: { kind: 'loading', progress: 100, message: 'Model loaded' },
        });
      });
      expect(result.current.localLoadingState).toMatchObject({ stage: 'ready', progress: 100 });

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
        type: 'progress',
        requestId: 'main:gen',
        runtimeId: 'llm-host:runtime',
        payload: { kind: 'text', text: 'partial answer' },
      });
    });
    expect(result.current.localLoadingState).toBeUndefined();

    unmount();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });
});
