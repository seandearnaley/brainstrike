import { createLogger } from '@brainstrike/logging';
import { serializeRuntimeError } from '@brainstrike/worker-runtime';
import type { MutableRefObject } from 'react';
import {
  assertEmbeddingHostCommand,
  type EmbeddingHostDocumentEmbeddingsResponseReport,
  type EmbeddingHostQueryEmbeddingResponseReport,
} from '../../embedding-host-shared';

const logger = createLogger('EmbeddingHostRuntime');

/** A disposed Effect still records failures, but cannot publish over its replacement. */
export function createEmbeddingHostLifecycleFailureHandler(
  runtimeIdRef: MutableRefObject<string>,
  isDisposed: () => boolean,
  reportError: (message: string) => void
): (label: string, error: unknown) => void {
  return (label, error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(label, { error: message, runtimeId: runtimeIdRef.current });
    if (!isDisposed()) {
      reportError(message);
    }
  };
}

export function runEmbeddingHostCleanupStep(
  runtimeIdRef: MutableRefObject<string>,
  label:
    | 'Embedding host command cleanup failed'
    | 'Embedding host query embedding cleanup failed'
    | 'Embedding host power cleanup failed'
    | 'Embedding host telemetry cleanup failed',
  cleanup: () => void
): void {
  try {
    cleanup();
  } catch (error) {
    logger.error(label, {
      error: error instanceof Error ? error.message : String(error),
      runtimeId: runtimeIdRef.current,
    });
  }
}

function getEnvelopeStringField(value: unknown, field: 'requestId' | 'runtimeId'): string | null {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : null;
}

export function createQueryEmbeddingRequestParseErrorReport(
  rawRequest: unknown,
  error: unknown
): EmbeddingHostQueryEmbeddingResponseReport | null {
  const requestId = getEnvelopeStringField(rawRequest, 'requestId');
  const runtimeId = getEnvelopeStringField(rawRequest, 'runtimeId');
  if (!(requestId && runtimeId)) {
    return null;
  }
  return {
    channel: 'query-embedding-error',
    payload: {
      message:
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : 'Invalid embedding host query embedding request.',
      name: error instanceof Error && error.name.trim().length > 0 ? error.name : 'Error',
      ...(error instanceof Error && typeof error.stack === 'string' ? { stack: error.stack } : {}),
    },
    requestId,
    runtimeId,
    type: 'error',
  };
}

/** Commands belong to the renderer, not to its replaceable database worker Effect. */
export function createEmbeddingHostCommandHandler(owner: {
  getRuntimeId(): string;
  isDisposed(): boolean;
  stop(): Promise<void>;
  reset(nextRuntimeId: string): Promise<void>;
  report(
    runtimeId: string,
    state: 'stopped' | 'error',
    commandId: string,
    lastError?: string
  ): void;
}): (command: unknown) => void {
  return (command) => {
    const next = assertEmbeddingHostCommand(command);
    if (next.runtimeId !== owner.getRuntimeId()) {
      logger.warn('Ignored embedding host command for stale runtime', {
        action: next.payload.action,
        commandRuntimeId: next.runtimeId,
        runtimeId: owner.getRuntimeId(),
      });
      return;
    }
    if (next.payload.action === 'reset' && next.payload.nextRuntimeId === owner.getRuntimeId()) {
      throw new Error('Embedding host reset requires a fresh nextRuntimeId.');
    }
    const pending =
      next.payload.action === 'stop' ? owner.stop() : owner.reset(next.payload.nextRuntimeId);
    void pending.then(
      () => {
        if (next.payload.action === 'stop' && !owner.isDisposed()) {
          owner.report(next.runtimeId, 'stopped', next.requestId);
        }
      },
      (error: unknown) => {
        logger.error(`Embedding host ${next.payload.action} failed`, {
          error,
          requestId: next.requestId,
        });
        if (!owner.isDisposed()) {
          owner.report(
            owner.getRuntimeId(),
            'error',
            next.requestId,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    );
  };
}

export function createDocumentEmbeddingsRequestParseErrorReport(
  rawRequest: unknown,
  error: unknown
): EmbeddingHostDocumentEmbeddingsResponseReport | null {
  const requestId = getEnvelopeStringField(rawRequest, 'requestId');
  const runtimeId = getEnvelopeStringField(rawRequest, 'runtimeId');
  if (!(requestId && runtimeId)) {
    return null;
  }
  return {
    channel: 'document-embeddings-error',
    payload: serializeRuntimeError(error),
    requestId,
    runtimeId,
    type: 'error',
  };
}
