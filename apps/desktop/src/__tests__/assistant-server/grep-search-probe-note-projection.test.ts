/**
 * Coverage for BST-1194's `probeNote` rendering in `projectGrepSearchModelOutput`:
 * `liveNote` and `probeNote` each render as an independent `note:` line, in
 * that order, with either present alone. Split out of
 * workspace-search-model-projections.test.ts to keep both files under the
 * repo's noExcessiveLinesPerFile cap (Biome enforces it), so new coverage gets
 * its own file rather than a grandfathered exemption.
 */
import { describe, expect, it } from 'vitest';
import { projectGrepSearchModelOutput } from '../../assistant-server/workspace-search-model-projections';

describe('grepSearch model projection — probeNote', () => {
  it('renders liveNote before probeNote as two independent note lines', () => {
    const projected = projectGrepSearchModelOutput({
      candidatesTruncated: false,
      files: [],
      liveEngine: 'js-walk',
      liveNote: 'ripgrep unavailable; bounded JavaScript walk used',
      offset: 0,
      outputMode: 'files',
      probeNote:
        "0 exact-case matches, but 2 case-insensitive matches — the pattern's casing may be wrong.",
      scanLimited: false,
      totalFiles: 0,
      totalMatches: 0,
      truncated: false,
    });

    const noteLines = projected.value.split('\n').filter((line) => line.startsWith('note: '));
    expect(noteLines).toEqual([
      'note: ripgrep unavailable; bounded JavaScript walk used',
      "note: 0 exact-case matches, but 2 case-insensitive matches — the pattern's casing may be wrong.",
    ]);
  });

  it('renders probeNote by itself as one note line', () => {
    const projected = projectGrepSearchModelOutput({
      candidatesTruncated: false,
      files: [],
      liveEngine: 'ripgrep',
      offset: 0,
      outputMode: 'files',
      probeNote: '0 regex matches, but 3 literal matches — regex metacharacters may need escaping.',
      scanLimited: false,
      totalFiles: 0,
      totalMatches: 0,
      truncated: false,
    });

    expect(projected.value.split('\n').filter((line) => line.startsWith('note: '))).toEqual([
      'note: 0 regex matches, but 3 literal matches — regex metacharacters may need escaping.',
    ]);
  });
});
