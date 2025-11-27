import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExpandableTextarea } from '../expandable-textarea';

describe('ExpandableTextarea', () => {
  it('renders with default props', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} />);

    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('displays the value', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea value="test content" onChange={onChange} />);

    expect(screen.getByDisplayValue('test content')).toBeInTheDocument();
  });

  it('renders with custom placeholder', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} placeholder="Custom placeholder" />);

    expect(screen.getByPlaceholderText('Custom placeholder')).toBeInTheDocument();
  });

  it('uses default placeholder when not provided', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} />);

    expect(screen.getByPlaceholderText('Enter search query...')).toBeInTheDocument();
  });

  it('calls onChange when text is entered', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new value' } });

    expect(onChange).toHaveBeenCalledWith('new value');
  });

  it('applies custom className', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} className="custom-class" />);

    expect(screen.getByRole('textbox')).toHaveClass('custom-class');
  });

  it('disables textarea when disabled prop is true', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} disabled />);

    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('is not disabled by default', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} />);

    expect(screen.getByRole('textbox')).not.toBeDisabled();
  });

  it('applies id when provided', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} id="my-textarea" />);

    expect(screen.getByRole('textbox')).toHaveAttribute('id', 'my-textarea');
  });

  it('applies aria-label when provided', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} aria-label="Search input" />);

    expect(screen.getByRole('textbox')).toHaveAttribute('aria-label', 'Search input');
  });

  it('calls onKeyDown when key is pressed', () => {
    const onChange = vi.fn();
    const onKeyDown = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} onKeyDown={onKeyDown} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onKeyDown).toHaveBeenCalled();
  });

  it('handles Enter key press', () => {
    const onChange = vi.fn();
    const onKeyDown = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} onKeyDown={onKeyDown} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });

    expect(onKeyDown).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'Enter',
        ctrlKey: true,
      })
    );
  });

  it('handles Escape key press', () => {
    const onChange = vi.fn();
    const onKeyDown = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} onKeyDown={onKeyDown} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    expect(onKeyDown).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'Escape',
      })
    );
  });

  it('handles multiline content', () => {
    const onChange = vi.fn();
    const multilineContent = 'line1\nline2\nline3';
    render(<ExpandableTextarea value={multilineContent} onChange={onChange} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toContain('line1');
    expect(textarea.value).toContain('line2');
    expect(textarea.value).toContain('line3');
  });

  it('has resize:none class to prevent manual resize', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} />);

    expect(screen.getByRole('textbox')).toHaveClass('resize-none');
  });

  it('handles custom minRows', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} minRows={2} />);

    // Component should render without errors with custom minRows
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('handles custom maxRows', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} maxRows={10} />);

    // Component should render without errors with custom maxRows
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('respects min and max rows together', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} minRows={3} maxRows={8} />);

    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('maintains focus on input', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} />);

    const textarea = screen.getByRole('textbox');
    textarea.focus();

    expect(document.activeElement).toBe(textarea);
  });

  it('has appropriate styling classes', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea value="" onChange={onChange} />);

    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveClass('w-full');
    expect(textarea).toHaveClass('rounded-md');
    expect(textarea).toHaveClass('border');
  });
});
