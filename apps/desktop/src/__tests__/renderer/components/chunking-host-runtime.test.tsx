import { addLogListener, type LogRecord } from '@brainstrike/utils';
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
  let logRecords: LogRecord[] = [];
  let removeLogListener: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    onRequestCallback = null;
    logRecords = [];
    removeLogListener = addLogListener((record: LogRecord) => {
      logRecords.push(record);
    });

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
    if (removeLogListener) {
      removeLogListener();
      removeLogListener = null;
    }
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

  it('warns if request accounting would underflow during cleanup', async () => {
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
      expect(
        logRecords.some(
          (record) =>
            record.level === 'warn' &&
            String(record.message ?? '').includes('active request count underflow')
        )
      ).toBe(true);
    });
  });
});
