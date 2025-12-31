import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileTab } from '../hooks/use-tab-manager';
import { TabbedFileEditor, type TabStripAction } from '../tabbed-file-editor';

describe('TabbedFileEditor', () => {
  let mockProps: {
    tabs: FileTab[];
    activeTabId: string | null;
    fileContents: Record<string, string>;
    loadingFiles: Set<string>;
    onTabClick: Mock<(tabId: string) => void>;
    onTabClose: Mock<(tabId: string) => void>;
    onLoadFileContent: Mock<(compositeKey: string) => void>;
    decodeFileSelection: Mock<(compositeKey: string) => { folderId: string; path: string }>;
  };

  beforeEach(() => {
    // Mock scrollIntoView as it's not implemented in JSDOM
    window.HTMLElement.prototype.scrollIntoView = vi.fn();

    mockProps = {
      tabs: [] as FileTab[],
      activeTabId: null,
      fileContents: {},
      loadingFiles: new Set<string>(),
      onTabClick: vi.fn<(tabId: string) => void>(),
      onTabClose: vi.fn<(tabId: string) => void>(),
      onLoadFileContent: vi.fn<(compositeKey: string) => void>(),
      decodeFileSelection: vi.fn<(compositeKey: string) => { folderId: string; path: string }>(
        (key) => ({ folderId: 'root', path: key.split(':')[1] ?? '' })
      ),
    };
  });

  it('should render empty state when no tabs are open', () => {
    render(<TabbedFileEditor {...mockProps} />);
    expect(screen.getByText('No files open')).toBeInTheDocument();
    expect(
      screen.getByText('Click on a file in the preview panel to open it here')
    ).toBeInTheDocument();
  });

  it('should render tabs when files are open', () => {
    const tabs: FileTab[] = [
      {
        id: 'root:file1',
        compositeKey: 'file1',
        path: '/src/index.ts',
        content: null,
        isLoading: false,
      },
      {
        id: 'root:file2',
        compositeKey: 'file2',
        path: '/src/components/Button.tsx',
        content: null,
        isLoading: false,
      },
    ];
    mockProps.decodeFileSelection.mockImplementation((key) => {
      if (key === 'file1') {
        return { folderId: 'f', path: '/src/index.ts' };
      }
      if (key === 'file2') {
        return { folderId: 'f', path: '/src/components/Button.tsx' };
      }
      return { folderId: 'f', path: 'unknown' };
    });

    render(<TabbedFileEditor {...mockProps} activeTabId="root:file1" tabs={tabs} />);

    const tab1 = screen.getByRole('tab', { name: 'index.ts' });
    const tab2 = screen.getByRole('tab', { name: 'Button.tsx' });
    expect(tab1).toBeInTheDocument();
    expect(tab2).toBeInTheDocument();

    expect(tab1).toHaveAttribute('id', 'tab-root:file1');
    expect(tab1).toHaveAttribute('aria-controls', 'panel-root:file1');
    expect(tab2).toHaveAttribute('id', 'tab-root:file2');
    expect(tab2).toHaveAttribute('aria-controls', 'panel-root:file2');
  });

  it('should set correct ids and aria attributes on panels', () => {
    const tabs: FileTab[] = [
      {
        id: 'root:file1',
        compositeKey: 'file1',
        path: '/src/index.ts',
        content: null,
        isLoading: false,
      },
      {
        id: 'root:file2',
        compositeKey: 'file2',
        path: '/src/app.ts',
        content: null,
        isLoading: false,
      },
    ];
    mockProps.decodeFileSelection.mockImplementation((key) => {
      if (key === 'file1') {
        return { folderId: 'f', path: '/src/index.ts' };
      }
      if (key === 'file2') {
        return { folderId: 'f', path: '/src/app.ts' };
      }
      return { folderId: 'f', path: 'unknown' };
    });

    render(<TabbedFileEditor {...mockProps} activeTabId="root:file1" tabs={tabs} />);

    const panel1 = screen.getByRole('tabpanel', { name: 'index.ts' });
    const panel2 = document.getElementById('panel-root:file2') as HTMLElement;

    expect(panel1).toHaveAttribute('id', 'panel-root:file1');
    expect(panel1).toHaveAttribute('aria-labelledby', 'tab-root:file1');
    expect(panel1).not.toHaveAttribute('hidden');

    expect(panel2).toHaveAttribute('id', 'panel-root:file2');
    expect(panel2).toHaveAttribute('aria-labelledby', 'tab-root:file2');
    expect(panel2).toHaveAttribute('hidden');
  });

  it('should show active tab with proper styling', () => {
    const tabs: FileTab[] = [
      {
        id: 'root:file1',
        compositeKey: 'file1',
        path: '/src/index.ts',
        content: 'const x = 1;',
        isLoading: false,
      },
      {
        id: 'root:file2',
        compositeKey: 'file2',
        path: '/src/app.ts',
        content: 'const y = 2;',
        isLoading: false,
      },
    ];
    mockProps.decodeFileSelection.mockImplementation((key) => {
      if (key === 'file1') {
        return { folderId: 'f', path: '/src/index.ts' };
      }
      if (key === 'file2') {
        return { folderId: 'f', path: '/src/app.ts' };
      }
      return { folderId: 'f', path: 'unknown' };
    });

    render(<TabbedFileEditor {...mockProps} activeTabId="root:file1" tabs={tabs} />);

    const activeTab = screen.getByRole('tab', { name: 'index.ts', selected: true });
    // The active tab's direct container has a border class that makes it visually distinct
    expect(activeTab.closest('[role="presentation"]')).toHaveClass('border-border');
  });

  it('should handle tab click', async () => {
    const user = userEvent.setup();
    const tabs: FileTab[] = [
      {
        id: 'root:file1',
        compositeKey: 'file1',
        path: '/src/index.ts',
        content: null,
        isLoading: false,
      },
      {
        id: 'root:file2',
        compositeKey: 'file2',
        path: '/src/app.ts',
        content: null,
        isLoading: false,
      },
    ];
    mockProps.decodeFileSelection.mockImplementation((key) => {
      if (key === 'file1') {
        return { folderId: 'f', path: '/src/index.ts' };
      }
      if (key === 'file2') {
        return { folderId: 'f', path: '/src/app.ts' };
      }
      return { folderId: 'f', path: 'unknown' };
    });

    render(<TabbedFileEditor {...mockProps} activeTabId="root:file1" tabs={tabs} />);

    const tab2 = screen.getByRole('tab', { name: 'app.ts' });
    await user.click(tab2);

    expect(mockProps.onTabClick).toHaveBeenCalledWith('root:file2');
  });

  it('should handle tab close', async () => {
    const user = userEvent.setup();
    const tabs: FileTab[] = [
      {
        id: 'root:file1',
        compositeKey: 'file1',
        path: '/src/index.ts',
        content: null,
        isLoading: false,
      },
    ];
    mockProps.decodeFileSelection.mockImplementation((key) => {
      if (key === 'file1') {
        return { folderId: 'f', path: '/src/index.ts' };
      }
      return { folderId: 'f', path: 'unknown' };
    });

    render(<TabbedFileEditor {...mockProps} activeTabId="root:file1" tabs={tabs} />);

    const closeButton = screen.getByTitle('Close index.ts');
    await user.click(closeButton);

    expect(mockProps.onTabClose).toHaveBeenCalledWith('root:file1');
  });

  it('should show loading state for tabs', () => {
    const tabs: FileTab[] = [
      {
        id: 'root:file1',
        compositeKey: 'file1',
        path: '/src/index.ts',
        content: null,
        isLoading: true,
      },
    ];
    mockProps.decodeFileSelection.mockImplementation((key) => {
      if (key === 'file1') {
        return { folderId: 'f', path: '/src/index.ts' };
      }
      return { folderId: 'f', path: 'unknown' };
    });

    render(
      <TabbedFileEditor
        {...mockProps}
        activeTabId="root:file1"
        loadingFiles={new Set(['file1'])}
        tabs={tabs}
      />
    );

    // Check for loading spinner in tab
    const tabButton = screen.getByRole('tab', { name: 'index.ts' });
    expect(tabButton.querySelector('.animate-spin')).toBeInTheDocument();

    // Check for loading text in content area
    expect(screen.getByText('Loading file content...')).toBeInTheDocument();
  });

  it('should display file content when loaded', () => {
    const tabs: FileTab[] = [
      {
        id: 'root:file1',
        compositeKey: 'file1',
        path: '/src/index.ts',
        content: 'const x = 42;',
        isLoading: false,
      },
    ];
    mockProps.decodeFileSelection.mockImplementation((key) => {
      if (key === 'file1') {
        return { folderId: 'f', path: '/src/index.ts' };
      }
      return { folderId: 'f', path: 'unknown' };
    });
    const fileContents = {
      file1: 'const x = 42;',
    };

    render(
      <TabbedFileEditor
        {...mockProps}
        activeTabId="root:file1"
        fileContents={fileContents}
        tabs={tabs}
      />
    );

    expect(screen.getByText('const x = 42;')).toBeInTheDocument();
  });

  it('should display error message for inaccessible files', () => {
    const tabs: FileTab[] = [
      {
        id: 'root:file1',
        compositeKey: 'file1',
        path: '/src/index.ts',
        content: 'File not accessible',
        isLoading: false,
      },
    ];
    mockProps.decodeFileSelection.mockImplementation((_key) => ({
      folderId: 'f',
      path: '/src/index.ts',
    }));
    const fileContents = {
      file1: 'File not accessible: Permission denied',
    };

    render(
      <TabbedFileEditor
        {...mockProps}
        activeTabId="root:file1"
        fileContents={fileContents}
        tabs={tabs}
      />
    );

    expect(screen.getByText(/File not accessible/)).toBeInTheDocument();
    expect(screen.getByText(/This is a security measure of your browser/)).toBeInTheDocument();
  });

  it('should trigger content loading when active tab changes', () => {
    const tabs: FileTab[] = [
      {
        id: 'root:file1',
        compositeKey: 'file1',
        path: '/src/index.ts',
        content: null,
        isLoading: false,
      },
      {
        id: 'root:file2',
        compositeKey: 'file2',
        path: '/src/app.ts',
        content: null,
        isLoading: false,
      },
    ];
    mockProps.decodeFileSelection.mockImplementation((_key) => ({ folderId: 'f', path: 'p' }));

    const { rerender } = render(
      <TabbedFileEditor {...mockProps} activeTabId="root:file1" tabs={tabs} />
    );
    expect(mockProps.onLoadFileContent).toHaveBeenCalledWith('file1');

    // Change active tab to file2
    rerender(<TabbedFileEditor {...mockProps} activeTabId="root:file2" tabs={tabs} />);

    expect(mockProps.onLoadFileContent).toHaveBeenCalledWith('file2');
  });

  it('should not load content if already loading', () => {
    const tabs: FileTab[] = [
      {
        id: 'root:file1',
        compositeKey: 'file1',
        path: '/src/index.ts',
        content: null,
        isLoading: true,
      },
    ];
    mockProps.decodeFileSelection.mockImplementation((_key) => ({ folderId: 'f', path: 'p' }));

    render(
      <TabbedFileEditor
        {...mockProps}
        activeTabId="root:file1"
        loadingFiles={new Set(['file1'])}
        tabs={tabs}
      />
    );

    expect(mockProps.onLoadFileContent).not.toHaveBeenCalled();
  });

  it('should not load content if already loaded', () => {
    const tabs: FileTab[] = [
      {
        id: 'root:file1',
        compositeKey: 'file1',
        path: '/src/index.ts',
        content: 'content',
        isLoading: false,
      },
    ];
    mockProps.decodeFileSelection.mockImplementation((_key) => ({ folderId: 'f', path: 'p' }));

    const fileContents = {
      file1: 'const x = 42;',
    };

    render(
      <TabbedFileEditor
        {...mockProps}
        activeTabId="root:file1"
        fileContents={fileContents}
        tabs={tabs}
      />
    );

    expect(mockProps.onLoadFileContent).not.toHaveBeenCalled();
  });

  it('should handle long file names with truncation', () => {
    const longPath =
      '/src/components/very/long/path/to/deeply/nested/ComponentWithReallyLongName.tsx';
    const tabs: FileTab[] = [
      {
        id: 'root:file1',
        compositeKey: 'file1',
        path: longPath,
        content: null,
        isLoading: false,
      },
    ];
    mockProps.decodeFileSelection.mockImplementation((_key) => ({ folderId: 'f', path: longPath }));

    render(<TabbedFileEditor {...mockProps} activeTabId="root:file1" tabs={tabs} />);

    const tabButton = screen.getByRole('tab', { name: 'ComponentWithReallyLongName.tsx' });
    expect(tabButton.querySelector('span')).toHaveClass('truncate');
  });

  it('should open the overflow menu and trigger Close All', async () => {
    const user = userEvent.setup();
    const closeAll = vi.fn();
    const tabStripActions: TabStripAction[] = [
      {
        id: 'close-all',
        label: 'Close All',
        enabled: true,
        onSelect: closeAll,
      },
    ];

    render(<TabbedFileEditor {...mockProps} tabStripActions={tabStripActions} />);

    const menuButton = screen.getByRole('button', { name: 'More actions' });
    await user.click(menuButton);

    const menuItem = screen.getByRole('menuitem', { name: 'Close All' });
    await user.click(menuItem);

    expect(closeAll).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.queryByRole('menuitem', { name: 'Close All' })).not.toBeInTheDocument();
    });
  });

  it('should disable Close All when there are no tabs', async () => {
    const user = userEvent.setup();
    const tabStripActions: TabStripAction[] = [
      {
        id: 'close-all',
        label: 'Close All',
        enabled: false,
        onSelect: vi.fn(),
      },
    ];

    render(<TabbedFileEditor {...mockProps} tabStripActions={tabStripActions} />);

    const menuButton = screen.getByRole('button', { name: 'More actions' });
    await user.click(menuButton);

    const menuItem = screen.getByRole('menuitem', { name: 'Close All' });
    expect(menuItem).toHaveAttribute('aria-disabled', 'true');
  });

  it('should close the overflow menu on Escape and return focus', async () => {
    const user = userEvent.setup();
    const tabStripActions: TabStripAction[] = [
      {
        id: 'close-all',
        label: 'Close All',
        enabled: true,
        onSelect: vi.fn(),
      },
    ];

    render(<TabbedFileEditor {...mockProps} tabStripActions={tabStripActions} />);

    const menuButton = screen.getByRole('button', { name: 'More actions' });
    await user.click(menuButton);

    expect(screen.getByRole('menuitem', { name: 'Close All' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('menuitem', { name: 'Close All' })).not.toBeInTheDocument();
    });

    expect(menuButton).toHaveFocus();
  });

  // Additional tests can be added here for hotkeys, etc.
});
