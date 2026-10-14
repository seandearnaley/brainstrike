import type { KeyboardEvent } from 'react';
import type { ActivityStep } from './activity-trace-model';

/**
 * Keyboard movement inside one activity group. ↑/↓ move between the header
 * and the visible step rows, →/← open and close the focused row, ] and [ move
 * to the next and previous failed step. Typing in a field inside the group is
 * left alone, as is any key with a modifier.
 */
const ROW_SELECTOR = 'button.bs-activity-summary, .bs-activity-body button.bs-step-row';

/** A collapsed body carries `hidden`; folded cluster members are not mounted at all. */
function isShown(element: HTMLElement): boolean {
  return element.closest('[hidden]') === null;
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('input, textarea, select, [contenteditable="true"]') !== null
  );
}

function moveBetweenRows(event: KeyboardEvent<HTMLElement>, current: HTMLElement | null): void {
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(ROW_SELECTOR)].filter(isShown);
  const at = current ? rows.indexOf(current) : -1;
  if (at < 0) {
    return;
  }
  event.preventDefault();
  const next = rows[at + (event.key === 'ArrowDown' ? 1 : -1)];
  next?.focus();
  next?.scrollIntoView?.({ block: 'nearest' });
}

function openOrClose(event: KeyboardEvent<HTMLElement>, current: HTMLElement | null): void {
  if (!current?.matches('button[aria-expanded]')) {
    return;
  }
  event.preventDefault();
  const open = current.getAttribute('aria-expanded') === 'true';
  if ((event.key === 'ArrowRight') !== open) {
    current.click();
  }
}

export function handleActivityGroupKey(
  event: KeyboardEvent<HTMLElement>,
  onFailureJump: (direction: 1 | -1, fromStepId: string | undefined) => boolean
): void {
  if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) {
    return;
  }
  const current = event.target instanceof HTMLElement ? event.target : null;
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp':
      moveBetweenRows(event, current);
      return;
    case 'ArrowRight':
    case 'ArrowLeft':
      openOrClose(event, current);
      return;
    case ']':
    case '[': {
      const from = current?.closest<HTMLElement>('[data-step-id]')?.dataset['stepId'];
      if (onFailureJump(event.key === ']' ? 1 : -1, from)) {
        event.preventDefault();
      }
      return;
    }
    default:
      return;
  }
}

/**
 * The failed step after (or before) `fromStepId` in step order, wrapping
 * around; from no step, the first (or last) failure. Undefined when nothing
 * failed.
 */
export function adjacentFailure(
  steps: readonly ActivityStep[],
  direction: 1 | -1,
  fromStepId: string | undefined
): string | undefined {
  const failed = steps.flatMap((step, index) => (step.state === 'failed' ? [index] : []));
  if (failed.length === 0) {
    return;
  }
  const position = fromStepId ? steps.findIndex((step) => step.id === fromStepId) : -1;
  const next =
    direction === 1
      ? (failed.find((index) => index > position) ?? failed[0])
      : (failed.findLast((index) => position < 0 || index < position) ?? failed.at(-1));
  return next === undefined ? undefined : steps[next]?.id;
}

/** The row standing for `stepId` inside `root`, if it is mounted. */
export function findStepRow(root: HTMLElement, stepId: string): HTMLElement | undefined {
  for (const row of root.querySelectorAll<HTMLElement>('[data-step-id]')) {
    if (row.dataset['stepId'] === stepId) {
      return row;
    }
  }
  return;
}
