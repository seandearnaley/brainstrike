import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ClearStoredFoldersPanel } from '../settings/system/clear-stored-folders-panel';

describe('ClearStoredFoldersPanel', () => {
  describe('rendering', () => {
    it('renders heading, description, and button', () => {
      const mockOnClearFolders = vi.fn();

      render(
        <ClearStoredFoldersPanel hasStoredFolders={true} onClearFolders={mockOnClearFolders} />
      );

      expect(screen.getByText('Stored Folders')).toBeInTheDocument();
      expect(
        screen.getByText(
          /Clear all remembered folders for File System access\. This will require you to re-select folders next time you use the file explorer\./u
        )
      ).toBeInTheDocument();
      expect(screen.getByTestId('clear-stored-folders-button')).toBeInTheDocument();
      expect(screen.getByText('Forget all folders')).toBeInTheDocument();
    });

    it('renders by default (assumes web platform)', () => {
      const mockOnClearFolders = vi.fn();

      render(
        <ClearStoredFoldersPanel hasStoredFolders={true} onClearFolders={mockOnClearFolders} />
      );

      expect(screen.getByTestId('clear-stored-folders-button')).toBeInTheDocument();
    });
  });

  describe('button disabled state', () => {
    it('disables button when no stored folders exist', () => {
      const mockOnClearFolders = vi.fn();

      render(
        <ClearStoredFoldersPanel hasStoredFolders={false} onClearFolders={mockOnClearFolders} />
      );

      const button = screen.getByTestId('clear-stored-folders-button') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });

    it('enables button when stored folders exist', () => {
      const mockOnClearFolders = vi.fn();

      render(
        <ClearStoredFoldersPanel hasStoredFolders={true} onClearFolders={mockOnClearFolders} />
      );

      const button = screen.getByTestId('clear-stored-folders-button') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
  });

  describe('user interactions', () => {
    it('calls onClearFolders when button is clicked', async () => {
      const user = userEvent.setup();
      const mockOnClearFolders = vi.fn();

      render(
        <ClearStoredFoldersPanel hasStoredFolders={true} onClearFolders={mockOnClearFolders} />
      );

      const button = screen.getByTestId('clear-stored-folders-button');
      await user.click(button);

      expect(mockOnClearFolders).toHaveBeenCalledTimes(1);
    });
  });

  describe('platform visibility', () => {
    it('returns null when isWebPlatform is false', () => {
      const mockOnClearFolders = vi.fn();

      const { container } = render(
        <ClearStoredFoldersPanel
          hasStoredFolders={true}
          isWebPlatform={false}
          onClearFolders={mockOnClearFolders}
        />
      );

      expect(container.firstChild).toBeNull();
    });

    it('renders when isWebPlatform is true', () => {
      const mockOnClearFolders = vi.fn();

      render(
        <ClearStoredFoldersPanel
          hasStoredFolders={true}
          isWebPlatform={true}
          onClearFolders={mockOnClearFolders}
        />
      );

      expect(screen.getByTestId('clear-stored-folders-button')).toBeInTheDocument();
    });
  });
});
