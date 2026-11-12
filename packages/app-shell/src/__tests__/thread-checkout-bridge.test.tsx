/**
 * ADR-0034 decision 3: the Explorer's header names the active thread's
 * checkout, `<project> · <checkout>`. The bridge words it from the thread's
 * binding and the open folders' names; the Explorer shows it on that folder.
 */
import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { useRootHeaderLabel } from '@brainstrike/file-explorer-ui/shell';
import type { FileExplorerState } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadCheckoutBridge } from '../thread-checkout-bridge';

const explorer = {
  rootDescriptors: {
    'r-docs': { displayName: 'docs', path: '/ws/docs', rootId: 'r-docs' },
    'r-main': { displayName: 'brainstrike', path: '/ws/brainstrike', rootId: 'r-main' },
    'r-wt': {
      displayName: 'swift-badger',
      path: '/managed/brainstrike/swift-badger',
      rootId: 'r-wt',
      worktree: true as const,
    },
  } as Record<string, { displayName: string; path: string; rootId: string; worktree?: true }>,
};

vi.mock('@brainstrike/file-explorer-ui/shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/file-explorer-ui/shell')>()),
  useFileExplorerStoreSelector: <T,>(selector: (state: FileExplorerState) => T): T =>
    selector(explorer as unknown as FileExplorerState),
}));

const THREAD_ID = 'thread-1';
const LOCAL = {
  operatingRootDisplayName: 'brainstrike',
  operatingRootId: 'r-main',
  operatingRootPath: '/ws/brainstrike',
};
const IN_WORKTREE = {
  checkoutLocalRootId: 'r-main',
  checkoutMode: 'worktree' as const,
  checkoutWorktreeId: 'w-1',
  checkoutWorktreePath: '/managed/brainstrike/swift-badger',
  operatingRootDisplayName: 'swift-badger',
  operatingRootId: 'r-wt',
  operatingRootPath: '/managed/brainstrike/swift-badger',
};

function selectThread(metadata: Record<string, unknown> | null): void {
  useAssistantThreadStore.setState({
    ...useAssistantThreadStore.getState(),
    selectedThreadByResourceId: metadata ? { [WORKSPACE_MEMORY_RESOURCE_ID]: THREAD_ID } : {},
    threadsByResourceId: {
      [WORKSPACE_MEMORY_RESOURCE_ID]: metadata
        ? [
            {
              createdAt: new Date(),
              id: THREAD_ID,
              metadata,
              resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
              title: 't',
              updatedAt: new Date(),
            },
          ]
        : [],
    },
  });
}

function Header({ rootId }: { readonly rootId: string }): ReactElement {
  return <span data-testid={`header-${rootId}`}>{useRootHeaderLabel(rootId, '')}</span>;
}

function renderHeaders(): void {
  render(
    <ThreadCheckoutBridge>
      <Header rootId="r-main" />
      <Header rootId="r-wt" />
      <Header rootId="r-docs" />
    </ThreadCheckoutBridge>
  );
}

beforeEach(() => {
  explorer.rootDescriptors = { ...explorer.rootDescriptors };
});

describe("the Explorer header's words for the active thread", () => {
  it('names the project and Local on the folder the thread works in', () => {
    selectThread(LOCAL);
    renderHeaders();
    expect(screen.getByTestId('header-r-main')).toHaveTextContent('brainstrike · Local');
    expect(screen.getByTestId('header-r-wt')).toBeEmptyDOMElement();
    expect(screen.getByTestId('header-r-docs')).toBeEmptyDOMElement();
  });

  it('names a folder outside git Local too', () => {
    selectThread({ operatingRootDisplayName: 'docs', operatingRootId: 'r-docs' });
    renderHeaders();
    expect(screen.getByTestId('header-r-docs')).toHaveTextContent('docs · Local');
  });

  it('names the project by its Local folder and the checkout by the worktree', () => {
    selectThread(IN_WORKTREE);
    renderHeaders();
    expect(screen.getByTestId('header-r-wt')).toHaveTextContent('brainstrike · swift-badger');
    expect(screen.getByTestId('header-r-main')).toBeEmptyDOMElement();
  });

  it('names nothing while no thread is selected', () => {
    selectThread(null);
    renderHeaders();
    for (const rootId of ['r-main', 'r-wt', 'r-docs']) {
      expect(screen.getByTestId(`header-${rootId}`)).toBeEmptyDOMElement();
    }
  });

  it('names nothing for a thread with no folder', () => {
    selectThread({});
    renderHeaders();
    expect(screen.getByTestId('header-r-main')).toBeEmptyDOMElement();
  });
});
