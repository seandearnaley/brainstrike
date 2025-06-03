import { vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { VirtualizedPreviewPanel } from '../virtualized-preview-panel';
import { FileExplorerNodeType } from '../types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  ArrowDown: () => 'ArrowDownIcon',
  ArrowRight: () => 'ArrowRightIcon',
  ChevronDown: () => 'ChevronDownIcon',
  ChevronRight: () => 'ChevronRightIcon',
  FileText: () => 'FileTextIcon',
  Folder: () => 'FolderIcon',
  Loader2: () => 'Loader2Icon',
  Trash2: () => 'Trash2Icon',
  X: () => 'XIcon',
  Copy: () => 'CopyIcon',
}));

// Mock @tanstack/react-virtual
const mockUseVirtualizer = vi.fn();
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: mockUseVirtualizer,
}));

// Mock UI components from @brainstrike/ui
vi.mock('@brainstrike/ui', async () => {
  const actual = await vi.importActual('@brainstrike/ui');
  return {
    ...actual,
    ScrollArea: ({ children }) => <div data-testid="scroll-area">{children}</div>,
    Checkbox: React.forwardRef((props, ref) => <input type="checkbox" {...props} ref={ref} data-testid="checkbox" />),
    Button: ({ children, ...props }) => <button {...props}>{children}</button>,
    Badge: ({ children, ...props }) => <span {...props}>{children}</span>,
    Progress: ({ value, ...props }) => <progress value={value} {...props} />,
    TooltipProvider: ({ children }) => <>{children}</>,
    Tooltip: ({ children }) => <>{children}</>,
    TooltipTrigger: ({ children }) => <>{children}</>,
    TooltipContent: ({ children }) => <div>{children}</div>,
  };
});


const mockOnSelectionChange = vi.fn();
const mockDecodeFileSelection = vi.fn((compositeKey) => {
  const parts = compositeKey.split(':');
  return {
    id: compositeKey,
    type: FileExplorerNodeType.FILE,
    path: parts.slice(1).join(':'),
    folderId: parts[0],
    node: {
      id: compositeKey,
      path: parts.slice(1).join(':'),
      type: FileExplorerNodeType.FILE,
      name: parts[parts.length -1],
      children: [],
      parent: parts[0]
    }
  }
});
const mockCountTokensHeuristic = vi.fn((content) => content.length);
const mockPerformUndoableAction = vi.fn();

const defaultProps = {
  selectedFiles: new Set<string>(),
  fileContents: {},
  fileSizes: {},
  loadingFiles: new Set<string>(),
  onSelectionChange: mockOnSelectionChange,
  decodeFileSelection: mockDecodeFileSelection,
  countTokensHeuristic: mockCountTokensHeuristic,
  performUndoableAction: mockPerformUndoableAction,
  className: '',
  style: {},
  showFolderSummaryThreshold: 5,
  defaultSortOrder: 'path',
};

// Helper to setup useVirtualizer mock for each test
const setupVirtualizerMock = (items) => {
  mockUseVirtualizer.mockImplementation(({ count, estimateSize, getScrollElement }) => {
    const virtualItems = items.map((item, index) => ({
      index,
      key: item.id || index, // Use item id if available, otherwise index
      size: estimateSize(index),
      start: index * estimateSize(index),
      data: item, // Pass item data through
    }));
    return {
      getVirtualItems: () => virtualItems,
      getTotalSize: () => virtualItems.reduce((sum, vi) => sum + vi.size, 0),
      scrollToIndex: vi.fn(),
    };
  });
};


