/**
 * Render-stability tests for `ChangedFilesTree` (BST-1114, W4 Task B).
 *
 * Modeled on `packages/ui/src/__tests__/tree-table-render-stability.test.tsx`:
 * `TreeTableRow` is `React.memo`'d, so it only bails out when every prop TWO
 * renders receive is reference/value-stable. This pins that `ChangedFilesTree`
 * own memoization glue (the `useMemo`'d `nodes`, the `useCallback`'d
 * `getCheckboxState`/`onCheckboxChange`) does not silently defeat that memo —
 * an unstable identity here would turn every store update into a full
 * visible-row re-render of the whole tree.
 *
 * Since this component's columns are a fixed internal concern (not injected
 * via props, unlike the generic `TreeTable` test), row-cell renders are
 * counted by wrapping the exported `CHANGED_FILES_TREE_COLUMNS[0].cell` with
 * a spy for the duration of each test, then restoring it — the columns array
 * is a live, shared object, so mutating its `cell` field takes effect
 * immediately without touching how `ChangedFilesTree` references it.
 */
import { createTestActionRegistry } from '@brainstrike/context-actions';
import { act } from '@brainstrike/test-utils/react-act';
import type { ChangedFileEntry } from '@brainstrike/types';
import {
  ActionRegistryProvider,
  type TreeTableCellProps,
  type TreeTableColumn,
} from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changedFileKey, useChangesStore } from '../changes-store';
import { ChangedFilesTree } from '../ui/changed-files-tree';
import { CHANGED_FILES_TREE_COLUMNS } from '../ui/changed-files-tree-columns';
import type { ChangedFilesTreeNodeData } from '../ui/changed-files-tree-model';

// Mirrors the mock in tree-table-render-stability.test.tsx: a STABLE
// virtualizer instance across renders (unlike the real library's per-render
// options mutation), and reports every row as a virtual item so nothing is
// clipped by JSDOM's zero-size viewport.
vi.mock('@tanstack/react-virtual', () => {
  const state = { count: 0 };
  const instance = {
    getTotalSize: () => state.count * 40,
    getVirtualItems: () =>
      Array.from({ length: state.count }, (_, index) => ({
        end: (index + 1) * 40,
        index,
        key: `item-${index}`,
        size: 40,
        start: index * 40,
      })),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  };
  return {
    useVirtualizer: vi.fn(({ count }: { count: number }) => {
      state.count = count;
      return instance;
    }),
  };
});

// `ChangedFilesTree` mounts an `ActionContextMenu`, whose `useActionRegistry`
// throws without a provider — same wrapper discipline as
// `file-explorer-ui/src/__tests__/test-helpers.tsx`.
const testActionRegistry = createTestActionRegistry().registry;

function withRegistry(node: ReactElement): ReactElement {
  return <ActionRegistryProvider registry={testActionRegistry}>{node}</ActionRegistryProvider>;
}

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

describe('ChangedFilesTree row render stability', () => {
  let cellRenders: Mock<(id: string) => void>;
  let originalCell: TreeTableColumn<ChangedFilesTreeNodeData>['cell'] | undefined;

  beforeEach(() => {
    useChangesStore.getState().clearSelection();
    useChangesStore.getState().setExpandedIds(new Set());

    cellRenders = vi.fn<(id: string) => void>();
    const nameColumn = CHANGED_FILES_TREE_COLUMNS[0];
    if (!nameColumn) {
      throw new Error('Expected changed-files-tree.tsx to define a name column');
    }
    originalCell = nameColumn.cell;
    nameColumn.cell = (props: TreeTableCellProps<ChangedFilesTreeNodeData>) => {
      cellRenders(props.node.id);
      return originalCell?.(props);
    };
  });

  afterEach(() => {
    const nameColumn = CHANGED_FILES_TREE_COLUMNS[0];
    if (nameColumn && originalCell) {
      nameColumn.cell = originalCell;
    }
  });

  const files: ChangedFileEntry[] = [
    entry({ path: 'src/one.ts' }),
    entry({ path: 'src/two.ts' }),
    entry({ path: 'src/three.ts' }),
  ];

  it('does not re-render row cells when ChangedFilesTree re-renders with unchanged props', () => {
    const view = render(
      withRegistry(
        <ChangedFilesTree changesetKey="test-changeset" files={files} inventory={null} />
      )
    );
    const rendersAfterMount = cellRenders.mock.calls.length;
    expect(rendersAfterMount).toBeGreaterThan(0);

    // Same element, same prop identities (files/inventory unchanged) — the
    // memo'd rows must bail out.
    view.rerender(
      withRegistry(
        <ChangedFilesTree changesetKey="test-changeset" files={files} inventory={null} />
      )
    );

    expect(cellRenders.mock.calls.length).toBe(rendersAfterMount);
  });

  it('does not re-render an unaffected row when toggling one row checkbox', () => {
    render(
      withRegistry(
        <ChangedFilesTree changesetKey="test-changeset" files={files} inventory={null} />
      )
    );

    const targetEntry = files[0];
    const untouchedEntry = files[2];
    if (!(targetEntry && untouchedEntry)) {
      throw new Error('Expected at least three fixture files');
    }
    const targetKey = changedFileKey(targetEntry);
    const untouchedKey = changedFileKey(untouchedEntry);

    const untouchedRendersBeforeToggle = cellRenders.mock.calls.filter(
      ([id]) => id === untouchedKey
    ).length;
    expect(untouchedRendersBeforeToggle).toBeGreaterThan(0);

    // Check exactly one file's box — the same store write
    // `ChangedFilesTree`'s own `onCheckboxChange` handler performs for a
    // single-file toggle.
    act(() => {
      useChangesStore.getState().setSelectedFileKeys(new Set([targetKey]));
    });

    const untouchedRendersAfterToggle = cellRenders.mock.calls.filter(
      ([id]) => id === untouchedKey
    ).length;

    expect(untouchedRendersAfterToggle).toBe(untouchedRendersBeforeToggle);
    expect(screen.getByRole('checkbox', { name: `Select ${targetEntry.path}` })).toBeChecked();
  });
});
