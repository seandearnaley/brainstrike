/**
 * Choosing a file in the Changes tree: a click hands that file to
 * `onSelectFile` (the surface scrolls the diff to it), the chosen row reads as
 * selected, and no row offers a checkbox — the tree no longer filters the diff.
 */
import { createTestActionRegistry } from '@brainstrike/context-actions';
import type { ChangedFileEntry } from '@brainstrike/types';
import { ActionRegistryProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { changedFileKey, useChangesStore } from '../changes-store';
import { ChangedFilesTree } from '../ui/changed-files-tree';

// The tree virtualizes its rows and happy-dom measures a zero-size viewport,
// so report every row as visible.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 29,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        end: (index + 1) * 29,
        index,
        key: `item-${index}`,
        size: 29,
        start: index * 29,
      })),
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  }),
}));

const testActionRegistry = createTestActionRegistry().registry;

function withRegistry(node: ReactElement): ReactElement {
  return <ActionRegistryProvider registry={testActionRegistry}>{node}</ActionRegistryProvider>;
}

function entry(path: string): ChangedFileEntry {
  return {
    additions: 1,
    deletions: 0,
    patch: null,
    path,
    repositoryRoot: '/repo',
    revertible: true,
    rootId: 'root-1',
    status: 'modified',
    worktreePath: '/repo',
  };
}

const FILES = [entry('src/a.ts'), entry('src/b.ts')];

function rowOf(path: string): HTMLElement {
  const row = screen.getByTitle(path).closest('tr');
  if (!row) {
    throw new Error(`No row for ${path}`);
  }
  return row;
}

beforeEach(() => {
  useChangesStore.getState().reset();
});

describe('ChangedFilesTree file choice', () => {
  it('hands the clicked file to onSelectFile', async () => {
    const user = userEvent.setup();
    const onSelectFile = vi.fn<(entry: ChangedFileEntry) => void>();
    render(
      withRegistry(
        <ChangedFilesTree
          changesetKey="cs-1"
          files={FILES}
          inventory={null}
          onSelectFile={onSelectFile}
        />
      )
    );

    await user.click(rowOf('src/b.ts'));

    expect(onSelectFile).toHaveBeenCalledWith(FILES[1]);
  });

  it('marks the chosen file selected and offers no checkboxes', () => {
    render(
      withRegistry(
        <ChangedFilesTree
          changesetKey="cs-1"
          files={FILES}
          inventory={null}
          selectedFileKey={changedFileKey(FILES[1] as ChangedFileEntry)}
        />
      )
    );

    expect(rowOf('src/b.ts')).toHaveAttribute('aria-selected', 'true');
    expect(rowOf('src/a.ts')).toHaveAttribute('aria-selected', 'false');
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
  });
});
