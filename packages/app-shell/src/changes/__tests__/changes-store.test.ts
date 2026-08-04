import type { ChangedFileEntry } from '@brainstrike/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { changedFileKey, selectRenderedFiles, useChangesStore } from '../changes-store';

function entry(overrides: Partial<ChangedFileEntry> = {}): ChangedFileEntry {
  return {
    additions: 1,
    deletions: 0,
    path: 'src/a.ts',
    repositoryRoot: '/repo',
    revertible: true,
    rootId: 'root-1',
    status: 'modified',
    worktreePath: '/repo',
    ...overrides,
  };
}

beforeEach(() => {
  useChangesStore.getState().clearSelection();
  useChangesStore.getState().setExpandedIds(new Set());
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

describe('selectRenderedFiles', () => {
  const files = [entry({ path: 'src/a.ts' }), entry({ path: 'src/b.ts' })];

  it('renders every file when nothing is explicitly selected', () => {
    // An EMPTY selection means "no explicit narrowing", not "render nothing".
    expect(selectRenderedFiles(files, new Set())).toBe(files);
  });

  it('renders only the selected files, preserving changeset order', () => {
    const selection = new Set([changedFileKey(files[1] as ChangedFileEntry)]);

    expect(selectRenderedFiles(files, selection)).toEqual([files[1]]);
  });
});

describe('useChangesStore', () => {
  it('tracks explicit selection separately from set size', () => {
    const key = changedFileKey(entry());
    expect(useChangesStore.getState().hasExplicitSelection).toBe(false);

    useChangesStore.getState().toggleFileKey(key);
    expect(useChangesStore.getState().hasExplicitSelection).toBe(true);
    expect(useChangesStore.getState().selectedFileKeys.has(key)).toBe(true);

    // Toggling the last key back off returns to "no explicit selection", which
    // is the render-everything state — not an empty view.
    useChangesStore.getState().toggleFileKey(key);
    expect(useChangesStore.getState().hasExplicitSelection).toBe(false);
  });

  it('toggles expansion ids', () => {
    useChangesStore.getState().toggleExpanded('repo:/repo');
    expect(useChangesStore.getState().expandedIds.has('repo:/repo')).toBe(true);

    useChangesStore.getState().toggleExpanded('repo:/repo');
    expect(useChangesStore.getState().expandedIds.has('repo:/repo')).toBe(false);
  });

  it('reset() clears both selection and expansion, matching the factory-reset contract', () => {
    const key = changedFileKey(entry());
    useChangesStore.getState().toggleFileKey(key);
    useChangesStore.getState().toggleExpanded('repo:/repo');
    expect(useChangesStore.getState().hasExplicitSelection).toBe(true);
    expect(useChangesStore.getState().expandedIds.size).toBeGreaterThan(0);

    useChangesStore.getState().reset();

    expect(useChangesStore.getState().hasExplicitSelection).toBe(false);
    expect(useChangesStore.getState().selectedFileKeys.size).toBe(0);
    expect(useChangesStore.getState().expandedIds.size).toBe(0);
  });
});
