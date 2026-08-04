import { describe, expect, it } from 'vitest';
import type { Changeset, StructuredFileDiffContent } from '../src/index.js';

function contentLabel(content: StructuredFileDiffContent): string {
  switch (content.kind) {
    case 'binary':
      return 'binary';
    case 'full':
      return `full:${content.oldContent === null ? 'added' : 'both'}`;
    case 'hunks-only':
      return `hunks:${content.reason}`;
    default: {
      const exhaustive: never = content;
      return exhaustive;
    }
  }
}

describe('changeset contracts', () => {
  it('narrows StructuredFileDiffContent by kind', () => {
    expect(contentLabel({ kind: 'binary' })).toBe('binary');
    expect(contentLabel({ kind: 'full', newContent: 'x', oldContent: null })).toBe('full:added');
    expect(
      contentLabel({
        hunkText: '@@',
        hunkTextTruncated: false,
        kind: 'hunks-only',
        reason: 'over-cap-old',
      })
    ).toBe('hunks:over-cap-old');
  });

  it('narrows Changeset by kind', () => {
    const changesets: Changeset[] = [
      { kind: 'agent-run', runId: 'r', threadId: 't' },
      { fromRunId: 'a', kind: 'run-range', threadId: 't' },
      {
        kind: 'git-scope',
        repositoryRoot: '/r',
        scope: 'uncommitted',
        worktreePath: '/r',
      },
    ];
    expect(changesets.map((c) => c.kind)).toEqual(['agent-run', 'run-range', 'git-scope']);
  });
});
