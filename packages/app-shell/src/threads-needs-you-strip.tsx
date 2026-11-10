/**
 * The "Needs you" strip above the Threads panel's sections (ADR-0034, owner
 * decisions 2026-11-10): what is waiting on the person shows before where it
 * lives.
 *
 * A short list, not a second tree: each row names a waiting thread and says
 * what it waits for, and opens it. The thread keeps its own row in its
 * section below. The strip is absent when nothing waits.
 *
 * Presentation only. `thread-needs-you.ts` decides which threads are here and
 * why, from the host's committed run state.
 */
import { BellDot } from 'lucide-react';
import type { ReactElement } from 'react';
import {
  THREAD_CONTROL_TITLE_CLASS_NAME,
  THREAD_PANEL_ROW_CLASS_NAME,
} from './assistant-thread-presentation';
import { ThreadIdentityMark, ThreadMarkChip } from './thread-identity-mark';
import type { ThreadNeedsYouReason, ThreadNeedsYouRow } from './thread-needs-you';
import { ThreadSectionHeader } from './thread-section-header';

/**
 * What a row says. The words carry the state here, so the thread's mark shows
 * no status glyph: its own row below keeps the one glyph that means it.
 */
const REASON_LABEL = {
  approval: 'Needs approval',
  failed: 'Failed',
  input: 'Waiting on you',
  plan: 'Plan to review',
  question: 'Asked a question',
  review: 'Ready to review',
  stopped: 'Stopped',
} as const satisfies Record<ThreadNeedsYouReason, string>;

export function ThreadsNeedsYouStrip({
  onSelectThread,
  rows,
}: {
  readonly onSelectThread: (threadId: string) => void;
  readonly rows: readonly ThreadNeedsYouRow[];
}): ReactElement | null {
  if (rows.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="Needs you"
      className="border-border/60 mx-1 shrink-0 border-b pb-1"
      data-testid="threads-needs-you"
    >
      <ThreadSectionHeader
        count={rows.length}
        countTestId="threads-needs-you-count"
        label="Needs you"
        mark={
          <ThreadMarkChip color={null}>
            <BellDot className="size-3" />
          </ThreadMarkChip>
        }
        testId="threads-needs-you-header"
      />
      {/* Bounded, so a long wait list never pushes the sections off the panel;
          every row stays reachable by scrolling it. */}
      <ul className="max-h-40 overflow-y-auto">
        {rows.map(({ reason, thread }) => {
          const label = REASON_LABEL[reason];
          return (
            <li key={thread.id}>
              <button
                aria-label={`${thread.title}: ${label}`}
                className={`${THREAD_PANEL_ROW_CLASS_NAME} focus-visible:ring-ring w-full items-center gap-2 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-inset`}
                data-testid="threads-needs-you-row"
                onClick={() => onSelectThread(thread.id)}
                type="button"
              >
                <ThreadIdentityMark status={null} thread={thread} />
                <span className={`${THREAD_CONTROL_TITLE_CLASS_NAME} flex-1`} title={thread.title}>
                  {thread.title}
                </span>
                <span
                  className="text-muted-foreground text-2xs shrink-0"
                  data-testid="threads-needs-you-reason"
                >
                  {label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
