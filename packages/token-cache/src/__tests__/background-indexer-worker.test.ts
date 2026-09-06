import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CONTENT_HASH = '000000000000002a';

vi.mock('xxhash-wasm', () => ({
  default: async () => ({
    h64: () => 42n,
  }),
}));

type WorkerMessageHandler = (event: MessageEvent) => Promise<void>;

async function loadWorkerHarness(): Promise<{
  messageHandler: WorkerMessageHandler;
  postMessage: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();

  const postMessage = vi.fn();
  const workerScope: {
    addEventListener: ReturnType<typeof vi.fn>;
    onmessage: WorkerMessageHandler | null;
    postMessage: ReturnType<typeof vi.fn>;
  } = {
    addEventListener: vi.fn(),
    onmessage: null,
    postMessage,
  };
  vi.stubGlobal('self', workerScope);

  await import('../background-indexer.worker');
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: 'ready' }));

  if (!workerScope.onmessage) {
    throw new Error('Background indexer worker message handler was not registered');
  }
  return { messageHandler: workerScope.onmessage, postMessage };
}

function createRequest(cachedFileSize: number | undefined): MessageEvent {
  return {
    data: {
      cachedFileSize,
      cachedHash: CONTENT_HASH,
      compositeKey: 'folder|@|file.txt',
      content: 'abcdefgh',
      filePath: 'file.txt',
      fileSize: 8,
      folderId: 'folder',
      id: 'request-1',
      mode: 'heuristic',
      type: 'index',
    },
  } as MessageEvent;
}

describe('background-indexer.worker cache validation', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips counting only when both the cached hash and known size match', async () => {
    const { messageHandler, postMessage } = await loadWorkerHarness();

    await messageHandler(createRequest(8));

    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ contentHash: CONTENT_HASH, fileSize: 8, skipped: true })
    );
  });

  it('recounts when the cached hash matches but the known size differs', async () => {
    const { messageHandler, postMessage } = await loadWorkerHarness();

    await messageHandler(createRequest(7));

    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ contentHash: CONTENT_HASH, fileSize: 8, skipped: false })
    );
  });

  it('rejects cached hashes without the required secondary size', async () => {
    const { messageHandler, postMessage } = await loadWorkerHarness();

    await messageHandler(createRequest(undefined));

    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ error: expect.stringContaining('cachedFileSize'), type: 'error' })
    );
  });
});
