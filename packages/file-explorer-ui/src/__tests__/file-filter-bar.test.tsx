import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileFilterBar } from '../file-filter-bar';

describe('FileFilterBar', () => {
  const defaultProps = {
    value: '',
    onChange: vi.fn(),
    onClear: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with placeholder text', () => {
    render(<FileFilterBar {...defaultProps} />);
    expect(
      screen.getByPlaceholderText(/Type to filter files... \(e.g. 'test component -spec'\)/i)
    ).toBeInTheDocument();
  });

  it('shows clear button only when there is input', async () => {
    const { rerender } = render(<FileFilterBar {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();

    rerender(<FileFilterBar {...defaultProps} value="test" />);
    expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
  });

  it('calls onChange when typing', async () => {
    const onChange = vi.fn();
    render(<FileFilterBar {...defaultProps} onChange={onChange} />);

    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'test');

    expect(onChange).toHaveBeenCalledTimes(4);
    expect(onChange).toHaveBeenNthCalledWith(1, 't');
    expect(onChange).toHaveBeenNthCalledWith(2, 'e');
    expect(onChange).toHaveBeenNthCalledWith(3, 's');
    expect(onChange).toHaveBeenNthCalledWith(4, 't');
  });

  it('calls onClear when clear button is clicked', async () => {
    const onClear = vi.fn();
    render(<FileFilterBar {...defaultProps} onClear={onClear} value="test" />);

    const clearButton = screen.getByRole('button', { name: /clear/i });
    await userEvent.click(clearButton);

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('shows filter syntax help when info button is clicked', async () => {
    const user = userEvent.setup();
    render(<FileFilterBar {...defaultProps} />);

    const helpButton = screen.getByRole('button', {
      name: /filter syntax help/i,
    });
    await user.click(helpButton);

    // Check content is visible
    expect(screen.getByText(/Filter Syntax:/)).toBeInTheDocument();
    expect(screen.getByText(/Use spaces to separate multiple terms/)).toBeInTheDocument();
    expect(screen.getByText(/-term/)).toBeInTheDocument();
    expect(screen.getByText(/test component -spec/)).toBeInTheDocument();
  });

  it('maintains input value while typing', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<FileFilterBar {...defaultProps} onChange={onChange} />);

    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'test');

    // Simulate parent component updating value
    rerender(<FileFilterBar {...defaultProps} onChange={onChange} value="test" />);
    expect(input).toHaveValue('test');
  });

  it('handles empty value correctly', () => {
    render(<FileFilterBar {...defaultProps} value="" />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('');
    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
  });

  describe('visual consistency with collection-browser filter input', () => {
    it('renders a leading search icon for visual consistency', () => {
      const { container } = render(<FileFilterBar {...defaultProps} />);
      // lucide Search icon — class is added by lucide-react automatically
      const searchIcon = container.querySelector('svg.lucide-search');
      expect(searchIcon).toBeInTheDocument();
    });

    it('uses the compact h-8 input height to match the toolbar filter input', () => {
      render(<FileFilterBar {...defaultProps} />);
      const input = screen.getByRole('textbox');
      expect(input.className).toMatch(/\bh-8\b/);
    });

    it('uses pl-9 to leave room for the leading search icon', () => {
      render(<FileFilterBar {...defaultProps} />);
      const input = screen.getByRole('textbox');
      expect(input.className).toMatch(/\bpl-9\b/);
    });
  });
});
