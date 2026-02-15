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
    postMessage,
    addEventListener,
  } as unknown as typeof self);

  await import('../worker-storage.worker');

  if (!messageHandler) {
    throw new Error('Worker message handler was not registered');
  }

  return { postMessage, messageHandler };
}

describe('worker-storage.worker', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('handles save/load/remove operations and serializes non-string values', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123_456);
    const { postMessage, messageHandler } = await loadWorkerHarness();

    await messageHandler({
      data: { id: 'save-1', type: 'save', key: 'settings', value: { a: 1 } },
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'save-1',
        type: 'storage_request',
        operation: 'setItem',
        key: 'settings',
        value: JSON.stringify({ a: 1 }),
        opId: 123_456,
      })
    );

    await messageHandler({
      data: { id: 'save-2', type: 'save', key: 'settings', value: 'already-serialized' },
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'save-2',
        operation: 'setItem',
        value: 'already-serialized',
      })
    );

    await messageHandler({ data: { id: 'load-1', type: 'load', key: 'settings' } });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'load-1',
        type: 'storage_request',
        operation: 'getItem',
        key: 'settings',
      })
    );

    await messageHandler({ data: { id: 'remove-1', type: 'remove', key: 'settings' } });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'remove-1',
        type: 'storage_request',
        operation: 'removeItem',
        key: 'settings',
      })
    );

    nowSpy.mockRestore();
  });

  it('handles storage responses and parses getItem payloads', async () => {
    const { postMessage, messageHandler } = await loadWorkerHarness();

    await messageHandler({
      data: {
        id: 'resp-1',
        type: 'storage_response',
        operation: 'getItem',
        rawValue: JSON.stringify({ nested: true }),
      },
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      id: 'resp-1',
      type: 'success',
      result: { nested: true },
    });

    await messageHandler({
      data: {
        id: 'resp-2',
        type: 'storage_response',
        operation: 'getItem',
        rawValue: 'not-json',
      },
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      id: 'resp-2',
      type: 'success',
      result: null,
    });

    await messageHandler({
      data: {
        id: 'resp-3',
        type: 'storage_response',
        operation: 'setItem',
      },
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      id: 'resp-3',
      type: 'success',
      result: true,
    });
  });

  it('returns error responses for invalid payloads and unknown operations', async () => {
    const { postMessage, messageHandler } = await loadWorkerHarness();

    await messageHandler({ data: { id: 'err-save', type: 'save', key: 'missing-value' } });
    expect(postMessage).toHaveBeenLastCalledWith({
      id: 'err-save',
      type: 'error',
      error: 'Save operation requires key and value',
    });

    await messageHandler({ data: { id: 'err-load', type: 'load' } });
    expect(postMessage).toHaveBeenLastCalledWith({
      id: 'err-load',
      type: 'error',
      error: 'Load operation requires key',
    });

    await messageHandler({ data: { id: 'err-remove', type: 'remove' } });
    expect(postMessage).toHaveBeenLastCalledWith({
      id: 'err-remove',
      type: 'error',
      error: 'Remove operation requires key',
    });

    await messageHandler({ data: { id: 'err-unknown', type: 'unsupported' } });
    expect(postMessage).toHaveBeenLastCalledWith({
      id: 'err-unknown',
      type: 'error',
      error: 'Unknown operation type: unsupported',
    });
  });
});
