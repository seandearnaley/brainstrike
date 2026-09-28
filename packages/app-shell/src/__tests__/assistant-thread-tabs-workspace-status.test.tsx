import './assistant-thread-tabs-workspace-test-support';
import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  activeThreadId,
  addThreadRow,
  dbMocks,
  latestRunColumns,
  markRenders,
  mockDb,
  openThreadTabs,
  renderWorkspace,
  threadRows,
} from './assistant-thread-tabs-workspace-test-support';

/**
 * Thread-tab run state (BST-1838, spec §8.1): the Threads panel's three
 * list-wide projections badge each tab through the shared identity mark.
 */
describe('AssistantThreadTabsWorkspace run state', () => {
  it('badges each tab with its run state from the three list-wide projections', async () => {
    addThreadRow('thread-c', 'Release checklist', {
      ...latestRunColumns('thread-c', 'failed', new Date('2026-04-22T11:00:10Z')),
    });
    addThreadRow('thread-d', 'Nightly triage', {
      ...latestRunColumns('thread-d', 'completed', new Date('2026-04-22T11:00:20Z')),
    });
    dbMocks.activeRunRows = [{ threadId: 'thread-a' }];
    dbMocks.awaitingApprovalRows = [{ threadId: 'thread-b' }];
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b', 'thread-c', 'thread-d', 'thread-a');

    // The mark owns the badge (the same glyph as the Threads-panel row); the
    // state reaches the accessible name.
    const running = await screen.findByRole('tab', { name: 'Purchasing app search log, running' });
    expect(within(running).getByTestId('thread-active-spinner')).toBeInTheDocument();
    const needsYou = screen.getByRole('tab', { name: 'Amazon Bedrock Converse, needs your input' });
    expect(within(needsYou).getByTestId('thread-needs-you-glyph')).toBeInTheDocument();
    const failed = screen.getByRole('tab', { name: 'Release checklist, failed' });
    expect(within(failed).getByTestId('thread-failed-glyph')).toBeInTheDocument();
    const finished = screen.getByRole('tab', { name: 'Nightly triage, finished' });
    expect(within(finished).getByTestId('thread-unseen-glyph')).toBeInTheDocument();
  });

  it('surfaces a failed run-state projection instead of presenting its tabs as idle', async () => {
    dbMocks.activeRunError = new Error('runs relation missing');
    dbMocks.activeRunRows = [{ threadId: 'thread-a' }];
    dbMocks.awaitingApprovalRows = [{ threadId: 'thread-a' }];
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });

    const statusError = await screen.findByTestId('assistant-thread-tab-status-error');
    expect(statusError).toHaveAccessibleName(
      'Thread status unavailable. Active thread status unavailable: runs relation missing'
    );
    expect(screen.getByTestId('assistant-thread-tab-strip')).toContainElement(statusError);
    // The healthy projection still badges its tab.
    expect(
      screen.getByRole('tab', { name: 'Purchasing app search log, needs your input' })
    ).toBeInTheDocument();
  });

  it('clears a finished badge once its tab has been viewed, with no Threads panel mounted', async () => {
    addThreadRow('thread-d', 'Nightly triage', {
      ...latestRunColumns('thread-d', 'completed', new Date('2026-04-22T11:00:20Z')),
    });
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    // Activating the tab shows the thread: the strip, not only the Threads
    // panel, must advance its viewed watermark.
    openThreadTabs('thread-d');
    await waitFor(() => expect(activeThreadId()).toBe('thread-d'));

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /Purchasing app search log/ }));
    await waitFor(() => expect(activeThreadId()).toBe('thread-a'));

    expect(screen.getByRole('tab', { name: 'Nightly triage' })).toBeInTheDocument();
    expect(screen.queryByTestId('thread-unseen-glyph')).not.toBeInTheDocument();
  });

  it('re-renders only the marks whose thread status changed when the selection moves', async () => {
    addThreadRow('thread-c', 'Release checklist');
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b', 'thread-c', 'thread-a');
    await waitFor(() => expect(markRenders.get('thread-c')).toBeGreaterThan(0));
    const before = new Map(markRenders);
    const delta = (id: string): number => (markRenders.get(id) ?? 0) - (before.get(id) ?? 0);

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Release checklist' }));
    await waitFor(() => expect(activeThreadId()).toBe('thread-c'));

    // Marks are memoized per (thread, status): the strip's field-equal items
    // let only the old and new active tabs re-render, and even those reuse
    // their mark element, so no mark re-renders on a pure selection change.
    expect(delta('thread-a')).toBe(0);
    expect(delta('thread-b')).toBe(0);
    expect(delta('thread-c')).toBe(0);

    // Positive control: a status change re-renders exactly that thread's mark.
    dbMocks.activeRunRows = [{ threadId: 'thread-b' }];
    openThreadTabs('thread-a');
    await screen.findByRole('tab', { name: 'Amazon Bedrock Converse, running' });
    expect(delta('thread-b')).toBeGreaterThan(0);
    expect(delta('thread-c')).toBe(0);
  });
});

