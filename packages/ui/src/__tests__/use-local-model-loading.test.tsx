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
          message: 'Downloading model.onnx',
          progress: 60,
          stage: 'downloading',
        });
      });
      act(() => {
        // Per-file progress resets to 0 for each artifact; the badge must not
        // jump backwards (the "fast layout shift" jank).
        result.current.handleLocalLoadingStateChange({
          message: 'Downloading tokenizer.json',
          progress: 5,
          stage: 'downloading',
        });
        vi.advanceTimersByTime(300);
      });

      expect(result.current.localLoadingState).toMatchObject({
        message: 'Downloading tokenizer.json',
        progress: 60,
        stage: 'downloading',
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
          file: 'config.json',
          message: 'Loading config.json',
          progress: 100,
          stage: 'loading',
        });
        result.current.handleLocalLoadingStateChange({
          file: 'onnx/decoder_model_merged_q4f16.onnx_data',
          message: 'Loading onnx/decoder_model_merged_q4f16.onnx_data',
          progress: 20,
          stage: 'loading',
        });
        result.current.handleLocalLoadingStateChange({
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
      const { result } = renderHook(() =>
        useLocalModelLoading({ localViaDataStream: false, modelName: 'gemma' })
      );

      act(() => {
        result.current.handleLocalLoadingStateChange({
          file: 'a.onnx',
          message: 'Loading a.onnx',
          progress: 10,
          stage: 'loading',
        });
      });
      // First report of the stage applies immediately.
      expect(result.current.localLoadingState).toMatchObject({ progress: 10 });

      act(() => {
        result.current.handleLocalLoadingStateChange({
          file: 'a.onnx',
          message: 'Loading a.onnx',
          progress: 50,
          stage: 'loading',
        });
        result.current.handleLocalLoadingStateChange({
          file: 'a.onnx',
          message: 'Loading a.onnx',
          progress: 90,
          stage: 'loading',
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
        message: 'Loading model',
        progress: 90,
        stage: 'loading',
      });
    });
    act(() => {
      result.current.handleLocalLoadingStateChange({
        message: 'Model ready',
        progress: 100,
        stage: 'ready',
      });
    });
    act(() => {
      result.current.handleLocalLoadingStateChange({
        message: 'Loading model',
        progress: 10,
        stage: 'loading',
      });
    });

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
});
