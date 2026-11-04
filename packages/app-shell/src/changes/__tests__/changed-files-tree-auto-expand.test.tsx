/**
 * Regression pins for the changed-files tree's first-load auto-expand
 * (BST-1114 review blocker B3).
 *
 * The tree mounts the INSTANT a changeset is selected, while `useChangeset`'s
 * view is still resolving — so its very first render always sees an empty
 * `files` array. The original implementation latched a "already auto-expanded"
 * ref BEFORE checking whether there was anything to expand, and keyed that
 * latch on the component instance with an empty dependency array. Because the
 * Changes surface stays mounted for the whole session (`KeepMountedRoute`),
 * that burned the one shot on the empty tree and left every real file list
 * collapsed behind a single root row, forever.
 *
 * These two tests fail against that implementation and pass against the
 * changeset-keyed latch.
 */
import { createTestActionRegistry } from '@brainstrike/context-actions';
import type { ChangedFileEntry } from '@brainstrike/types';
import { ActionRegistryProvider } from '@brainstrike/ui';
import { act, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useChangesStore } from '../changes-store';
import { ChangedFilesTree } from '../ui/changed-files-tree';

const testActionRegistry = createTestActionRegistry().registry;

function withRegistry(node: ReactElement): ReactElement {
  return <ActionRegistryProvider registry={testActionRegistry}>{node}</ActionRegistryProvider>;
}

function entry(overrides: Partial<ChangedFileEntry> = {}): ChangedFileEntry {
  return {
    additions: 1,
    deletions: 0,
    patch: null,
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
  useChangesStore.getState().reset();
});

describe('ChangedFilesTree first-load auto-expand', () => {
  it('expands once the files arrive, not on the empty first render', () => {
    const { rerender } = render(
      withRegistry(<ChangedFilesTree changesetKey="cs-1" files={[]} inventory={null} />)
    );

    // Nothing to expand yet — and, critically, no latch may be spent here.
    expect(useChangesStore.getState().expandedIds.size).toBe(0);

    rerender(
      withRegistry(<ChangedFilesTree changesetKey="cs-1" files={[entry()]} inventory={null} />)
    );

    expect(useChangesStore.getState().expandedIds.size).toBeGreaterThan(0);
  });

  it('re-expands for a NEW changeset on a still-mounted tree', () => {
    const { rerender } = render(
      withRegistry(<ChangedFilesTree changesetKey="cs-1" files={[entry()]} inventory={null} />)
    );
    expect(useChangesStore.getState().expandedIds.size).toBeGreaterThan(0);

    // The user collapses everything, then switches source. The new changeset
    // must arrive expanded — the latch is per-changeset, not per-mount.
    act(() => {
      useChangesStore.getState().setExpandedIds(new Set());
    });
    rerender(
      withRegistry(
        <ChangedFilesTree
          changesetKey="cs-2"
          files={[entry({ repositoryRoot: '/other', worktreePath: '/other' })]}
          inventory={null}
        />
      )
    );

    expect(useChangesStore.getState().expandedIds.size).toBeGreaterThan(0);
  });
});
