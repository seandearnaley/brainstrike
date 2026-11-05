import type { ChangedFileEntry } from '@brainstrike/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { changedFileKey, type DraftComment, useChangesStore } from '../changes-store';

function entry(overrides: Partial<ChangedFileEntry> = {}): ChangedFileEntry {
  return {
    actions: [],
    additions: 1,
    deletions: 0,
    patch: null,
    path: 'src/a.ts',
    repositoryRoot: '/repo',
    revision: 'r1',
    rootId: 'root-1',
    status: 'modified',
    worktreePath: '/repo',
    ...overrides,
  };
}

function comment(id: string, text: string): DraftComment {
  return {
    comment: {
      endLine: 3,
      fileId: changedFileKey(entry()),
      id,
      lines: ['const value = 1;'],
      side: 'additions',
      startLine: 3,
      text,
    },
    entry: entry(),
  };
}

function drafts(changesetKey: string): readonly string[] {
  return (useChangesStore.getState().commentsByChangeset.get(changesetKey) ?? []).map(
    (draft) => draft.comment.text
  );
}

beforeEach(() => {
  useChangesStore.getState().reset();
});

describe('changedFileKey', () => {
  it('distinguishes the same relative path in two worktrees', () => {
    const a = entry({ worktreePath: '/repo' });
    const b = entry({ worktreePath: '/repo-wt/feature' });

    expect(changedFileKey(a)).not.toBe(changedFileKey(b));
  });

  it('is stable for structurally equal entries', () => {
    expect(changedFileKey(entry())).toBe(changedFileKey(entry()));
  });

  // Journal-sourced (`agent-run`/`run-range`) entries always have a null
  // `worktreePath` but a real `rootId` — the collision this fix closes
  // (review findings 3714410839 / 3714434939): a turn editing the same
  // relative path in two workspace roots used to collapse to one key.
  it('distinguishes the same relative path across two roots when worktreePath is null (journal entries)', () => {
    const a = entry({ repositoryRoot: null, rootId: 'root-a', worktreePath: null });
    const b = entry({ repositoryRoot: null, rootId: 'root-b', worktreePath: null });

    expect(changedFileKey(a)).not.toBe(changedFileKey(b));
  });
});

describe('useChangesStore', () => {
  it('toggles expansion ids', () => {
    useChangesStore.getState().toggleExpanded('repo:/repo');
    expect(useChangesStore.getState().expandedIds.has('repo:/repo')).toBe(true);

    useChangesStore.getState().toggleExpanded('repo:/repo');
    expect(useChangesStore.getState().expandedIds.has('repo:/repo')).toBe(false);
  });

  it('keeps draft comments in the order they were written', () => {
    useChangesStore.getState().saveComment('cs-1', comment('a', 'first'));
    useChangesStore.getState().saveComment('cs-1', comment('b', 'second'));

    expect(drafts('cs-1')).toEqual(['first', 'second']);
  });

  it('replaces an edited draft in place instead of adding another', () => {
    useChangesStore.getState().saveComment('cs-1', comment('a', 'first'));
    useChangesStore.getState().saveComment('cs-1', comment('b', 'second'));

    useChangesStore.getState().saveComment('cs-1', comment('a', 'first, reworded'));

    expect(drafts('cs-1')).toEqual(['first, reworded', 'second']);
  });

  it('deletes only the named draft', () => {
    useChangesStore.getState().saveComment('cs-1', comment('a', 'first'));
    useChangesStore.getState().saveComment('cs-1', comment('b', 'second'));

    useChangesStore.getState().deleteComment('cs-1', 'a');
    expect(drafts('cs-1')).toEqual(['second']);

    useChangesStore.getState().deleteComment('cs-1', 'b');
    expect(drafts('cs-1')).toEqual([]);
  });

  it("clears one changeset's drafts and keeps every other changeset's", () => {
    useChangesStore.getState().saveComment('cs-1', comment('a', 'on the turn'));
    useChangesStore.getState().saveComment('cs-2', comment('a', 'on the branch'));

    useChangesStore.getState().clearComments('cs-1');

    expect(drafts('cs-1')).toEqual([]);
    expect(drafts('cs-2')).toEqual(['on the branch']);
  });

  it('reset() drops every draft and every expanded group (factory reset)', () => {
    useChangesStore.getState().saveComment('cs-1', comment('a', 'first'));
    useChangesStore.getState().saveComment('cs-2', comment('b', 'second'));
    useChangesStore.getState().toggleExpanded('repo:/repo');

    useChangesStore.getState().reset();

    expect(useChangesStore.getState().commentsByChangeset.size).toBe(0);
    expect(useChangesStore.getState().expandedIds.size).toBe(0);
  });
});
