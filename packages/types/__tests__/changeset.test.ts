import { describe, expect, it } from 'vitest';
import {
  actionHunks,
  type ChangedFileStatus,
  type Changeset,
  type ChangesetView,
  type GitScope,
  patchHunks,
  type StructuredFileDiffContent,
  type WorktreeDescriptor,
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
    expect(contentLabel({ kind: 'full', newContent: 'x', oldContent: null, patch: '' })).toBe(
      'full:added'
    );
    expect(
      contentLabel({
        kind: 'hunks-only',
        patch: '',
        patchTruncated: false,
        reason: 'over-cap-old',
      })
    ).toBe('hunks:over-cap-old');
    expect(
      contentLabel({
        kind: 'hunks-only',
        patch: '',
        patchTruncated: true,
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

  it('ChangesetView.totalAdditions/totalDeletions accept a literal null (journal sources) AND a real number (git-scope sources)', () => {
    // The settled contract: null means "not computable for this source"
    // (every journal-backed changeset); a git-scope changeset always
    // computes a real number, including a real 0 when every file is binary.
    const journalSourced: ChangesetView = {
      changeset: { kind: 'agent-run', runId: 'r', threadId: 't' },
      files: [],
      totalAdditions: null,
      totalDeletions: null,
    };
    const gitScopeSourced: ChangesetView = {
      changeset: {
        kind: 'git-scope',
        repositoryRoot: '/r',
        scope: { kind: 'uncommitted' },
        worktreePath: '/r',
      },
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };
    expect(journalSourced.totalAdditions).toBeNull();
    expect(gitScopeSourced.totalAdditions).toBe(0);
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

describe('patchHunks', () => {
  it('quotes each hunk from its @@ line to the next hunk or file, endings and markers included', () => {
    const first = '@@ -1,2 +1,2 @@ fn\n-a\r\n+b\r\n c\n';
    const second =
      '@@ -9 +9 @@\n-y\n\\ No newline at end of file\n+z\n\\ No newline at end of file\n';
    const typeChange = '@@ -1 +0,0 @@\n-link\n';
    const header = 'diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n';
    const patch = `${header}${first}${second}${header}${typeChange}diff --git a/g b/g\nnew file mode 120000\n`;

    expect(patchHunks(patch)).toEqual([first, second, typeChange]);
    expect(patchHunks(header)).toEqual([]);
    expect(patchHunks(`${header}${first}`).join('')).toBe(first);
  });
});

describe('actionHunks', () => {
  const header = 'diff --git a/f b/f\nindex 1111111..2222222 100644\n--- a/f\n+++ b/f\n';
  const hunk = '@@ -1,2 +1,2 @@\n-a\n+b\n c\n';

  it("offers a text patch's hunks, whatever its lines' text says", () => {
    // Lines that would be headers outside a hunk are only content inside one.
    const lookalike = '@@ -5 +5,3 @@\n-e\n+diff --git a/g b/g\n+new file mode 160000\n+caf\u00e9\n';
    expect(actionHunks(`${header}${hunk}${lookalike}`)).toEqual([hunk, lookalike]);
  });

  it('offers none for a gitlink, a type change, or text git did not decode', () => {
    const gitlink = (line: string) =>
      `diff --git a/m b/m\n${line}\n--- a/m\n+++ b/m\n@@ -1 +1 @@\n-Subproject commit 1\n+Subproject commit 2\n`;
    const typeChange =
      'diff --git a/f b/f\ndeleted file mode 100644\n--- a/f\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\ndiff --git a/f b/f\nnew file mode 120000\n--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+target\n\\ No newline at end of file\n';

    expect(actionHunks(gitlink('index 1111111..2222222 160000'))).toBeNull();
    expect(actionHunks(gitlink('new file mode 160000'))).toBeNull();
    expect(actionHunks(gitlink('deleted file mode 160000'))).toBeNull();
    expect(actionHunks(`diff --git a/f b/f\nold mode 100644\nnew mode 160000\n${hunk}`)).toBeNull();
    expect(actionHunks(typeChange)).toBeNull();
    expect(actionHunks(`${header}@@ -1 +1 @@\n-caf\uFFFD\n+cafe\n`)).toBeNull();
  });
});
