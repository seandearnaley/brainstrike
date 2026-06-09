import { describe, expect, it } from 'vitest';
import {
  assertChunkingHostChunkBatchRequestPayload,
  assertChunkingHostChunkFileRequestPayload,
  assertChunkingHostResponseReport,
  assertChunkingHostStatusReport,
  createStoppedChunkingHostStatus,
  isChunkingHostRequestPayloadBase,
} from '../chunking-host-shared';

const requestBase = {
  requestId: 'request-1',
} as const;

const filePayload = {
  content: 'export const answer = 42;',
  fileName: 'answer.ts',
  filePath: 'src/answer.ts',
  fileRecordId: 'file-1',
} as const;

const fullOptions = {
  allowLargeFiles: true,
  forceStrategy: true,
  ignoreFileTypeRecommendations: false,
  maxTokens: 400,
  maxTokensCap: 800,
  overlap: 20,
  requestedStrategy: 'markdown',
  separators: ['\n\n', '\n'],
  tokenTrueSizing: true,
} as const;

const chunkResult = {
  chunks: [{ content: 'chunk', index: 0, tokenCount: 3 }],
  fileRecordId: 'file-1',
  id: 'result-1',
  skipped: false,
  strategyUsed: 'markdown',
  totalTokens: 3,
  type: 'result',
} as const;

function envelope(type: 'error' | 'progress' | 'result', channel: string, payload: unknown) {
  return {
    channel,
    payload,
    requestId: 'request-1',
    runtimeId: 'chunking-host:runtime-1',
    type,
  };
}

