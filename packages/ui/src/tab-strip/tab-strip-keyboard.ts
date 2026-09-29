import { moveTabId } from '@brainstrike/context-actions';
import type { KeyboardEvent } from 'react';
import { resolveFocusAfterClose, resolveRovingTargetIndex } from './tab-strip-order';

export interface TabStripKeyboardContext {
  /** Pinned then scroll ids: ONE roving sequence. */
  readonly allIds: readonly string[];
  readonly announce: (message: string) => void;
  readonly close: ((id: string) => void) | null;
  readonly focusFallback: () => void;
  readonly focusTab: (id: string) => void;
  readonly focusTabAfterCommit: (id: string) => void;
  readonly hasContextMenu: boolean;
  readonly isClosable: (id: string) => boolean;
  readonly labelOf: (id: string) => string;
  readonly openContextMenu: (id: string) => void;
  readonly reorder: ((orderedIds: readonly string[]) => void) | null;
  /** Ids the reorder chord may move (the scroll group); pinned tabs never move. */
  readonly reorderableIds: readonly string[];
}

function readTabId(event: KeyboardEvent<HTMLElement>): string | null {
  if (!(event.target instanceof HTMLElement)) {
    return null;
  }
  const tab = event.target.closest<HTMLElement>('[role="tab"][data-strip-tab-id]');
  return tab?.dataset['stripTabId'] ?? null;
}

function isShiftF10(event: KeyboardEvent<HTMLElement>): boolean {
  return event.key === 'F10' && event.shiftKey && !(event.altKey || event.ctrlKey || event.metaKey);
}

function readReorderDirection(event: KeyboardEvent<HTMLElement>): 'left' | 'right' | null {
  if (!(event.altKey && event.shiftKey) || event.ctrlKey || event.metaKey) {
    return null;
  }
  if (event.key === 'ArrowLeft') {
    return 'left';
  }
  return event.key === 'ArrowRight' ? 'right' : null;
}

/** ⌥⇧←/→ on a scroll-group tab: move it, announce the new position, keep focus on it. */
function reorderByKeyboard(
  event: KeyboardEvent<HTMLElement>,
  context: TabStripKeyboardContext,
  id: string,
  direction: 'left' | 'right'
): void {
  if (!(context.reorder && context.reorderableIds.includes(id))) {
    return;
  }
  event.preventDefault();
  const next = moveTabId(context.reorderableIds, id, direction);
  if (!next) {
    return;
  }
  context.reorder(next);
  context.announce(
    `${context.labelOf(id)} moved to position ${next.indexOf(id) + 1} of ${next.length}`
  );
  context.focusTabAfterCommit(id);
}

/** Delete: close a closable tab, then focus the next tab, else the previous, else the fallback. */
function closeByKeyboard(
  event: KeyboardEvent<HTMLElement>,
  context: TabStripKeyboardContext,
  id: string
): void {
  if (!(context.close && context.isClosable(id))) {
    return;
  }
  event.preventDefault();
  const successor = resolveFocusAfterClose(context.allIds, id);
  context.close(id);
  if (successor === null) {
    context.focusFallback();
  } else {
    context.focusTabAfterCommit(successor);
  }
}

/** WAI-ARIA APG tabs keyboard model with manual activation (BST-1836 §6.2). */
export function handleTabStripKeyDown(
  event: KeyboardEvent<HTMLElement>,
  context: TabStripKeyboardContext
): void {
  const id = readTabId(event);
  if (id === null) {
    return;
  }
  if (event.key === 'ContextMenu') {
    // Opened on keyup (handleTabStripKeyUp): Windows Chromium raises its own
    // page menu on the ContextMenu key's keyup, so the strip opens there and
    // prevents both halves.
    if (context.hasContextMenu) {
      event.preventDefault();
    }
    return;
  }
  if (isShiftF10(event)) {
    if (!context.hasContextMenu) {
      return;
    }
    event.preventDefault();
    context.openContextMenu(id);
    return;
  }
  const direction = readReorderDirection(event);
  if (direction) {
    reorderByKeyboard(event, context, id, direction);
    return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return;
  }
  if (event.key === 'Delete') {
    closeByKeyboard(event, context, id);
    return;
  }
  const targetIndex = resolveRovingTargetIndex(
    event.key,
    context.allIds.indexOf(id),
    context.allIds.length
  );
  const targetId = targetIndex === null ? undefined : context.allIds[targetIndex];
  if (targetId === undefined) {
    return;
  }
  event.preventDefault();
  context.focusTab(targetId);
}

/** The ContextMenu key opens the focused tab's menu on keyup (see keydown note). */
export function handleTabStripKeyUp(
  event: KeyboardEvent<HTMLElement>,
  context: Pick<TabStripKeyboardContext, 'hasContextMenu' | 'openContextMenu'>
): void {
  if (event.key !== 'ContextMenu' || !context.hasContextMenu) {
    return;
  }
  const id = readTabId(event);
  if (id === null) {
    return;
  }
  event.preventDefault();
  context.openContextMenu(id);
}
