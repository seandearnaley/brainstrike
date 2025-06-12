import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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
    mockProps = {
      tabs: [] as FileTab[],
      activeTabId: null,
      fileContents: {},
      loadingFiles: new Set<string>(),
      onTabClick: vi.fn(),
      onTabClose: vi.fn(),
      onLoadFileContent: vi.fn(),
      decodeFileSelection: vi.fn((key: string) => ({
        folderId: 'folder1',
        path: key.split(':')[1] || key,
      })),
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
      { id: 'file1', path: '/src/index.ts', content: null, isLoading: false },
      { id: 'file2', path: '/src/components/Button.tsx', content: null, isLoading: false },
    ];

    render(<TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="file1" />);

    expect(screen.getByRole('button', { name: 'index.ts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Button.tsx' })).toBeInTheDocument();
  });

  it('should show active tab with proper styling', () => {
    const tabs: FileTab[] = [
      { id: 'file1', path: '/src/index.ts', content: 'const x = 1;', isLoading: false },
      { id: 'file2', path: '/src/app.ts', content: 'const y = 2;', isLoading: false },
    ];

    const fileContents = {
      file1: 'const x = 1;',
      file2: 'const y = 2;',
    };

    render(
      <TabbedFileEditor
        {...mockProps}
        tabs={tabs}
        activeTabId="file1"
        fileContents={fileContents}
      />
    );

    const activeTab = screen.getByRole('button', { name: 'index.ts' });
    expect(activeTab.parentElement).toHaveClass('bg-background');
  });

  it('should handle tab click', async () => {
    const user = userEvent.setup();
    const tabs: FileTab[] = [
      { id: 'file1', path: '/src/index.ts', content: null, isLoading: false },
      { id: 'file2', path: '/src/app.ts', content: null, isLoading: false },
    ];

    render(<TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="file1" />);

    const tab2 = screen.getByRole('button', { name: 'app.ts' });
    await user.click(tab2);

    expect(mockProps.onTabClick).toHaveBeenCalledWith('file2');
  });

  it('should handle tab close', async () => {
    const user = userEvent.setup();
    const tabs: FileTab[] = [
      { id: 'file1', path: '/src/index.ts', content: null, isLoading: false },
    ];

    render(<TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="file1" />);

    const closeButton = screen.getByTitle('Close index.ts');
    await user.click(closeButton);

    expect(mockProps.onTabClose).toHaveBeenCalledWith('file1');
  });

  it('should show loading state for tabs', () => {
    const tabs: FileTab[] = [
      { id: 'file1', path: '/src/index.ts', content: null, isLoading: true },
    ];

    render(
      <TabbedFileEditor
        {...mockProps}
        tabs={tabs}
        activeTabId="file1"
        loadingFiles={new Set(['file1'])}
      />
    );

    // Check for loading spinner in tab
    const tabButton = screen.getByRole('button', { name: 'index.ts' });
    expect(tabButton.querySelector('.animate-spin')).toBeInTheDocument();

    // Check for loading text in content area
    expect(screen.getByText('Loading file content...')).toBeInTheDocument();
  });

  it('should display file content when loaded', () => {
    const tabs: FileTab[] = [
      { id: 'file1', path: '/src/index.ts', content: 'const x = 42;', isLoading: false },
    ];

    const fileContents = {
      file1: 'const x = 42;',
    };

    render(
      <TabbedFileEditor
        {...mockProps}
        tabs={tabs}
        activeTabId="file1"
        fileContents={fileContents}
      />
    );

    expect(screen.getByText('const x = 42;')).toBeInTheDocument();
  });

  it('should display error message for inaccessible files', () => {
    const tabs: FileTab[] = [
      { id: 'file1', path: '/src/index.ts', content: 'File not accessible', isLoading: false },
    ];

    const fileContents = {
      file1: 'File not accessible: Permission denied',
    };

    render(
      <TabbedFileEditor
        {...mockProps}
        tabs={tabs}
        activeTabId="file1"
        fileContents={fileContents}
      />
    );

    expect(screen.getByText(/File not accessible/)).toBeInTheDocument();
    expect(
      screen.getByText(/To access this file, please open the folder again/)
    ).toBeInTheDocument();
  });

  it('should trigger content loading when active tab changes', () => {
    const tabs: FileTab[] = [
      { id: 'file1', path: '/src/index.ts', content: null, isLoading: false },
      { id: 'file2', path: '/src/app.ts', content: null, isLoading: false },
    ];

    const { rerender } = render(
      <TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="file1" />
    );

    // Change active tab to file2
    rerender(<TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="file2" />);

    expect(mockProps.onLoadFileContent).toHaveBeenCalledWith('file2');
  });

  it('should not load content if already loading', () => {
    const tabs: FileTab[] = [
      { id: 'file1', path: '/src/index.ts', content: null, isLoading: true },
    ];

    render(
      <TabbedFileEditor
        {...mockProps}
        tabs={tabs}
        activeTabId="file1"
        loadingFiles={new Set(['file1'])}
      />
    );

    expect(mockProps.onLoadFileContent).not.toHaveBeenCalled();
  });

  it('should not load content if already loaded', () => {
    const tabs: FileTab[] = [
      { id: 'file1', path: '/src/index.ts', content: 'content', isLoading: false },
    ];

    const fileContents = {
      file1: 'const x = 42;',
    };

    render(
      <TabbedFileEditor
        {...mockProps}
        tabs={tabs}
        activeTabId="file1"
        fileContents={fileContents}
      />
    );

    expect(mockProps.onLoadFileContent).not.toHaveBeenCalled();
  });

  it('should show file path in header', () => {
    const tabs: FileTab[] = [
      { id: 'file1', path: '/src/components/Button.tsx', content: null, isLoading: false },
    ];

    render(<TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="file1" />);

    expect(screen.getByText('/src/components/Button.tsx')).toBeInTheDocument();
  });

  it('should handle long file names with truncation', () => {
    const tabs: FileTab[] = [
      {
        id: 'file1',
        path: '/src/components/very/long/path/to/deeply/nested/ComponentWithReallyLongName.tsx',
        content: null,
        isLoading: false,
      },
    ];

    render(<TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="file1" />);

    const tabButton = screen.getByRole('button', { name: 'ComponentWithReallyLongName.tsx' });
    expect(tabButton).toBeInTheDocument();
    expect(tabButton.querySelector('.truncate')).toBeInTheDocument();
  });

  it('should handle tabs with file icons', () => {
    const tabs: FileTab[] = [
      { id: 'file1', path: '/src/index.ts', content: null, isLoading: false },
      { id: 'file2', path: '/src/app.ts', content: null, isLoading: false },
    ];

    render(<TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="file1" />);

    // Check that file icons are rendered
    const tabButtons = screen.getAllByRole('button', { name: /\.ts$/ });
    for (const button of tabButtons) {
      expect(button.querySelector('svg')).toBeInTheDocument();
    }
  });

  it('should show "No content available" for empty content', () => {
    const tabs: FileTab[] = [
      { id: 'file1', path: '/src/index.ts', content: null, isLoading: false },
    ];

    render(<TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="file1" />);

    expect(screen.getByText('No content available')).toBeInTheDocument();
  });

  it('should handle binary file messages', () => {
    const tabs: FileTab[] = [
      { id: 'file1', path: '/assets/image.png', content: 'Binary file', isLoading: false },
    ];

    const fileContents = {
      file1: 'Binary file: Cannot display binary content',
    };

    render(
      <TabbedFileEditor
        {...mockProps}
        tabs={tabs}
        activeTabId="file1"
        fileContents={fileContents}
      />
    );

    expect(screen.getByText(/Binary file/)).toBeInTheDocument();
  });

  it('should stop event propagation on close button click', async () => {
    const user = userEvent.setup();
    const tabs: FileTab[] = [
      { id: 'file1', path: '/src/index.ts', content: null, isLoading: false },
    ];

    render(<TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="file1" />);

    const closeButton = screen.getByTitle('Close index.ts');
    await user.click(closeButton);

    // onTabClick should not be called when clicking close button
    expect(mockProps.onTabClick).not.toHaveBeenCalled();
    expect(mockProps.onTabClose).toHaveBeenCalledWith('file1');
  });

  it('should handle scrollable tab bar for many tabs', () => {
    const tabs: FileTab[] = Array.from({ length: 20 }, (_, i) => ({
      id: `file${i}`,
      path: `/src/file${i}.ts`,
      content: null,
      isLoading: false,
    }));

    const { container } = render(
      <TabbedFileEditor {...mockProps} tabs={tabs} activeTabId="file0" />
    );

    const tabContainer = container.querySelector('.overflow-x-auto');
    expect(tabContainer).toBeInTheDocument();
    expect(tabContainer).toHaveClass('scrollbar-thin');
  });
});
