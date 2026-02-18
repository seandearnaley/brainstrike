import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
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
    onSelectionLimitExceeded: vi.fn(),
    ...overrides,
  };
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
  });

  describe('Button Functionality', () => {
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

    it('calls onSelectionLimitExceeded when selecting all exceeds limit (fallback behavior)', async () => {
      const onSelectionLimitExceeded = vi.fn();
      const setSelectedFiles = vi.fn();
      const props = getProps({
        displayedFiles: new Set(['file1.txt', 'file2.txt', 'file3.txt']),
        maxSelectionCount: 2,
        onSelectionLimitExceeded,
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
      expect(onSelectionLimitExceeded).toHaveBeenCalled();
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
