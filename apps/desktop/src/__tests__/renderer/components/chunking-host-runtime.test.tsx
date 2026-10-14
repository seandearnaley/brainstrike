import { render, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChunkingHostRuntime } from '../../../renderer/components/chunking-host-runtime';

const { ensureStartedMock, getChunkingStrategyMock } = vi.hoisted(() => ({
  ensureStartedMock: vi.fn(),
  getChunkingStrategyMock: vi.fn((filePath: string) =>
    filePath.endsWith('.ts') ? 'recursive' : 'sentence'
  ),
}));

vi.mock('@brainstrike/file-import', () => ({
  getChunkingStrategy: getChunkingStrategyMock,
  useChunkingWorkerContext: () => ({
    ensureStarted: ensureStartedMock,
    error: null,
  }),
}));

type RequestListener = (request: {
  channel: 'chunk';
  payload: {
    fileRecordId: string;
    kind: 'chunk-file-by-id';
    options: Record<string, never>;
    requestId: string;
  };
  requestId: string;
  runtimeId: string;
  type: 'request';
}) => void;

describe('ChunkingHostRuntime', () => {
  let onRequestCallback: RequestListener | null;
  const reportResponseMock = vi.fn();
  const reportStatusMock = vi.fn();
  const readSourceMock = vi.fn();
  const chunkFileMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    onRequestCallback = null;

    ensureStartedMock.mockResolvedValue({
      chunkFile: chunkFileMock,
    });

    Object.defineProperty(window, 'chunkingHost', {
      configurable: true,
      value: {
        onRequest: (callback: RequestListener) => {
          onRequestCallback = callback;
          return () => {
            onRequestCallback = null;
          };
        },
        reportResponse: reportResponseMock,
        reportStatus: reportStatusMock,
      },
    });

    vi.stubGlobal('sourceFiles', {
      read: async (...args: unknown[]) => ({ ok: true, value: await readSourceMock(...args) }),
    });

    window.history.replaceState({}, '', '/?mode=chunking-host&runtimeId=test-runtime');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads file content by id inside the hidden host before chunking', async () => {
    chunkFileMock.mockResolvedValue({
      chunks: [
        {
          chunkIndex: 0,
          chunkSize: 32,
          chunkType: 'text',
          content: 'chunk',
          contentHash: 'hash',
          tokenCount: 4,
        },
      ],
      fileRecordId: 'file-1',
      id: 'req-1',
      skipped: false,
      strategyUsed: 'sentence',
      totalTokens: 4,
      type: 'result',
    });
    readSourceMock.mockResolvedValue([
      {
        content: 'mock file content',
        fileId: 'file-1',
        fileName: 'mock-file1.txt',
        path: '/mock/mock-file1.txt',
      },
    ]);

    render(<ChunkingHostRuntime />);

    await waitFor(() => {
      expect(reportStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeId: 'test-runtime',
          runtimeKind: 'chunking-host',
          state: 'running',
        })
      );
    });

    await act(async () => {
      onRequestCallback?.({
        channel: 'chunk',
        payload: {
          fileRecordId: 'file-1',
          kind: 'chunk-file-by-id',
          options: {},
          requestId: 'req-1',
        },
        requestId: 'req-1',
        runtimeId: 'test-runtime',
        type: 'request',
      });
    });

    await waitFor(() => {
      expect(readSourceMock).toHaveBeenCalledWith(['file-1'], Number.MAX_SAFE_INTEGER);
      expect(chunkFileMock).toHaveBeenCalledWith(
        'file-1',
        'mock file content',
        'mock-file1.txt',
        '/mock/mock-file1.txt',
        { strategy: 'sentence' }
      );
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'chunk-result',
          requestId: 'req-1',
          runtimeId: 'test-runtime',
          type: 'result',
        })
      );
    });
  });

  it('fails fast when the file record content is missing', async () => {
    readSourceMock.mockResolvedValue([
      { content: null, fileId: 'file-1', fileName: 'mock-file1.txt', path: '/mock/mock-file1.txt' },
    ]);

    render(<ChunkingHostRuntime />);

    await act(async () => {
      onRequestCallback?.({
        channel: 'chunk',
        payload: {
          fileRecordId: 'file-1',
          kind: 'chunk-file-by-id',
          options: {},
          requestId: 'req-2',
        },
        requestId: 'req-2',
        runtimeId: 'test-runtime',
        type: 'request',
      });
    });

    await waitFor(() => {
      expect(chunkFileMock).not.toHaveBeenCalled();
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'chunk-error',
          payload: expect.objectContaining({
            errorMessage: expect.stringContaining('missing content'),
            fileRecordId: 'file-1',
          }),
          requestId: 'req-2',
          runtimeId: 'test-runtime',
          type: 'error',
        })
      );
    });
  });

  it('treats zero-byte file content as a valid chunking skip, not a host error', async () => {
    chunkFileMock.mockResolvedValue({
      chunks: [],
      fileRecordId: 'file-empty',
      id: 'req-empty',
      skipped: true,
      skipReason: 'Empty file content',
      strategyUsed: 'recursive',
      totalTokens: 0,
      type: 'result',
    });
    readSourceMock.mockResolvedValue([
      { content: '', fileId: 'file-empty', fileName: 'empty.ts', path: '/mock/empty.ts' },
    ]);

    render(<ChunkingHostRuntime />);

    await act(async () => {
      onRequestCallback?.({
        channel: 'chunk',
        payload: {
          fileRecordId: 'file-empty',
          kind: 'chunk-file-by-id',
          options: {},
          requestId: 'req-empty',
        },
        requestId: 'req-empty',
        runtimeId: 'test-runtime',
        type: 'request',
      });
    });

    await waitFor(() => {
      expect(chunkFileMock).toHaveBeenCalledWith('file-empty', '', 'empty.ts', '/mock/empty.ts', {
        strategy: 'recursive',
      });
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'chunk-result',
          payload: expect.objectContaining({
            result: expect.objectContaining({
              skipped: true,
              skipReason: 'Empty file content',
            }),
          }),
          requestId: 'req-empty',
          runtimeId: 'test-runtime',
          type: 'result',
        })
      );
    });
  });

  it('fails fast when the source bridge returns a malformed records payload', async () => {
    readSourceMock.mockResolvedValue(null);

    render(<ChunkingHostRuntime />);

    await act(async () => {
      onRequestCallback?.({
        channel: 'chunk',
        payload: {
          fileRecordId: 'file-1',
          kind: 'chunk-file-by-id',
          options: {},
          requestId: 'req-bad-rows',
        },
        requestId: 'req-bad-rows',
        runtimeId: 'test-runtime',
        type: 'request',
      });
    });

    await waitFor(() => {
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'chunk-error',
          payload: expect.objectContaining({
            errorMessage: 'Chunking host could not find file record file-1.',
          }),
          requestId: 'req-bad-rows',
          type: 'error',
        })
      );
    });
  });

  it('emits liveness progress while a chunk-file-by-id request is pending', async () => {
    vi.useFakeTimers();
    let resolveQuery:
      | ((
          value: Array<{ fileId: string; content: string; fileName: string; path: string }>
        ) => void)
      | null = null;
    readSourceMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve;
        })
    );
    chunkFileMock.mockResolvedValue({
      chunks: [],
      fileRecordId: 'file-1',
      id: 'req-heartbeat',
      skipped: true,
      skipReason: 'Empty file content',
      strategyUsed: 'sentence',
      totalTokens: 0,
      type: 'result',
    });

    render(<ChunkingHostRuntime />);

    await act(async () => {
      onRequestCallback?.({
        channel: 'chunk',
        payload: {
          fileRecordId: 'file-1',
          kind: 'chunk-file-by-id',
          options: {},
          requestId: 'req-heartbeat',
        },
        requestId: 'req-heartbeat',
        runtimeId: 'test-runtime',
        type: 'request',
      });
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(reportResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'chunk',
        payload: {
          chunksCreated: 0,
          currentIndex: 0,
          fileRecordId: 'file-1',
          totalFiles: 1,
        },
        requestId: 'req-heartbeat',
        runtimeId: 'test-runtime',
        type: 'progress',
      })
    );

    await act(async () => {
      resolveQuery?.([
        { content: '', fileId: 'file-1', fileName: 'mock-file1.txt', path: '/mock/mock-file1.txt' },
      ]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(reportResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'chunk-result',
        requestId: 'req-heartbeat',
        type: 'result',
      })
    );
  });

  it('stops cleanly if a request resolves after cleanup', async () => {
    let releaseChunking: (() => void) | null = null;
    chunkFileMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseChunking = () =>
            resolve({
              chunks: [],
              fileRecordId: 'file-1',
              id: 'req-3',
              skipped: false,
              strategyUsed: 'sentence',
              totalTokens: 0,
              type: 'result',
            });
        })
    );
    readSourceMock.mockResolvedValue([
      {
        content: 'mock file content',
        fileId: 'file-1',
        fileName: 'mock-file1.txt',
        path: '/mock/mock-file1.txt',
      },
    ]);

    const view = render(<ChunkingHostRuntime />);

    await act(async () => {
      onRequestCallback?.({
        channel: 'chunk',
        payload: {
          fileRecordId: 'file-1',
          kind: 'chunk-file-by-id',
          options: {},
          requestId: 'req-3',
        },
        requestId: 'req-3',
        runtimeId: 'test-runtime',
        type: 'request',
      });
    });

    view.unmount();
    const finishChunking = releaseChunking as (() => void) | null;
    if (!finishChunking) {
      throw new Error('Expected chunking to be pending.');
    }
    finishChunking();

    await waitFor(() => {
      expect(reportStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({
          active: false,
          lastError: null,
          runtimeId: 'test-runtime',
          runtimeKind: 'chunking-host',
          state: 'stopped',
        })
      );
    });
  });
});
