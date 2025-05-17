import { useFileExplorerStore } from '@brainstrike/file-explorer';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileExplorerConfig from '../file-explorer-config';

describe('FileExplorerConfig', () => {
  const defaultProps = {
    includeFilters: ['*.ts'],
    excludeFilters: ['*.test.ts'],
    onFilterChange: vi.fn(),
    filterError: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
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

  it('applies settings and closes popover', async () => {
    const mockOnFilterChange = vi.fn();
    render(<FileExplorerConfig {...defaultProps} onFilterChange={mockOnFilterChange} />);

    const button = screen.getByRole('button');
    await userEvent.click(button);

    // Modify some settings
    const regexSwitch = screen.getByRole('switch', { name: /Use Regex/i });
    await userEvent.click(regexSwitch);

    // Click apply
    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    // Verify settings were applied
    expect(mockOnFilterChange).toHaveBeenCalled();

    // Verify popover is closed
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