/**
 * The finished/failed badge reads `latestRun` from the loaded thread list, and
 * nothing but a list refresh updates it (BST-1844). The workspace owns ONE
 * live-query-driven refresh on run completions, so the badge follows the run
 * row's terminal write on any platform and with any panel state: the desktop
 * host writes that row after the renderer's own completion callbacks, and a
 * thread that already has its title gets no title write to piggyback on.
 */
describe('AssistantThreadTabsWorkspace run completion', () => {
  const listReads = (): number =>
    mockDb.query.mock.calls.filter(([sql]) => sql.includes('FROM mastra_threads')).length;

  async function renderWithBackgroundThreadB(): Promise<void> {
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b', 'thread-a');
    await screen.findByRole('tab', { name: 'Amazon Bedrock Converse' });
    await waitFor(() => expect(activeThreadId()).toBe('thread-a'));
  }

  /**
   * Any workspace re-render (each call flips the tab order, as an identical one
   * is a store no-op), with the active and so viewed thread unchanged.
   */
  function rerenderWorkspace(): void {
    const flipped = useAssistantThreadStore
      .getState()
      .openThreadIdsByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]?.slice()
      .reverse();
    act(() => {
      useAssistantThreadStore
        .getState()
        .reorderThreadTabs(WORKSPACE_MEMORY_RESOURCE_ID, flipped ?? []);
    });
  }

  it('badges a background thread finished when a terminal run write lands, with no title change', async () => {
    await renderWithBackgroundThreadB();
    expect(screen.queryByTestId('thread-unseen-glyph')).not.toBeInTheDocument();

    // The run row reaches its terminal status: the list read now sees it, and the
    // live query over the runs table delivers a new completion signature.
    Object.assign(
      threadRows.find((row) => row['id'] === 'thread-b') ?? {},
      latestRunColumns('thread-b', 'completed', new Date('2026-04-22T12:00:00Z'))
    );
    dbMocks.runCompletionRows = [{ lastCompletedAt: '2026-04-22 12:00:00+00', terminalCount: 1 }];
    rerenderWorkspace();

    const finished = await screen.findByRole('tab', { name: 'Amazon Bedrock Converse, finished' });
    expect(within(finished).getByTestId('thread-unseen-glyph')).toBeInTheDocument();
  });

  it('badges a failed run the same way', async () => {
    await renderWithBackgroundThreadB();

    Object.assign(
      threadRows.find((row) => row['id'] === 'thread-b') ?? {},
      latestRunColumns('thread-b', 'failed', new Date('2026-04-22T12:00:00Z'))
    );
    dbMocks.runCompletionRows = [{ lastCompletedAt: '2026-04-22 12:00:00+00', terminalCount: 1 }];
    rerenderWorkspace();

    expect(
      await screen.findByRole('tab', { name: 'Amazon Bedrock Converse, failed' })
    ).toBeInTheDocument();
  });

  it('re-reads the thread list once per completion, and not for a projection that did not change', async () => {
    await renderWithBackgroundThreadB();
    const initialReads = listReads();

    // The same signature delivered again (an unrelated write re-ran the query).
    rerenderWorkspace();
    await act(async () => {
      await Promise.resolve();
    });
    expect(listReads()).toBe(initialReads);

    dbMocks.runCompletionRows = [{ lastCompletedAt: '2026-04-22 12:00:00+00', terminalCount: 1 }];
    rerenderWorkspace();
    await waitFor(() => expect(listReads()).toBe(initialReads + 1));
  });
});
