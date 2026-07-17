/**
 * Tests for useContextPacker hook (BST-173)
 */

import type { SemanticSearchResult } from '@brainstrike/ui';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { packSearchResults, useContextPacker } from '../use-context-packer';

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

describe('useContextPacker', () => {
  it('returns packResults function and budgetTokens', () => {
    const { result } = renderHook(() => useContextPacker());

    expect(typeof result.current.packResults).toBe('function');
    expect(result.current.budgetTokens).toBe(4000);
  });

  it('uses custom budgetTokens', () => {
    const { result } = renderHook(() => useContextPacker({ budgetTokens: 8000 }));

    expect(result.current.budgetTokens).toBe(8000);
  });

  it('packs search results and returns formatted context', () => {
    const { result } = renderHook(() => useContextPacker({ budgetTokens: 10_000 }));

    const searchResults = [
      createMockSearchResult({ chunkId: 'chunk-1', content: 'First chunk content.' }),
      createMockSearchResult({ chunkId: 'chunk-2', content: 'Second chunk content.' }),
    ];

    const packed = result.current.packResults(searchResults);

    expect(packed.chunks).toHaveLength(2);
    expect(packed.formattedContext).toContain('Source 1:');
    expect(packed.formattedContext).toContain('First chunk content.');
    expect(packed.formattedContext).toContain('Source 2:');
    expect(packed.formattedContext).toContain('Second chunk content.');
  });

  it('respects token budget and skips chunks that exceed it', () => {
    // Use a very small budget that can only fit one small chunk
    const { result } = renderHook(() =>
      useContextPacker({
        budgetTokens: 10,
        estimateTokens: (content) => content.length, // 1 token per char for testing
      })
    );

    const searchResults = [
      createMockSearchResult({ chunkId: 'chunk-1', content: 'Hello' }), // 5 tokens
      createMockSearchResult({ chunkId: 'chunk-2', content: 'World!' }), // 6 tokens, exceeds budget
    ];

    const packed = result.current.packResults(searchResults);

    expect(packed.chunks).toHaveLength(1);
    expect(packed.chunks[0]?.id).toBe('chunk-1');
    expect(packed.skipped).toBe(1);
    expect(packed.totalTokens).toBe(5);
  });

  it('respects maxChunks limit', () => {
    const { result } = renderHook(() =>
      useContextPacker({
        budgetTokens: 100_000,
        maxChunks: 2,
      })
    );

    const searchResults = [
      createMockSearchResult({ chunkId: 'chunk-1' }),
      createMockSearchResult({ chunkId: 'chunk-2' }),
      createMockSearchResult({ chunkId: 'chunk-3' }),
    ];

    const packed = result.current.packResults(searchResults);

    expect(packed.chunks).toHaveLength(2);
    expect(packed.skipped).toBe(1);
  });

  it('uses tokenCountLookup when provided', () => {
    const tokenLookup = vi.fn((content: string) => content.length * 2);

    const { result } = renderHook(() =>
      useContextPacker({
        budgetTokens: 100,
        tokenCountLookup: tokenLookup,
      })
    );

    const searchResults = [createMockSearchResult({ content: 'Test' })];

    result.current.packResults(searchResults);

    expect(tokenLookup).toHaveBeenCalledWith('Test');
  });

  it('handles empty results array', () => {
    const { result } = renderHook(() => useContextPacker());

    const packed = result.current.packResults([]);

    expect(packed.chunks).toHaveLength(0);
    expect(packed.formattedContext).toBe('');
    expect(packed.totalTokens).toBe(0);
    expect(packed.skipped).toBe(0);
  });

  it('maintains stable function reference on re-render', () => {
    const { result, rerender } = renderHook(() => useContextPacker({ budgetTokens: 4000 }));

    const firstPackResults = result.current.packResults;
    rerender();
    const secondPackResults = result.current.packResults;

    expect(firstPackResults).toBe(secondPackResults);
  });
});

describe('packSearchResults (standalone function)', () => {
  it('packs search results without React hooks', () => {
    const searchResults = [
      createMockSearchResult({ chunkId: 'chunk-1', content: 'Content one.' }),
      createMockSearchResult({ chunkId: 'chunk-2', content: 'Content two.' }),
    ];

    const packed = packSearchResults(searchResults, { budgetTokens: 10_000 });

    expect(packed.chunks).toHaveLength(2);
    expect(packed.formattedContext).toContain('Source 1:');
    expect(packed.formattedContext).toContain('Source 2:');
  });

  it('uses default budget when not specified', () => {
    const searchResults = [createMockSearchResult()];

    const packed = packSearchResults(searchResults);

    expect(packed.budget).toBe(4000);
  });

  it('respects all options', () => {
    const searchResults = [
      createMockSearchResult({ chunkId: 'chunk-1', content: 'Short' }),
      createMockSearchResult({ chunkId: 'chunk-2', content: 'Also short' }),
      createMockSearchResult({ chunkId: 'chunk-3', content: 'Third one' }),
    ];

    const packed = packSearchResults(searchResults, {
      budgetTokens: 10_000,
      maxChunks: 2,
      tokenCountLookup: (content) => content.length,
    });

    expect(packed.chunks).toHaveLength(2);
    expect(packed.skipped).toBe(1);
  });
});
