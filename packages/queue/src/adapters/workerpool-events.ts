import {
  EMBEDDING_DEVICE_LOST_CODE,
  EmbeddingDeviceLostError,
  embedWorkerFailure,
  isEmbedWorkerErrorCode,
} from '@brainstrike/indexing-contract';
import type { QueueErrorEvent, QueueProgressEvent } from '../types.js';

export type WorkerEvent = QueueProgressEvent | QueueErrorEvent;

export function readWorkerEvent(value: unknown): WorkerEvent | null {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const typeValue = record['type'];
  if (typeValue === 'progress') {
    if (
      !(typeof record['id'] === 'string' && record['id'].length > 0) ||
      (record['phase'] !== 'initializing' &&
        record['phase'] !== 'embedding' &&
        record['phase'] !== 'complete') ||
      !(
        typeof record['progress'] === 'number' &&
        Number.isFinite(record['progress']) &&
        record['progress'] >= 0 &&
        record['progress'] <= 1
      )
    ) {
      throw new Error('Embedding worker request progress event is malformed.');
    }
    return value as QueueProgressEvent;
  }
  if (typeValue === 'error') {
    if (
      !(
        typeof record['id'] === 'string' &&
        record['id'].length > 0 &&
        typeof record['message'] === 'string' &&
        record['message'].length > 0 &&
        (record['cause'] === undefined || typeof record['cause'] === 'string') &&
        (record['code'] === undefined || isEmbedWorkerErrorCode(record['code']))
      )
    ) {
      throw new Error('Embedding worker request error event is malformed.');
    }
    return value as QueueErrorEvent;
  }
  return null;
}

export function assertCurrentTaskWorkerEvent(workerEvent: WorkerEvent, taskId: string): void {
  if (workerEvent.id !== taskId) {
    throw new Error('Embedding worker request event id must match the current task id.');
  }
}

export function readDeviceLoss(workerEvent: WorkerEvent): EmbeddingDeviceLostError | null {
  if (workerEvent.type !== 'error' || workerEvent.code !== EMBEDDING_DEVICE_LOST_CODE) {
    return null;
  }
  return new EmbeddingDeviceLostError(workerEvent.cause ?? workerEvent.message);
}

export function throwIfWorkerError(workerEvent: WorkerEvent): void {
  if (workerEvent.type === 'error') {
    // A typed device failure keeps its code, so the host can refuse it with its
    // remedy instead of reporting an internal fault (BST-2058).
    throw embedWorkerFailure(workerEvent);
  }
}
