/**
 * Local model loading-state management shared by both local chat transports:
 * the in-renderer local runtime (progress callbacks from the adapter) and the
 * data-stream transport (renderer-side warmup before the assistant server
 * streams the Mastra turn).
 *
 * Also subscribes to the desktop llm-host's broadcast loading progress so
 * MAIN-initiated model loads (e.g. the assistant server warming a cold local
 * memory model) surface in the same badge instead of a silent spinner.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { warmDesktopLocalModel } from './local-runtime-adapter';

// Local model loading state for progress display
export interface LocalModelLoadingState {
  file?: string;
  message: string;
  progress: number;
  stage: 'downloading' | 'generating' | 'loading' | 'ready' | 'error';
}

interface HostLoadingProgressReport {
  payload?: {
    file?: string;
    kind?: string;
    message?: string;
    progress?: number;
  };
  type?: string;
}

function getDesktopLlmHostProgressSubscription(): {
  onProgress?: (listener: (report: unknown) => void) => () => void;
} | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const hostWindow = window as Window & {
    llmHost?: { onProgress?: (listener: (report: unknown) => void) => () => void };
  };
  return hostWindow.llmHost ?? null;
}

function isLoadingProgressReport(report: unknown): report is HostLoadingProgressReport {
  if (report === null || typeof report !== 'object') {
    return false;
  }
  const candidate = report as HostLoadingProgressReport;
  return candidate.type === 'progress' && candidate.payload?.kind === 'loading';
}

export function useLocalModelLoading(args: {
  localViaDataStream: boolean;
  modelName: string | undefined;
}): {
  handleLocalLoadingStateChange: (state: LocalModelLoadingState) => void;
  localLoadingState: LocalModelLoadingState | undefined;
  prepareLocalModel: (() => Promise<void>) | undefined;
} {
  const { localViaDataStream, modelName } = args;
  const [localLoadingState, setLocalLoadingState] = useState<LocalModelLoadingState | undefined>();
  // Per-file artifact downloads each report 0→100, which made the badge jump
  // backwards constantly (visual jank). Within one loading session the shown
  // progress is monotonically non-decreasing; terminal stages reset the floor.
  const monotonicProgressRef = useRef(0);

  const handleLocalLoadingStateChange = useCallback((state: LocalModelLoadingState) => {
    if (state.stage === 'loading' || state.stage === 'downloading') {
      const progress = Math.max(monotonicProgressRef.current, state.progress);
      monotonicProgressRef.current = progress;
      setLocalLoadingState({ ...state, progress });
      return;
    }
    monotonicProgressRef.current = 0;
    setLocalLoadingState(state);
  }, []);

  useEffect(() => {
    if (localLoadingState?.stage !== 'ready') {
      return;
    }

    const timer = window.setTimeout(() => {
      setLocalLoadingState((current) => (current?.stage === 'ready' ? undefined : current));
    }, 1200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [localLoadingState]);

  // Surface llm-host loading progress regardless of who initiated the load:
  // main-process warmups (cold local memory models) have no renderer request
  // in flight, so this broadcast subscription is their only UI signal.
  useEffect(() => {
    const llmHost = getDesktopLlmHostProgressSubscription();
    if (!llmHost?.onProgress) {
      return;
    }
    const unsubscribe = llmHost.onProgress((report) => {
      if (!isLoadingProgressReport(report)) {
        return;
      }
      const payload = report.payload ?? {};
      const progress = typeof payload.progress === 'number' ? payload.progress : 0;
      if (progress >= 100) {
        handleLocalLoadingStateChange({
          stage: 'ready',
          progress: 100,
          message: payload.message ?? 'Model ready',
        });
        return;
      }
      handleLocalLoadingStateChange({
        stage: 'loading',
        progress,
        message: payload.message ?? 'Loading local model',
        ...(payload.file ? { file: payload.file } : {}),
      });
    });
    return unsubscribe;
  }, [handleLocalLoadingStateChange]);

  // Pre-request warmup for local-over-data-stream: surfaces model download /
  // load progress in the renderer before the assistant server starts the
  // Mastra stream (the server also warms as a safety net).
  const prepareLocalModel = useMemo(() => {
    if (!(localViaDataStream && modelName)) {
      return;
    }
    return async () => {
      try {
        await warmDesktopLocalModel({
          modelId: modelName,
          onLoadingProgress: handleLocalLoadingStateChange,
        });
        handleLocalLoadingStateChange({ stage: 'ready', progress: 100, message: 'Model ready' });
      } catch (error) {
        handleLocalLoadingStateChange({
          stage: 'error',
          progress: 0,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
  }, [handleLocalLoadingStateChange, localViaDataStream, modelName]);

  return { handleLocalLoadingStateChange, localLoadingState, prepareLocalModel };
}
