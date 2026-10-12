import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDarwinManager,
  hostedEmbeddingMock,
  lifecycleState,
} from './embedding-host-manager-fixture';

describe('owned hosted native queries', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    lifecycleState.getHostWindow.mockReturnValue(null);
  });
  it.each(['openai', 'google', 'cohere', 'voyage', 'ollama', 'lmstudio'])(
    'routes %s through the selected hosted model without starting local inference',
    async (provider) => {
      const vector = new Array<number>(768).fill(1);
      hostedEmbeddingMock.mockResolvedValueOnce([vector]);
      const manager = createDarwinManager();
      expect(
        await manager.queryEmbedding({
          dimensions: 768,
          modelId: 'saved-model',
          modelKey: `${provider}::saved-model`,
          query: 'find code',
        })
      ).toEqual(vector);
      expect(hostedEmbeddingMock).toHaveBeenCalledWith({
        dimensions: 768,
        modelId: 'saved-model',
        provider,
        purpose: 'query',
        signal: expect.any(AbortSignal),
        texts: ['find code'],
      });
      expect(lifecycleState.ensureStarted).not.toHaveBeenCalled();
      await manager.dispose();
    }
  );
  it('joins physical hosted settlement before stop completes and prevents readmission during retirement', async () => {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    hostedEmbeddingMock
      .mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
        entered();
        await held;
        signal.throwIfAborted();
        return [new Array<number>(768).fill(1)];
      })
      .mockResolvedValueOnce([new Array<number>(768).fill(2)]);
    const manager = createDarwinManager();
    const payload = {
      dimensions: 768,
      modelId: 'saved-model',
      modelKey: 'ollama::saved-model',
      query: 'find code',
    };
    const query = manager.queryEmbedding(payload);
    const rejected = expect(query).rejects.toMatchObject({ name: 'AbortError' });
    await enteredPromise;
    let stopped = false;
    const stopping = manager.stop().then(() => {
      stopped = true;
    });
    const next = manager.queryEmbedding(payload);
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(hostedEmbeddingMock).toHaveBeenCalledTimes(1);
    release();
    await rejected;
    await stopping;
    expect(await next).toEqual(new Array<number>(768).fill(2));
    await manager.dispose();
  });
  it('preserves independent provider failure during stop', async () => {
    let reject!: (error: Error) => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    hostedEmbeddingMock.mockImplementationOnce(() => {
      entered();
      return new Promise<number[][]>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      });
    });
    const manager = createDarwinManager();
    const query = manager.queryEmbedding({
      dimensions: 768,
      modelId: 'saved-model',
      modelKey: 'ollama::saved-model',
      query: 'find code',
    });
    const failure = new Error('Independent provider failure');
    const rejectedQuery = expect(query).rejects.toBe(failure);
    await enteredPromise;
    const stop = manager.stop();
    const rejectedStop = expect(stop).rejects.toMatchObject({ errors: [failure] });
    reject(failure);
    await rejectedQuery;
    await rejectedStop;
    await manager.dispose();
  });
});
