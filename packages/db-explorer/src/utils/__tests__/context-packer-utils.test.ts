/**
 * Tests for context-packer-utils (BST-173)
 */

import type { SemanticSearchResult } from '@brainstrike/ui';
import { describe, expect, it, vi } from 'vitest';
import {
  formatPackedContext,
  type TokenCountLookup,
  toContextPackerChunk,
  toContextPackerChunks,
} from '../context-packer-utils';

const createMockSearchResult = (
  overrides: Partial<SemanticSearchResult> = {}
): SemanticSearchResult => ({
  chunkId: 'abc123',
  content: 'This is test content for the chunk.',
  fileName: 'example.ts',
  filePath: '/src/example.ts',
  fileRecordId: 'file-001',
  nodeId: 'chunk-abc123',
  similarity: 0.85,
  ...overrides,
});

describe('toContextPackerChunk', () => {
  it('converts basic search result to context packer chunk', () => {
    const result = createMockSearchResult();
    const chunk = toContextPackerChunk(result, 0);

    expect(chunk).toEqual({
      content: 'This is test content for the chunk.',
      fileName: 'example.ts',
      filePath: '/src/example.ts',
      id: 'abc123',
      metadata: {
        fileRecordId: 'file-001',
        nodeId: 'chunk-abc123',
        rank: 1,
      },
      score: 0.85,
    });
  });

  it('includes embeddingSetId in metadata when present', () => {
    const result = createMockSearchResult({ embeddingSetId: 'set-123' });
    const chunk = toContextPackerChunk(result, 0);

    expect(chunk.metadata).toEqual({
      embeddingSetId: 'set-123',
      fileRecordId: 'file-001',
      nodeId: 'chunk-abc123',
      rank: 1,
    });
  });

  it('uses tokenCountLookup when provided', () => {
    const result = createMockSearchResult();
    const lookup: TokenCountLookup = vi.fn(() => 42);

    const chunk = toContextPackerChunk(result, 0, lookup);

    expect(lookup).toHaveBeenCalledWith(result.content);
    expect(chunk.tokenCount).toBe(42);
  });

  it('omits tokenCount when lookup returns undefined', () => {
    const result = createMockSearchResult();
    const lookup: TokenCountLookup = vi.fn().mockReturnValue(undefined);

    const chunk = toContextPackerChunk(result, 0, lookup);

    expect(chunk.tokenCount).toBeUndefined();
  });

  it('calculates rank from index (1-based)', () => {
    const result = createMockSearchResult();

    expect(toContextPackerChunk(result, 0).metadata?.['rank']).toBe(1);
    expect(toContextPackerChunk(result, 4).metadata?.['rank']).toBe(5);
    expect(toContextPackerChunk(result, 9).metadata?.['rank']).toBe(10);
  });

  it('handles missing optional fields', () => {
    const result = createMockSearchResult({
      fileName: '',
      filePath: '',
    });

    const chunk = toContextPackerChunk(result, 0);

    // Empty strings are falsy, so fields are not set
    expect(chunk.filePath).toBeUndefined();
    expect(chunk.fileName).toBeUndefined();
  });
});

describe('toContextPackerChunks', () => {
  it('converts array of search results', () => {
    const results = [
      createMockSearchResult({ chunkId: 'chunk-1', similarity: 0.9 }),
      createMockSearchResult({ chunkId: 'chunk-2', similarity: 0.8 }),
      createMockSearchResult({ chunkId: 'chunk-3', similarity: 0.7 }),
    ];

    const chunks = toContextPackerChunks(results);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.id).toBe('chunk-1');
    expect(chunks[0]?.metadata?.['rank']).toBe(1);
    expect(chunks[1]?.id).toBe('chunk-2');
    expect(chunks[1]?.metadata?.['rank']).toBe(2);
    expect(chunks[2]?.id).toBe('chunk-3');
    expect(chunks[2]?.metadata?.['rank']).toBe(3);
  });

  it('passes tokenCountLookup to each chunk', () => {
    const results = [
      createMockSearchResult({ chunkId: 'chunk-1', content: 'short' }),
      createMockSearchResult({ chunkId: 'chunk-2', content: 'medium length content' }),
    ];
    const lookup: TokenCountLookup = (content) => content.length;

    const chunks = toContextPackerChunks(results, lookup);

    expect(chunks[0]?.tokenCount).toBe(5);
    expect(chunks[1]?.tokenCount).toBe(21);
  });

  it('handles empty array', () => {
    const chunks = toContextPackerChunks([]);
    expect(chunks).toEqual([]);
  });
});

describe('formatPackedContext', () => {
  it('formats single chunk with source header', () => {
    const chunks = [
      {
        content: 'This is the chunk content.',
        filePath: '/src/file.ts',
      },
    ];

    const formatted = formatPackedContext(chunks);

    expect(formatted).toBe('Source 1: /src/file.ts\nThis is the chunk content.');
  });

  it('formats multiple chunks with separators', () => {
    const chunks = [
      { content: 'First chunk.', filePath: '/src/a.ts' },
      { content: 'Second chunk.', filePath: '/src/b.ts' },
    ];

    const formatted = formatPackedContext(chunks);

    expect(formatted).toBe(
      'Source 1: /src/a.ts\nFirst chunk.\n\n---\n\nSource 2: /src/b.ts\nSecond chunk.'
    );
  });

  it('uses fileName when filePath is missing', () => {
    const chunks = [{ content: 'Content.', fileName: 'file.ts' }];

    const formatted = formatPackedContext(chunks);

    expect(formatted).toBe('Source 1: file.ts\nContent.');
  });

  it('uses "Unknown file" when both path and name are missing', () => {
    const chunks = [{ content: 'Content.' }];

    const formatted = formatPackedContext(chunks);

    expect(formatted).toBe('Source 1: Unknown file\nContent.');
  });

  it('includes chunk index label when present', () => {
    const chunks = [{ chunkIndex: 3, content: 'Content.', filePath: '/src/file.ts' }];

    const formatted = formatPackedContext(chunks);

    expect(formatted).toBe('Source 1: /src/file.ts (chunk 3)\nContent.');
  });

  it('returns empty string for empty array', () => {
    const formatted = formatPackedContext([]);
    expect(formatted).toBe('');
  });
});
