import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import type { IFileNode } from '@brainstrike/types';
import type { ActionButtonsProps } from '../action-buttons';
import { ActionButtons } from '../action-buttons';

const DEFAULT_MAX_SELECTION = 10;
const TEST_FOLDER_ID = 'test-folder';

function getProps(overrides: Partial<ActionButtonsProps> = {}): ActionButtonsProps {
  return {
    displayedFiles: new Set(['file1.txt', 'file2.txt', 'file3.txt']),
    selectedFilePaths: new Set<string>(),
    maxSelectionCount: DEFAULT_MAX_SELECTION,
    currentFolderId: TEST_FOLDER_ID,
    setSelectedFiles: vi.fn(),
    encodeFileSelection: (folderId, path) => `${folderId}:${path}`,
    ...overrides,
  };
}

function createFullyLoadedTree(): IFileNode[] {
  return [
    {
      name: 'src',
      path: '/src',
      type: 'directory',
      depth: 0,
      handle: {} as FileSystemDirectoryHandle,
      selectionState: 'unchecked' as const,
      rootFolderId: TEST_FOLDER_ID,
      loadState: 'loaded' as const,
      children: [
        {
          name: 'a.ts',
          path: '/src/a.ts',
          type: 'file',
          depth: 1,
          handle: {} as FileSystemFileHandle,
          selectionState: 'unchecked' as const,
          rootFolderId: TEST_FOLDER_ID,
        },
      ],
    },
  ];
}

