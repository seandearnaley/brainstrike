import React from 'react';
import { render, screen, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { FileExplorerLeftPanel, FileExplorerLeftPanelProps } from '../file-explorer-left-panel';
import { useFileExplorerStoreContext } from '../file-explorer-provider';
import { useFileFilters } from '../../hooks/use-file-filters'; // Assuming path
import { FileTree } from '../file-tree';
import { FileFilterBar } from '../file-filter-bar';
import { FileExplorerToolbar } from '../file-explorer-toolbar';

// --- Mock Child Components ---
vi.mock('../file-tree', () => ({
  FileTree: vi.fn(() => <div data-testid="mock-file-tree"></div>),
}));
vi.mock('../file-filter-bar', () => ({
  FileFilterBar: vi.fn(({ onFilterChange, onExtensionFilterChange, onRegexToggle, currentFilter, currentExtensionFilter, isRegex }) => (
    <div data-testid="mock-file-filter-bar">
      <input
        data-testid="filter-text-input"
        type="text"
        value={currentFilter}
        onChange={(e) => onFilterChange(e.target.value)}
      />
      <input
        data-testid="filter-extension-input"
        type="text"
        value={currentExtensionFilter.join(',')}
        onChange={(e) => onExtensionFilterChange(e.target.value.split(','))}
      />
      <button data-testid="regex-toggle-button" onClick={() => onRegexToggle(!isRegex)}>
        Regex: {isRegex ? 'On' : 'Off'}
      </button>
    </div>
  )),
}));
vi.mock('../file-explorer-toolbar', () => ({
  FileExplorerToolbar: vi.fn(({ onRefresh, onCollapseAll, onClearFilters }) => (
    <div data-testid="mock-file-toolbar">
      <button data-testid="refresh-button" onClick={onRefresh}>Refresh</button>
      <button data-testid="collapse-all-button" onClick={onCollapseAll}>Collapse All</button>
      <button data-testid="clear-filters-button" onClick={onClearFilters}>Clear Filters</button>
    </div>
  )),
}));

// --- Mock Hooks ---
const mockUseFileFiltersState = {
  filter: '',
  setFilter: vi.fn(),
  extensionFilter: [],
  setExtensionFilter: vi.fn(),
  isRegex: false,
  setIsRegex: vi.fn(),
  clearFilters: vi.fn(),
};
vi.mock('../../hooks/use-file-filters', () => ({
  useFileFilters: vi.fn(() => mockUseFileFiltersState),
}));

const mockStoreState = {
  // Mock any relevant store state that FileExplorerLeftPanel might use
  // e.g., settings for MaxSelectionCountSetting, etc.
  refreshFileTree: vi.fn(),
  collapseAllFolders: vi.fn(),
  maxSelectionCount: 100,
  updateMaxSelectionCount: vi.fn(),
  showFolderSummaryThreshold: 5,
  updateShowFolderSummaryThreshold: vi.fn(),
  includeProjectTree: true,
  updateIncludeProjectTree: vi.fn(),
  // ... other store state / actions
};
const mockUseFileExplorerStoreContext = vi.fn();
vi.mock('../file-explorer-provider', () => ({
  useFileExplorerStoreContext: mockUseFileExplorerStoreContext,
}));


const defaultProps: FileExplorerLeftPanelProps = {
  folderId: 'test-folder-id',
  isLoading: false,
  error: null,
  // Add any other required props, mock them if necessary
};

describe('FileExplorerLeftPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock states
    mockUseFileFiltersState.filter = '';
    mockUseFileFiltersState.extensionFilter = [];
    mockUseFileFiltersState.isRegex = false;
    mockUseFileFiltersState.setFilter.mockImplementation((val) => mockUseFileFiltersState.filter = val);
    mockUseFileFiltersState.setExtensionFilter.mockImplementation((val) => mockUseFileFiltersState.extensionFilter = val);
    mockUseFileFiltersState.setIsRegex.mockImplementation((val) => mockUseFileFiltersState.isRegex = val);
    mockUseFileFiltersState.clearFilters.mockImplementation(() => {
        mockUseFileFiltersState.filter = '';
        mockUseFileFiltersState.extensionFilter = [];
        mockUseFileFiltersState.isRegex = false;
    });


    mockUseFileExplorerStoreContext.mockImplementation(selector => selector(mockStoreState));
  });

  const renderPanel = (props: Partial<FileExplorerLeftPanelProps> = {}) => {
    return render(<FileExplorerLeftPanel {...defaultProps} {...props} />);
  };

  describe('Integration with FileFilterBar', () => {
    it('updates text filter and passes it to FileTree', async () => {
      const user = userEvent.setup();
      renderPanel();
      
      const filterInput = screen.getByTestId('filter-text-input');
      await user.type(filterInput, 'searchTerm');
      
      expect(mockUseFileFiltersState.setFilter).toHaveBeenCalledWith('searchTerm');
      // FileTree mock should be called with props reflecting the new filter
      // Need to wait for re-render if filter update is async (usually not with simple setState)
      // The FileTree mock is called on each render, so the last call matters.
      expect(FileTree).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filter: 'searchTerm',
          // folderId: defaultProps.folderId, // This also gets passed
        }),
        {}
      );
    });

    it('updates extension filter and passes it to FileTree', async () => {
      const user = userEvent.setup();
      renderPanel();
      
      const extensionInput = screen.getByTestId('filter-extension-input');
      await user.clear(extensionInput); // Clear default empty value if any
      await user.type(extensionInput, '.ts,.tsx');
      
      expect(mockUseFileFiltersState.setExtensionFilter).toHaveBeenCalledWith(['.ts', '.tsx']);
      expect(FileTree).toHaveBeenLastCalledWith(
        expect.objectContaining({ extensionFilter: ['.ts', '.tsx'] }),
        {}
      );
    });

    it('toggles regex filter and passes it to FileTree', async () => {
      const user = userEvent.setup();
      renderPanel(); // Initial isRegex = false
      
      const regexButton = screen.getByTestId('regex-toggle-button');
      await user.click(regexButton);
      
      expect(mockUseFileFiltersState.setIsRegex).toHaveBeenCalledWith(true);
      expect(FileTree).toHaveBeenLastCalledWith(
        expect.objectContaining({ isRegex: true }),
        {}
      );

      await user.click(regexButton); // Toggle back
       expect(mockUseFileFiltersState.setIsRegex).toHaveBeenCalledWith(false);
      expect(FileTree).toHaveBeenLastCalledWith(
        expect.objectContaining({ isRegex: false }),
        {}
      );
    });
  });

  describe('Integration with FileExplorerToolbar', () => {
    it('calls refreshFileTree from store on Refresh button click', async () => {
      const user = userEvent.setup();
      renderPanel();
      
      const refreshButton = screen.getByTestId('refresh-button');
      await user.click(refreshButton);
      
      expect(mockStoreState.refreshFileTree).toHaveBeenCalledTimes(1);
      expect(mockStoreState.refreshFileTree).toHaveBeenCalledWith(defaultProps.folderId);
    });

    it('calls collapseAllFolders from store on Collapse All button click', async () => {
      const user = userEvent.setup();
      renderPanel();
      
      const collapseButton = screen.getByTestId('collapse-all-button');
      await user.click(collapseButton);
      
      expect(mockStoreState.collapseAllFolders).toHaveBeenCalledTimes(1);
      // If collapseAllFolders takes folderId, add: expect(mockStoreState.collapseAllFolders).toHaveBeenCalledWith(defaultProps.folderId);
    });

    it('calls clearFilters from useFileFilters on Clear Filters button click', async () => {
      const user = userEvent.setup();
      // Setup some initial filters
      mockUseFileFiltersState.filter = "initialText";
      mockUseFileFiltersState.extensionFilter = [".js"];
      renderPanel();

      const clearFiltersButton = screen.getByTestId('clear-filters-button');
      await user.click(clearFiltersButton);
      
      expect(mockUseFileFiltersState.clearFilters).toHaveBeenCalledTimes(1);
      // Verify FileTree is re-rendered with cleared filters
      expect(FileTree).toHaveBeenLastCalledWith(
        expect.objectContaining({ filter: '', extensionFilter: [], isRegex: false }),
        {}
      );
    });
  });
  
  describe('FileTree Rendering and Props', () => {
    it('renders FileTree with essential props', () => {
        renderPanel();
        expect(screen.getByTestId('mock-file-tree')).toBeInTheDocument();
        expect(FileTree).toHaveBeenCalledWith(
            expect.objectContaining({
                folderId: defaultProps.folderId,
                filter: mockUseFileFiltersState.filter, // initial empty
                extensionFilter: mockUseFileFiltersState.extensionFilter, // initial empty
                isRegex: mockUseFileFiltersState.isRegex, // initial false
                isLoading: defaultProps.isLoading,
                error: defaultProps.error,
            }),
            {}
        );
    });
  });

  describe('Loading and Error States', () => {
    it('passes isLoading prop to FileTree', () => {
      renderPanel({ isLoading: true });
      expect(FileTree).toHaveBeenCalledWith(expect.objectContaining({ isLoading: true }), {});
    });

    it('passes error prop to FileTree', () => {
      const error = { message: 'Failed to load tree' };
      renderPanel({ error });
      expect(FileTree).toHaveBeenCalledWith(expect.objectContaining({ error }), {});
    });
  });

  // Add tests for settings components if they are directly part of LeftPanel's rendering/logic
  // For example, if LeftPanel itself renders a settings popover that uses store actions.
  // Based on the current structure, settings are likely within FileExplorerToolbar or a separate settings component.
  // The provided mocks for the store (updateMaxSelectionCount etc.) suggest these settings might be tested
  // via their own components or by ensuring FileExplorerToolbar receives props to trigger them.
  // If the missing lines are within conditional rendering blocks in LeftPanel related to these settings,
  // we might need to simulate those conditions.

  // Example: If there's a direct settings button in LeftPanel (unlikely, usually in Toolbar)
  // it('opens settings modal/popover when settings button clicked', () => { ... });

  describe('FileExplorerToolbar Prop Wiring', () => {
    it('passes all relevant callbacks and props to FileExplorerToolbar', () => {
      renderPanel();
      expect(FileExplorerToolbar).toHaveBeenCalledWith(
        expect.objectContaining({
          // onRefresh is bound to store.refreshFileTree(folderId)
          // onCollapseAll is bound to store.collapseAllFolders
          // onClearFilters is bound to hook.clearFilters
          // We need to check if these functions are passed.
          // The actual implementation of these bound functions is tested elsewhere (store/hook tests).
          // Here, we just check that *a* function is passed for each expected prop.
          onRefresh: expect.any(Function),
          onCollapseAll: expect.any(Function),
          onClearFilters: expect.any(Function),
          // Other props like settings components if FileExplorerToolbar expects them directly
          // MaxSelectionCountSetting: expect.any(Function), // Or however these are passed
          // FolderSummaryThresholdSetting: expect.any(Function),
          // IncludeProjectTreeSetting: expect.any(Function),
        }),
        {}
      );
    });
  });

  describe('Combined States', () => {
    it('handles isLoading true with an existing error prop', () => {
      // This scenario might occur if a refresh is triggered while a previous error is still displayed.
      // The expected behavior is usually to prioritize the loading state for UI feedback.
      const error = { message: 'Previous error' };
      renderPanel({ isLoading: true, error: error });

      // FileTree should reflect it's loading, error might also be passed or ignored by FileTree when loading
      expect(FileTree).toHaveBeenCalledWith(
        expect.objectContaining({
          isLoading: true,
          error: error, // FileTree might decide to show loader over error
        }),
        {}
      );
      // Toolbar might disable certain actions during loading
      // FileFilterBar might be disabled or not, depending on desired UX
    });
  });
});
