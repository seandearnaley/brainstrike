import { describe, expect, it } from 'vitest';
import type {
  ChangedFileStatus,
  Changeset,
  GitScope,
  StructuredFileDiffContent,
  WorktreeDescriptor,
} from '../src/index.js';

function trustLabel(trust: WorktreeDescriptor['trust']): string {
  switch (trust) {
    case 'unvalidated':
      return 'unvalidated';
    case 'validated':
      return 'validated';
    default: {
      const exhaustive: never = trust;
      return exhaustive;
    }
  }
}

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

function changesetLabel(changeset: Changeset): string {
  switch (changeset.kind) {
    case 'agent-run':
      return 'agent-run';
    case 'git-scope':
      return 'git-scope';
    case 'run-range':
      return 'run-range';
    default: {
      const exhaustive: never = changeset;
      return exhaustive;
    }
  }
}

function scopeLabel(scope: GitScope): string {
  switch (scope.kind) {
    case 'branch-vs-base':
      return 'branch-vs-base';
    case 'commit':
      return 'commit';
    case 'staged':
      return 'staged';
    case 'uncommitted':
      return 'uncommitted';
    case 'unstaged':
      return 'unstaged';
    default: {
      const exhaustive: never = scope;
      return exhaustive;
    }
  }
}

function statusLabel(status: ChangedFileStatus): string {
  switch (status) {
    case 'added':
      return 'added';
    case 'deleted':
      return 'deleted';
    case 'modified':
      return 'modified';
    case 'renamed':
      return 'renamed';
    case 'untracked':
      return 'untracked';
    default: {
      const exhaustive: never = status;
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
    expect(
      contentLabel({
        hunkText: '@@',
        hunkTextTruncated: true,
        kind: 'hunks-only',
        reason: 'diff-overflow',
      })
    ).toBe('hunks:diff-overflow');
  });

  it('narrows Changeset by kind', () => {
    const changesets: Changeset[] = [
      { kind: 'agent-run', runId: 'r', threadId: 't' },
      { fromRunId: 'a', kind: 'run-range', threadId: 't' },
      {
        kind: 'git-scope',
        repositoryRoot: '/r',
        scope: { kind: 'uncommitted' },
        worktreePath: '/r',
      },
    ];
    expect(changesets.map((c) => changesetLabel(c))).toEqual([
      'agent-run',
      'run-range',
      'git-scope',
    ]);
  });

  it('narrows GitScope by kind', () => {
    const scopes: GitScope[] = [
      { kind: 'branch-vs-base' },
      { baseRef: 'origin/main', kind: 'branch-vs-base' },
      { commitId: 'abc123', kind: 'commit' },
      { kind: 'staged' },
      { kind: 'uncommitted' },
      { kind: 'unstaged' },
    ];
    expect(scopes.map((s) => scopeLabel(s))).toEqual([
      'branch-vs-base',
      'branch-vs-base',
      'commit',
      'staged',
      'uncommitted',
      'unstaged',
    ]);
  });

  it('narrows ChangedFileStatus exhaustively', () => {
    const statuses: ChangedFileStatus[] = ['added', 'deleted', 'modified', 'renamed', 'untracked'];
    expect(statuses.map((s) => statusLabel(s))).toEqual(statuses);
  });

  it('narrows WorktreeDescriptor.trust exhaustively', () => {
    const trusts: WorktreeDescriptor['trust'][] = ['validated', 'unvalidated'];
    expect(trusts.map((t) => trustLabel(t))).toEqual(trusts);
  });

  it('constructs a WorktreeDescriptor with containment and trust', () => {
    const validated: WorktreeDescriptor = {
      bare: false,
      branch: 'main',
      containment: ['root-1'],
      current: true,
      detached: false,
      head: 'abc123',
      lockedReason: null,
      name: 'repo',
      path: '/root-1/repo',
      provenance: 'scanned',
      prunableReason: null,
      trust: 'validated',
      trustReason: null,
    };
    const unvalidated: WorktreeDescriptor = {
      ...validated,
      containment: 'outside-roots',
      current: false,
      name: 'evil',
      path: '/outside/evil',
      trust: 'unvalidated',
      trustReason: 'own ".git" resolves to a different common dir',
    };
    expect(validated.trust).toBe('validated');
    expect(unvalidated.containment).toBe('outside-roots');
    expect(unvalidated.trust).toBe('unvalidated');
  });
});
