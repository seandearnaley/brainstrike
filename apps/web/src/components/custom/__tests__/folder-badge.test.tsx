import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getFolderColor } from '../../../utils/color-utils';
import { FolderBadge } from '../folder-badge';

// Define mock function type
type MockedGetFolderColor = ReturnType<typeof vi.fn> & {
  mockReturnValue: (value: unknown) => void;
};

// Mock the color-utils module
vi.mock('../../../utils/color-utils', () => ({
  getFolderColor: vi.fn(),
}));

describe('FolderBadge', () => {
  beforeEach(() => {
    // Setup default mock return value
    (getFolderColor as MockedGetFolderColor).mockReturnValue({
      light: { bg: '#e2e8f0', text: '#334155' },
      dark: { bg: '#334155', text: '#e2e8f0' },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('renders correctly with folder ID', () => {
    render(<FolderBadge folderId="test-folder" />);

    // Check that the folder ID is displayed
    expect(screen.getByText('test-folder')).toBeInTheDocument();

    // Check that the folder icon is rendered
    expect(document.querySelector('.lucide-folder')).toBeInTheDocument();

    // Verify getFolderColor was called with the correct folder ID
    expect(getFolderColor).toHaveBeenCalledWith('test-folder');
  });

  test('applies custom className when provided', () => {
    render(<FolderBadge folderId="test-folder" className="custom-class" />);

    // Since .closest() might not work as expected in JSDOM, let's check directly
    const badgeElement = screen.getByText('test-folder').parentElement;
    expect(badgeElement).not.toBeNull();
    expect(badgeElement?.className).toContain('custom-class');
  });

  test('applies the correct colors based on getFolderColor result', () => {
    const mockColors = {
      light: { bg: '#ff0000', text: '#ffffff' },
      dark: { bg: '#000000', text: '#ffffff' },
    };

    (getFolderColor as MockedGetFolderColor).mockReturnValue(mockColors);

    render(<FolderBadge folderId="colored-folder" />);

    // Get the Badge element
    const badgeElement = screen.getByText('colored-folder').parentElement;
    expect(badgeElement).not.toBeNull();

    // Check that the style attributes are passed correctly
    // Note: We can't directly test the computed style in JSDOM,
    // so we'll check that the inline style attributes are set
    if (badgeElement) {
      expect(badgeElement.style.getPropertyValue('--folder-bg')).toBe('#ff0000');
      expect(badgeElement.style.getPropertyValue('--folder-text')).toBe('#ffffff');
      expect(badgeElement.style.getPropertyValue('--folder-dark-bg')).toBe('#000000');
      expect(badgeElement.style.getPropertyValue('--folder-dark-text')).toBe('#ffffff');
      expect(badgeElement.style.backgroundColor).toBe('var(--folder-bg)');
      expect(badgeElement.style.color).toBe('var(--folder-text)');
    }
  });
});
