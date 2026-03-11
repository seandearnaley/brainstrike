import { describe, expect, it } from 'vitest';
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
});
