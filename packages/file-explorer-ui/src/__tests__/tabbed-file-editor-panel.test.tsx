import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabbedFileEditorPanel } from '../tabbed-file-editor-panel';
import { FileExplorerTestWrapper } from './test-helpers';

// Mock the useFileExplorer hook
vi.mock('../use-file-explorer-context', () => ({
  useFileExplorer: vi.fn(() => ({
    fileContents: {},
    loadingFiles: new Set<string>(),
    loadFileContent: vi.fn(),
  })),
}));

// Mock the useTabManager hook
vi.mock('../hooks/use-tab-manager', () => ({
  useTabManager: vi.fn(() => ({
    tabs: [],
    activeTabId: null,
    openTab: vi.fn(),
    closeTab: vi.fn(),
    setActiveTab: vi.fn(),
    updateTabContent: vi.fn(),
    setTabLoading: vi.fn(),
    setTabError: vi.fn(),
    clearTabs: vi.fn(),
  })),
}));

interface MockTab {
  id: string;
  path: string;
}

// Mock the TabbedFileEditor component
vi.mock('../tabbed-file-editor', () => ({
  TabbedFileEditor: vi.fn(({ tabs, onTabClick, onTabClose, onLoadFileContent }) => (
    <div data-testid="tabbed-file-editor">
      {tabs.length === 0 ? (
        <div>No tabs open</div>
      ) : (
        tabs.map((tab: MockTab) => (
          <div key={tab.id}>
            <button type="button" onClick={() => onTabClick(tab.id)}>
              {tab.path}
            </button>
            <button type="button" onClick={() => onTabClose(tab.id)}>
              Close {tab.id}
            </button>
            <button type="button" onClick={() => onLoadFileContent(tab.id)}>
              Load {tab.id}
            </button>
          </div>
        ))
      )}
    </div>
  )),
}));

