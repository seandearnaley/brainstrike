/**
 * ExpandableTextarea Component
 *
 * An auto-growing textarea that expands from a single line to multiple rows
 * as content is added. Designed for RAG prompts and longer search queries.
 */

import * as React from 'react';
import { cn } from './lib/utils';

export type ExpandableTextareaProps = {
  /** Current value */
  value: string;
  /** Callback when value changes */
  onChange: (value: string) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Minimum number of rows (default: 1) */
  minRows?: number;
  /** Maximum number of rows (default: 6) */
  maxRows?: number;
  /** Keyboard event handler */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Maximum input length */
  maxLength?: number;
  /** Custom class name */
  className?: string;
  /** Whether the textarea is disabled */
  disabled?: boolean;
  /** ID for the textarea */
  id?: string;
  /** Aria label for accessibility */
  'aria-label'?: string;
};

/**
 * ExpandableTextarea - Auto-growing textarea for RAG prompts
 *
 * Features:
 * - Starts as single-line (matches Input component height)
 * - Grows up to maxRows as content expands
 * - Collapses when content is removed
 * - Keyboard shortcuts: Cmd/Ctrl+Enter to submit (handled by parent)
 */
export const ExpandableTextarea = React.memo(function ExpandableTextarea({
  value,
  onChange,
  placeholder = 'Enter search query...',
  minRows = 1,
  maxRows = 6,
  onKeyDown,
  maxLength,
  className,
  disabled = false,
  id,
  'aria-label': ariaLabel,
}: ExpandableTextareaProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const [height, setHeight] = React.useState<number | undefined>(undefined);

  // Calculate line height once on mount
  const lineHeightRef = React.useRef<number>(20); // Default fallback

  // Update height when value changes
  React.useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    // Get computed line height
    const computedStyle = window.getComputedStyle(textarea);
    const lineHeight = Number.parseInt(computedStyle.lineHeight, 10);
    if (!Number.isNaN(lineHeight)) {
      lineHeightRef.current = lineHeight;
    }

    // Get padding
    const paddingTop = Number.parseInt(computedStyle.paddingTop, 10) || 0;
    const paddingBottom = Number.parseInt(computedStyle.paddingBottom, 10) || 0;
    const verticalPadding = paddingTop + paddingBottom;

    // Calculate min and max heights
    const minHeight = lineHeightRef.current * minRows + verticalPadding;
    const maxHeight = lineHeightRef.current * maxRows + verticalPadding;

    // Reset height to auto to get accurate scrollHeight
    textarea.style.height = 'auto';
    const scrollHeight = textarea.scrollHeight;

    // Clamp to min/max
    const newHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
    setHeight(newHeight);
  }, [value, minRows, maxRows]);

  // Handle change
  const handleChange = React.useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
    },
    [onChange]
  );

  return (
    <textarea
      aria-label={ariaLabel}
      className={cn(
        'w-full resize-none transition-[height] duration-150 ease-out',
        'rounded-md border border-input bg-background px-3 py-2',
        'text-sm ring-offset-background',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      disabled={disabled}
      id={id}
      maxLength={maxLength}
      onChange={handleChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      ref={textareaRef}
      style={{ height }}
      value={value}
    />
  );
});

ExpandableTextarea.displayName = 'ExpandableTextarea';

export default ExpandableTextarea;
