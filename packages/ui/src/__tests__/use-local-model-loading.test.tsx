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
    });

    expect(result.current.localLoadingState).toMatchObject({
      stage: 'downloading',
      progress: 60,
      message: 'Downloading tokenizer.json',
    });
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
