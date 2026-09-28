import {
  type ActionOutcome,
  type ClosedTabHistory,
  createClosedTabHistory,
  NO_CLOSED_TAB_OUTCOME,
} from '@brainstrike/context-actions';
import { getErrorMessage } from '@brainstrike/utils/error-utils';
import { type RefObject, useCallback, useMemo, useState } from 'react';
import { type TabChordStrip, useTabChordStrip } from '../tab-chords/tab-chord-registry';
import type { BrowserBridge } from './browser-bridge';
import { browserTabLabel, liveBrowserTabs } from './browser-tabs-store';

/** What Reopen Closed Tab needs to recreate a browser tab. */
export interface ClosedBrowserTab {
  readonly url: string;
}

/**
 * Close tabs in main and record each one main actually closed, so Reopen
 * Closed Tab can recreate it. Every close is attempted; the promise then
 * rejects once, naming every failure.
 */
export async function closeRecorded(
  bridge: BrowserBridge,
  history: ClosedTabHistory<ClosedBrowserTab>,
  tabIds: readonly string[]
): Promise<void> {
  const before = liveBrowserTabs();
  const results = await Promise.allSettled(tabIds.map((tabId) => bridge.closeTab(tabId)));
  history.record(
    results.flatMap((result, position) => {
      const index = before.findIndex((candidate) => candidate.tabId === tabIds[position]);
      const closed = before[index];
      return result.status === 'fulfilled' && closed ? [{ index, tab: { url: closed.url } }] : [];
    })
  );
  // Every reason goes in the message: the logger serializes errors
  // (message/stack only), so a separate reasons array would not survive.
  const reasons = results.flatMap((result) =>
    result.status === 'rejected' ? [getErrorMessage(result.reason)] : []
  );
  if (reasons.length === 0) {
    return;
  }
  throw new Error(
    reasons.length === 1
      ? reasons.join('')
      : `${reasons.length} of ${tabIds.length} browser tabs failed to close: ${reasons.join('; ')}`
  );
}

interface BrowserTabChordsOptions {
  readonly bridge: BrowserBridge | null;
  /** Focus inside this element scopes chords to the browser strip. */
  readonly paneRootRef: RefObject<HTMLElement | null>;
  readonly runTabAction: (action: Promise<unknown>, label: string) => void;
  readonly settleTabAction: (action: Promise<unknown>, label: string) => Promise<ActionOutcome>;
}

/**
 * The browser pane strip's closed-tab history and its chord registration
 * (BST-1842). Session-only: the history lives and dies with the pane, so it
 * needs no factory-reset wiring. Main creates a reopened tab at the END: the
 * bridge has no reorder operation (spec §8.3), so its old index cannot be
 * restored. Registers nothing without a bridge.
 */
export function useBrowserTabChords({
  bridge,
  paneRootRef,
  runTabAction,
  settleTabAction,
}: BrowserTabChordsOptions): {
  readonly closeTab: (tabId: string) => void;
  readonly closedTabs: ClosedTabHistory<ClosedBrowserTab>;
  readonly hasClosedTabs: () => boolean;
  /** The one reopen ⌘⇧T, the palette and the strip menu share. */
  readonly reopenClosed: () => Promise<ActionOutcome>;
} {
  const [closedTabs] = useState(() => createClosedTabHistory<ClosedBrowserTab>());
  const closeTab = useCallback(
    (tabId: string): void => {
      if (bridge) {
        runTabAction(closeRecorded(bridge, closedTabs, [tabId]), 'closeTab');
      }
    },
    [bridge, closedTabs, runTabAction]
  );

  const hasClosedTabs = useCallback((): boolean => closedTabs.size() > 0, [closedTabs]);
  const reopenClosed = useCallback((): Promise<ActionOutcome> => {
    if (!bridge) {
      return Promise.resolve({ error: 'The browser pane is unavailable', ok: false });
    }
    const closed = closedTabs.pop();
    if (!closed) {
      return Promise.resolve(NO_CLOSED_TAB_OUTCOME);
    }
    const { url } = closed.tab;
    return settleTabAction(
      url === '' ? bridge.createTab() : bridge.createTab(url),
      'reopenClosedTab'
    );
  }, [bridge, closedTabs, settleTabAction]);

  const chordStrip = useMemo<TabChordStrip | null>(() => {
    if (!bridge) {
      return null;
    }
    return {
      activate: (tabId) => runTabAction(bridge.selectTab(tabId), 'selectTab'),
      close: closeTab,
      getActiveId: () => liveBrowserTabs().find((tab) => tab.active)?.tabId ?? null,
      getPanel: () => paneRootRef.current,
      getTabs: () =>
        liveBrowserTabs().map((tab) => ({ id: tab.tabId, label: browserTabLabel(tab) })),
      hasClosedTabs,
      reopenClosed,
    };
  }, [bridge, closeTab, hasClosedTabs, paneRootRef, reopenClosed, runTabAction]);
  useTabChordStrip('browser', chordStrip);

  return { closedTabs, closeTab, hasClosedTabs, reopenClosed };
}
