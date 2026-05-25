import { describe, expect, it } from 'vitest';
import { formatRetrievalCoverageNote } from '../retrieval-coverage-summary';

describe('formatRetrievalCoverageNote', () => {
  it('returns empty string when nothing was skipped', () => {
    expect(
      formatRetrievalCoverageNote({
        skippedForMissingSourceRange: 0,
        skippedForTokenBudget: 0,
      })
    ).toBe('');
  });

  it('summarizes missing source-range skips with re-index guidance', () => {
    const note = formatRetrievalCoverageNote({
      skippedForMissingSourceRange: 2,
      skippedSourceRangeChunks: [
        { chunkId: 'c1', chunkIndex: 0, fileRecordId: 'f1' },
        { chunkId: 'c2', chunkIndex: 1, fileRecordId: 'f2' },
      ],
      affectedFilePaths: new Map([
        ['f1', '/src/a.ts'],
        ['f2', '/src/b.ts'],
      ]),
    });

    expect(note).toContain('[Retrieval coverage]');
    expect(note).toContain('2 chunks missing source line ranges');
    expect(note).toContain('Re-index the embedding space');
    expect(note).toContain('/src/a.ts');
    expect(note).toContain('/src/b.ts');
  });

  it('summarizes token-budget truncation without re-index hint', () => {
    const note = formatRetrievalCoverageNote({
      skippedForMissingSourceRange: 0,
      skippedForTokenBudget: 3,
    });

    expect(note).toContain('3 chunks omitted for token budget');
    expect(note).not.toContain('Re-index');
  });

  it('caps affected file listing for token-aware output', () => {
    const note = formatRetrievalCoverageNote({
      skippedForMissingSourceRange: 5,
      skippedSourceRangeChunks: [
        { chunkId: 'c1', chunkIndex: 0, fileRecordId: 'f1' },
        { chunkId: 'c2', chunkIndex: 0, fileRecordId: 'f2' },
        { chunkId: 'c3', chunkIndex: 0, fileRecordId: 'f3' },
        { chunkId: 'c4', chunkIndex: 0, fileRecordId: 'f4' },
      ],
      affectedFilePaths: new Map([
        ['f1', 'a.ts'],
        ['f2', 'b.ts'],
        ['f3', 'c.ts'],
        ['f4', 'd.ts'],
      ]),
    });

    expect(note).toContain('(+1 more)');
    expect(note).not.toContain('d.ts');
  });
});
