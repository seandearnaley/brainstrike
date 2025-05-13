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
    onDownloadReport: vi.fn(),
    onCopyReport: vi.fn(),
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

    it('should show max selection count when files exceed limit', () => {
      const props = getProps({
        displayedFiles: new Set(['file1.txt', 'file2.txt', 'file3.txt']),
        maxSelectionCount: 2,
      });
      render(<ActionButtons {...props} />);
      expect(screen.getByRole('button', { name: 'Select 2' })).toBeInTheDocument();
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

    it('should select up to max selection limit when files exceed limit', async () => {
      const props = getProps({
        displayedFiles: new Set(['file1.txt', 'file2.txt', 'file3.txt']),
        maxSelectionCount: 2,
      });
      const user = userEvent.setup();
      render(<ActionButtons {...props} />);
      const selectButton = screen.getByRole('button', {
        name: 'Select 2',
      });
      await user.click(selectButton);
      const expectedSelection = new Set(['test-folder:file1.txt', 'test-folder:file2.txt']);
      expect(props.setSelectedFiles).toHaveBeenCalledWith(expectedSelection);
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
      const selectButton = screen.getByRole('button', {
        name: 'Select 2',
      });
      expect(selectButton).not.toBeDisabled();
    });

    it('should not call setSelectedFiles with undefined when encodeFileSelection returns undefined', async () => {
      const setSelectedFiles = vi.fn();
      const props = getProps({
        displayedFiles: new Set(['file1.txt', 'file2.txt']),
        // Bypass TS: simulate bug by returning undefined as string
        encodeFileSelection: (() => undefined) as unknown as (
          folderId: string,
          path: string
        ) => string,
        setSelectedFiles,
      });
      const user = userEvent.setup();
      render(<ActionButtons {...props} />);
      const selectAllButton = screen.getByRole('button', { name: /select all/i });
      await user.click(selectAllButton);

      expect(setSelectedFiles).toHaveBeenCalled();
      const calledWith = setSelectedFiles.mock.calls[0]?.[0];
      expect([...calledWith].every((v) => typeof v === 'string')).toBe(true);
    });
  });

  describe('Report Buttons', () => {
    it('should disable report buttons when no files are selected', () => {
      const props = getProps();
      render(<ActionButtons {...props} />);
      expect(screen.getByRole('button', { name: /download report/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /copy report/i })).toBeDisabled();
    });

    it('should enable report buttons when files are selected', () => {
      const props = getProps({
        selectedFilePaths: new Set(['test-folder:file1.txt']),
      });
      render(<ActionButtons {...props} />);
      expect(screen.getByRole('button', { name: /download report/i })).not.toBeDisabled();
      expect(screen.getByRole('button', { name: /copy report/i })).not.toBeDisabled();
    });
  });
});
