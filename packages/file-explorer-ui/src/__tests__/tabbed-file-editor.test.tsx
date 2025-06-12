import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileTab } from '../hooks/use-tab-manager';
import { TabbedFileEditor } from '../tabbed-file-editor';

describe('TabbedFileEditor', () => {
  let mockProps: {
    tabs: FileTab[];
    activeTabId: string | null;
    fileContents: Record<string, string>;
    loadingFiles: Set<string>;
    onTabClick: ReturnType<typeof vi.fn>;
    onTabClose: ReturnType<typeof vi.fn>;
    onLoadFileContent: ReturnType<typeof vi.fn>;
    decodeFileSelection: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    // Mock scrollIntoView as it's not implemented in JSDOM
    window.HTMLElement.prototype.scrollIntoView = vi.fn();

    mockProps = {
      tabs: [] as FileTab[],
      activeTabId: null,
      fileContents: {},
      loadingFiles: new Set<string>(),
      onTabClick: vi.fn(),
      onTabClose: vi.fn(),
      onLoadFileContent: vi.fn(),
      decodeFileSelection: vi.fn((key) => ({ folderId: 'root', path: key.split(':')[1] })),
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
      if (key === 'file1') return { folderId: 'f', path: '/src/index.ts' };
      if (key === 'file2') return { folderId: 'f', path: '/src/components/Button.tsx' };
      return { folderId: 'f', path: 'unknown' };
    });

    render(<TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="root:file1" />);

    expect(screen.getByRole('tab', { name: 'index.ts' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Button.tsx' })).toBeInTheDocument();
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
      if (key === 'file1') return { folderId: 'f', path: '/src/index.ts' };
      if (key === 'file2') return { folderId: 'f', path: '/src/app.ts' };
      return { folderId: 'f', path: 'unknown' };
    });

    render(<TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="root:file1" />);

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
      if (key === 'file1') return { folderId: 'f', path: '/src/index.ts' };
      if (key === 'file2') return { folderId: 'f', path: '/src/app.ts' };
      return { folderId: 'f', path: 'unknown' };
    });

    render(<TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="root:file1" />);

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
      if (key === 'file1') return { folderId: 'f', path: '/src/index.ts' };
      return { folderId: 'f', path: 'unknown' };
    });

    render(<TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="root:file1" />);

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
      if (key === 'file1') return { folderId: 'f', path: '/src/index.ts' };
      return { folderId: 'f', path: 'unknown' };
    });

    render(
      <TabbedFileEditor
        {...mockProps}
        tabs={tabs}
        activeTabId="root:file1"
        loadingFiles={new Set(['file1'])}
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
      if (key === 'file1') return { folderId: 'f', path: '/src/index.ts' };
      return { folderId: 'f', path: 'unknown' };
    });
    const fileContents = {
      file1: 'const x = 42;',
    };

    render(
      <TabbedFileEditor
        {...mockProps}
        tabs={tabs}
        activeTabId="root:file1"
        fileContents={fileContents}
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
        tabs={tabs}
        activeTabId="root:file1"
        fileContents={fileContents}
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
      <TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="root:file1" />
    );
    expect(mockProps.onLoadFileContent).toHaveBeenCalledWith('file1');

    // Change active tab to file2
    rerender(<TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="root:file2" />);

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
        tabs={tabs}
        activeTabId="root:file1"
        loadingFiles={new Set(['file1'])}
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
        tabs={tabs}
        activeTabId="root:file1"
        fileContents={fileContents}
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

    render(<TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="root:file1" />);

    const tabButton = screen.getByRole('tab', { name: 'ComponentWithReallyLongName.tsx' });
    expect(tabButton.querySelector('span')).toHaveClass('truncate');
  });

  // Additional tests can be added here for hotkeys, etc.
});
