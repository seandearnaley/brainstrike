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
  const dbQueryMock = vi.fn();
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

    (
      window as Window & {
        electronAPI?: {
          db?: {
            query?: typeof dbQueryMock;
          };
        };
      }
    ).electronAPI = {
      db: {
        query: dbQueryMock,
      },
    };

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
    dbQueryMock.mockResolvedValue({
      rows: [
        { name: 'mock-file1.txt', path: '/mock/mock-file1.txt', content: 'mock file content' },
      ],
    });

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
        type: 'request',
        channel: 'chunk',
        requestId: 'req-1',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'chunk-file-by-id',
          requestId: 'req-1',
          fileRecordId: 'file-1',
          options: {},
        },
      });
    });

    await waitFor(() => {
      expect(dbQueryMock).toHaveBeenCalledWith(expect.stringContaining('FROM file_records'), [
        'file-1',
      ]);
      expect(chunkFileMock).toHaveBeenCalledWith(
        'file-1',
        'mock file content',
        'mock-file1.txt',
        '/mock/mock-file1.txt',
        { strategy: 'sentence' }
      );
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'result',
          channel: 'chunk-result',
          requestId: 'req-1',
          runtimeId: 'test-runtime',
        })
      );
    });
  });

  it('fails fast when the file record content is missing', async () => {
    dbQueryMock.mockResolvedValue({
      rows: [{ name: 'mock-file1.txt', path: '/mock/mock-file1.txt', content: null }],
    });

    render(<ChunkingHostRuntime />);

    await act(async () => {
      onRequestCallback?.({
        type: 'request',
        channel: 'chunk',
        requestId: 'req-2',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'chunk-file-by-id',
          requestId: 'req-2',
          fileRecordId: 'file-1',
          options: {},
        },
      });
    });

    await waitFor(() => {
      expect(chunkFileMock).not.toHaveBeenCalled();
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          channel: 'chunk-error',
          requestId: 'req-2',
          runtimeId: 'test-runtime',
          payload: expect.objectContaining({
            fileRecordId: 'file-1',
            errorMessage: expect.stringContaining('missing content'),
          }),
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
    dbQueryMock.mockResolvedValue({
      rows: [{ name: 'empty.ts', path: '/mock/empty.ts', content: '' }],
    });

    render(<ChunkingHostRuntime />);

    await act(async () => {
      onRequestCallback?.({
        type: 'request',
        channel: 'chunk',
        requestId: 'req-empty',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'chunk-file-by-id',
          requestId: 'req-empty',
          fileRecordId: 'file-empty',
          options: {},
        },
      });
    });

    await waitFor(() => {
      expect(chunkFileMock).toHaveBeenCalledWith('file-empty', '', 'empty.ts', '/mock/empty.ts', {
        strategy: 'recursive',
      });
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'result',
          channel: 'chunk-result',
          requestId: 'req-empty',
          runtimeId: 'test-runtime',
          payload: expect.objectContaining({
            result: expect.objectContaining({
              skipped: true,
              skipReason: 'Empty file content',
            }),
          }),
        })
      );
    });
  });

  it('fails fast when the db bridge returns a malformed rows payload', async () => {
    dbQueryMock.mockResolvedValue({
      rows: null,
    });

    render(<ChunkingHostRuntime />);

    await act(async () => {
      onRequestCallback?.({
        type: 'request',
        channel: 'chunk',
        requestId: 'req-bad-rows',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'chunk-file-by-id',
          requestId: 'req-bad-rows',
          fileRecordId: 'file-1',
          options: {},
        },
      });
    });

    await waitFor(() => {
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          channel: 'chunk-error',
          requestId: 'req-bad-rows',
          payload: expect.objectContaining({
            errorMessage: 'Chunking host could not find file record file-1.',
          }),
        })
      );
    });
  });

  it('emits liveness progress while a chunk-file-by-id request is pending', async () => {
    vi.useFakeTimers();
    let resolveQuery:
      | ((value: { rows: Array<{ content: string; name: string; path: string }> }) => void)
      | null = null;
    dbQueryMock.mockImplementation(
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
        type: 'request',
        channel: 'chunk',
        requestId: 'req-heartbeat',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'chunk-file-by-id',
          requestId: 'req-heartbeat',
          fileRecordId: 'file-1',
          options: {},
        },
      });
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(reportResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'progress',
        channel: 'chunk',
        requestId: 'req-heartbeat',
        runtimeId: 'test-runtime',
        payload: {
          chunksCreated: 0,
          fileRecordId: 'file-1',
          currentIndex: 0,
          totalFiles: 1,
        },
      })
    );

    await act(async () => {
      resolveQuery?.({
        rows: [{ name: 'mock-file1.txt', path: '/mock/mock-file1.txt', content: '' }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(reportResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        channel: 'chunk-result',
        requestId: 'req-heartbeat',
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
    dbQueryMock.mockResolvedValue({
      rows: [
        { name: 'mock-file1.txt', path: '/mock/mock-file1.txt', content: 'mock file content' },
      ],
    });

    const view = render(<ChunkingHostRuntime />);

    await act(async () => {
      onRequestCallback?.({
        type: 'request',
        channel: 'chunk',
        requestId: 'req-3',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'chunk-file-by-id',
          requestId: 'req-3',
          fileRecordId: 'file-1',
          options: {},
        },
      });
    });

    view.unmount();
    releaseChunking?.();

    await waitFor(() => {
      expect(reportStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeId: 'test-runtime',
          runtimeKind: 'chunking-host',
          state: 'stopped',
          active: false,
          lastError: null,
        })
      );
    });
  });
});
