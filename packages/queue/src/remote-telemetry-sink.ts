import { createLogger } from '@brainstrike/utils';
import { addQueueTelemetryListener, type QueueTelemetryEvent } from './telemetry';

const logger = createLogger('EmbeddingQueueTelemetrySink');

export type QueueTelemetryRuntime = 'browser' | 'electron-renderer' | 'electron-main';

export interface QueueTelemetrySinkOptions {
  readonly apiKey?: string;
  readonly enableInTest?: boolean;
  readonly endpoint: string;
  readonly flushIntervalMs?: number;
  readonly headers?: Record<string, string>;
  readonly maxBatchSize?: number;
  /**
   * Maximum consecutive failures before disabling the sink.
   * After this many failures in a row, the sink stops attempting to send.
   * Defaults to 3.
   */
  readonly maxConsecutiveFailures?: number;
  readonly metadata?: Record<string, unknown>;
  readonly runtime?: QueueTelemetryRuntime;
  readonly useSendBeacon?: boolean;
}

export interface QueueTelemetrySink {
  dispose(): Promise<void>;
  flush(): Promise<void>;
}

function resolveDefaultRuntime(): QueueTelemetryRuntime {
  if (typeof window === 'undefined') {
    return 'electron-main';
  }
  if ((window as { electronAPI?: unknown }).electronAPI) {
    return 'electron-renderer';
  }
  return 'browser';
}

function resolveIsTest(): boolean {
  try {
    const env = (
      globalThis as {
        process?: { env?: Record<string, string | undefined> };
      }
    ).process?.env?.['NODE_ENV'];
    return env === 'test';
  } catch {
    return false;
  }
}

function trySendWithBeacon(
  endpoint: string,
  body: string,
  useBeacon: boolean | undefined
): boolean {
  if (
    useBeacon !== false &&
    typeof navigator !== 'undefined' &&
    typeof navigator.sendBeacon === 'function'
  ) {
    try {
      const blob = new Blob([body], { type: 'application/json' });
      const dispatched = navigator.sendBeacon(endpoint, blob);
      if (dispatched) {
        return true;
      }
    } catch (error) {
      logger.warn('Failed to send queue telemetry via Beacon; falling back to fetch', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return false;
}

function createRequestInit(
  body: string,
  headers: Record<string, string>,
  controller: AbortController | undefined
): RequestInit {
  return {
    method: 'POST',
    headers,
    body,
    keepalive: true,
    ...(controller
      ? {
          signal: controller.signal,
        }
      : {}),
  };
}

async function sendPayload(
  endpoint: string,
  body: string,
  headers: Record<string, string>,
  useBeacon: boolean | undefined
): Promise<void> {
  if (trySendWithBeacon(endpoint, body, useBeacon)) {
    return;
  }

  if (typeof fetch !== 'function') {
    throw new Error('Queue telemetry sink requires fetch support');
  }

  const controller = typeof AbortController === 'undefined' ? undefined : new AbortController();
  const timeoutId =
    controller === undefined
      ? null
      : setTimeout(() => {
          controller.abort();
        }, 10_000);

  try {
    const response = await fetch(endpoint, createRequestInit(body, headers, controller));
    if (!response.ok) {
      throw new Error(`Unexpected response: ${response.status}`);
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function initializeQueueTelemetrySink(
  options: QueueTelemetrySinkOptions
): QueueTelemetrySink | null {
  const {
    endpoint,
    apiKey,
    headers: customHeaders,
    runtime = resolveDefaultRuntime(),
    metadata,
    flushIntervalMs = 5000,
    maxBatchSize = 20,
    useSendBeacon,
    enableInTest = false,
    maxConsecutiveFailures = 3,
  } = options;

  if (!endpoint) {
    logger.warn('Queue telemetry sink disabled: endpoint not provided');
    return null;
  }

  if (resolveIsTest() && !enableInTest) {
    logger.debug('Queue telemetry sink disabled in test environment');
    return null;
  }

  if (
    typeof fetch !== 'function' &&
    (useSendBeacon === false || typeof navigator === 'undefined')
  ) {
    logger.warn('Queue telemetry sink disabled: fetch not available');
    return null;
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
    ...(customHeaders ?? {}),
  };

  const events: QueueTelemetryEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  // Track consecutive failures to disable sink after too many in a row
  const failureState = { consecutiveFailures: 0, disabled: false };
  const unsubscribe = addQueueTelemetryListener((event) => {
    // Drop events if sink is disabled due to repeated failures
    if (failureState.disabled) {
      return;
    }
    events.push(event);
    if (events.length >= maxBatchSize) {
      void flush();
      return;
    }
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, flushIntervalMs);
    }
  });

  const handleFlushError = (error: unknown, payloadEvents: QueueTelemetryEvent[]): void => {
    failureState.consecutiveFailures += 1;
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (failureState.consecutiveFailures >= maxConsecutiveFailures) {
      failureState.disabled = true;
      logger.warn(
        'Queue telemetry sink disabled after repeated failures - endpoint may be unreachable',
        {
          error: errorMessage,
          consecutiveFailures: failureState.consecutiveFailures,
          droppedEvents: payloadEvents.length,
        }
      );
      return;
    }

    logger.debug('Queue telemetry sink failed to send payload, will retry', {
      error: errorMessage,
      eventCount: payloadEvents.length,
      consecutiveFailures: failureState.consecutiveFailures,
    });
    events.unshift(...payloadEvents);
  };

  const flush = async () => {
    if (flushing || failureState.disabled || events.length === 0) {
      return;
    }
    flushing = true;
    const payloadEvents = events.splice(0, events.length);
    const body = JSON.stringify({
      runtime,
      sentAt: new Date().toISOString(),
      events: payloadEvents,
      metadata,
    });

    try {
      await sendPayload(endpoint, body, headers, useSendBeacon);
      failureState.consecutiveFailures = 0;
    } catch (error) {
      handleFlushError(error, payloadEvents);
    } finally {
      flushing = false;
    }
  };

  const dispose = async () => {
    unsubscribe();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await flush();
  };

  return {
    flush,
    dispose,
  };
}
