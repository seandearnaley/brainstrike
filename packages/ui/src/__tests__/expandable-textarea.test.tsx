import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpandableTextarea } from '../expandable-textarea';

describe('ExpandableTextarea', () => {
  it('renders with default props', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea onChange={onChange} value="" />);

    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('sets rows to minRows so the host does not use the native default of two rows', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea minRows={1} onChange={onChange} value="" />);
    expect(screen.getByRole('textbox')).toHaveAttribute('rows', '1');
  });

  it('displays the value', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea onChange={onChange} value="test content" />);

    expect(screen.getByDisplayValue('test content')).toBeInTheDocument();
  });

  it('renders with custom placeholder', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea onChange={onChange} placeholder="Custom placeholder" value="" />);

    expect(screen.getByPlaceholderText('Custom placeholder')).toBeInTheDocument();
  });

  it('uses default placeholder when not provided', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea onChange={onChange} value="" />);

    expect(screen.getByPlaceholderText('Enter search query...')).toBeInTheDocument();
  });

  it('calls onChange when text is entered', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea onChange={onChange} value="" />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new value' } });

    expect(onChange).toHaveBeenCalledWith('new value');
  });

  it('applies custom className', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea className="custom-class" onChange={onChange} value="" />);

    expect(screen.getByRole('textbox')).toHaveClass('custom-class');
  });

  it('disables textarea when disabled prop is true', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea disabled onChange={onChange} value="" />);

    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('is not disabled by default', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea onChange={onChange} value="" />);

    expect(screen.getByRole('textbox')).not.toBeDisabled();
  });

  it('applies id when provided', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea id="my-textarea" onChange={onChange} value="" />);

    expect(screen.getByRole('textbox')).toHaveAttribute('id', 'my-textarea');
  });

  it('applies aria-label when provided', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea aria-label="Search input" onChange={onChange} value="" />);

    expect(screen.getByRole('textbox')).toHaveAttribute('aria-label', 'Search input');
  });

  it('applies maxLength when provided', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea maxLength={123} onChange={onChange} value="" />);
    expect(screen.getByRole('textbox')).toHaveAttribute('maxLength', '123');
  });

  it('calls onKeyDown when key is pressed', () => {
    const onChange = vi.fn();
    const onKeyDown = vi.fn();
    render(<ExpandableTextarea onChange={onChange} onKeyDown={onKeyDown} value="" />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onKeyDown).toHaveBeenCalled();
  });

  it('handles Enter key press', () => {
    const onChange = vi.fn();
    const onKeyDown = vi.fn();
    render(<ExpandableTextarea onChange={onChange} onKeyDown={onKeyDown} value="" />);

    fireEvent.keyDown(screen.getByRole('textbox'), { ctrlKey: true, key: 'Enter' });

    expect(onKeyDown).toHaveBeenCalledWith(
      expect.objectContaining({
        ctrlKey: true,
        key: 'Enter',
      })
    );
  });

  it('handles Escape key press', () => {
    const onChange = vi.fn();
    const onKeyDown = vi.fn();
    render(<ExpandableTextarea onChange={onChange} onKeyDown={onKeyDown} value="" />);

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
    render(<ExpandableTextarea onChange={onChange} value={multilineContent} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toContain('line1');
    expect(textarea.value).toContain('line2');
    expect(textarea.value).toContain('line3');
  });

  it('has resize:none class to prevent manual resize', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea onChange={onChange} value="" />);

    expect(screen.getByRole('textbox')).toHaveClass('resize-none');
  });

  it('handles custom minRows', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea minRows={2} onChange={onChange} value="" />);

    expect(screen.getByRole('textbox')).toHaveAttribute('rows', '2');
  });

  it('handles custom maxRows', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea maxRows={10} onChange={onChange} value="" />);

    // Component should render without errors with custom maxRows
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('respects min and max rows together', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea maxRows={8} minRows={3} onChange={onChange} value="" />);

    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  describe('height clamping with minHeight and maxRows', () => {
    let scrollHeightSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      scrollHeightSpy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200);
    });

    afterEach(() => {
      scrollHeightSpy.mockRestore();
    });

    it('maintains minHeight as floor when maxRows=1 and content is multi-line', () => {
      const onChange = vi.fn();
      render(
        <ExpandableTextarea
          maxRows={1}
          minHeight={36}
          onChange={onChange}
          value={'line1\nline2\nline3'}
        />
      );

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      // With maxRows=1: rawMaxHeight = 20px (1 row * 20 lineHeight + 0 padding)
      // calculatedMinHeight = 36px (minHeight prop)
      // After fix: calculatedMaxHeight = Math.max(20, 36) = 36px
      // newHeight = Math.min(Math.max(200, 36), 36) = 36px
      // Before fix: calculatedMaxHeight = 20px
      // newHeight = Math.min(Math.max(200, 36), 20) = 20px  ← BUG
      expect(Number.parseInt(textarea.style.height, 10)).toBeGreaterThanOrEqual(36);
    });

    it('still caps height at maxRows when maxRows produces a higher limit than minHeight', () => {
      const onChange = vi.fn();
      render(
        <ExpandableTextarea
          maxRows={3}
          minHeight={36}
          onChange={onChange}
          value={'line1\nline2\nline3'}
        />
      );

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      // maxRows=3: rawMaxHeight = 20*3 = 60px > minHeight=36px
      // calculatedMaxHeight = Math.max(60, 36) = 60px
      // newHeight = Math.min(Math.max(200, 36), 60) = 60px
      expect(Number.parseInt(textarea.style.height, 10)).toBe(60);
    });
  });

  it('maintains focus on input', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea onChange={onChange} value="" />);

    const textarea = screen.getByRole('textbox');
    textarea.focus();

    expect(document.activeElement).toBe(textarea);
  });

  it('has appropriate styling classes', () => {
    const onChange = vi.fn();
    render(<ExpandableTextarea onChange={onChange} value="" />);

    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveClass('w-full');
    expect(textarea).toHaveClass('rounded-md');
    expect(textarea).toHaveClass('border');
  });
});
