/**
 * Local model loading-state management for the built-in local provider, which
 * always runs over the data-stream transport: the renderer warms the hidden
 * llm-host before the assistant server streams the Mastra turn.
 *
 * Also subscribes to the desktop llm-host's broadcast loading progress so
 * MAIN-initiated model loads (e.g. the assistant server warming a cold local
 * memory model) surface in the same badge instead of a silent spinner.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { warmDesktopLocalModel } from './local-runtime-desktop-host';

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

// Apply at most one badge update per window during a same-stage report burst.
// Transformers.js loads many artifacts in parallel and its interleaved
// per-file callbacks arrive in rapid bursts — rendering each one flashed the
// badge between unrelated file names ("seizure inducing").
const PROGRESS_THROTTLE_MS = 250;

/**
 * Fold a per-file progress report into the session's file map and derive ONE
 * stable view: mean progress across every file seen, a "(completed/total)"
 * message, and the laggard file as the label (the file users are actually
 * waiting on — never whichever file happened to report last).
 */
function aggregateFileProgress(
  fileProgress: Map<string, number>,
  state: LocalModelLoadingState & { file: string }
): LocalModelLoadingState {
  fileProgress.set(state.file, Math.max(fileProgress.get(state.file) ?? 0, state.progress));
  let total = 0;
  let completed = 0;
  let laggardFile: string | undefined;
  let laggardProgress = Number.POSITIVE_INFINITY;
  for (const [file, progress] of fileProgress) {
    total += progress;
    if (progress >= 100) {
      completed += 1;
    } else if (progress < laggardProgress) {
      laggardProgress = progress;
      laggardFile = file;
    }
  }
  const verb = state.stage === 'downloading' ? 'Downloading' : 'Loading';
  return {
    message: `${verb} model files (${completed}/${fileProgress.size})`,
    progress: Math.round(total / fileProgress.size),
    stage: state.stage,
    ...(laggardFile ? { file: laggardFile } : {}),
  };
}

export function useLocalModelLoading(args: {
  localViaDataStream: boolean;
  modelName: string | undefined;
}): {
  localLoadingState: LocalModelLoadingState | undefined;
  prepareLocalModel: ((abortSignal?: AbortSignal) => Promise<void>) | undefined;
} {
  const { localViaDataStream, modelName } = args;
  const [localLoadingState, setLocalLoadingState] = useState<LocalModelLoadingState | undefined>();
  // Unkeyed reports (no file field) each run 0→100 per artifact, which made
  // the badge jump backwards constantly. Within one loading session the shown
  // progress is monotonically non-decreasing; terminal stages reset the floor.
  // (File-keyed reports use the mean aggregate instead — clamping THAT would
  // pin the percent at 100 as soon as any small file completed.)
  const monotonicProgressRef = useRef(0);
  const fileProgressRef = useRef(new Map<string, number>());
  const lastAppliedStageRef = useRef<LocalModelLoadingState['stage'] | undefined>(undefined);
  const lastAppliedAtRef = useRef(0);
  const pendingStateRef = useRef<LocalModelLoadingState | null>(null);
  const throttleTimerRef = useRef<number | null>(null);

  const applyLoadingState = useCallback((state: LocalModelLoadingState) => {
    lastAppliedAtRef.current = Date.now();
    lastAppliedStageRef.current = state.stage;
    setLocalLoadingState(state);
  }, []);

  const clearThrottle = useCallback(() => {
    if (throttleTimerRef.current !== null) {
      window.clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = null;
    }
    pendingStateRef.current = null;
  }, []);

  useEffect(() => clearThrottle, [clearThrottle]);

  const handleLocalLoadingStateChange = useCallback(
    (state: LocalModelLoadingState) => {
      if (!(state.stage === 'loading' || state.stage === 'downloading')) {
        // Terminal stages end the smoothing session and always render now.
        monotonicProgressRef.current = 0;
        fileProgressRef.current.clear();
        clearThrottle();
        applyLoadingState(state);
        return;
      }

      let smoothed: LocalModelLoadingState;
      if (state.file) {
        smoothed = aggregateFileProgress(
          fileProgressRef.current,
          state as LocalModelLoadingState & { file: string }
        );
      } else {
        const progress = Math.max(monotonicProgressRef.current, state.progress);
        monotonicProgressRef.current = progress;
        smoothed = { ...state, progress };
      }

      const stageChanged = lastAppliedStageRef.current !== state.stage;
      const elapsed = Date.now() - lastAppliedAtRef.current;
      if (stageChanged || elapsed >= PROGRESS_THROTTLE_MS) {
        clearThrottle();
        applyLoadingState(smoothed);
        return;
      }
      pendingStateRef.current = smoothed;
      if (throttleTimerRef.current === null) {
        throttleTimerRef.current = window.setTimeout(() => {
          throttleTimerRef.current = null;
          const pending = pendingStateRef.current;
          pendingStateRef.current = null;
          if (pending) {
            applyLoadingState(pending);
          }
        }, PROGRESS_THROTTLE_MS - elapsed);
      }
    },
    [applyLoadingState, clearThrottle]
  );

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
          message: payload.message ?? 'Model ready',
          progress: 100,
          stage: 'ready',
        });
        return;
      }
      handleLocalLoadingStateChange({
        message: payload.message ?? 'Loading local model',
        progress,
        stage: 'loading',
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
    return async (abortSignal?: AbortSignal) => {
      try {
        await warmDesktopLocalModel({
          modelId: modelName,
          onLoadingProgress: handleLocalLoadingStateChange,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        handleLocalLoadingStateChange({ message: 'Model ready', progress: 100, stage: 'ready' });
      } catch (error) {
        if (abortSignal?.aborted) {
          throw error;
        }
        handleLocalLoadingStateChange({
          message: error instanceof Error ? error.message : String(error),
          progress: 0,
          stage: 'error',
        });
        throw error;
      }
    };
  }, [handleLocalLoadingStateChange, localViaDataStream, modelName]);

  return { localLoadingState, prepareLocalModel };
}
