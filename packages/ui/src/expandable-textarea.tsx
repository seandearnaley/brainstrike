/**
 * ExpandableTextarea Component
 *
 * An auto-growing textarea that expands from a single line to multiple rows
 * as content is added. Designed for RAG prompts and longer search queries.
 */

import * as React from 'react';
import { cn } from './lib/utils';

const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

export interface ExpandableTextareaProps {
  /** Aria label for accessibility */
  'aria-label'?: string;
  /** Custom class name */
  className?: string;
  /** Whether the textarea is disabled */
  disabled?: boolean;
  /** ID for the textarea */
  id?: string;
  /** Maximum input length */
  maxLength?: number;
  /** Maximum number of rows (default: 6) */
  maxRows?: number;
  /** Fixed minimum height in pixels (overrides minRows calculation) */
  minHeight?: number;
  /** Minimum number of rows (default: 1) */
  minRows?: number;
  /** Callback when value changes */
  onChange: (value: string) => void;
  /** Keyboard event handler */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Current value */
  value: string;
}

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
  minHeight,
  onKeyDown,
  maxLength,
  className,
  disabled = false,
  id,
  'aria-label': ariaLabel,
}: ExpandableTextareaProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const [height, setHeight] = React.useState<number | undefined>(undefined);

  // Cache computed style measurements to avoid layout thrashing on every keystroke.
  const lineHeightRef = React.useRef<number>(20); // Default fallback
  const paddingRef = React.useRef<number>(0);
  const hasMeasuredRef = React.useRef(false);

  // Measure line-height and vertical padding once on mount.
  useIsomorphicLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || hasMeasuredRef.current) {
      return;
    }
    const computedStyle = window.getComputedStyle(textarea);
    const lh = Number.parseInt(computedStyle.lineHeight, 10);
    if (!Number.isNaN(lh)) {
      lineHeightRef.current = lh;
    }
    const pt = Number.parseInt(computedStyle.paddingTop, 10) || 0;
    const pb = Number.parseInt(computedStyle.paddingBottom, 10) || 0;
    paddingRef.current = pt + pb;
    hasMeasuredRef.current = true;
  }, []);

  // Update height when value changes — uses cached measurements to avoid getComputedStyle.
  // useIsomorphicLayoutEffect prevents a visible one-frame flash at 'auto' height.
  useIsomorphicLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const currentLineHeight = lineHeightRef.current;
    const verticalPadding = paddingRef.current;

    // Calculate min and max heights
    // Use provided minHeight prop if available, otherwise calculate from minRows
    const calculatedMinHeight = minHeight ?? currentLineHeight * minRows + verticalPadding;
    const rawMaxHeight = currentLineHeight * maxRows + verticalPadding;
    // Ensure max is never below min to avoid conflicting constraints (e.g. maxRows=1 with minHeight=36)
    const calculatedMaxHeight = Math.max(rawMaxHeight, calculatedMinHeight);

    // Reset height to auto to get accurate scrollHeight
    textarea.style.height = 'auto';
    const scrollHeight = textarea.scrollHeight;

    // When minHeight is explicitly set and content fits in single line, use minHeight
    // This ensures the textarea matches adjacent elements like buttons
    const isSingleLine = !value.includes('\n');
    const useFixedMin =
      minHeight && isSingleLine && scrollHeight <= calculatedMinHeight + currentLineHeight;

    // Clamp to min/max
    const newHeight = useFixedMin
      ? calculatedMinHeight
      : Math.min(Math.max(scrollHeight, calculatedMinHeight), calculatedMaxHeight);
    setHeight(newHeight);
  }, [value, minRows, maxRows, minHeight]);

  // Handle change
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
  };

  // Native default is rows=2 (~56px with py-2 + text-sm), which fights minHeight/maxRows=1.
  // rows=minRows keeps intrinsic height to one row until the measure effect sets inline height.
  // Do not mirror minHeight into style before that effect: the effect sets height to "auto" on the
  // DOM node; if the next render passes the same numeric height, React may skip patching inline
  // style and leave height stuck at "auto".

  return (
    <textarea
      aria-label={ariaLabel}
      className={cn(
        'w-full resize-none transition-[height] duration-150 ease-out',
        'border-input bg-background rounded-md border px-3 py-2',
        'ring-offset-background text-sm',
        'placeholder:text-muted-foreground',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
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
      rows={minRows}
      style={{ height }}
      value={value}
    />
  );
});

ExpandableTextarea.displayName = 'ExpandableTextarea';
