/**
 * FileTabBody ↔ explorer pane integration (BST-1269): the header toggle
 * mounts/unmounts the pane split, the pane receives the FILE path as its
 * default reveal target, and a breadcrumb segment click reveals that folder
 * (opening the pane when closed). The pane's own tree behavior is covered by
 * optimized-file-tree-scoping tests; here it is a spy component.
 */

import { createTestActionRegistry } from '@brainstrike/context-actions';
import { ActionRegistryProvider } from '@brainstrike/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openFileInTab, paneProps, toastFn } = vi.hoisted(() => ({
  openFileInTab: vi.fn(),
  paneProps: { current: [] as Array<{ compositeKey: string; revealPath: string | null }> },
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
  FileTabExplorerPane: (props: { compositeKey: string; revealPath: string | null }) => {
    paneProps.current.push({ ...props });
    return <div data-testid="pane-spy" />;
  },
}));

import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { fileEntryActions } from '../../context-actions/file-entry-actions';
import { useFileTabPaneStore } from '../../stores/file-tab-pane-store';
import { FileTabBodyForTesting as FileTabBody } from '../file-tab-body';

// react-resizable-panels v4 probes `matchMedia('(pointer: coarse)').matches`
// while mounting a Group. The shared setup's matchMedia is a vi.fn whose
// implementation is reset between tests (returns undefined) — install a PLAIN
// function per test instead.
function stubMatchMedia(): void {
  window.matchMedia = ((query: string) => ({
    addEventListener: () => undefined,
    addListener: () => undefined,
    dispatchEvent: () => false,
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: () => undefined,
    removeListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

const KEY = encodeFileSelection('folder-1', '/root/src/app.ts');

function renderBody() {
  const { registry } = createTestActionRegistry({ actions: [...fileEntryActions] });
  return render(
    <ActionRegistryProvider registry={registry}>
      <FileTabBody
        content={'const x = 1;'}
        isLoading={false}
        isRestoring={false}
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

  it('toggle opens the pane with the file as the default reveal target', () => {
    renderBody();
    expect(screen.queryByTestId('file-tab-explorer-pane')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle explorer pane' }));

    expect(screen.getByTestId('file-tab-explorer-pane')).toBeInTheDocument();
    expect(useFileTabPaneStore.getState().panes[KEY]?.open).toBe(true);
    expect(paneProps.current.at(-1)).toEqual({
      compositeKey: KEY,
      revealPath: '/root/src/app.ts',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Toggle explorer pane' }));
    expect(screen.queryByTestId('file-tab-explorer-pane')).not.toBeInTheDocument();
  });

  it('breadcrumb segment click opens the pane and reveals that folder', () => {
    renderBody();
    fireEvent.click(screen.getByRole('button', { name: 'src' }));

    expect(useFileTabPaneStore.getState().panes[KEY]?.open).toBe(true);
    expect(paneProps.current.at(-1)).toEqual({
      compositeKey: KEY,
      revealPath: '/root/src',
    });
  });

  it('renders breadcrumbs with the file as the current page', () => {
    renderBody();
    expect(screen.getByText('app.ts')).toHaveAttribute('aria-current', 'page');
  });
});
