// @vitest-environment jsdom
import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadNeedsYouRow } from '../thread-needs-you';
import { ThreadsNeedsYouStrip } from '../threads-needs-you-strip';

function thread(id: string, title: string): AssistantMemoryThread {
  const at = new Date('2026-11-10T12:00:00Z');
  return { createdAt: at, id, resourceId: 'workspace', title, updatedAt: at };
}

const ROWS: readonly ThreadNeedsYouRow[] = [
  { reason: 'question', thread: thread('asked', 'Pick a database') },
  { reason: 'approval', thread: thread('approval', 'Run the migration') },
  { reason: 'plan', thread: thread('plan', 'Rework the importer') },
  { reason: 'input', thread: thread('input', 'Older host thread') },
  { reason: 'failed', thread: thread('failed', 'Nightly sync') },
  { reason: 'review', thread: thread('review', 'Fix the flaky test') },
  { reason: 'stopped', thread: thread('stopped', 'Abandoned spike') },
];

describe('ThreadsNeedsYouStrip', () => {
  it('is absent when nothing waits', () => {
    const { container } = render(<ThreadsNeedsYouStrip onSelectThread={vi.fn()} rows={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('lists each waiting thread with what it waits for, and counts them', () => {
    render(<ThreadsNeedsYouStrip onSelectThread={vi.fn()} rows={ROWS} />);

    const strip = screen.getByRole('region', { name: 'Needs you' });
    expect(within(strip).getByTestId('threads-needs-you-count')).toHaveTextContent('7');
    expect(
      within(strip)
        .getAllByTestId('threads-needs-you-row')
        .map((row) => row.textContent)
    ).toEqual([
      'Pick a databaseAsked a question',
      'Run the migrationNeeds approval',
      'Rework the importerPlan to review',
      'Older host threadWaiting on you',
      'Nightly syncFailed',
      'Fix the flaky testReady to review',
      'Abandoned spikeStopped',
    ]);
    // One name for a screen reader: the thread and why it is here.
    expect(
      within(strip).getByRole('button', { name: 'Pick a database: Asked a question' })
    ).toBeVisible();
  });

  it('opens the thread a row names', () => {
    const onSelectThread = vi.fn();
    render(<ThreadsNeedsYouStrip onSelectThread={onSelectThread} rows={ROWS} />);

    fireEvent.click(screen.getByRole('button', { name: 'Nightly sync: Failed' }));

    expect(onSelectThread).toHaveBeenCalledExactlyOnceWith('failed');
  });
});