describe('chunking-host-shared', () => {
  it('asserts chunk-file requests with every supported option', () => {
    expect(
      assertChunkingHostChunkFileRequestPayload({
        ...requestBase,
        ...filePayload,
        kind: 'chunk-file',
        options: fullOptions,
      })
    ).toEqual({
      ...requestBase,
      ...filePayload,
      kind: 'chunk-file',
      options: {
        ...fullOptions,
        separators: ['\n\n', '\n'],
      },
    });
  });

  it('asserts chunk-file-by-id requests', () => {
    expect(
      assertChunkingHostChunkFileRequestPayload({
        ...requestBase,
        fileRecordId: 'file-1',
        kind: 'chunk-file-by-id',
        options: { requestedStrategy: 'json' },
      })
    ).toEqual({
      ...requestBase,
      fileRecordId: 'file-1',
      kind: 'chunk-file-by-id',
      options: { requestedStrategy: 'json' },
    });
  });

  it('asserts batch requests and clones separator arrays', () => {
    const separators = ['```', '\n'];
    const result = assertChunkingHostChunkBatchRequestPayload({
      ...requestBase,
      files: [filePayload],
      kind: 'chunk-batch',
      options: { separators },
    });

    separators.push('mutated');

    expect(result).toEqual({
      ...requestBase,
      files: [filePayload],
      kind: 'chunk-batch',
      options: { separators: ['```', '\n'] },
    });
  });

  it('identifies request payload bases without accepting malformed payloads as valid requests', () => {
    expect(isChunkingHostRequestPayloadBase({ kind: 'chunk-file' })).toBe(true);
    expect(isChunkingHostRequestPayloadBase({ kind: 7 })).toBe(false);
    expect(isChunkingHostRequestPayloadBase(null)).toBe(false);
  });

  it('rejects malformed request payloads and options with explicit errors', () => {
    expect(() =>
      assertChunkingHostChunkFileRequestPayload({
        ...requestBase,
        ...filePayload,
        kind: 'chunk-file',
        options: { maxTokens: 0 },
      })
    ).toThrow('Chunking host request options maxTokens must be greater than zero when set.');
    expect(() =>
      assertChunkingHostChunkFileRequestPayload({
        ...requestBase,
        ...filePayload,
        kind: 'chunk-file',
        options: { overlap: -1 },
      })
    ).toThrow('Chunking host request options overlap must be non-negative when set.');
    expect(() =>
      assertChunkingHostChunkFileRequestPayload({
        ...requestBase,
        ...filePayload,
        kind: 'chunk-file',
        options: { requestedStrategy: 'unsupported' },
      })
    ).toThrow('Chunking host request options has invalid requestedStrategy.');
    expect(() =>
      assertChunkingHostChunkBatchRequestPayload({
        ...requestBase,
        files: [],
        kind: 'chunk-batch',
        options: {},
      })
    ).toThrow('Chunking host chunk-batch request must include at least one file.');
  });

  it('asserts progress, file-complete, and file-error response reports', () => {
    expect(
      assertChunkingHostResponseReport(
        envelope('progress', 'chunk', {
          chunksCreated: 3,
          currentIndex: 1,
          fileRecordId: 'file-1',
          totalFiles: 2,
        })
      )
    ).toEqual(
      envelope('progress', 'chunk', {
        chunksCreated: 3,
        currentIndex: 1,
        fileRecordId: 'file-1',
        totalFiles: 2,
      })
    );
    expect(
      assertChunkingHostResponseReport(
        envelope('progress', 'chunk-file-complete', {
          fileRecordId: 'file-1',
          result: chunkResult,
        })
      )
    ).toEqual(
      envelope('progress', 'chunk-file-complete', {
        fileRecordId: 'file-1',
        result: chunkResult,
      })
    );
    expect(
      assertChunkingHostResponseReport(
        envelope('progress', 'chunk-file-error', {
          errorMessage: 'read failed',
          fileRecordId: 'file-1',
        })
      )
    ).toEqual(
      envelope('progress', 'chunk-file-error', {
        errorMessage: 'read failed',
        fileRecordId: 'file-1',
      })
    );
  });

  it('asserts result, batch-complete, and error response reports', () => {
    expect(
      assertChunkingHostResponseReport(envelope('result', 'chunk-result', { result: chunkResult }))
    ).toEqual(envelope('result', 'chunk-result', { result: chunkResult }));
    expect(
      assertChunkingHostResponseReport(
        envelope('result', 'chunk-batch-complete', { results: [chunkResult] })
      )
    ).toEqual(envelope('result', 'chunk-batch-complete', { results: [chunkResult] }));
    expect(
      assertChunkingHostResponseReport(
        envelope('error', 'chunk-error', { fileRecordId: 'file-1', message: 'boom' })
      )
    ).toEqual({
      ...envelope('error', 'chunk-error', {
        errorMessage: 'boom',
        fileRecordId: 'file-1',
        message: 'boom',
        name: 'Error',
        stack: expect.any(String),
      }),
    });
  });

  it('rejects malformed response reports with explicit errors', () => {
    expect(() =>
      assertChunkingHostResponseReport(envelope('progress', 'unknown', { fileRecordId: 'file-1' }))
    ).toThrow('Chunking host progress report has invalid channel.');
    expect(() =>
      assertChunkingHostResponseReport(envelope('result', 'chunk-result', { result: null }))
    ).toThrow('Chunking host result payload result must be an object.');
    expect(() =>
      assertChunkingHostResponseReport(envelope('result', 'chunk-batch-complete', { results: {} }))
    ).toThrow('Chunking host batch-complete payload must include results array.');
    expect(() =>
      assertChunkingHostResponseReport(envelope('error', 'chunk-error', { message: 7 }))
    ).toThrow('Chunking host error payload must include message string.');
  });

  it('asserts status reports and creates stopped statuses', () => {
    expect(
      assertChunkingHostStatusReport({
        active: true,
        lastError: null,
        runtimeId: 'chunking-host:runtime-1',
        runtimeKind: 'chunking-host',
        state: 'running',
      })
    ).toEqual({
      active: true,
      lastError: null,
      runtimeId: 'chunking-host:runtime-1',
      runtimeKind: 'chunking-host',
      state: 'running',
    });
    expect(createStoppedChunkingHostStatus('chunking-host:custom')).toEqual({
      active: false,
      lastError: null,
      runtimeId: 'chunking-host:custom',
      runtimeKind: 'chunking-host',
      state: 'stopped',
    });
  });
});
