import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChunkBatchRequest, ChunkRequest, WorkerResponse } from '../shared';

interface WorkerSelfMock {
  addEventListener: ReturnType<typeof vi.fn>;
  onmessage: ((event: MessageEvent<ChunkRequest | ChunkBatchRequest>) => Promise<void>) | null;
  postMessage: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

function createWorkerSelfMock(): WorkerSelfMock {
  return {
    addEventListener: vi.fn(),
    onmessage: null,
    postMessage: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function createChunkRequest(id: string): ChunkRequest {
  return {
    type: 'chunk',
    id,
    fileRecordId: `file-${id}`,
    fileName: `${id}.txt`,
    filePath: `/workspace/${id}.txt`,
    content: 'abcde '.repeat(160),
    options: {
      strategy: 'token',
      maxTokens: 32,
      overlap: 0,
      tokenTrueSizing: true,
    },
  };
}

async function importWorkerWithMockedSelf(selfMock: WorkerSelfMock): Promise<void> {
  vi.stubGlobal('self', selfMock);
  vi.doMock('../token-utils-lite', () => {
    throw new Error('accurate token utility module should not load for local estimation');
  });

  await import('../chunking.worker');
}

afterEach(() => {
  vi.doUnmock('../token-utils-lite');
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('chunking.worker token sizing', () => {
  it('chunks a legacy tokenTrueSizing request without loading accurate token utilities', async () => {
    const selfMock = createWorkerSelfMock();
    await importWorkerWithMockedSelf(selfMock);

    await selfMock.onmessage?.({
      data: createChunkRequest('single'),
    } as MessageEvent<ChunkRequest>);

    const messages = selfMock.postMessage.mock.calls.map(([message]) => message as WorkerResponse);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'result',
        id: 'single',
        fileRecordId: 'file-single',
        skipped: false,
      })
    );
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'error' }));
  });

  it('chunks legacy tokenTrueSizing batches without loading accurate token utilities', async () => {
    const selfMock = createWorkerSelfMock();
    await importWorkerWithMockedSelf(selfMock);

    await selfMock.onmessage?.({
      data: {
        type: 'chunk-batch',
        requests: [createChunkRequest('batch-a'), createChunkRequest('batch-b')].map(
          ({ type: _type, ...request }) => request
        ),
      },
    } as MessageEvent<ChunkBatchRequest>);

    const messages = selfMock.postMessage.mock.calls.map(([message]) => message as WorkerResponse);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'result',
        id: 'batch-a',
        fileRecordId: 'file-batch-a',
        skipped: false,
      })
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'result',
        id: 'batch-b',
        fileRecordId: 'file-batch-b',
        skipped: false,
      })
    );
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'error' }));
  });
});
