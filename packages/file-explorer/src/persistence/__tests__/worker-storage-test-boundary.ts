import { type Mock, vi } from 'vitest';
import type { StorageRequest, WorkerStorage } from '../worker-storage';

/** An adapter request must originate from a live public worker operation. */
export async function exchangeStorageRequest(
  storage: WorkerStorage,
  worker: { postMessage: Mock; emitMessage(data: unknown): void },
  request: Omit<StorageRequest, 'id' | 'type'>
): Promise<unknown> {
  vi.useFakeTimers();
  let id: string | undefined;
  worker.postMessage.mockImplementation(
    (message: { id: string; type: string; rawValue?: string }) => {
      if (message.type === 'storage_response') {
        worker.emitMessage({ id: message.id, result: message.rawValue, type: 'success' });
        return;
      }
      id = message.id;
    }
  );
  const operation =
    request.operation === 'setItem'
      ? storage.setItem(request.key, request.value)
      : request.operation === 'getItem'
        ? storage.getItem(request.key)
        : storage.removeItem(request.key);
  const outcome = operation.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(request.operation === 'setItem' ? 100 : 0);
  if (!id) {
    throw new Error('Public worker request was not sent');
  }
  worker.emitMessage({ ...request, id, type: 'storage_request' });
  await vi.advanceTimersByTimeAsync(0);
  return await outcome;
}