describe('ActionButtons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Button Text and State', () => {
    it('should show "Select All" when no files are displayed', () => {
      const props = getProps({ displayedFiles: new Set<string>() });
      render(<ActionButtons {...props} />);
      expect(screen.getByRole('button', { name: 'Select All' })).toBeInTheDocument();
    });

    it('should show "Select All" when files are within max limit', () => {
      const props = getProps({ displayedFiles: new Set(['file1.txt', 'file2.txt']) });
      render(<ActionButtons {...props} />);
      expect(screen.getByRole('button', { name: 'Select All' })).toBeInTheDocument();
    });

    it('should show "Select All" even when files exceed limit (recursive selection handles limits)', () => {
      const props = getProps({
        displayedFiles: new Set(['file1.txt', 'file2.txt', 'file3.txt']),
        maxSelectionCount: 2,
      });
      render(<ActionButtons {...props} />);
      // Now always shows "Select All" since recursive selection handles the limit internally
      expect(screen.getByRole('button', { name: 'Select All' })).toBeInTheDocument();
    });

    it('should show "Deselect All" when files are selected', () => {
      const props = getProps({
        displayedFiles: new Set(['file1.txt', 'file2.txt']),
        selectedFilePaths: new Set(['test-folder:file1.txt']),
      });
      render(<ActionButtons {...props} />);
      expect(screen.getByRole('button', { name: 'Deselect All' })).toBeInTheDocument();
    });

    it('renders compact and full labels so the button can collapse in narrow panels', () => {
      const props = getProps();
      render(<ActionButtons {...props} />);

      expect(screen.getByTestId('bulk-action-short-label')).toHaveTextContent('Select');
      expect(screen.getByTestId('bulk-action-full-label')).toHaveTextContent('Select All');
    });

    it('updates compact and full labels when selections are active', () => {
      const props = getProps({
        selectedFilePaths: new Set(['test-folder:file1.txt']),
      });
      render(<ActionButtons {...props} />);

      expect(screen.getByTestId('bulk-action-short-label')).toHaveTextContent('Clear');
      expect(screen.getByTestId('bulk-action-full-label')).toHaveTextContent('Deselect All');
    });

    it('shows a tooltip for Select All', async () => {
      const user = userEvent.setup();
      const props = getProps();
      render(<ActionButtons {...props} />);

      await user.hover(screen.getByRole('button', { name: 'Select All' }));

      expect(await screen.findByRole('tooltip')).toHaveTextContent(
        'Select all files in the current explorer view'
      );
    });

    it('shows a tooltip for Deselect All', async () => {
      const user = userEvent.setup();
      const props = getProps({
        selectedFilePaths: new Set(['test-folder:file1.txt']),
      });
      render(<ActionButtons {...props} />);

      await user.hover(screen.getByRole('button', { name: 'Deselect All' }));

      expect(await screen.findByRole('tooltip')).toHaveTextContent(
        'Clear the current file selection'
      );
    });
  });

  describe('Button Functionality', () => {
    it('always routes select-all through the canonical recursive selection path', async () => {
      const selectAllRecursively = vi.fn(async () => ({
        success: true,
        filePaths: ['/src/a.ts', '/README.md'],
        limitReached: false,
      }));
      const props = getProps({
        addMultipleSelectedFiles: vi.fn(),
        filteredTree: createFullyLoadedTree(),
        selectAllRecursively,
        visibleFilePaths: ['/src/a.ts', '/README.md'],
      });

      const user = userEvent.setup();
      render(<ActionButtons {...props} />);
      await user.click(screen.getByRole('button', { name: 'Select All' }));

      expect(selectAllRecursively).toHaveBeenCalledWith(
        createFullyLoadedTree(),
        TEST_FOLDER_ID,
        expect.any(Function),
        DEFAULT_MAX_SELECTION,
        undefined
      );
      expect(props.setSelectedFiles).not.toHaveBeenCalled();
    });

    it('leaves query-mode decisions to the recursive selection hook instead of the button', async () => {
      const visibleFilePaths = Array.from({ length: 600 }, (_, index) => `/src/file-${index}.ts`);
      const selectAllRecursively = vi.fn(async () => ({
        success: true,
        filePaths: visibleFilePaths,
        limitReached: false,
      }));
      const props = getProps({
        addMultipleSelectedFiles: vi.fn(),
        filteredTree: createFullyLoadedTree(),
        maxSelectionCount: 1000,
        selectAllRecursively,
        visibleFilePaths,
      });

      const user = userEvent.setup();
      render(<ActionButtons {...props} />);
      await user.click(screen.getByRole('button', { name: 'Select All' }));

      expect(selectAllRecursively).toHaveBeenCalled();
    });

    it('should select all files when clicking "Select All" and files are within limit', async () => {
      const props = getProps({
        displayedFiles: new Set(['file1.txt', 'file2.txt']),
      });
      const user = userEvent.setup();
      render(<ActionButtons {...props} />);
      const selectAllButton = screen.getByRole('button', {
        name: 'Select All',
      });
      expect(selectAllButton).not.toBeDisabled();
      await user.click(selectAllButton);
      const expectedSelection = new Set(['test-folder:file1.txt', 'test-folder:file2.txt']);
      expect(props.setSelectedFiles).toHaveBeenCalledWith(expectedSelection);
    });

    it('uses explicit visible-file selection when a quick filter is active', async () => {
      const selectAllRecursively = vi.fn();
      const props = getProps({
        addMultipleSelectedFiles: vi.fn(),
        currentFolderId: TEST_FOLDER_ID,
        displayedFiles: new Set<string>(),
        filteredTree: createFullyLoadedTree(),
        hasActiveQuickFilter: true,
        selectAllRecursively,
        setSelectedFiles: vi.fn(),
        visibleFilePaths: ['/test.ts', '/test2.ts'],
      });

      const user = userEvent.setup();
      render(<ActionButtons {...props} />);
      await user.click(screen.getByRole('button', { name: 'Select All' }));

      expect(selectAllRecursively).not.toHaveBeenCalled();
      expect(props.setSelectedFiles).toHaveBeenCalledWith(
        new Set(['test-folder:/test.ts', 'test-folder:/test2.ts'])
      );
    });

    it('should select up to max selection limit when files exceed limit (fallback behavior)', async () => {
      const props = getProps({
        displayedFiles: new Set(['file1.txt', 'file2.txt', 'file3.txt']),
        maxSelectionCount: 2,
      });
      const user = userEvent.setup();
      render(<ActionButtons {...props} />);
      // Button now always says "Select All" - limit is handled by selection logic
      const selectButton = screen.getByRole('button', {
        name: 'Select All',
      });
      await user.click(selectButton);
      // Fallback behavior (no selectAllRecursively): selects up to max from displayed files
      const expectedSelection = new Set(['test-folder:file1.txt', 'test-folder:file2.txt']);
      expect(props.setSelectedFiles).toHaveBeenCalledWith(expectedSelection);
    });

    it('caps fallback Select All without a limit notification prop', async () => {
      const setSelectedFiles = vi.fn();
      const props = getProps({
        displayedFiles: new Set(['file1.txt', 'file2.txt', 'file3.txt']),
        maxSelectionCount: 2,
        setSelectedFiles,
      });
      const user = userEvent.setup();
      render(<ActionButtons {...props} />);
      // Button now always says "Select All" - limit notification still works
      const selectButton = screen.getByRole('button', {
        name: 'Select All',
      });
      await user.click(selectButton);
      const expectedSelection = new Set(['test-folder:file1.txt', 'test-folder:file2.txt']);
      expect(setSelectedFiles).toHaveBeenCalledWith(expectedSelection);
    });

    it('caps quick-filter explicit selection to maxSelectionCount', async () => {
      const setSelectedFiles = vi.fn();
      const onSelectionLimitExceeded = vi.fn();
      const props = getProps({
        currentFolderId: TEST_FOLDER_ID,
        displayedFiles: new Set<string>(),
        hasActiveQuickFilter: true,
        maxSelectionCount: 2,
        onSelectionLimitExceeded,
        setSelectedFiles,
        visibleFilePaths: ['/test.ts', '/test2.ts', '/test3.ts'],
      });

      const user = userEvent.setup();
      render(<ActionButtons {...props} />);
      await user.click(screen.getByRole('button', { name: 'Select All' }));

      expect(setSelectedFiles).toHaveBeenCalledWith(
        new Set(['test-folder:/test.ts', 'test-folder:/test2.ts'])
      );
      expect(onSelectionLimitExceeded).toHaveBeenCalledTimes(1);
    });

    it('accepts recursive Select All cap results without a limit notification prop', async () => {
      const selectAllRecursively = vi.fn().mockResolvedValue({
        success: true,
        filePaths: ['/src/a.ts'],
        totalAvailable: 2,
        limitReached: true,
      });
      const props = getProps({
        addMultipleSelectedFiles: vi.fn(),
        filteredTree: createFullyLoadedTree(),
        maxSelectionCount: 1,
        selectAllRecursively,
      });

      const user = userEvent.setup();
      render(<ActionButtons {...props} />);
      await user.click(screen.getByRole('button', { name: 'Select All' }));

      expect(selectAllRecursively).toHaveBeenCalled();
    });

    it('notifies when recursive Select All reaches the selection limit', async () => {
      const onSelectionLimitExceeded = vi.fn();
      const selectAllRecursively = vi.fn().mockResolvedValue({
        success: true,
        filePaths: ['/src/a.ts'],
        totalAvailable: 2,
        limitReached: true,
      });
      const props = getProps({
        addMultipleSelectedFiles: vi.fn(),
        filteredTree: createFullyLoadedTree(),
        maxSelectionCount: 1,
        onSelectionLimitExceeded,
        selectAllRecursively,
      });

      const user = userEvent.setup();
      render(<ActionButtons {...props} />);
      await user.click(screen.getByRole('button', { name: 'Select All' }));

      await waitFor(() => {
        expect(selectAllRecursively).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(onSelectionLimitExceeded).toHaveBeenCalledTimes(1);
      });
    });

    it('should deselect all files when clicking "Deselect All"', async () => {
      const props = getProps({
        displayedFiles: new Set(['file1.txt', 'file2.txt']),
        selectedFilePaths: new Set(['test-folder:file1.txt', 'test-folder:file2.txt']),
      });
      const user = userEvent.setup();
      render(<ActionButtons {...props} />);
      const deselectAllButton = screen.getByRole('button', {
        name: 'Deselect All',
      });
      expect(deselectAllButton).not.toBeDisabled();
      await user.click(deselectAllButton);
      expect(props.setSelectedFiles).toHaveBeenCalledWith(new Set());
    });

    it('should enable select button when files are available even if they exceed max limit', () => {
      const props = getProps({
        displayedFiles: new Set(['file1.txt', 'file2.txt', 'file3.txt']),
        maxSelectionCount: 2,
      });
      render(<ActionButtons {...props} />);
      // Button now always says "Select All"
      const selectButton = screen.getByRole('button', {
        name: 'Select All',
      });
      expect(selectButton).not.toBeDisabled();
    });
  });
});
