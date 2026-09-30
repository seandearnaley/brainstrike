import './assistant-thread-tabs-workspace-test-support';
import {
  type AssistantThreadRepository,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { getTabChordStrip } from '../tab-chords/tab-chord-registry';
import {
  activeThreadId,
  addThreadRow,
  dbMocks,
  openThreadIds,
  openThreadTabs,
  renderWorkspace,
  setPanelRunning,
  wrapperLifecycle,
} from './assistant-thread-tabs-workspace-test-support';

/**
 * Closing the tab of a RUNNING thread HIDES it (BST-1844, maintainer decision
 * 2026-09-28). The run is owned by that thread's mounted panel: the web local
 * runtime aborts its run when the panel unmounts, and its conversation exists
 * nowhere but in that mounted runtime. So the panel outlives the tab.
 *
 * "Running" is the PANEL's own state (`thread.isRunning`, reported through
 * `onRunningChange`), never the durable run row: the row lags the send (a
 * second live-query instance, created after the row is written) and can
 * outlive the run that wrote it.
 */
describe('AssistantThreadTabsWorkspace closing a running thread', () => {
  async function renderWithRunningThreadB(): Promise<ReturnType<typeof userEvent.setup>> {
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b');
    await screen.findByRole('tab', { name: /Amazon Bedrock Converse/ });
    setPanelRunning('thread-b', true);
    return userEvent.setup();
  }

  it('keeps the panel mounted and hidden, outside the tab strip, when its tab is closed', async () => {
    const user = await renderWithRunningThreadB();

    await user.click(screen.getByTitle('Close Amazon Bedrock Converse'));

    expect(openThreadIds()).toEqual(['thread-a']);
    expect(screen.queryByRole('tab', { name: /Amazon Bedrock Converse/ })).not.toBeInTheDocument();
    const panel = screen.getByTestId('assistant-thread-panel-thread-b');
    expect(panel).toHaveAttribute('hidden');
    expect(within(panel).getByTestId('assistant-thread-wrapper')).toBeInTheDocument();
    expect(within(panel).getByTestId('assistant-thread-wrapper')).toHaveAttribute(
      'data-is-visible',
      'false'
    );
    // No tab labels it, so it must not claim to be one's tabpanel.
    expect(panel).not.toHaveAttribute('aria-labelledby');
    // The wrapper never unmounted: its run was never handed an abort.
    expect(wrapperLifecycle).not.toContain('unmount:thread-b');
    // The panel on screen is still the surviving tab's.
    expect(screen.getByTestId('assistant-thread-panel-thread-a')).toBeVisible();
  });

  it('keeps the panel after the run ends and reuses it, unremounted, when the thread is reopened', async () => {
    const user = await renderWithRunningThreadB();
    await user.click(screen.getByTitle('Close Amazon Bedrock Converse'));
    const panel = screen.getByTestId('assistant-thread-panel-thread-b');

    // The run finishes while the thread is hidden. Web local turns are
    // session-only (assistant-persistence.md), so the finished conversation
    // lives only in this mounted panel until the user comes back to it.
    setPanelRunning('thread-b', false);
    expect(screen.getByTestId('assistant-thread-panel-thread-b')).toBe(panel);
    expect(wrapperLifecycle).not.toContain('unmount:thread-b');

    openThreadTabs('thread-b');

    await waitFor(() => expect(activeThreadId()).toBe('thread-b'));
    const reopened = screen.getByRole('tab', { name: /Amazon Bedrock Converse/ });
    expect(reopened).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('assistant-thread-panel-thread-b')).toBe(panel);
    expect(panel).toBeVisible();
    expect(within(panel).getByTestId('assistant-thread-wrapper')).toHaveAttribute(
      'data-is-visible',
      'true'
    );
    expect(panel).toHaveAttribute('aria-labelledby', reopened.id);
    expect(wrapperLifecycle.filter((entry) => entry.endsWith(':thread-b'))).toEqual([
      'mount:thread-b',
    ]);
  });

  it('releases the retained panel once the reopened thread is closed while idle', async () => {
    const user = await renderWithRunningThreadB();
    await user.click(screen.getByTitle('Close Amazon Bedrock Converse'));
    setPanelRunning('thread-b', false);
    openThreadTabs('thread-b');
    await screen.findByRole('tab', { name: /Amazon Bedrock Converse/ });

    await user.click(screen.getByTitle('Close Amazon Bedrock Converse'));

    // Idle at close: nothing is running, so the tab closes exactly as it always has.
    expect(screen.queryByTestId('assistant-thread-panel-thread-b')).not.toBeInTheDocument();
    expect(wrapperLifecycle).toContain('unmount:thread-b');
  });

  it('closes a thread whose run already ended exactly as an idle one', async () => {
    const user = await renderWithRunningThreadB();
    setPanelRunning('thread-b', false);

    await user.click(screen.getByTitle('Close Amazon Bedrock Converse'));

    // Running once is not running now.
    expect(screen.queryByTestId('assistant-thread-panel-thread-b')).not.toBeInTheDocument();
    expect(wrapperLifecycle).toContain('unmount:thread-b');
  });

  it('does not keep a panel alive for a durable running row its own runtime does not report', async () => {
    dbMocks.activeRunRows = [{ threadId: 'thread-b' }];
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b');
    await screen.findByRole('tab', { name: 'Amazon Bedrock Converse, running' });
    const user = userEvent.setup();

    await user.click(screen.getByTitle('Close Amazon Bedrock Converse'));

    // The row can outlive its run (a reaped orphan) or belong to a host that
    // owns it (desktop): only a run this panel is executing needs the panel.
    expect(screen.queryByTestId('assistant-thread-panel-thread-b')).not.toBeInTheDocument();
    expect(wrapperLifecycle).toContain('unmount:thread-b');
  });

  it('keeps the retained panel when its durable run row flips to terminal', async () => {
    dbMocks.activeRunRows = [{ threadId: 'thread-b' }];
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b');
    await screen.findByRole('tab', { name: 'Amazon Bedrock Converse, running' });
    setPanelRunning('thread-b', true);
    const user = userEvent.setup();
    await user.click(screen.getByTitle('Close Amazon Bedrock Converse'));

    // The row is written and read by machinery of its own (a second live-query
    // instance, a startup reap): its flip says nothing about the conversation
    // that only this mounted panel holds. Any store write re-renders the strip.
    dbMocks.activeRunRows = [];
    openThreadTabs('thread-a');

    expect(screen.getByTestId('assistant-thread-panel-thread-b')).toHaveAttribute('hidden');
    expect(wrapperLifecycle).not.toContain('unmount:thread-b');
  });

  it('forgets a retained thread once it is reopened, so a later removal that skips closeRecorded leaves no panel', async () => {
    const user = await renderWithRunningThreadB();
    await user.click(screen.getByTitle('Close Amazon Bedrock Converse'));
    setPanelRunning('thread-b', false);
    openThreadTabs('thread-b');
    await screen.findByRole('tab', { name: /Amazon Bedrock Converse/ });

    // A direct store close (not the strip's recorded close): nothing reports the
    // removal to the retained set, so reopening must already have released it.
    act(() => {
      useAssistantThreadStore.getState().closeThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
    });

    expect(screen.queryByRole('tab', { name: /Amazon Bedrock Converse/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-thread-panel-thread-b')).not.toBeInTheDocument();
    expect(wrapperLifecycle).toContain('unmount:thread-b');
  });

  it('keeps every running thread and drops every idle one when Close All empties the strip', async () => {
    const user = await renderWithRunningThreadB();

    await user.click(screen.getByRole('button', { name: 'All tabs' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Close All' }));

    expect(openThreadIds()).toEqual([]);
    // The empty state and the hidden running panel coexist.
    expect(screen.getByTestId('assistant-thread-workspace-state')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-thread-panel-thread-b')).toHaveAttribute('hidden');
    expect(screen.queryByTestId('assistant-thread-panel-thread-a')).not.toBeInTheDocument();
    expect(wrapperLifecycle).toContain('unmount:thread-a');
    expect(wrapperLifecycle).not.toContain('unmount:thread-b');
  });

  it('unmounts the retained panel when its thread is deleted', async () => {
    const user = await renderWithRunningThreadB();
    await user.click(screen.getByTitle('Close Amazon Bedrock Converse'));
    expect(screen.getByTestId('assistant-thread-panel-thread-b')).toBeInTheDocument();
    const repository = {
      deleteThread: vi.fn(() => Promise.resolve()),
    } as unknown as AssistantThreadRepository;

    await act(async () => {
      await useAssistantThreadStore
        .getState()
        .deleteThread(repository, WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
    });

    expect(repository.deleteThread).toHaveBeenCalledWith('thread-b');
    expect(screen.queryByTestId('assistant-thread-panel-thread-b')).not.toBeInTheDocument();
    expect(wrapperLifecycle).toContain('unmount:thread-b');
  });
});

/**
 * A panel's scroller keeps its scroll position only while its DOM node stays
 * attached: a browser resets `scrollTop` on any detach, and React detaches a
 * keyed node to move it. So panels render in one list ordered by thread id,
 * which neither a reopen (retained -> open) nor a tab reorder can change.
 */
describe('AssistantThreadTabsWorkspace panel DOM stability', () => {
  const PANEL_TEST_ID = /^assistant-thread-panel-/;

  function panelOrder(): string[] {
    return screen
      .getAllByTestId(PANEL_TEST_ID)
      .map((panel) => panel.dataset['testid']?.replace('assistant-thread-panel-', '') ?? '');
  }

  /** Test ids of every panel node inserted or removed until `stop()` is called. */
  function watchPanelDetaches(): { stop: () => string[] } {
    const detached: string[] = [];
    const collect = (records: readonly MutationRecord[]): void => {
      for (const record of records) {
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          const testId = node instanceof HTMLElement ? node.dataset['testid'] : undefined;
          if (testId && PANEL_TEST_ID.test(testId)) {
            detached.push(testId);
          }
        }
      }
    };
    const observer = new MutationObserver(collect);
    observer.observe(document.body, { childList: true, subtree: true });
    return {
      stop: () => {
        collect(observer.takeRecords());
        observer.disconnect();
        return detached;
      },
    };
  }

  async function renderThreeOpenTabs(): Promise<void> {
    addThreadRow('thread-c', 'Release checklist');
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b', 'thread-c');
    await screen.findByRole('tab', { name: /Release checklist/ });
  }

  it('reopens a retained thread at its old tab index without detaching any panel', async () => {
    await renderThreeOpenTabs();
    const nodesBefore = screen.getAllByTestId(PANEL_TEST_ID);
    setPanelRunning('thread-b', true);
    const user = userEvent.setup();
    const watch = watchPanelDetaches();

    await user.click(screen.getByTitle('Close Amazon Bedrock Converse'));
    await act(async () => {
      await getTabChordStrip('assistant-threads')?.reopenClosed();
    });

    expect(watch.stop()).toEqual([]);
    expect(openThreadIds()).toEqual(['thread-a', 'thread-b', 'thread-c']);
    expect(screen.getAllByTestId(PANEL_TEST_ID)).toEqual(nodesBefore);
  });

  it('reorders tabs without detaching any panel, and orders panels by thread id', async () => {
    await renderThreeOpenTabs();
    const nodesBefore = screen.getAllByTestId(PANEL_TEST_ID);
    const watch = watchPanelDetaches();

    act(() => {
      useAssistantThreadStore
        .getState()
        .reorderThreadTabs(WORKSPACE_MEMORY_RESOURCE_ID, ['thread-c', 'thread-a', 'thread-b']);
    });

    expect(watch.stop()).toEqual([]);
    expect(openThreadIds()).toEqual(['thread-c', 'thread-a', 'thread-b']);
    expect(panelOrder()).toEqual(['thread-a', 'thread-b', 'thread-c']);
    expect(screen.getAllByTestId(PANEL_TEST_ID)).toEqual(nodesBefore);
  });
});
