import { useFileExplorerSettings } from '@brainstrike/hooks';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileExplorerStore } from '../../../../stores/use-file-explorer-store';
import FileExplorerConfig from '../../file-explorer-config';

// Mock the hook
vi.mock('@brainstrike/hooks', () => ({
  useFileExplorerSettings: vi.fn(),
}));

describe('FileExplorerConfig', () => {
  const defaultProps = {
    includeFilters: ['*.ts'],
    excludeFilters: ['*.test.ts'],
    onFilterChange: vi.fn(),
    filterError: null,
  };
  const mockUpdateSettings = vi.fn();
  const mockInitialSettings = {
    includeFilters: ['*.ts'],
    excludeFilters: ['*.test.ts'],
    useRegex: false,
    includeProjectTree: true,
    folderSummaryThreshold: 5,
    maxSelectionCount: 10,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock hook return value
    (useFileExplorerSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      settings: { ...mockInitialSettings },
      updateSettings: mockUpdateSettings,
    });

    // Mock Zustand store state (can potentially be simplified if hook drives all state)
    useFileExplorerStore.setState({
      includeFilters: ['*.ts'],
      excludeFilters: ['*.test.ts'],
      useRegex: false,
      includeProjectTree: true,
      folderSummaryThreshold: 5,
      maxSelectionCount: 10,
      setUseRegex: vi.fn((value: boolean) => {
        useFileExplorerStore.setState({ useRegex: value });
      }),
      setIncludeProjectTree: vi.fn((value: boolean) => {
        useFileExplorerStore.setState({ includeProjectTree: value });
      }),
      setFolderSummaryThreshold: vi.fn((value: number) => {
        useFileExplorerStore.setState({ folderSummaryThreshold: value });
      }),
      setMaxSelectionCount: vi.fn((value: number) => {
        useFileExplorerStore.setState({ maxSelectionCount: value });
      }),
      setFilters: vi.fn((include: readonly string[], exclude: readonly string[]) => {
        useFileExplorerStore.setState({
          includeFilters: [...include],
          excludeFilters: [...exclude],
        });
      }),
    });
  });

  it('renders settings button', () => {
    render(<FileExplorerConfig {...defaultProps} />);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('opens popover on button click', async () => {
    render(<FileExplorerConfig {...defaultProps} />);
    const button = screen.getByRole('button');
    await userEvent.click(button);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('displays filter error when present', () => {
    const props = {
      ...defaultProps,
      filterError: 'Invalid regex pattern',
    };
    render(<FileExplorerConfig {...props} />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(screen.getByText('Invalid regex pattern')).toBeInTheDocument();
  });

  it('handles regex toggle', async () => {
    render(<FileExplorerConfig {...defaultProps} />);
    const button = screen.getByRole('button');
    await userEvent.click(button);

    const regexSwitch = screen.getByRole('switch', { name: /Use Regex/i });
    await userEvent.click(regexSwitch);

    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    const store = useFileExplorerStore.getState();
    expect(store.setUseRegex).toHaveBeenCalledWith(true);
    expect(defaultProps.onFilterChange).toHaveBeenCalledWith(
      defaultProps.includeFilters,
      defaultProps.excludeFilters,
      true
    );
  });

  it('handles project tree toggle', async () => {
    render(<FileExplorerConfig {...defaultProps} />);
    const button = screen.getByRole('button');
    await userEvent.click(button);

    const treeSwitch = screen.getByRole('switch', {
      name: /Include Project Tree/i,
    });
    await userEvent.click(treeSwitch);

    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    const store = useFileExplorerStore.getState();
    expect(store.setIncludeProjectTree).toHaveBeenCalledWith(false);
  });

  it('updates folder summary threshold', async () => {
    render(<FileExplorerConfig {...defaultProps} />);
    const button = screen.getByRole('button');
    await userEvent.click(button);

    const input = screen.getByLabelText(/Folder Summary Threshold/i);
    fireEvent.change(input, { target: { value: '10' } });

    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    const store = useFileExplorerStore.getState();
    expect(store.setFolderSummaryThreshold).toHaveBeenCalledWith(10);
  });

  it('updates max selection count', async () => {
    render(<FileExplorerConfig {...defaultProps} />);
    const button = screen.getByRole('button');
    await userEvent.click(button);

    const input = screen.getByLabelText(/Max Selection Count/i);
    fireEvent.change(input, { target: { value: '20' } });

    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    const store = useFileExplorerStore.getState();
    expect(store.setMaxSelectionCount).toHaveBeenCalledWith(20);
  });

  it('applies settings, calls store actions, hook update, and closes popover', async () => {
    const mockOnFilterChange = vi.fn();
    render(<FileExplorerConfig {...defaultProps} onFilterChange={mockOnFilterChange} />);

    const button = screen.getByRole('button');
    await userEvent.click(button);

    // Modify some settings
    const regexSwitch = screen.getByRole('switch', { name: /Use Regex/i });
    await userEvent.click(regexSwitch);
    const maxCountInput = screen.getByLabelText(/Max Selection Count/i);
    await userEvent.clear(maxCountInput);
    await userEvent.type(maxCountInput, '15');

    // Click apply
    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    // Verify store actions were called
    const store = useFileExplorerStore.getState();
    expect(store.setUseRegex).toHaveBeenCalledWith(true);
    expect(store.setMaxSelectionCount).toHaveBeenCalledWith(15);
    expect(store.setFilters).toHaveBeenCalledWith(
      mockInitialSettings.includeFilters,
      mockInitialSettings.excludeFilters
    );

    // Verify settings were applied to hook
    expect(mockOnFilterChange).toHaveBeenCalledWith(
      mockInitialSettings.includeFilters,
      mockInitialSettings.excludeFilters,
      true // useRegex was toggled
    );
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        useRegex: true,
        maxSelectionCount: 15,
      })
    );

    // Verify popover is closed
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
