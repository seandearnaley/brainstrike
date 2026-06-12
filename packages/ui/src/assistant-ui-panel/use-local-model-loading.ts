/**
 * Local model loading-state management shared by both local chat transports:
 * the in-renderer local runtime (progress callbacks from the adapter) and the
 * data-stream transport (renderer-side warmup before the assistant server
 * streams the Mastra turn).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { warmDesktopLocalModel } from './local-runtime-adapter';

// Local model loading state for progress display
export interface LocalModelLoadingState {
  file?: string;
  message: string;
  progress: number;
  stage: 'downloading' | 'generating' | 'loading' | 'ready' | 'error';
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

  const handleLocalLoadingStateChange = useCallback((state: LocalModelLoadingState) => {
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
        setLocalLoadingState({ stage: 'ready', progress: 100, message: 'Model ready' });
      } catch (error) {
        setLocalLoadingState({
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