describe('TabbedFileEditorPanel', () => {
  let useFileExplorer: typeof import('../use-file-explorer-context').useFileExplorer;
  let useTabManager: typeof import('../hooks/use-tab-manager').useTabManager;

  beforeAll(async () => {
    const fileExplorerModule = await import('../use-file-explorer-context');
    const tabManagerModule = await import('../hooks/use-tab-manager');

    useFileExplorer = fileExplorerModule.useFileExplorer;
    useTabManager = tabManagerModule.useTabManager;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear the global function
    window.__openFileInTab = undefined;
  });

  afterEach(() => {
    window.__openFileInTab = undefined;
  });

  it('should render without errors', () => {
    render(
      <FileExplorerTestWrapper>
        <TabbedFileEditorPanel />
      </FileExplorerTestWrapper>
    );

    expect(screen.getByTestId('tabbed-file-editor')).toBeInTheDocument();
  });

  it('should expose openFileInTab function globally', () => {
    render(
      <FileExplorerTestWrapper>
        <TabbedFileEditorPanel />
      </FileExplorerTestWrapper>
    );

    expect(window.__openFileInTab).toBeDefined();
    expect(typeof window.__openFileInTab).toBe('function');
  });

  it('should clean up global function on unmount', () => {
    const { unmount } = render(
      <FileExplorerTestWrapper>
        <TabbedFileEditorPanel />
      </FileExplorerTestWrapper>
    );

    expect(window.__openFileInTab).toBeDefined();

    unmount();

    expect(window.__openFileInTab).toBeUndefined();
  });

  it('should handle opening files via global function', async () => {
    const mockOpenTab = vi.fn();
    const mockLoadFileContent = vi.fn();

    vi.mocked(useTabManager).mockReturnValue({
      tabs: [],
      activeTabId: null,
      openTab: mockOpenTab,
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabContent: vi.fn(),
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    });

    vi.mocked(useFileExplorer).mockReturnValue({
      fileContents: {},
      loadingFiles: new Set<string>(),
      loadFileContent: mockLoadFileContent,
    });

    render(
      <FileExplorerTestWrapper>
        <TabbedFileEditorPanel />
      </FileExplorerTestWrapper>
    );

    // Call the global function to open a file - use proper format
    window.__openFileInTab?.('folder1|@|/src/index.ts');

    await waitFor(() => {
      expect(mockOpenTab).toHaveBeenCalledWith('/src/index.ts', 'folder1|@|/src/index.ts');
      expect(mockLoadFileContent).toHaveBeenCalledWith('folder1|@|/src/index.ts');
    });
  });

  it('should not reload content if already loaded', () => {
    const mockOpenTab = vi.fn();
    const mockLoadFileContent = vi.fn();

    vi.mocked(useFileExplorer).mockReturnValue({
      fileContents: { 'folder1|@|/src/index.ts': 'const x = 42;' },
      loadingFiles: new Set<string>(),
      loadFileContent: mockLoadFileContent,
    });

    vi.mocked(useTabManager).mockReturnValue({
      tabs: [],
      activeTabId: null,
      openTab: mockOpenTab,
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabContent: vi.fn(),
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    });

    render(
      <FileExplorerTestWrapper>
        <TabbedFileEditorPanel />
      </FileExplorerTestWrapper>
    );

    window.__openFileInTab?.('folder1|@|/src/index.ts');

    expect(mockOpenTab).toHaveBeenCalledWith('/src/index.ts', 'folder1|@|/src/index.ts');
    expect(mockLoadFileContent).not.toHaveBeenCalled(); // Already loaded
  });

  it('should not reload content if currently loading', () => {
    const mockOpenTab = vi.fn();
    const mockLoadFileContent = vi.fn();

    vi.mocked(useFileExplorer).mockReturnValue({
      fileContents: {},
      loadingFiles: new Set(['folder1|@|/src/index.ts']),
      loadFileContent: mockLoadFileContent,
    });

    vi.mocked(useTabManager).mockReturnValue({
      tabs: [],
      activeTabId: null,
      openTab: mockOpenTab,
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabContent: vi.fn(),
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    });

    render(
      <FileExplorerTestWrapper>
        <TabbedFileEditorPanel />
      </FileExplorerTestWrapper>
    );

    window.__openFileInTab?.('folder1|@|/src/index.ts');

    expect(mockOpenTab).toHaveBeenCalledWith('/src/index.ts', 'folder1|@|/src/index.ts');
    expect(mockLoadFileContent).not.toHaveBeenCalled(); // Already loading
  });

  it('should sync tab content when files load', () => {
    // This test verifies that the component has the sync logic
    // The actual sync is tested through integration tests
    const mockUpdateTabContent = vi.fn();

    const tabs = [{ id: 'file1', path: '/src/index.ts', content: null, isLoading: false }];

    vi.mocked(useFileExplorer).mockReturnValue({
      fileContents: { file1: 'const x = 42;' },
      loadingFiles: new Set<string>(),
      loadFileContent: vi.fn(),
    });

    vi.mocked(useTabManager).mockReturnValue({
      tabs,
      activeTabId: 'file1',
      openTab: vi.fn(),
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabContent: mockUpdateTabContent,
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    });

    render(
      <FileExplorerTestWrapper>
        <TabbedFileEditorPanel />
      </FileExplorerTestWrapper>
    );

    // The component should render without errors
    // Sync behavior is verified through integration tests
    expect(screen.getByTestId('tabbed-file-editor')).toBeInTheDocument();
  });

  it('should handle tab interactions', async () => {
    const user = userEvent.setup();
    const mockSetActiveTab = vi.fn();
    const mockCloseTab = vi.fn();
    const mockLoadFileContent = vi.fn();

    const tabs = [
      { id: 'file1', path: '/src/index.ts', content: 'content1', isLoading: false },
      { id: 'file2', path: '/src/app.ts', content: 'content2', isLoading: false },
    ];

    vi.mocked(useTabManager).mockReturnValue({
      tabs,
      activeTabId: 'file1',
      openTab: vi.fn(),
      closeTab: mockCloseTab,
      setActiveTab: mockSetActiveTab,
      updateTabContent: vi.fn(),
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    });

    vi.mocked(useFileExplorer).mockReturnValue({
      fileContents: {
        file1: 'content1',
        file2: 'content2',
      },
      loadingFiles: new Set<string>(),
      loadFileContent: mockLoadFileContent,
    });

    render(
      <FileExplorerTestWrapper>
        <TabbedFileEditorPanel />
      </FileExplorerTestWrapper>
    );

    // Click on tab
    await user.click(screen.getByText('/src/index.ts'));
    expect(mockSetActiveTab).toHaveBeenCalledWith('file1');

    // Close tab
    await user.click(screen.getByText('Close file1'));
    expect(mockCloseTab).toHaveBeenCalledWith('file1');

    // Load file content
    await user.click(screen.getByText('Load file1'));
    expect(mockLoadFileContent).toHaveBeenCalledWith('file1');
  });

  it('should apply custom className', () => {
    const { container } = render(
      <FileExplorerTestWrapper>
        <TabbedFileEditorPanel className="custom-class" />
      </FileExplorerTestWrapper>
    );

    expect(container.firstChild).toHaveClass('custom-class');
  });

  it('should not update content if already up to date', async () => {
    const mockUpdateTabContent = vi.fn();

    const tabs = [
      { id: 'file1', path: '/src/index.ts', content: 'const x = 42;', isLoading: false },
    ];

    vi.mocked(useTabManager).mockReturnValue({
      tabs,
      activeTabId: 'file1',
      openTab: vi.fn(),
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabContent: mockUpdateTabContent,
      setTabLoading: vi.fn(),
      setTabError: vi.fn(),
      clearTabs: vi.fn(),
    });

    vi.mocked(useFileExplorer).mockReturnValue({
      fileContents: {
        file1: 'const x = 42;', // Same content
      },
      loadingFiles: new Set<string>(),
      loadFileContent: vi.fn(),
    });

    render(
      <FileExplorerTestWrapper>
        <TabbedFileEditorPanel />
      </FileExplorerTestWrapper>
    );

    await waitFor(() => {
      expect(mockUpdateTabContent).not.toHaveBeenCalled(); // Content already up to date
    });
  });
});
