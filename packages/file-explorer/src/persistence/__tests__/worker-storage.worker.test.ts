import { beforeEach, describe, expect, it, vi } from 'vitest';

type WorkerMessageHandler = (event: { data: Record<string, unknown> }) => void | Promise<void>;

async function loadWorkerHarness() {
  vi.resetModules();

  let messageHandler: WorkerMessageHandler | undefined;
  const postMessage = vi.fn();
  const addEventListener = vi.fn((type: string, handler: WorkerMessageHandler) => {
    if (type === 'message') {
      messageHandler = handler;
    }
  });

  vi.stubGlobal('self', {
    addEventListener,
    postMessage,
  } as unknown as typeof self);

  await import('../worker-storage.worker');

  if (!messageHandler) {
    throw new Error('Worker message handler was not registered');
  }

  return { messageHandler, postMessage };
}

describe('worker-storage.worker', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('handles save/load/remove operations and serializes non-string values', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123_456);
    const { postMessage, messageHandler } = await loadWorkerHarness();

    await messageHandler({
      data: { id: 'save-1', key: 'settings', type: 'save', value: { a: 1 } },
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'save-1',
        key: 'settings',
        operation: 'setItem',
        opId: 123_456,
        type: 'storage_request',
        value: JSON.stringify({ a: 1 }),
      })
    );

    await messageHandler({
      data: { id: 'save-2', key: 'settings', type: 'save', value: 'already-serialized' },
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'save-2',
        operation: 'setItem',
        value: 'already-serialized',
      })
    );

    await messageHandler({ data: { id: 'load-1', key: 'settings', type: 'load' } });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'load-1',
        key: 'settings',
        operation: 'getItem',
        type: 'storage_request',
      })
    );

    await messageHandler({ data: { id: 'remove-1', key: 'settings', type: 'remove' } });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'remove-1',
        key: 'settings',
        operation: 'removeItem',
        type: 'storage_request',
      })
    );

    nowSpy.mockRestore();
  });

  it('handles storage responses and parses getItem payloads', async () => {
    const { postMessage, messageHandler } = await loadWorkerHarness();

    await messageHandler({
      data: {
        id: 'resp-1',
        operation: 'getItem',
        rawValue: JSON.stringify({ nested: true }),
        type: 'storage_response',
      },
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      id: 'resp-1',
      result: { nested: true },
      type: 'success',
    });

    await messageHandler({
      data: {
        id: 'resp-2',
        operation: 'getItem',
        rawValue: 'not-json',
        type: 'storage_response',
      },
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      error: 'Persisted state contains invalid JSON',
      id: 'resp-2',
      type: 'error',
    });

    await messageHandler({
      data: {
        id: 'resp-3',
        operation: 'setItem',
        type: 'storage_response',
      },
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      id: 'resp-3',
      result: true,
      type: 'success',
    });
  });

  it('returns error responses for invalid payloads and unknown operations', async () => {
    const { postMessage, messageHandler } = await loadWorkerHarness();

    await messageHandler({ data: { id: 'err-save', key: 'missing-value', type: 'save' } });
    expect(postMessage).toHaveBeenLastCalledWith({
      error: 'Save operation requires key and value',
      id: 'err-save',
      type: 'error',
    });

    await messageHandler({ data: { id: 'err-load', type: 'load' } });
    expect(postMessage).toHaveBeenLastCalledWith({
      error: 'Load operation requires key',
      id: 'err-load',
      type: 'error',
    });

    await messageHandler({ data: { id: 'err-remove', type: 'remove' } });
    expect(postMessage).toHaveBeenLastCalledWith({
      error: 'Remove operation requires key',
      id: 'err-remove',
      type: 'error',
    });

    await messageHandler({ data: { id: 'err-unknown', type: 'unsupported' } });
    expect(postMessage).toHaveBeenLastCalledWith({
      error: 'Unknown operation type: unsupported',
      id: 'err-unknown',
      type: 'error',
    });
  });
});
