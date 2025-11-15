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
