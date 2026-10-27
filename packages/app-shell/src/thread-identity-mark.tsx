import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import type { AgentColor } from '@brainstrike/types/agent-color';
import type { ReactElement, ReactNode } from 'react';
import {
  getAssistantThreadIconPresentation,
  getThreadTint,
  THREAD_CONTROL_MARK_CLASS_NAME,
  type ThreadRowStatusState,
} from './assistant-thread-presentation';
import { ThreadRowStatusGlyph } from './thread-row-status-glyph';

/**
 * The 20px identity chip every Threads-panel row leads with: a section's, a
 * thread's or a child's icon, tinted with its colour, or the muted icon of
 * something with none. One chip for every level keeps the levels consistent.
 */
export function ThreadMarkChip({
  children,
  color,
  testId,
}: {
  readonly children: ReactNode;
  readonly color: AgentColor | null | undefined;
  readonly testId?: string;
}): ReactElement {
  const tint = getThreadTint(color);
  return (
    <span
      className={`relative ${THREAD_CONTROL_MARK_CLASS_NAME} ${tint.markClassName}`}
      data-testid={testId}
      style={tint.style}
    >
      {children}
    </span>
  );
}

/**
 * A thread's identity: its icon on its colour, with the run-state glyph in the
 * corner. Threads-panel rows and thread tabs render this one control, so a tab
 * and its row read as the same thing (BST-939).
 */
export function ThreadIdentityMark({
  status,
  thread,
}: {
  readonly status: ThreadRowStatusState | null;
  readonly thread: AssistantMemoryThread;
}): ReactElement {
  const icon = getAssistantThreadIconPresentation(thread.metadata?.icon);
  const colorId = thread.metadata?.color ?? null;
  const Icon = icon.iconComponent;
  return (
    <ThreadMarkChip color={colorId} testId={`thread-color-${colorId ?? 'unassigned'}`}>
      <Icon className="size-3" data-testid={`thread-icon-${icon.iconId}`} />
      <ThreadRowStatusGlyph state={status} title={thread.title} />
    </ThreadMarkChip>
  );
}
