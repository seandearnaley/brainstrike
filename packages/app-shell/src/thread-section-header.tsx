/**
 * The one header row every Threads-panel section renders — a custom group, a
 * folder, a date, Pinned, Ungrouped — in the same 28px row shape, chip and type
 * as the thread rows under it, so the levels read as one tree, the way the
 * explorer's folders and files do.
 */
import type { ReactElement, ReactNode } from 'react';
import { THREAD_PANEL_ROW_CLASS_NAME } from './assistant-thread-presentation';

export function ThreadSectionHeader({
  actions,
  count,
  countTestId,
  label,
  mark,
  muted = false,
  testId,
  title,
}: {
  /** Trailing controls (the section's actions), after the count. */
  readonly actions?: ReactNode;
  readonly count: number;
  readonly countTestId?: string;
  /** The section's name, or a rename form in its place. */
  readonly label: ReactNode;
  /** A `ThreadMarkChip`, so a header leads like the rows under it. */
  readonly mark: ReactNode;
  /** Sections that are a view over threads (dates, Ungrouped) read quieter. */
  readonly muted?: boolean;
  readonly testId: string;
  readonly title?: string | undefined;
}): ReactElement {
  return (
    <div
      className={`${THREAD_PANEL_ROW_CLASS_NAME} items-center gap-2`}
      data-testid={testId}
      title={title}
    >
      {mark}
      {typeof label === 'string' ? (
        <span
          className={`min-w-0 flex-1 truncate font-medium text-xs leading-4 ${muted ? 'text-muted-foreground' : ''}`}
        >
          {label}
        </span>
      ) : (
        label
      )}
      <span
        className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
        data-testid={countTestId}
      >
        {count}
      </span>
      {actions}
    </div>
  );
}
