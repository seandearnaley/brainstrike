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
    expect(isChunkingRequestOptions({ strategy: 'auto', maxTokens: 0 })).toBe(false);
    expect(isChunkingRequestOptions({ strategy: 'auto', maxTokensCap: -1 })).toBe(false);
    expect(isChunkingRequestOptions({ strategy: 'auto', overlap: -1 })).toBe(false);
    expect(isChunkingRequestOptions({ strategy: 'auto', maxTokens: 999_999_999 })).toBe(false);
    expect(isChunkingRequestOptions({ strategy: 'auto', maxTokensCap: 999_999_999 })).toBe(false);
    expect(isChunkingRequestOptions({ strategy: 'auto', overlap: 999_999_999 })).toBe(false);
    expect(isChunkingRequestOptions({ strategy: 'auto', allowLargeFiles: 'yes' })).toBe(false);
    expect(isChunkingRequestOptions({ strategy: 'auto', separators: ['\n', 1] })).toBe(false);
  });

  it('accepts valid optional request option fields', () => {
    expect(
      isChunkingRequestOptions({
        strategy: 'recursive',
        allowLargeFiles: true,
        forceStrategy: false,
        ignoreFileTypeRecommendations: true,
        tokenTrueSizing: false,
        maxTokens: 256,
        maxTokensCap: 4096,
        overlap: 32,
        separators: ['\n\n', '\n'],
      })
    ).toBe(true);
  });

  it('rejects separator arrays that exceed the hard worker limit', () => {
    expect(
      isChunkingRequestOptions({
        strategy: 'recursive',
        separators: Array.from({ length: CHUNKING_CONFIG.maxSeparatorsCount + 1 }, () => '\n'),
      })
    ).toBe(false);
  });

  it('accepts chunk requests with expanded strategies', () => {
    expect(
      isChunkRequest({
        type: 'chunk',
        id: 'chunk-1',
        fileRecordId: 'file-1',
        content: '# Heading\n\nBody',
        fileName: 'README.md',
        filePath: '/tmp/README.md',
        options: {
          strategy: 'semantic-markdown',
        },
      })
    ).toBe(true);
  });

  it('accepts chunk batch requests with expanded strategies', () => {
    expect(
      isChunkBatchRequest({
        type: 'chunk-batch',
        requests: [
          {
            id: 'chunk-1',
            fileRecordId: 'file-1',
            content: '{"hello":"world"}',
            fileName: 'data.json',
            filePath: '/tmp/data.json',
            options: {
              strategy: 'json',
            },
          },
        ],
      })
    ).toBe(true);
  });

  it('rejects empty chunk batch requests', () => {
    expect(
      isChunkBatchRequest({
        type: 'chunk-batch',
        requests: [],
      })
    ).toBe(false);
  });

  it('accepts oversized chunk requests so runtime skip handling can decide the outcome', () => {
    expect(
      isChunkRequest({
        type: 'chunk',
        id: 'chunk-1',
        fileRecordId: 'file-1',
        content: 'x'.repeat(CHUNKING_CONFIG.maxChunkableSize + 1),
        fileName: 'README.md',
        filePath: '/tmp/README.md',
        options: {
          strategy: 'recursive',
        },
      })
    ).toBe(true);
  });

  it('accepts oversized chunk batch entries so runtime skip handling can decide the outcome', () => {
    expect(
      isChunkBatchRequest({
        type: 'chunk-batch',
        requests: [
          {
            id: 'chunk-1',
            fileRecordId: 'file-1',
            content: 'x'.repeat(CHUNKING_CONFIG.maxChunkableSize + 1),
            fileName: 'README.md',
            filePath: '/tmp/README.md',
            options: {
              strategy: 'recursive',
            },
          },
        ],
      })
    ).toBe(true);
  });

  it('rejects oversized chunk batches before they reach the worker runtime', () => {
    expect(
      isChunkBatchRequest({
        type: 'chunk-batch',
        requests: Array.from({ length: CHUNKING_CONFIG.maxBatchSize + 1 }, (_, index) => ({
          id: `chunk-${index}`,
          fileRecordId: `file-${index}`,
          content: 'hello',
          fileName: `file-${index}.txt`,
          filePath: `/tmp/file-${index}.txt`,
          options: { strategy: 'sentence' },
        })),
      })
    ).toBe(false);
  });

  it('rejects metadata fields that exceed the hard worker limit', () => {
    const oversizedMetadata = 'x'.repeat(CHUNKING_CONFIG.maxMetadataFieldLength + 1);

    expect(
      isChunkRequest({
        type: 'chunk',
        id: oversizedMetadata,
        fileRecordId: 'file-1',
        content: 'hello',
        fileName: 'README.md',
        filePath: '/tmp/README.md',
        options: {
          strategy: 'recursive',
        },
      })
    ).toBe(false);

    expect(
      isChunkBatchRequest({
        type: 'chunk-batch',
        requests: [
          {
            id: 'chunk-1',
            fileRecordId: 'file-1',
            content: 'hello',
            fileName: oversizedMetadata,
            filePath: '/tmp/README.md',
            options: {
              strategy: 'recursive',
            },
          },
        ],
      })
    ).toBe(false);
  });
});
