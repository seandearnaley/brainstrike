import { createLogger } from '../logger';

export interface RendererErrorEventPayload {
  type: 'error' | 'unhandledrejection';
  message: string;
  stack?: string;
  source?: string;
  line?: number;
  column?: number;
  reason?: unknown;
}

export interface RendererErrorHooksOptions {
  scope?: string;
  onError?: (payload: RendererErrorEventPayload) => void;
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
      type: 'error',
      message: event.message,
      source: event.filename,
      ...(event.error instanceof Error && event.error.stack ? { stack: event.error.stack } : {}),
      ...(typeof event.lineno === 'number' ? { line: event.lineno } : {}),
      ...(typeof event.colno === 'number' ? { column: event.colno } : {}),
    };
    logger.error('Unhandled renderer error', payload);
    options.onError?.(payload);
  };

  const handleRejection = (event: PromiseRejectionEvent) => {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/a67c7242-fa95-40d2-befe-f4f7a66bce86', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'b4e51e' },
      body: JSON.stringify({
        sessionId: 'b4e51e',
        location: 'install-renderer-error-hooks.ts:51',
        message: 'Promise rejection caught',
        data: { reason: event.reason ? String(event.reason) : 'unknown' },
        hypothesisId: 'H3,H5',
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    const reason = event.reason;
    const payload: RendererErrorEventPayload = {
      type: 'unhandledrejection',
      message:
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : 'Unhandled promise rejection',
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
