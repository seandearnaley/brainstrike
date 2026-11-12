/**
 * ADR-0034 decision 3: the Explorer's header names the active thread's
 * checkout, `<project> · <checkout>`, in the words app-shell gives it through
 * the thread-checkout context. Other folders, and no thread, keep their names.
 * Its control opens the composer's where-control, the one place a thread's
 * checkout is changed.
 */
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import { act } from '@brainstrike/test-utils/react-act';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import FileExplorerSidebar from '../shell/file-explorer-sidebar';
import {
  type ThreadCheckout,
  type ThreadCheckoutHeader,
  ThreadCheckoutProvider,
} from '../shell/thread-checkout-context';
import { FileExplorerTestWrapper } from './test-helpers';

const ROOT_LOCAL = 'root-brainstrike';
const ROOT_WORKTREE = 'root-swift-badger';
const ROOT_DOCS = 'root-docs';

const brainstrike = {
  _internal: {} as FileSystemDirectoryHandle,
  kind: 'directory' as const,
  name: 'brainstrike',
  path: '/ws/brainstrike',
  platform: 'web' as const,
};
const swiftBadger = {
  _internal: {} as FileSystemDirectoryHandle,
  kind: 'directory' as const,
  name: 'swift-badger',
  path: '/managed/brainstrike/swift-badger',
  platform: 'web' as const,
  worktree: true as const,
};
const docs = {
  _internal: {} as FileSystemDirectoryHandle,
  kind: 'directory' as const,
  name: 'docs',
  path: '/ws/docs',
  platform: 'web' as const,
};
const ROOT_IDS = new Map([
  [brainstrike.path, ROOT_LOCAL],
  [swiftBadger.path, ROOT_WORKTREE],
  [docs.path, ROOT_DOCS],
]);
const IN_WORKTREE: ThreadCheckout = { localRootId: ROOT_LOCAL, threadRootId: ROOT_WORKTREE };

function renderExplorer(options: {
  readonly checkout?: ThreadCheckout | null;
  readonly handles: readonly (typeof brainstrike | typeof swiftBadger | typeof docs)[];
  readonly header?: ThreadCheckoutHeader | null;
}): void {
  const adapter = new MockFileSystemAdapter();
  vi.spyOn(adapter, 'readDirectoryStreaming').mockImplementation(
    async (_handle, onBatch, _options) => {
      onBatch([], { done: true, total: 0 });
    }
  );
  const Wrapper = composeWrappers(({ children }) => (
    <FileExplorerTestWrapper mockFileSystemAdapter={adapter}>
      <ThreadCheckoutProvider checkout={options.checkout ?? null} header={options.header ?? null}>
        {children}
      </ThreadCheckoutProvider>
    </FileExplorerTestWrapper>
  ));
  const renderWithProviders = makeRenderWithProviders(Wrapper);
  const [first] = options.handles;
  act(() => {
    renderWithProviders(
      <FileExplorerSidebar
        currentFolderId={null}
        filterError={null}
        isInitialLoad={false}
        isLoading={false}
        loadingFiles={new Set<string>()}
        quickFilteredTree={[]}
        rootDirectoryHandle={first ?? null}
        rootDirectoryHandles={[...options.handles]}
        rootIdByPath={ROOT_IDS}
        setFocusedRoot={vi.fn()}
        treeError={null}
      />
    );
  });
}

describe("the Explorer's header, one folder", () => {
  it('names the project and Local for the thread working in its folder', () => {
    renderExplorer({
      handles: [brainstrike],
      header: { changeCheckout: null, label: 'brainstrike · Local', rootId: ROOT_LOCAL },
    });
    const name = within(screen.getByTestId('single-root-header-row')).getByText(
      'brainstrike · Local'
    );
    expect(name).toHaveAttribute('title', '/ws/brainstrike');
  });

  it("names the project and the worktree for the thread's worktree", () => {
    renderExplorer({
      checkout: IN_WORKTREE,
      handles: [swiftBadger],
      header: { changeCheckout: null, label: 'brainstrike · swift-badger', rootId: ROOT_WORKTREE },
    });
    const name = within(screen.getByTestId('single-root-header-row')).getByText(
      'brainstrike · swift-badger'
    );
    expect(name).toHaveAttribute('title', '/managed/brainstrike/swift-badger');
  });

  it("opens where the thread works from its folder's header", async () => {
    const user = userEvent.setup();
    const changeCheckout = vi.fn();
    renderExplorer({
      handles: [brainstrike],
      header: { changeCheckout, label: 'brainstrike · Local', rootId: ROOT_LOCAL },
    });
    await user.click(
      within(screen.getByTestId('single-root-header-row')).getByRole('button', {
        name: 'Change where this thread works',
      })
    );
    expect(changeCheckout).toHaveBeenCalledTimes(1);
  });

  it('offers no control while nothing can change where the thread works', () => {
    renderExplorer({
      handles: [brainstrike],
      header: { changeCheckout: null, label: 'brainstrike · Local', rootId: ROOT_LOCAL },
    });
    expect(
      screen.queryByRole('button', { name: 'Change where this thread works' })
    ).not.toBeInTheDocument();
  });

  it('keeps the folder name with no thread selected', () => {
    renderExplorer({ handles: [brainstrike] });
    const row = screen.getByTestId('single-root-header-row');
    expect(within(row).getByText('brainstrike')).toHaveAttribute('title', '/ws/brainstrike');
    expect(row).not.toHaveTextContent('·');
  });
});

describe("the Explorer's header, several folders", () => {
  it("names the thread's checkout on its section and leaves the others as they are", async () => {
    const user = userEvent.setup();
    renderExplorer({
      checkout: IN_WORKTREE,
      handles: [swiftBadger, docs],
      header: { changeCheckout: null, label: 'brainstrike · swift-badger', rootId: ROOT_WORKTREE },
    });
    const [checkoutSection, docsSection] = screen.getAllByTestId('root-section-header');
    expect(checkoutSection).toHaveTextContent('brainstrike · swift-badger');
    expect(docsSection).toHaveTextContent('docs');
    expect(docsSection).not.toHaveTextContent('·');

    await user.hover(
      within(checkoutSection as HTMLElement).getByText('brainstrike · swift-badger')
    );
    expect(
      (await screen.findAllByText('/managed/brainstrike/swift-badger')).length
    ).toBeGreaterThan(0);
  });

  it("offers the control on the thread's section only", async () => {
    const user = userEvent.setup();
    const changeCheckout = vi.fn();
    renderExplorer({
      checkout: IN_WORKTREE,
      handles: [swiftBadger, docs],
      header: { changeCheckout, label: 'brainstrike · swift-badger', rootId: ROOT_WORKTREE },
    });
    const [checkoutRow, docsRow] = screen.getAllByTestId('root-section-header-row');
    expect(
      within(docsRow as HTMLElement).queryByRole('button', {
        name: 'Change where this thread works',
      })
    ).not.toBeInTheDocument();
    await user.click(
      within(checkoutRow as HTMLElement).getByRole('button', {
        name: 'Change where this thread works',
      })
    );
    expect(changeCheckout).toHaveBeenCalledTimes(1);
  });
});
