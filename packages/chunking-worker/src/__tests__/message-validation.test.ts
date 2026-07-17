import { describe, expect, it } from 'vitest';
import { CHUNKING_CONFIG } from '../chunking-config';
import {
  isChunkBatchRequest,
  isChunkingRequestOptions,
  isChunkRequest,
} from '../message-validation';

describe('chunking worker message validation', () => {
  it('accepts every canonical chunking strategy', () => {
    const strategies = [
      'auto',
      'character',
      'recursive',
      'token',
      'markdown',
      'semantic-markdown',
      'html',
      'json',
      'latex',
      'sentence',
    ] as const;

    for (const strategy of strategies) {
      expect(isChunkingRequestOptions({ strategy })).toBe(true);
    }
  });

  it('rejects unknown chunking strategies', () => {
    expect(isChunkingRequestOptions({ strategy: 'bogus' })).toBe(false);
  });

  it('rejects invalid numeric and typed request option fields', () => {
    expect(isChunkingRequestOptions({ maxTokens: 0, strategy: 'auto' })).toBe(false);
    expect(isChunkingRequestOptions({ maxTokensCap: -1, strategy: 'auto' })).toBe(false);
    expect(isChunkingRequestOptions({ overlap: -1, strategy: 'auto' })).toBe(false);
    expect(isChunkingRequestOptions({ maxTokens: 999_999_999, strategy: 'auto' })).toBe(false);
    expect(isChunkingRequestOptions({ maxTokensCap: 999_999_999, strategy: 'auto' })).toBe(false);
    expect(isChunkingRequestOptions({ overlap: 999_999_999, strategy: 'auto' })).toBe(false);
    expect(isChunkingRequestOptions({ allowLargeFiles: 'yes', strategy: 'auto' })).toBe(false);
    expect(isChunkingRequestOptions({ separators: ['\n', 1], strategy: 'auto' })).toBe(false);
  });

  it('accepts valid optional request option fields', () => {
    expect(
      isChunkingRequestOptions({
        allowLargeFiles: true,
        forceStrategy: false,
        ignoreFileTypeRecommendations: true,
        maxTokens: 256,
        maxTokensCap: 4096,
        overlap: 32,
        separators: ['\n\n', '\n'],
        strategy: 'recursive',
        tokenTrueSizing: false,
      })
    ).toBe(true);
  });

  it('rejects separator arrays that exceed the hard worker limit', () => {
    expect(
      isChunkingRequestOptions({
        separators: Array.from({ length: CHUNKING_CONFIG.maxSeparatorsCount + 1 }, () => '\n'),
        strategy: 'recursive',
      })
    ).toBe(false);
  });

  it('accepts chunk requests with expanded strategies', () => {
    expect(
      isChunkRequest({
        content: '# Heading\n\nBody',
        fileName: 'README.md',
        filePath: '/tmp/README.md',
        fileRecordId: 'file-1',
        id: 'chunk-1',
        options: {
          strategy: 'semantic-markdown',
        },
        type: 'chunk',
      })
    ).toBe(true);
  });

  it('accepts chunk batch requests with expanded strategies', () => {
    expect(
      isChunkBatchRequest({
        requests: [
          {
            content: '{"hello":"world"}',
            fileName: 'data.json',
            filePath: '/tmp/data.json',
            fileRecordId: 'file-1',
            id: 'chunk-1',
            options: {
              strategy: 'json',
            },
          },
        ],
        type: 'chunk-batch',
      })
    ).toBe(true);
  });

  it('rejects empty chunk batch requests', () => {
    expect(
      isChunkBatchRequest({
        requests: [],
        type: 'chunk-batch',
      })
    ).toBe(false);
  });

  it('accepts oversized chunk requests structurally so the worker can return a file-level skip', () => {
    expect(
      isChunkRequest({
        content: 'x'.repeat(CHUNKING_CONFIG.maxChunkableSize + 1),
        fileName: 'README.md',
        filePath: '/tmp/README.md',
        fileRecordId: 'file-1',
        id: 'chunk-1',
        options: {
          strategy: 'recursive',
        },
        type: 'chunk',
      })
    ).toBe(true);
  });

  it('accepts oversized chunk-batch entries structurally so the worker can handle them per file', () => {
    expect(
      isChunkBatchRequest({
        requests: [
          {
            content: 'x'.repeat(CHUNKING_CONFIG.maxChunkableSize + 1),
            fileName: 'README.md',
            filePath: '/tmp/README.md',
            fileRecordId: 'file-1',
            id: 'chunk-1',
            options: {
              strategy: 'recursive',
            },
          },
        ],
        type: 'chunk-batch',
      })
    ).toBe(true);
  });

  it('rejects oversized chunk batches before they reach the worker runtime', () => {
    expect(
      isChunkBatchRequest({
        requests: Array.from({ length: CHUNKING_CONFIG.maxBatchSize + 1 }, (_, index) => ({
          content: 'hello',
          fileName: `file-${index}.txt`,
          filePath: `/tmp/file-${index}.txt`,
          fileRecordId: `file-${index}`,
          id: `chunk-${index}`,
          options: { strategy: 'sentence' },
        })),
        type: 'chunk-batch',
      })
    ).toBe(false);
  });

  it('rejects metadata fields that exceed the hard worker limit', () => {
    const oversizedMetadata = 'x'.repeat(CHUNKING_CONFIG.maxMetadataFieldLength + 1);

    expect(
      isChunkRequest({
        content: 'hello',
        fileName: 'README.md',
        filePath: '/tmp/README.md',
        fileRecordId: 'file-1',
        id: oversizedMetadata,
        options: {
          strategy: 'recursive',
        },
        type: 'chunk',
      })
    ).toBe(false);

    expect(
      isChunkBatchRequest({
        requests: [
          {
            content: 'hello',
            fileName: oversizedMetadata,
            filePath: '/tmp/README.md',
            fileRecordId: 'file-1',
            id: 'chunk-1',
            options: {
              strategy: 'recursive',
            },
          },
        ],
        type: 'chunk-batch',
      })
    ).toBe(false);
  });
});
