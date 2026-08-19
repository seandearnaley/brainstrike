/**
 * FileTabBody ↔ explorer pane integration (BST-1269, BST-1318, BST-1319):
 * the pane is OPEN by default (absent state = open) docked on the RIGHT,
 * revealed to the file on mount; the header toggle records an explicit close
 * that sticks; a breadcrumb segment click opens the popover picker and never
 * touches the pane. The pane's and popover's own tree behavior is covered by
 * their dedicated tests; here they are spy components.
 */

import { createTestActionRegistry } from '@brainstrike/context-actions';
import { ActionRegistryProvider } from '@brainstrike/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openFileInTab, paneProps, toastFn } = vi.hoisted(() => ({
  openFileInTab: vi.fn(),
  paneProps: {
    current: [] as Array<{ compositeKey: string; revealNonce: number; revealPath: string | null }>,
  },
  toastFn: vi.fn(),
}));

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    CodeSurface: () => <div data-testid="file-code-surface" />,
    useIdeFileEditor: () => ({ openFileInTab, registerOpenFileInTab: vi.fn() }),
    useToast: () => ({ toast: toastFn }),
  };
});

vi.mock('../file-tab-explorer-pane', () => ({
  FileTabExplorerPane: (props: {
    compositeKey: string;
    revealNonce: number;
    revealPath: string | null;
  }) => {
    paneProps.current.push({ ...props });
    return <div data-testid="pane-spy" />;
  },
}));

// The popover's own tree behavior is covered by breadcrumb-mini-tree tests;
// here a spy pins the segment routing and the pick → open-in-new-tab flow.
vi.mock('../file-tab-breadcrumb-popover', () => ({
  FileTabBreadcrumbPopover: (props: {
    compositeKey: string;
    onPickFile: (path: string) => void;
    rootPath: string | null;
    segmentPath: string;
  }) => (
    <div data-segment={props.segmentPath} data-testid="breadcrumb-popover-spy">
      <button
        data-testid="pick-file"
        onClick={() => props.onPickFile('/root/src/other.ts')}
        type="button"
      >
        pick
      </button>
    </div>
  ),
}));

import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { stubMatchMedia } from '../../__tests__/setup/stub-match-media';
import { fileEntryActions } from '../../context-actions/file-entry-actions';
import { useFileTabPaneStore } from '../../stores/file-tab-pane-store';
import { FileTabBodyForTesting as FileTabBody } from '../file-tab-body';

const KEY = encodeFileSelection('folder-1', '/root/src/app.ts');

function renderBody() {
  const { registry } = createTestActionRegistry({ actions: [...fileEntryActions] });
  return render(
    <ActionRegistryProvider registry={registry}>
      <FileTabBody
        content={'const x = 1;'}
        isLoading={false}
        isRestoring={false}
        onRetryContent={vi.fn()}
        rootPath="/root"
        status={undefined}
        tab={{
          compositeKey: KEY,
          content: null,
          id: KEY,
          isLoading: false,
          path: 'src/app.ts',
        }}
      />
    </ActionRegistryProvider>
  );
}

describe('FileTabBody explorer pane', () => {
  beforeEach(() => {
    stubMatchMedia();
    paneProps.current.length = 0;
    useFileTabPaneStore.getState().hydratePanes({});
  });

  it('pane is open by default, docked RIGHT, revealed to the file (BST-1318)', () => {
    renderBody();

    const pane = screen.getByTestId('file-tab-explorer-pane');
    expect(pane).toBeInTheDocument();
    // Absent store state means open — no entry may be materialized by rendering.
    expect(useFileTabPaneStore.getState().panes[KEY]).toBeUndefined();
    // Mount-time reveal: nonce 0 with the FILE as the target.
    expect(paneProps.current.at(-1)).toEqual({
      compositeKey: KEY,
      revealNonce: 0,
      revealPath: '/root/src/app.ts',
    });
    // Docked right: the content surface precedes the pane in DOM order.
    const content = screen.getByTestId('file-code-surface');
    expect(content.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('toggle records a sticky close, and reopening re-reveals the file', () => {
    renderBody();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle explorer pane' }));
    expect(screen.queryByTestId('file-tab-explorer-pane')).not.toBeInTheDocument();
    // The close is an EXPLICIT open: false entry (persists via the snapshot),
    // not a deleted key (which now means open).
    expect(useFileTabPaneStore.getState().panes[KEY]?.open).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle explorer pane' }));
    expect(screen.getByTestId('file-tab-explorer-pane')).toBeInTheDocument();
    expect(useFileTabPaneStore.getState().panes[KEY]?.open).toBe(true);
    expect(paneProps.current.at(-1)).toEqual({
      compositeKey: KEY,
      revealNonce: 2,
      revealPath: '/root/src/app.ts',
    });
  });

  it('breadcrumb click opens a popover picker and leaves the pane alone (BST-1319)', () => {
    renderBody();

    fireEvent.click(screen.getByRole('button', { name: 'src' }));

    const popover = screen.getByTestId('breadcrumb-popover-spy');
    expect(popover).toHaveAttribute('data-segment', '/root/src');
    // The pane is untouched by breadcrumbs: no store entry materialized, no
    // reveal request issued beyond the mount-time one.
    expect(useFileTabPaneStore.getState().panes[KEY]).toBeUndefined();
    expect(paneProps.current.at(-1)?.revealNonce).toBe(0);

    // Picking a file opens it in a NEW tab (same flow as tree file-clicks)
    // and dismisses the popover; the current tab's pane state is untouched.
    fireEvent.click(screen.getByTestId('pick-file'));
    expect(openFileInTab).toHaveBeenCalledExactlyOnceWith(
      encodeFileSelection('folder-1', '/root/src/other.ts')
    );
    expect(screen.queryByTestId('breadcrumb-popover-spy')).not.toBeInTheDocument();
  });

  it('the LEAF segment is a popover trigger too — sibling files are the primary picker', () => {
    renderBody();

    const leaf = screen.getByRole('button', { name: 'app.ts' });
    expect(leaf).toHaveAttribute('aria-current', 'page');
    fireEvent.click(leaf);
    expect(screen.getByTestId('breadcrumb-popover-spy')).toHaveAttribute(
      'data-segment',
      '/root/src/app.ts'
    );
  });

  it('renders breadcrumbs with the file as the current page', () => {
    renderBody();
    expect(screen.getByText('app.ts')).toHaveAttribute('aria-current', 'page');
  });
});
