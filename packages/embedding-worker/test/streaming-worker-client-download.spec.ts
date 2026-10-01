import { describe, expect, it, vi } from 'vitest';
import { StreamingEmbeddingWorkerClient } from '../src/streaming-worker-client';

class TestWorker {
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void {
    if (type === 'message') {
      this.listeners.add(listener);
    }
  }
  removeEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void {
    if (type === 'message') {
      this.listeners.delete(listener);
    }
  }
  emit(data: unknown): void {
    for (const listener of this.listeners) {
      listener({ data } as MessageEvent<unknown>);
    }
  }
}

describe('download worker transport', () => {
  it('correlates progress and completion and releases request listeners', async () => {
    const worker = new TestWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const onProgress = vi.fn();
    const download = client.download({ id: 'a', model: 'model-a' }, { onProgress });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    worker.emit({ id: 'other', type: 'download-complete' });
    worker.emit({ id: 'a', progress: 23, type: 'download-progress' });
    expect(onProgress).toHaveBeenCalledWith(23);
    worker.emit({ id: 'a', type: 'download-complete' });
    await download;
    client.terminate();
    expect(worker.listeners.size).toBe(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('aborts active and queued downloads through actual owned Worker termination', async () => {
    const worker = new TestWorker();
    const client = new StreamingEmbeddingWorkerClient(worker as unknown as Worker);
    const controller = new AbortController();
    const active = client.download({ id: 'a', model: 'model-a' }, { signal: controller.signal });
    const queued = client.download({ id: 'b', model: 'model-b' });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    const rejected = Promise.allSettled([active, queued]);
    controller.abort(new DOMException('Stop', 'AbortError'));
    expect(await rejected).toEqual([
      { reason: controller.signal.reason, status: 'rejected' },
      { reason: controller.signal.reason, status: 'rejected' },
    ]);
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.listeners.size).toBe(0);
  });
});