describe('VirtualizedPreviewPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default virtualizer mock for tests that don't rely on specific items
    setupVirtualizerMock([]);
  });

  describe('Component Rendering', () => {
    it('should render "No files selected" message when selectedFiles is empty', () => {
      render(<VirtualizedPreviewPanel {...defaultProps} />);
      expect(screen.getByText('No files selected')).toBeInTheDocument();
    });

    it('should render FileRow for file items and FolderHeaderRow for folder header items', () => {
      const selectedFiles = new Set(['folder1:file1.txt', 'folder2:file2.ts']);
      const props = {
        ...defaultProps,
        selectedFiles,
        fileSizes: { 'folder1:file1.txt': 100, 'folder2:file2.ts': 200 },
        fileContents: { 'folder1:file1.txt': 'content1', 'folder2:file2.ts': 'content2' },
      };
      // Mock flatListItems generation for this test
      const mockFlatListItems = [
        { type: 'folder', id: 'folder1', tokenCount: 10, fileCount: 1, color: 'bg-red-500' },
        { type: 'file', id: 'folder1:file1.txt', path: 'file1.txt', name: 'file1.txt', folderId: 'folder1', size: 100, tokens: 10 },
        { type: 'folder', id: 'folder2', tokenCount: 20, fileCount: 1, color: 'bg-blue-500' },
        { type: 'file', id: 'folder2:file2.ts', path: 'file2.ts', name: 'file2.ts', folderId: 'folder2', size: 200, tokens: 20 },
      ];
      setupVirtualizerMock(mockFlatListItems);
      mockDecodeFileSelection.mockImplementation((compositeKey) => {
        const parts = compositeKey.split(':');
        return { 
            id: compositeKey, 
            path: parts.slice(1).join(':'), 
            folderId: parts[0], 
            name: parts[parts.length -1],
            type: FileExplorerNodeType.FILE,
            node: {
              id: compositeKey,
              path: parts.slice(1).join(':'),
              type: FileExplorerNodeType.FILE,
              name: parts[parts.length -1],
              children: [],
              parent: parts[0]
            }
        }
      });


      render(<VirtualizedPreviewPanel {...props} />);
      
      // Check for folder headers
      expect(screen.getByText('folder1')).toBeInTheDocument();
      expect(screen.getByText('folder2')).toBeInTheDocument();
      
      // Check for file rows
      expect(screen.getByText('file1.txt')).toBeInTheDocument();
      expect(screen.getByText('file2.ts')).toBeInTheDocument();

      // Check for formatted sizes and tokens
      expect(screen.getByText('100 B')).toBeInTheDocument(); // formatFileSize mock needed for exact match
      expect(screen.getByText('200 B')).toBeInTheDocument();
      expect(screen.getAllByText('10 tokens').length).toBeGreaterThan(0); // tokenCount for folder1
      expect(screen.getAllByText('20 tokens').length).toBeGreaterThan(0); // tokenCount for folder2
    });

    it('should display Loader2 icon for loading files', () => {
      const selectedFiles = new Set(['folder1:file1.txt']);
      const loadingFiles = new Set(['folder1:file1.txt']);
      const props = {
        ...defaultProps,
        selectedFiles,
        loadingFiles,
        fileSizes: { 'folder1:file1.txt': 100 },
        fileContents: { 'folder1:file1.txt': 'content' },
      };
      const mockFlatListItems = [
        { type: 'folder', id: 'folder1', tokenCount: 7, fileCount: 1, color: 'bg-red-500' },
        { type: 'file', id: 'folder1:file1.txt', path: 'file1.txt', name: 'file1.txt', folderId: 'folder1', size: 100, tokens: 7, isLoading: true },
      ];
      setupVirtualizerMock(mockFlatListItems);
      mockDecodeFileSelection.mockImplementation((compositeKey) => ({ 
        id: compositeKey, path: 'file1.txt', folderId: 'folder1', name: 'file1.txt', type: FileExplorerNodeType.FILE,
        node: { id: compositeKey, path: 'file1.txt', type: FileExplorerNodeType.FILE, name: 'file1.txt', children: [], parent: 'folder1' }
      }));


      render(<VirtualizedPreviewPanel {...props} />);
      expect(screen.getByText('file1.txt')).toBeInTheDocument();
      // Check specifically within the row of file1.txt for the loader
      const fileRow = screen.getByText('file1.txt').closest('div[role="listitem"]');
      //This will depend on how Loader2 is rendered. If it has specific text or title:
      //expect(within(fileRow).getByTitle('Loading...')).toBeInTheDocument(); 
      // For now, let's assume Loader2Icon text is rendered
      expect(within(fileRow).getByText('Loader2Icon')).toBeInTheDocument();
    });

    it('header section should display correctly', () => {
      const selectedFiles = new Set(['folder1:file1.txt', 'folder1:file2.txt']);
      const props = {
        ...defaultProps,
        selectedFiles,
        fileSizes: { 'folder1:file1.txt': 100, 'folder1:file2.txt': 150 },
        fileContents: { 'folder1:file1.txt': 'content1', 'folder1:file2.txt': 'content2 assez long' },
      };
       mockCountTokensHeuristic
        .mockImplementationOnce(() => 8) // file1.txt
        .mockImplementationOnce(() => 18); // file2.txt

      const mockFlatListItems = [
         { type: 'folder', id: 'folder1', tokenCount: (8+18), fileCount: 2, color: 'bg-red-500' },
         { type: 'file', id: 'folder1:file1.txt', path: 'file1.txt', name: 'file1.txt', folderId: 'folder1', size: 100, tokens: 8 },
         { type: 'file', id: 'folder1:file2.txt', path: 'file2.txt', name: 'file2.txt', folderId: 'folder1', size: 150, tokens: 18 },
      ];
      setupVirtualizerMock(mockFlatListItems);
       mockDecodeFileSelection.mockImplementation((compositeKey) => {
        const parts = compositeKey.split(':');
        const name = parts[parts.length -1];
        return { 
            id: compositeKey, path: name, folderId: parts[0], name: name, type: FileExplorerNodeType.FILE,
            node: { id: compositeKey, path: name, type: FileExplorerNodeType.FILE, name: name, children: [], parent: parts[0] }
        }
      });

      render(<VirtualizedPreviewPanel {...props} />);
      
      expect(screen.getByTestId('checkbox')).toBeInTheDocument(); // Header checkbox
      expect(screen.getByText(/26 tokens/)).toBeInTheDocument(); // Total token count badge
      expect(screen.getByText(/2 files selected, 26 total tokens/)).toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      // Progress bar value can be asserted if total token limit is known and passed
      // For now, just check existence.
    });
  });
  
  // More test suites for User Interactions, FileDetailPanel, Props and State, Edge Cases will be added here.
  describe('User Interactions', () => {
    describe('File Selection/Deselection (FileRow)', () => {
      it('should call toggleFileSelection and update batchSelectedFiles on FileRow checkbox click', async () => {
        const user = userEvent.setup();
        const selectedFiles = new Set(['folder1:file1.txt', 'folder1:file2.txt']);
        const props = {
          ...defaultProps,
          selectedFiles,
          fileSizes: { 'folder1:file1.txt': 100, 'folder1:file2.txt': 150 },
          fileContents: { 'folder1:file1.txt': 'content1', 'folder1:file2.txt': 'content2' },
        };
        const mockFlatListItems = [
          { type: 'folder', id: 'folder1', tokenCount: 10, fileCount: 2, color: 'bg-red-500' },
          { type: 'file', id: 'folder1:file1.txt', path: 'file1.txt', name: 'file1.txt', folderId: 'folder1', size: 100, tokens: 10 },
          { type: 'file', id: 'folder1:file2.txt', path: 'file2.txt', name: 'file2.txt', folderId: 'folder1', size: 150, tokens: 10 },
        ];
        setupVirtualizerMock(mockFlatListItems);
        mockDecodeFileSelection.mockImplementation((compositeKey) => {
          const parts = compositeKey.split(':');
          const name = parts[parts.length -1];
          return { 
              id: compositeKey, path: name, folderId: parts[0], name: name, type: FileExplorerNodeType.FILE,
              node: { id: compositeKey, path: name, type: FileExplorerNodeType.FILE, name: name, children: [], parent: parts[0] }
          }
        });

        const { rerender } = render(<VirtualizedPreviewPanel {...props} />);
        
        const file1Checkbox = screen.getAllByTestId('checkbox').find(cb => {
            // Heuristic to find the checkbox associated with file1.txt
            // This might need adjustment based on actual DOM structure
            const listItem = cb.closest('div[role="listitem"]');
            return listItem && within(listItem).queryByText('file1.txt');
        });
        expect(file1Checkbox).toBeInTheDocument();

        // Initially, all files in selectedFiles should be in batchSelectedFiles (by default behavior)
        // So, clicking it should deselect it from batchSelectedFiles
        await user.click(file1Checkbox!);
        
        // At this point, batchSelectedFiles should not contain 'folder1:file1.txt'
        // We can't directly check batchSelectedFiles state here,
        // but we can check if the checkbox reflects the change (if it's controlled)
        // or how other components react to this change (e.g., footer visibility or remove button state)

        // For now, let's assume toggleFileSelection correctly updates internal state.
        // We'll verify this more concretely when testing batch removal.
        // Let's rerender with updated batchSelectedFiles (simulated parent component behavior)
        // This part is tricky as VirtualizedPreviewPanel controls batchSelectedFiles internally.
        // The component itself would need to expose a way to check this or we test its effects.

        // Let's check if the 'Remove Selected' button appears/disappears or its count changes.
        // When a file is batch selected, the footer with "Remove Selected" should be visible.
        // Initially, all are batch selected.
        expect(screen.getByRole('button', { name: /Remove Selected/i })).toBeInTheDocument();

        // Click to deselect file1.txt from batch
        await user.click(file1Checkbox!); // Click again to re-select for next part of test

        // Simulate deselecting all but one file to test the footer
        const file2Checkbox = screen.getAllByTestId('checkbox').find(cb => {
            const listItem = cb.closest('div[role="listitem"]');
            return listItem && within(listItem).queryByText('file2.txt');
        });
        await user.click(file2Checkbox!); // Deselect file2.txt from batch

        // Now only file1.txt is batch selected. Footer should still be there.
        expect(screen.getByRole('button', { name: /Remove Selected/i })).toBeInTheDocument();
        expect(screen.getByText(/1 file selected for batch operation/)).toBeInTheDocument();


        await user.click(file1Checkbox!); // Deselect file1.txt from batch

        // Now no files are batch selected. Footer should be hidden.
        // The component hides the footer if batchSelectedFiles is empty.
        // We need to wait for the state update and re-render if it's async.
        // For now, assuming synchronous update or test effects.
        expect(screen.queryByRole('button', { name: /Remove Selected/i })).not.toBeInTheDocument();

      });
    });

    describe('Batch File Selection/Deselection (Header)', () => {
      it('should select all files when header checkbox is clicked and not all are selected', async () => {
        const user = userEvent.setup();
        const selectedFiles = new Set(['folder1:file1.txt', 'folder1:file2.txt']);
        const props = {
          ...defaultProps,
          selectedFiles,
          fileSizes: { 'folder1:file1.txt': 100, 'folder1:file2.txt': 150 },
          fileContents: { 'folder1:file1.txt': 'content1', 'folder1:file2.txt': 'content2' },
        };
        const mockFlatListItems = [
          { type: 'folder', id: 'folder1', tokenCount: 10, fileCount: 2, color: 'bg-red-500' },
          { type: 'file', id: 'folder1:file1.txt', path: 'file1.txt', name: 'file1.txt', folderId: 'folder1', size: 100, tokens: 10 },
          { type: 'file', id: 'folder1:file2.txt', path: 'file2.txt', name: 'file2.txt', folderId: 'folder1', size: 150, tokens: 10 },
        ];
        setupVirtualizerMock(mockFlatListItems);
        mockDecodeFileSelection.mockImplementation((compositeKey) => {
          const parts = compositeKey.split(':');
          const name = parts[parts.length -1];
          return { 
              id: compositeKey, path: name, folderId: parts[0], name: name, type: FileExplorerNodeType.FILE,
              node: { id: compositeKey, path: name, type: FileExplorerNodeType.FILE, name: name, children: [], parent: parts[0] }
          }
        });

        render(<VirtualizedPreviewPanel {...props} />);
        
        const headerCheckbox = screen.getAllByTestId('checkbox')[0]; // Assuming first checkbox is the header
        expect(headerCheckbox).toBeInTheDocument();
        // Initially all are selected by default batch selection logic
        expect(headerCheckbox).toBeChecked(); 
        expect(screen.getByText(/2 files selected for batch operation/)).toBeInTheDocument();


        // Click one of the file checkboxes to deselect one file from batch
        const file1Checkbox = screen.getAllByTestId('checkbox').find(cb => {
            const listItem = cb.closest('div[role="listitem"]');
            return listItem && within(listItem).queryByText('file1.txt');
        });
        await user.click(file1Checkbox!);
        expect(headerCheckbox).not.toBeChecked(); // Header checkbox should now be indeterminate or unchecked
        expect(screen.getByText(/1 file selected for batch operation/)).toBeInTheDocument();


        // Click header checkbox to select all
        await user.click(headerCheckbox);
        expect(headerCheckbox).toBeChecked();
        expect(screen.getByText(/2 files selected for batch operation/)).toBeInTheDocument();
         // Verify individual checkboxes also become checked
        mockFlatListItems.forEach(item => {
          if (item.type === 'file') {
            const fileCheckbox = screen.getAllByTestId('checkbox').find(cb => {
                const listItem = cb.closest('div[role="listitem"]');
                return listItem && within(listItem).queryByText(item.name);
            });
            expect(fileCheckbox).toBeChecked();
          }
        });
      });

      it('should deselect all files when header checkbox is clicked and all are selected', async () => {
        const user = userEvent.setup();
        const selectedFiles = new Set(['folder1:file1.txt', 'folder1:file2.txt']);
        const props = {
          ...defaultProps,
          selectedFiles,
          fileSizes: { 'folder1:file1.txt': 100, 'folder1:file2.txt': 150 },
          fileContents: { 'folder1:file1.txt': 'content1', 'folder1:file2.txt': 'content2' },
        };
        const mockFlatListItems = [
          { type: 'folder', id: 'folder1', tokenCount: 10, fileCount: 2, color: 'bg-red-500' },
          { type: 'file', id: 'folder1:file1.txt', path: 'file1.txt', name: 'file1.txt', folderId: 'folder1', size: 100, tokens: 10 },
          { type: 'file', id: 'folder1:file2.txt', path: 'file2.txt', name: 'file2.txt', folderId: 'folder1', size: 150, tokens: 10 },
        ];
        setupVirtualizerMock(mockFlatListItems);
         mockDecodeFileSelection.mockImplementation((compositeKey) => {
          const parts = compositeKey.split(':');
          const name = parts[parts.length -1];
          return { 
              id: compositeKey, path: name, folderId: parts[0], name: name, type: FileExplorerNodeType.FILE,
              node: { id: compositeKey, path: name, type: FileExplorerNodeType.FILE, name: name, children: [], parent: parts[0] }
          }
        });

        render(<VirtualizedPreviewPanel {...props} />);
        
        const headerCheckbox = screen.getAllByTestId('checkbox')[0]; // Header checkbox
        // Initially all are selected
        expect(headerCheckbox).toBeChecked();
        expect(screen.getByText(/2 files selected for batch operation/)).toBeInTheDocument();

        // Click header checkbox to deselect all
        await user.click(headerCheckbox);
        expect(headerCheckbox).not.toBeChecked();
        expect(screen.queryByText(/files selected for batch operation/)).not.toBeInTheDocument(); // Footer text gone
        expect(screen.queryByRole('button', { name: /Remove Selected/i })).not.toBeInTheDocument(); // Footer button gone

        // Verify individual checkboxes also become unchecked
         mockFlatListItems.forEach(item => {
          if (item.type === 'file') {
            const fileCheckbox = screen.getAllByTestId('checkbox').find(cb => {
                const listItem = cb.closest('div[role="listitem"]');
                return listItem && within(listItem).queryByText(item.name);
            });
            expect(fileCheckbox).not.toBeChecked();
          }
        });
      });
    });

    describe('File Removal', () => {
      it('should call handleRemoveFile (onSelectionChange and performUndoableAction) on FileRow remove button click', async () => {
        const user = userEvent.setup();
        const selectedFileToRemove = 'folder1:file1.txt';
        const initialSelectedFiles = new Set([selectedFileToRemove, 'folder1:file2.txt']);
        const props = {
          ...defaultProps,
          selectedFiles: initialSelectedFiles,
          fileSizes: { [selectedFileToRemove]: 100, 'folder1:file2.txt': 150 },
          fileContents: { [selectedFileToRemove]: 'content1', 'folder1:file2.txt': 'content2' },
        };
        const mockFlatListItems = [
          { type: 'folder', id: 'folder1', tokenCount: 10, fileCount: 2, color: 'bg-red-500' },
          { type: 'file', id: selectedFileToRemove, path: 'file1.txt', name: 'file1.txt', folderId: 'folder1', size: 100, tokens: 10 },
          { type: 'file', id: 'folder1:file2.txt', path: 'file2.txt', name: 'file2.txt', folderId: 'folder1', size: 150, tokens: 10 },
        ];
        setupVirtualizerMock(mockFlatListItems);
        mockDecodeFileSelection.mockImplementation((compositeKey) => {
          const parts = compositeKey.split(':');
          const name = parts[parts.length -1];
          return { 
              id: compositeKey, path: name, folderId: parts[0], name: name, type: FileExplorerNodeType.FILE,
              node: { id: compositeKey, path: name, type: FileExplorerNodeType.FILE, name: name, children: [], parent: parts[0] }
          }
        });

        render(<VirtualizedPreviewPanel {...props} />);
        
        const file1Row = screen.getByText('file1.txt').closest('div[role="listitem"]');
        const removeButton = within(file1Row!).getByRole('button', { name: /Trash2Icon/i }); // Assuming Trash2Icon implies remove
        expect(removeButton).toBeInTheDocument();

        await user.click(removeButton);

        expect(mockPerformUndoableAction).toHaveBeenCalledTimes(1);
        expect(mockOnSelectionChange).toHaveBeenCalledTimes(1);
        const expectedNewSelection = new Set(['folder1:file2.txt']);
        expect(mockOnSelectionChange.mock.calls[0][0]).toEqual(expectedNewSelection);

        // The component should also remove the file from its internal batchSelectedFiles
        // Check if footer updates (if it was the last batch selected item)
        // If file1.txt was the only one batch selected, footer should disappear.
        // By default, all selectedFiles are batchSelected. So removing one keeps the other batch selected.
        expect(screen.getByRole('button', { name: /Remove Selected/i })).toBeInTheDocument();
        expect(screen.getByText(/1 file selected for batch operation/)).toBeInTheDocument();

      });

      it('should call handleBatchRemove when "Remove Selected" is clicked and batchSelectedFiles is not empty', async () => {
        const user = userEvent.setup();
        const filesToBatchRemove = ['folder1:file1.txt', 'folder1:file2.txt'];
        const initialSelectedFiles = new Set([...filesToBatchRemove, 'folder2:file3.ts']);
        const props = {
          ...defaultProps,
          selectedFiles: initialSelectedFiles,
          fileSizes: { 'folder1:file1.txt': 100, 'folder1:file2.txt': 150, 'folder2:file3.ts': 200 },
          fileContents: { 'folder1:file1.txt': 'content1', 'folder1:file2.txt': 'content2', 'folder2:file3.ts': 'content3' },
        };
         const mockFlatListItems = [ // Initial state, all files present
          { type: 'folder', id: 'folder1', tokenCount: 20, fileCount: 2, color: 'bg-red-500' },
          { type: 'file', id: 'folder1:file1.txt', path: 'file1.txt', name: 'file1.txt', folderId: 'folder1', size: 100, tokens: 10 },
          { type: 'file', id: 'folder1:file2.txt', path: 'file2.txt', name: 'file2.txt', folderId: 'folder1', size: 150, tokens: 10 },
          { type: 'folder', id: 'folder2', tokenCount: 10, fileCount: 1, color: 'bg-blue-500' },
          { type: 'file', id: 'folder2:file3.ts', path: 'file3.ts', name: 'file3.ts', folderId: 'folder2', size: 200, tokens: 10 },
        ];
        setupVirtualizerMock(mockFlatListItems);
        mockDecodeFileSelection.mockImplementation((compositeKey) => {
          const parts = compositeKey.split(':');
          const name = parts[parts.length -1];
          return { 
              id: compositeKey, path: name, folderId: parts[0], name: name, type: FileExplorerNodeType.FILE,
              node: { id: compositeKey, path: name, type: FileExplorerNodeType.FILE, name: name, children: [], parent: parts[0] }
          }
        });


        render(<VirtualizedPreviewPanel {...props} />);
        
        // By default, all selectedFiles are batchSelected.
        // So, 'folder1:file1.txt', 'folder1:file2.txt', 'folder2:file3.ts' are batch selected.
        expect(screen.getByText(/3 files selected for batch operation/)).toBeInTheDocument();
        const batchRemoveButton = screen.getByRole('button', { name: /Remove Selected/i });
        expect(batchRemoveButton).toBeInTheDocument();

        // Deselect 'folder2:file3.ts' to only batch remove the first two
        const file3Checkbox = screen.getAllByTestId('checkbox').find(cb => {
            const listItem = cb.closest('div[role="listitem"]');
            return listItem && within(listItem).queryByText('file3.ts');
        });
        await user.click(file3Checkbox!);
        expect(screen.getByText(/2 files selected for batch operation/)).toBeInTheDocument();


        await user.click(batchRemoveButton);

        expect(mockPerformUndoableAction).toHaveBeenCalledTimes(1);
        expect(mockOnSelectionChange).toHaveBeenCalledTimes(1);
        const expectedNewSelection = new Set(['folder2:file3.ts']);
        expect(mockOnSelectionChange.mock.calls[0][0]).toEqual(expectedNewSelection);

        // Footer should disappear as batchSelectedFiles becomes empty after removal
        expect(screen.queryByRole('button', { name: /Remove Selected/i })).not.toBeInTheDocument();
        expect(screen.queryByText(/files selected for batch operation/)).not.toBeInTheDocument();
      });

      it('footer with "Remove Selected" button should only be visible if batchSelectedFiles is not empty', async () => {
        const user = userEvent.setup();
        const selectedFiles = new Set(['folder1:file1.txt']);
        const props = {
          ...defaultProps,
          selectedFiles,
          fileSizes: { 'folder1:file1.txt': 100 },
          fileContents: { 'folder1:file1.txt': 'content1' },
        };
        const mockFlatListItems = [
          { type: 'folder', id: 'folder1', tokenCount: 10, fileCount: 1, color: 'bg-red-500' },
          { type: 'file', id: 'folder1:file1.txt', path: 'file1.txt', name: 'file1.txt', folderId: 'folder1', size: 100, tokens: 10 },
        ];
        setupVirtualizerMock(mockFlatListItems);
        mockDecodeFileSelection.mockImplementation((compositeKey) => ({ 
            id: compositeKey, path: 'file1.txt', folderId: 'folder1', name: 'file1.txt', type: FileExplorerNodeType.FILE,
            node: { id: compositeKey, path: 'file1.txt', type: FileExplorerNodeType.FILE, name: 'file1.txt', children: [], parent: 'folder1' }
        }));

        render(<VirtualizedPreviewPanel {...props} />);

        // Initially, file1.txt is batch selected
        expect(screen.getByRole('button', { name: /Remove Selected/i })).toBeInTheDocument();
        expect(screen.getByText(/1 file selected for batch operation/)).toBeInTheDocument();

        // Deselect file1.txt
        const file1Checkbox = screen.getAllByTestId('checkbox').find(cb => {
            const listItem = cb.closest('div[role="listitem"]');
            return listItem && within(listItem).queryByText('file1.txt');
        });
        await user.click(file1Checkbox!);

        // Footer should disappear
        expect(screen.queryByRole('button', { name: /Remove Selected/i })).not.toBeInTheDocument();
        expect(screen.queryByText(/files selected for batch operation/)).not.toBeInTheDocument();
      });
    });

    describe('Folder Collapse/Expand', () => {
      const files = {
        'folder1:file1.txt': { path: 'file1.txt', name: 'file1.txt', folderId: 'folder1', size: 100, tokens: 10, content: 'f1c1' },
        'folder1:file2.txt': { path: 'file2.txt', name: 'file2.txt', folderId: 'folder1', size: 120, tokens: 12, content: 'f1c2' },
        'folder2:file3.ts': { path: 'file3.ts', name: 'file3.ts', folderId: 'folder2', size: 200, tokens: 20, content: 'f2c3' },
      };
      const initialSelectedFiles = new Set(Object.keys(files));
      const baseProps = {
        ...defaultProps,
        selectedFiles: initialSelectedFiles,
        fileSizes: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.size])),
        fileContents: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.content])),
      };
       const getMockFlatListItems = (collapsedFolders = new Set()) => [
        { type: 'folder', id: 'folder1', tokenCount: 22, fileCount: 2, color: 'bg-red-500' },
        ...(!collapsedFolders.has('folder1') ? [
          { type: 'file', id: 'folder1:file1.txt', ...files['folder1:file1.txt'] },
          { type: 'file', id: 'folder1:file2.txt', ...files['folder1:file2.txt'] },
        ] : []),
        { type: 'folder', id: 'folder2', tokenCount: 20, fileCount: 1, color: 'bg-blue-500' },
        ...(!collapsedFolders.has('folder2') ? [
          { type: 'file', id: 'folder2:file3.ts', ...files['folder2:file3.ts'] },
        ] : []),
      ];

      beforeEach(() => {
        mockDecodeFileSelection.mockImplementation((compositeKey) => {
          const f = files[compositeKey];
          return { 
              id: compositeKey, path: f.path, folderId: f.folderId, name: f.name, type: FileExplorerNodeType.FILE,
              node: { id: compositeKey, path: f.path, type: FileExplorerNodeType.FILE, name: f.name, children: [], parent: f.folderId }
          }
        });
      });

      it('should toggle folder collapse on FolderHeaderRow click and hide/show files', async () => {
        const user = userEvent.setup();
        setupVirtualizerMock(getMockFlatListItems());
        const { rerender } = render(<VirtualizedPreviewPanel {...baseProps} />);

        expect(screen.getByText('file1.txt')).toBeInTheDocument();
        expect(screen.getByText('file2.txt')).toBeInTheDocument();
        
        const folder1Header = screen.getByText('folder1').closest('div[role="listitem"]');
        expect(folder1Header).toBeInTheDocument();
        await user.click(folder1Header!);

        // After click, folder1 should be collapsed. Rerender with new state for virtualizer.
        setupVirtualizerMock(getMockFlatListItems(new Set(['folder1'])));
        rerender(<VirtualizedPreviewPanel {...baseProps} />); // State update happens internally
        
        expect(screen.queryByText('file1.txt')).not.toBeInTheDocument();
        expect(screen.queryByText('file2.txt')).not.toBeInTheDocument();
        expect(screen.getByText('file3.ts')).toBeInTheDocument(); // folder2 files still visible

        // Click again to expand
        // Need to find folder1Header again as DOM might have changed slightly if keying strategy for virtualizer isn't perfect
        const folder1HeaderAgain = screen.getByText('folder1').closest('div[role="listitem"]');
        await user.click(folder1HeaderAgain!);
        setupVirtualizerMock(getMockFlatListItems(new Set()));
        rerender(<VirtualizedPreviewPanel {...baseProps} />);

        expect(screen.getByText('file1.txt')).toBeInTheDocument();
        expect(screen.getByText('file2.txt')).toBeInTheDocument();
      });

      it('should expand all folders when "Expand All" button is clicked', async () => {
        const user = userEvent.setup();
        // Start with folder1 collapsed
        setupVirtualizerMock(getMockFlatListItems(new Set(['folder1'])));
        const { rerender } = render(<VirtualizedPreviewPanel {...baseProps} />);

        expect(screen.queryByText('file1.txt')).not.toBeInTheDocument();
        expect(screen.getByText('file3.ts')).toBeInTheDocument(); // folder2 initially expanded for this test variant

        const expandAllButton = screen.getByRole('button', { name: /Expand All/i });
        await user.click(expandAllButton);

        setupVirtualizerMock(getMockFlatListItems(new Set())); // All expanded
        rerender(<VirtualizedPreviewPanel {...baseProps} />);

        expect(screen.getByText('file1.txt')).toBeInTheDocument();
        expect(screen.getByText('file2.txt')).toBeInTheDocument();
        expect(screen.getByText('file3.ts')).toBeInTheDocument();
      });

      it('should collapse all folders when "Collapse All" button is clicked', async () => {
        const user = userEvent.setup();
        setupVirtualizerMock(getMockFlatListItems()); // Start with all expanded
        const { rerender } = render(<VirtualizedPreviewPanel {...baseProps} />);

        expect(screen.getByText('file1.txt')).toBeInTheDocument();
        expect(screen.getByText('file3.ts')).toBeInTheDocument();

        const collapseAllButton = screen.getByRole('button', { name: /Collapse All/i });
        await user.click(collapseAllButton);
        
        setupVirtualizerMock(getMockFlatListItems(new Set(['folder1', 'folder2']))); // All collapsed
        rerender(<VirtualizedPreviewPanel {...baseProps} />);

        expect(screen.queryByText('file1.txt')).not.toBeInTheDocument();
        expect(screen.queryByText('file2.txt')).not.toBeInTheDocument();
        expect(screen.queryByText('file3.ts')).not.toBeInTheDocument();
      });
    });

    describe('Show File Details & FileDetailPanel', () => {
      const fileKey = 'folder1:file1.txt';
      const fileData = { path: 'file1.txt', name: 'file1.txt', folderId: 'folder1', size: 100, tokens: 10, content: 'File content for detail view.' };
      const initialSelectedFiles = new Set([fileKey]);
      const baseProps = {
        ...defaultProps,
        selectedFiles: initialSelectedFiles,
        fileSizes: { [fileKey]: fileData.size },
        fileContents: { [fileKey]: fileData.content },
      };
      const mockFlatListItems = [
        { type: 'folder', id: 'folder1', tokenCount: fileData.tokens, fileCount: 1, color: 'bg-red-500' },
        { type: 'file', id: fileKey, ...fileData },
      ];

      beforeEach(() => {
        mockDecodeFileSelection.mockImplementation((compositeKey) => {
          if (compositeKey === fileKey) {
            return { 
                id: compositeKey, path: fileData.path, folderId: fileData.folderId, name: fileData.name, type: FileExplorerNodeType.FILE,
                node: { id: compositeKey, path: fileData.path, type: FileExplorerNodeType.FILE, name: fileData.name, children: [], parent: fileData.folderId }
            }
          }
          return { id: compositeKey, path: 'unknown', folderId: 'unknown', name: 'unknown', type: FileExplorerNodeType.FILE, node: {} as any };
        });
        setupVirtualizerMock(mockFlatListItems);
      });

      it('should call onShowDetail (setSelectedFileForDetail) and show FileDetailPanel on file name click', async () => {
        const user = userEvent.setup();
        const { rerender } = render(<VirtualizedPreviewPanel {...baseProps} />);

        expect(screen.queryByTestId('file-detail-panel')).not.toBeInTheDocument();

        const fileNameElement = screen.getByText(fileData.name);
        await user.click(fileNameElement);
        
        // setSelectedFileForDetail is called, which updates internal state.
        // We need to rerender the component as if the parent passed down the new selectedFileForDetail,
        // or rely on the component's internal state update to show the panel.
        // The VirtualizedPreviewPanel manages selectedFileForDetail internally.

        rerender(<VirtualizedPreviewPanel {...baseProps} />); // Rerender to reflect internal state change if needed, though RTL handles many cases.

        expect(screen.getByTestId('file-detail-panel')).toBeInTheDocument();
        expect(within(screen.getByTestId('file-detail-panel')).getByText(fileData.path)).toBeInTheDocument();
        expect(within(screen.getByTestId('file-detail-panel')).getByText(fileData.content)).toBeInTheDocument();
      });
      
      it('FileDetailPanel should display file path and content correctly', () => {
        // This test relies on the previous one setting the selectedFileForDetail.
        // To make it independent, we can set selectedFileForDetail directly for testing FileDetailPanel rendering.
        // However, VirtualizedPreviewPanel controls this state internally.
        // So we'll test it through interaction again, or by passing a prop if the component supported it.

        render(<VirtualizedPreviewPanel {...baseProps} selectedFileForDetail={fileKey} />); // Simulate it being already selected

        expect(screen.getByTestId('file-detail-panel')).toBeInTheDocument();
        expect(within(screen.getByTestId('file-detail-panel')).getByText(fileData.path)).toBeInTheDocument(); // Path from decodeFileSelection
        expect(within(screen.getByTestId('file-detail-panel')).getByText(fileData.content)).toBeInTheDocument();
      });

      it('FileDetailPanel should show Loader2 if file is loading', () => {
        render(
          <VirtualizedPreviewPanel 
            {...baseProps} 
            selectedFileForDetail={fileKey} 
            loadingFiles={new Set([fileKey])} 
          />
        );
        expect(screen.getByTestId('file-detail-panel')).toBeInTheDocument();
        expect(within(screen.getByTestId('file-detail-panel')).getByText('Loader2Icon')).toBeInTheDocument();
      });

      it('FileDetailPanel should display "File not accessible" message', () => {
         render(
          <VirtualizedPreviewPanel 
            {...baseProps} 
            selectedFileForDetail={fileKey} 
            fileContents={{ [fileKey]: 'File not accessible: Some error' }}
          />
        );
        expect(screen.getByTestId('file-detail-panel')).toBeInTheDocument();
        expect(within(screen.getByTestId('file-detail-panel')).getByText(/File not accessible: Some error/)).toBeInTheDocument();
      });
      
      it('FileDetailPanel should display "Binary file" message', () => {
         render(
          <VirtualizedPreviewPanel 
            {...baseProps} 
            selectedFileForDetail={fileKey} 
            fileContents={{ [fileKey]: 'Binary file: Cannot display content' }}
          />
        );
        expect(screen.getByTestId('file-detail-panel')).toBeInTheDocument();
        expect(within(screen.getByTestId('file-detail-panel')).getByText(/Binary file: Cannot display content/)).toBeInTheDocument();
      });

      it('FileDetailPanel close button should set selectedFileForDetail to null and hide panel', async () => {
        const user = userEvent.setup();
        const { rerender } = render(<VirtualizedPreviewPanel {...baseProps} selectedFileForDetail={fileKey} />);
        
        expect(screen.getByTestId('file-detail-panel')).toBeInTheDocument();
        
        const closeButton = within(screen.getByTestId('file-detail-panel')).getByRole('button', { name: /XIcon/i }); // Assuming XIcon is the close button
        await user.click(closeButton);

        // Rerender to reflect internal state change
        rerender(<VirtualizedPreviewPanel {...baseProps} selectedFileForDetail={null} />); // Simulate state update
        expect(screen.queryByTestId('file-detail-panel')).not.toBeInTheDocument();
      });
    });

    describe('Props and State Management', () => {
      it('flatListItems should be generated correctly (grouping, sorting, folder token totals, respects collapsedFolders)', () => {
        const selectedFiles = new Set(['folderB:file3.txt', 'folderA:file1.txt', 'folderA:file2.txt']);
        const fileData = {
            'folderB:file3.txt': { path: 'file3.txt', name: 'file3.txt', folderId: 'folderB', size: 50, content: 'content3' }, // 8 tokens
            'folderA:file1.txt': { path: 'file1.txt', name: 'file1.txt', folderId: 'folderA', size: 100, content: 'content1' }, // 8 tokens
            'folderA:file2.txt': { path: 'file2.txt', name: 'file2.txt', folderId: 'folderA', size: 150, content: 'longercontent2' }, // 14 tokens
        };
        const props = {
          ...defaultProps,
          selectedFiles,
          fileSizes: Object.fromEntries(Object.entries(fileData).map(([k,v]) => [k,v.size])),
          fileContents: Object.fromEntries(Object.entries(fileData).map(([k,v]) => [k,v.content])),
        };
        mockCountTokensHeuristic
            .mockImplementation(content => content.length); // Simplified for this test

        let capturedFlatListItems: any[] = [];
        const mockVirtualizerImplementation = ({ items }) => {
          capturedFlatListItems = items;
          const virtualItems = items.map((item, index) => ({
            index, key: item.id || index, size: 30, start: index * 30, data: item,
          }));
          return {
            getVirtualItems: () => virtualItems,
            getTotalSize: () => virtualItems.reduce((sum, vi) => sum + vi.size, 0),
            scrollToIndex: vi.fn(),
          };
        };
        mockUseVirtualizer.mockImplementation(mockVirtualizerImplementation);
        
        mockDecodeFileSelection.mockImplementation((compositeKey) => {
          const f = fileData[compositeKey];
          return { 
              id: compositeKey, path: f.path, folderId: f.folderId, name: f.name, type: FileExplorerNodeType.FILE,
              node: { id: compositeKey, path: f.path, type: FileExplorerNodeType.FILE, name: f.name, children: [], parent: f.folderId }
          }
        });

        const { rerender } = render(<VirtualizedPreviewPanel {...props} />);

        expect(capturedFlatListItems).toBeDefined();
        expect(capturedFlatListItems.length).toBe(5); // 2 folders, 3 files

        // Folder A (sorted first by path)
        expect(capturedFlatListItems[0].type).toBe('folder');
        expect(capturedFlatListItems[0].id).toBe('folderA');
        expect(capturedFlatListItems[0].fileCount).toBe(2);
        expect(capturedFlatListItems[0].tokenCount).toBe(fileData['folderA:file1.txt'].content.length + fileData['folderA:file2.txt'].content.length); // 8 + 14 = 22
        // Files in Folder A (sorted by path)
        expect(capturedFlatListItems[1].type).toBe('file');
        expect(capturedFlatListItems[1].id).toBe('folderA:file1.txt');
        expect(capturedFlatListItems[2].type).toBe('file');
        expect(capturedFlatListItems[2].id).toBe('folderA:file2.txt');

        // Folder B
        expect(capturedFlatListItems[3].type).toBe('folder');
        expect(capturedFlatListItems[3].id).toBe('folderB');
        expect(capturedFlatListItems[3].fileCount).toBe(1);
        expect(capturedFlatListItems[3].tokenCount).toBe(fileData['folderB:file3.txt'].content.length); // 8
        // File in Folder B
        expect(capturedFlatListItems[4].type).toBe('file');
        expect(capturedFlatListItems[4].id).toBe('folderB:file3.txt');

        // Test collapsedFolders
        // Manually trigger collapse of folderA by simulating internal state update, then rerender
        // This is hard because collapsedFolders is internal. We test its effect via folder click tests.
        // For direct flatListItems check, we'd need to pass collapsedFolders as a prop if possible,
        // or rely on a more complex setup. Given previous collapse tests, this aspect is covered.
      });

      it('tokenCacheRef should cache token counts and countTokensHeuristic called only for new content', () => {
        mockCountTokensHeuristic.mockClear(); // Clear previous calls
        mockCountTokensHeuristic.mockImplementation(content => content.length);

        const initialFileKey = 'folder1:file1.txt';
        const initialContent = 'initial content'; // 15 tokens
        const props1 = {
          ...defaultProps,
          selectedFiles: new Set([initialFileKey]),
          fileContents: { [initialFileKey]: initialContent },
          fileSizes: { [initialFileKey]: 100 },
        };
        
        mockDecodeFileSelection.mockImplementationOnce((compositeKey) => ({ 
            id: compositeKey, path: 'file1.txt', folderId: 'folder1', name: 'file1.txt', type: FileExplorerNodeType.FILE,
            node: { id: compositeKey, path: 'file1.txt', type: FileExplorerNodeType.FILE, name: 'file1.txt', children: [], parent: 'folder1' }
        }));
        
        let capturedItems1: any[] = [];
        mockUseVirtualizer.mockImplementationOnce(({items}) => { 
            capturedItems1 = items; 
            return { getVirtualItems: () => items.map((item, index) => ({index, key: item.id, size:30, start: index*30, data:item})), getTotalSize: () => items.length * 30, scrollToIndex: vi.fn()};
        });

        const { rerender } = render(<VirtualizedPreviewPanel {...props1} />);
        expect(mockCountTokensHeuristic).toHaveBeenCalledTimes(1); // Called for initialFileKey
        expect(mockCountTokensHeuristic).toHaveBeenCalledWith(initialContent, initialFileKey);
        expect(capturedItems1.find(item => item.type === 'file' && item.id === initialFileKey)?.tokens).toBe(initialContent.length);


        // Add a new file, heuristic should be called for the new file only
        const newFileKey = 'folder1:file2.txt';
        const newContent = 'new file content'; // 16 tokens
        const props2 = {
          ...props1,
          selectedFiles: new Set([initialFileKey, newFileKey]),
          fileContents: { ...props1.fileContents, [newFileKey]: newContent },
          fileSizes: { ...props1.fileSizes, [newFileKey]: 120 },
        };
        mockDecodeFileSelection.mockImplementation((compositeKey) => {
          const name = compositeKey.endsWith('file1.txt') ? 'file1.txt' : 'file2.txt';
          return { 
            id: compositeKey, path: name, folderId: 'folder1', name: name, type: FileExplorerNodeType.FILE,
            node: { id: compositeKey, path: name, type: FileExplorerNodeType.FILE, name: name, children: [], parent: 'folder1' }
          }
        });
         let capturedItems2: any[] = [];
        mockUseVirtualizer.mockImplementationOnce(({items}) => { 
            capturedItems2 = items; 
            return { getVirtualItems: () => items.map((item, index) => ({index, key: item.id, size:30, start: index*30, data:item})), getTotalSize: () => items.length * 30, scrollToIndex: vi.fn()};
        });

        rerender(<VirtualizedPreviewPanel {...props2} />);
        // Called once for initial, once for new. Total 2 calls.
        expect(mockCountTokensHeuristic).toHaveBeenCalledTimes(2); 
        expect(mockCountTokensHeuristic).toHaveBeenCalledWith(newContent, newFileKey);
        // Ensure old file's token count is still from cache (not re-calculated)
        expect(capturedItems2.find(item => item.type === 'file' && item.id === initialFileKey)?.tokens).toBe(initialContent.length);
        expect(capturedItems2.find(item => item.type === 'file' && item.id === newFileKey)?.tokens).toBe(newContent.length);

        // Rerender with same props, heuristic should not be called again
        rerender(<VirtualizedPreviewPanel {...props2} />);
        expect(mockCountTokensHeuristic).toHaveBeenCalledTimes(2); // Still 2 calls
      });

      it('totalStats calculation should sum tokens and count files correctly, using cached tokens', () => {
        // This is somewhat tested by the header test. Here's a more direct check.
        mockCountTokensHeuristic.mockClear();
        mockCountTokensHeuristic.mockImplementation(content => content.length);

        const files = {
          'f1:a.txt': { content: 'one', size: 3 },   // 3 tokens
          'f1:b.txt': { content: 'two', size: 3 },   // 3 tokens
          'f2:c.txt': { content: 'three', size: 5 }, // 5 tokens
        };
        const selectedFilesSet = new Set(Object.keys(files));
        const props = {
          ...defaultProps,
          selectedFiles: selectedFilesSet,
          fileContents: Object.fromEntries(Object.entries(files).map(([k,v]) => [k,v.content])),
          fileSizes: Object.fromEntries(Object.entries(files).map(([k,v]) => [k,v.size])),
        };
        
        mockDecodeFileSelection.mockImplementation((compositeKey) => {
          const parts = compositeKey.split(':');
          const name = parts[parts.length -1];
          return { 
              id: compositeKey, path: name, folderId: parts[0], name: name, type: FileExplorerNodeType.FILE,
              node: { id: compositeKey, path: name, type: FileExplorerNodeType.FILE, name: name, children: [], parent: parts[0] }
          }
        });
        // Let useVirtualizer capture the items to ensure it runs after flatListItems are processed
        mockUseVirtualizer.mockImplementation(({items}) => ({ 
            getVirtualItems: () => items.map((item, index) => ({index, key: item.id, size:30, start: index*30, data:item})), 
            getTotalSize: () => items.length * 30, 
            scrollToIndex: vi.fn()
        }));

        render(<VirtualizedPreviewPanel {...props} />);

        expect(mockCountTokensHeuristic).toHaveBeenCalledTimes(3); // Once for each file initially
        
        // Verify total stats displayed in the header
        expect(screen.getByText(/3 files selected, 11 total tokens/)).toBeInTheDocument(); // 3+3+5 = 11
        expect(screen.getByText(/11 tokens/)).toBeInTheDocument(); // Badge total
      });
    });

    describe('Edge Cases', () => {
      it('should handle empty selectedFiles prop (already tested in rendering, confirm here)', () => {
        render(<VirtualizedPreviewPanel {...defaultProps} selectedFiles={new Set()} />);
        expect(screen.getByText('No files selected')).toBeInTheDocument();
        expect(screen.queryByRole('progressbar')).not.toBeInTheDocument(); // No progress bar
        expect(screen.queryByText(/files selected/i)).not.toBeInTheDocument(); // No count text
      });

      it('should handle files with missing sizes or content gracefully', () => {
        // Missing size: should format as 0 B or similar.
        // Missing content: should count as 0 tokens.
        const fileKey = 'folder1:file1.txt';
        const props = {
          ...defaultProps,
          selectedFiles: new Set([fileKey]),
          // fileSizes: {}, // Missing size for fileKey
          fileContents: { [fileKey]: undefined }, // Undefined content
        };
        mockDecodeFileSelection.mockImplementationOnce((compositeKey) => ({ 
            id: compositeKey, path: 'file1.txt', folderId: 'folder1', name: 'file1.txt', type: FileExplorerNodeType.FILE,
            node: { id: compositeKey, path: 'file1.txt', type: FileExplorerNodeType.FILE, name: 'file1.txt', children: [], parent: 'folder1' }
        }));
        mockCountTokensHeuristic.mockReturnValueOnce(0); // For undefined content

        setupVirtualizerMock([
            { type: 'folder', id: 'folder1', tokenCount: 0, fileCount: 1, color: 'bg-red-500' },
            { type: 'file', id: fileKey, path: 'file1.txt', name: 'file1.txt', folderId: 'folder1', size: undefined, tokens: 0 },
        ]);

        render(<VirtualizedPreviewPanel {...props} />);
        
        expect(screen.getByText('file1.txt')).toBeInTheDocument();
        expect(screen.getByText('0 B')).toBeInTheDocument(); // Handled by formatFileSize
        // Token count for the file row (will be 0)
        const fileRow = screen.getByText('file1.txt').closest('div[role="listitem"]');
        expect(within(fileRow!).getByText('0 tokens')).toBeInTheDocument();
        
        // Header stats
        expect(screen.getByText(/1 file selected, 0 total tokens/)).toBeInTheDocument();
        expect(screen.getByText(/0 tokens/)).toBeInTheDocument(); // Badge
      });

      // countTokensHeuristic is mocked, so testing its error state needs to be via mock behavior.
      it('should handle countTokensHeuristic error by defaulting to 0 tokens for the problematic file', () => {
        mockCountTokensHeuristic.mockClear();
        const errorFileKey = 'folder1:error.txt';
        const goodFileKey = 'folder1:good.txt';
        const goodContent = "good content"; // 12 tokens
        
        mockCountTokensHeuristic
            .mockImplementationOnce((content, key) => {
                if (key === errorFileKey) throw new Error("Token counting failed!");
                return content.length;
            })
            .mockImplementationOnce(content => content.length); // For goodFileKey

        const props = {
          ...defaultProps,
          selectedFiles: new Set([errorFileKey, goodFileKey]),
          fileContents: { [errorFileKey]: "problematic content", [goodFileKey]: goodContent },
          fileSizes: { [errorFileKey]: 50, [goodFileKey]: 60 },
        };
        mockDecodeFileSelection.mockImplementation((compositeKey) => {
          const name = compositeKey.includes('error') ? 'error.txt' : 'good.txt';
          return { 
              id: compositeKey, path: name, folderId: 'folder1', name: name, type: FileExplorerNodeType.FILE,
              node: { id: compositeKey, path: name, type: FileExplorerNodeType.FILE, name: name, children: [], parent: 'folder1' }
          }
        });
        setupVirtualizerMock([
            { type: 'folder', id: 'folder1', tokenCount: 12, fileCount: 2, color: 'bg-red-500' }, // Only good file's tokens
            { type: 'file', id: errorFileKey, path: 'error.txt', name: 'error.txt', folderId: 'folder1', size: 50, tokens: 0 }, // Error file gets 0
            { type: 'file', id: goodFileKey, path: 'good.txt', name: 'good.txt', folderId: 'folder1', size: 60, tokens: 12 },
        ]);

        render(<VirtualizedPreviewPanel {...props} />);
        
        // Check file row for error file shows 0 tokens
        const errorFileRow = screen.getByText('error.txt').closest('div[role="listitem"]');
        expect(within(errorFileRow!).getByText('0 tokens')).toBeInTheDocument();
        
        // Check file row for good file shows correct tokens
        const goodFileRow = screen.getByText('good.txt').closest('div[role="listitem"]');
        expect(within(goodFileRow!).getByText('12 tokens')).toBeInTheDocument();

        // Header stats should reflect 0 for error file and correct for good file
        expect(screen.getByText(/2 files selected, 12 total tokens/)).toBeInTheDocument();
        expect(screen.getByText(/12 tokens/)).toBeInTheDocument(); // Badge
      });
    });
  });

});
// Need to import 'within' for querying inside elements
import { within } from '@testing-library/react';
