import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileExplorerConfig from '../file-explorer-config';
import { FileExplorerTestWrapper } from './test-helpers';

const Wrapper = composeWrappers(({ children }) => (
  <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
));
const renderWithProviders = makeRenderWithProviders(Wrapper);

describe('FileExplorerConfig', () => {
  const defaultProps = {
    filterError: null,
    onFilterChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders settings button', () => {
    act(() => {
      renderWithProviders(<FileExplorerConfig {...defaultProps} />);
    });
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('opens popover on button click', async () => {
    act(() => {
      renderWithProviders(<FileExplorerConfig {...defaultProps} />);
    });
    const button = screen.getByRole('button');
    await userEvent.click(button);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('displays filter error when present', () => {
    const props = {
      ...defaultProps,
      filterError: 'Invalid regex pattern',
    };
    act(() => {
      renderWithProviders(<FileExplorerConfig {...props} />);
    });
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(screen.getByText('Invalid regex pattern')).toBeInTheDocument();
  });

  it('handles regex toggle', async () => {
    act(() => {
      renderWithProviders(<FileExplorerConfig {...defaultProps} />);
    });
    const button = screen.getByRole('button');
    await userEvent.click(button);

    const regexSwitch = screen.getByRole('switch', { name: /Use Regex/i });
    await userEvent.click(regexSwitch);

    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    // Just verify the callback was called (integration test would verify state changes)
    expect(defaultProps.onFilterChange).toHaveBeenCalled();
  });

  it('handles project tree toggle', async () => {
    act(() => {
      renderWithProviders(<FileExplorerConfig {...defaultProps} />);
    });
    const button = screen.getByRole('button');
    await userEvent.click(button);

    const treeSwitch = screen.getByRole('switch', {
      name: /Include Project Tree/i,
    });
    await userEvent.click(treeSwitch);

    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    // Just verify UI interaction works
    expect(defaultProps.onFilterChange).toHaveBeenCalled();
  });

  it('updates folder summary threshold', async () => {
    act(() => {
      renderWithProviders(<FileExplorerConfig {...defaultProps} />);
    });
    const button = screen.getByRole('button');
    await userEvent.click(button);

    const input = screen.getByLabelText(/Folder Summary Threshold/i);
    fireEvent.change(input, { target: { value: '10' } });

    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    // Just verify UI interaction works
    expect(defaultProps.onFilterChange).toHaveBeenCalled();
  });

  it('updates max selection count', async () => {
    renderWithProviders(<FileExplorerConfig {...defaultProps} />);
    const button = screen.getByRole('button');
    await userEvent.click(button);

    const input = screen.getByLabelText(/Max Selection Count/i);
    fireEvent.change(input, { target: { value: '20' } });

    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    // Just verify UI interaction works
    expect(defaultProps.onFilterChange).toHaveBeenCalled();
  });

  it('applies settings and closes popover', async () => {
    const mockOnFilterChange = vi.fn();
    act(() => {
      renderWithProviders(
        <FileExplorerConfig {...defaultProps} onFilterChange={mockOnFilterChange} />
      );
    });

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
