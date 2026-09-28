import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import type { ReactElement } from 'react';
import {
  getAssistantThreadColorSurface,
  getAssistantThreadIconPresentation,
  THREAD_CONTROL_MARK_CLASS_NAME,
  type ThreadRowStatusState,
} from './assistant-thread-presentation';
import { ThreadRowStatusGlyph } from './thread-row-status-glyph';

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
    <span
      className={`relative ${THREAD_CONTROL_MARK_CLASS_NAME} ${getAssistantThreadColorSurface(colorId).markClassName}`}
      data-testid={`thread-color-${colorId ?? 'unassigned'}`}
    >
      <Icon className="size-3" data-testid={`thread-icon-${icon.iconId}`} />
      <ThreadRowStatusGlyph state={status} title={thread.title} />
    </span>
  );
}
