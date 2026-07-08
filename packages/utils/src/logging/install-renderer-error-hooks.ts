import { createLogger } from '@brainstrike/utils/logger';

export interface RendererErrorEventPayload {
  column?: number;
  line?: number;
  message: string;
  reason?: unknown;
  source?: string;
  stack?: string;
  type: 'error' | 'unhandledrejection';
}

export interface RendererErrorHooksOptions {
  onError?: (payload: RendererErrorEventPayload) => void;
  scope?: string;
}

/**
 * Installs global window error hooks that forward unhandled errors/rejections to the logger.
 * Returns a cleanup function for HMR/teardown scenarios.
 */
export function installRendererErrorHooks(options: RendererErrorHooksOptions = {}): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const logger = createLogger(options.scope ?? 'Renderer');

  const handleError = (event: ErrorEvent) => {
    // ResizeObserver loop errors are benign browser quirks that occur when resize
    // observations can't complete in a single animation frame. They don't indicate
    // real problems and shouldn't be logged as errors.
    // See: https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver#observation_errors
    if (event.message?.includes('ResizeObserver loop')) {
      return;
    }

    const payload: RendererErrorEventPayload = {
      message: event.message,
      source: event.filename,
      type: 'error',
      ...(event.error instanceof Error && event.error.stack ? { stack: event.error.stack } : {}),
      ...(typeof event.lineno === 'number' ? { line: event.lineno } : {}),
      ...(typeof event.colno === 'number' ? { column: event.colno } : {}),
    };
    logger.error('Unhandled renderer error', payload);
    options.onError?.(payload);
  };

  const handleRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const payload: RendererErrorEventPayload = {
      message:
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : 'Unhandled promise rejection',
      type: 'unhandledrejection',
      ...(reason instanceof Error && reason.stack ? { stack: reason.stack } : {}),
      reason,
    };
    logger.error('Unhandled renderer promise rejection', payload);
    options.onError?.(payload);
  };

  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleRejection);

  return () => {
    window.removeEventListener('error', handleError);
    window.removeEventListener('unhandledrejection', handleRejection);
  };
}
