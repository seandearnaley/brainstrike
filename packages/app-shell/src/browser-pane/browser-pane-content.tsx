import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import {
  type ActionOutcome,
  type AnyContextAction,
  createTabStripActions,
  defineContextAction,
} from '@brainstrike/context-actions';
import { createLogger } from '@brainstrike/logging';
import {
  Button,
  Input,
  TAB_STRIP_ICON_BUTTON_CLASS_NAME,
  TabStrip,
  type TabStripContextMenu,
  type TabStripItem,
} from '@brainstrike/ui';
import { getErrorMessage } from '@brainstrike/utils/error-utils';
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw } from 'lucide-react';
import {
  type FormEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useCommandPaletteStore } from '../stores/command-palette-store';
import { useQuickOpenStore } from '../stores/quick-open-store';
import { type BrowserBridge, type BrowserTab, resolveBrowserBridge } from './browser-bridge';
import { selectActiveBrowserTab, useBrowserTabsStore } from './browser-tabs-store';

/**
 * The embedded browser pane surface (BST-1174). Renders the chrome — tab
 * strip, URL bar, back/forward — as DOM, and reserves an empty region whose
 * on-screen rect it reports to main so the native `WebContentsView` overlays
 * exactly that box.
 *
 * OCCLUSION (novel — a native view paints above all DOM): the pane must hide
 * whenever it would be covered. Five sources, unified into a single
 * `setOccluded`:
 * 1. this nav-rail route is not the active shell tab (its DOM is
 *    `display:none`, so the reserved region reports a zero rect);
 * 2. Settings is the active shell route (BST-1668 made it a route, not a modal);
 * 3. the command palette is open;
 * 4. Quick Open (Cmd/Ctrl+P) is open — a SEPARATE store from the command
 *    palette, and `QuickOpenHost` portals a full-screen dialog on every route;
 * 5. a tab-strip menu (context or All-tabs) is open — reported by `TabStrip`'s
 *    `onMenuOpenChange` (BST-1840), since those menus drop into the pane.
 * (Other transient overlays — toasts, popovers, page context menus — are a
 * documented follow-up.)
 */
const logger = createLogger('BrowserPane');

/** DOM id of the reserved region: every tab's `aria-controls` target. */
const BROWSER_TAB_PANEL_DOM_ID = 'browser-tab-panel';

function browserTabLabel(tab: Pick<BrowserTab, 'title' | 'url'>): string {
  return tab.title || tab.url || 'New Tab';
}

function toTabStripItem(tab: BrowserTab): TabStripItem {
  return {
    closable: true,
    closeTestId: `browser-tab-close-${tab.tabId}`,
    // A constant icon keeps the label still: the loading status replaces it in place.
    icon: Globe,
    id: tab.tabId,
    label: browserTabLabel(tab),
    panelDomId: BROWSER_TAB_PANEL_DOM_ID,
    status: tab.isLoading ? 'loading' : undefined,
    tabDomId: `browser-tab-${tab.tabId}`,
    testId: `browser-tab-${tab.tabId}`,
    tooltip: tab.url || undefined,
  };
}

/** Main's tab list as last pushed, read live at menu-open and at execution. */
function liveTabs(): readonly BrowserTab[] {
  return useBrowserTabsStore.getState().tabs;
}

function isTabOpen(tabId: string): boolean {
  return liveTabs().some((tab) => tab.tabId === tabId);
}

const STALE_TAB_OUTCOME: ActionOutcome = { error: 'This browser tab is no longer open', ok: false };

/**
 * The strip's menu actions (spec §8.3). Tab management comes from the shared
 * factory; Reload, Duplicate and the strip's New Tab resolve the bridge call
 * into an `ActionOutcome`, so a rejection toasts as well as re-seeding.
 */
function createBrowserTabActions(
  bridge: BrowserBridge,
  settleTabAction: (action: Promise<unknown>, label: string) => Promise<ActionOutcome>
): readonly AnyContextAction[] {
  // Menu closes REJECT on a bridge failure (after settleTabAction has logged
  // and re-seeded), so the shared factory reports them as failed actions.
  const closeTab = async (tabId: string): Promise<void> => {
    const outcome = await settleTabAction(bridge.closeTab(tabId), 'closeTab');
    if (!outcome.ok) {
      throw new Error(outcome.error);
    }
  };
  const closeTabs = async (keep: (tabId: string) => boolean): Promise<void> => {
    await Promise.all(liveTabs().flatMap(({ tabId }) => (keep(tabId) ? [] : [closeTab(tabId)])));
  };
  return [
    ...createTabStripActions({
      close: closeTab,
      closeAll: () => closeTabs(() => false),
      closeOthers: (tabId) => closeTabs((candidate) => candidate === tabId),
      getId: (target) => target.tabId,
      getLabel: browserTabLabel,
      getOrderedIds: () => liveTabs().map((tab) => tab.tabId),
      idPrefix: 'browser-tab',
      kind: 'browser-tab',
      noun: 'browser tab',
    }),
    defineContextAction<'browser-tab'>({
      appliesTo: ['browser-tab'],
      group: 'navigate',
      id: 'browser-tab.reload',
      isEnabled: (target) => isTabOpen(target.tabId),
      label: 'Reload',
      run: (target) =>
        isTabOpen(target.tabId)
          ? settleTabAction(bridge.reload(target.tabId), 'reload')
          : Promise.resolve(STALE_TAB_OUTCOME),
    }),
    defineContextAction<'browser-tab'>({
      appliesTo: ['browser-tab'],
      group: 'navigate',
      id: 'browser-tab.duplicate',
      isEnabled: (target) => isTabOpen(target.tabId),
      label: 'Duplicate',
      run: (target) =>
        isTabOpen(target.tabId)
          ? settleTabAction(bridge.createTab(target.url), 'duplicate')
          : Promise.resolve(STALE_TAB_OUTCOME),
    }),
    defineContextAction<'tab-strip'>({
      appliesTo: ['tab-strip'],
      group: 'primary',
      id: 'browser-tab-strip.new-tab',
      label: 'New Tab',
      run: () => settleTabAction(bridge.createTab(), 'createTab'),
    }),
  ];
}

export function BrowserPaneContent(): ReactElement {
  const bridge = resolveBrowserBridge();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const tabs = useBrowserTabsStore((state) => state.tabs);
  const setTabs = useBrowserTabsStore((state) => state.setTabs);
  const activeTab = useBrowserTabsStore(selectActiveBrowserTab);

  const activeShellTab = usePanelLayoutStore((state) => state.activeTab);
  const paletteOpen = useCommandPaletteStore((state) => state.isOpen);
  const quickOpenOpen = useQuickOpenStore((state) => state.isOpen);
  const routeActive = activeShellTab === 'browser';
  // A COUNT, not a flag: opening the All-tabs menu straight from an open tab
  // menu reports the new open before the old close (Radix reports from commit
  // effects, child before parent), so a flag would reveal the native view over
  // the open All-tabs menu. Each menu's reports strictly alternate.
  const [openStripMenuCount, setOpenStripMenuCount] = useState(0);
  const handleStripMenuOpenChange = useCallback((open: boolean): void => {
    setOpenStripMenuCount((count) => count + (open ? 1 : -1));
  }, []);
  const occluded = !routeActive || paletteOpen || quickOpenOpen || openStripMenuCount > 0;

  // The URL input follows the active tab's url unless the user is editing.
  // `draft === null` means "follow the active tab" (derived, no sync effect);
  // any string is the user's in-progress edit. Cleared to null on submit/blur.
  const [draft, setDraft] = useState<string | null>(null);
  const displayedUrl = draft ?? activeTab?.url ?? '';

  // Subscribe to main's tab-state pushes, then seed from the current list.
  // Subscribe FIRST and skip the seed if ANY push already arrived, so a push
  // during the seed round-trip is never clobbered by the stale snapshot. Track
  // whether a push occurred (not the store length): an authoritative EMPTY push
  // — the last tab closed, or the manager disposed mid-round-trip — must also
  // win, or the seed would resurrect closed tabs whose actions then fail.
  //
  // `cancelled` guards the StrictMode setup→cleanup→setup double-invoke: the
  // first effect's `listTabs()` promise outlives its own unsubscribe, so
  // without this flag a late-resolving first snapshot (whose `pushed` is still
  // false) could overwrite a push the SECOND subscription already applied.
  useEffect(() => {
    if (!bridge) {
      return;
    }
    let pushed = false;
    let cancelled = false;
    const unsubscribe = bridge.onTabsChanged((tabs) => {
      pushed = true;
      setTabs(tabs);
    });
    bridge
      .listTabs()
      .then((seed) => {
        if (!(cancelled || pushed)) {
          setTabs(seed);
        }
      })
      // Best-effort seed, but a rejected round-trip must be attributable, not
      // an anonymous unhandled rejection.
      .catch((error: unknown) => logger.error('Browser pane tab seed failed', { error }));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge, setTabs]);

  // Report bounds (or occlusion) whenever geometry or occlusion changes.
  useEffect(() => {
    const pane = paneRef.current;
    if (!(bridge && pane)) {
      return;
    }
    if (occluded) {
      void bridge.setOccluded(true);
      return;
    }
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = pane.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          void bridge.setOccluded(true);
          return;
        }
        // Position BEFORE revealing: if setOccluded(false) reached main first,
        // the manager would reveal the view at its previous (stale) rect for
        // one IPC tick before this setBounds moved it. Send bounds first so the
        // native view only ever appears at the freshly-measured rect.
        void bridge.setBounds({
          height: Math.round(rect.height),
          width: Math.round(rect.width),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        });
        void bridge.setOccluded(false);
      });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(pane);
    window.addEventListener('resize', report);
    window.addEventListener('scroll', report, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, true);
    };
  }, [bridge, occluded]);

  // On unmount, force-occlude: a WebContentsView paints above ALL DOM, so a
  // pane that unmounts while visible would leave the native view painted over
  // (and swallowing clicks on) whatever replaces it. Runs only on teardown.
  useEffect(
    () => () => {
      void bridge?.setOccluded(true);
    },
    [bridge]
  );

  // A tab action's IPC can reject: double-clicking Close, or any action that
  // races manager disposal, names an unknown tab, and `unwrapBrowserResult`
  // rejects that structured failure. Dropping the promise would surface a
  // global unhandledrejection with no attribution; instead log it AND resync
  // the tab mirror from main's authoritative list — the mirror going stale is
  // exactly what produced the unknown-tab call, so re-seeding recovers it.
  //
  // `settleTabAction` is that same recovery resolved into an `ActionOutcome`,
  // for menu runs that must report the failure as well as recover from it.
  const settleTabAction = useCallback(
    async (action: Promise<unknown>, label: string): Promise<ActionOutcome> => {
      try {
        await action;
        return { ok: true };
      } catch (error: unknown) {
        logger.error('Browser pane tab action failed; resyncing tabs', { error, label });
        bridge
          ?.listTabs()
          .then(setTabs)
          .catch((resyncError: unknown) =>
            logger.error('Browser pane tab resync failed', { error: resyncError })
          );
        return { error: getErrorMessage(error), ok: false };
      }
    },
    [bridge, setTabs]
  );
  const runTabAction = useCallback(
    (action: Promise<unknown>, label: string): void => {
      void settleTabAction(action, label);
    },
    [settleTabAction]
  );

  const stripItems = useMemo(() => tabs.map(toTabStripItem), [tabs]);
  const stripContextMenu = useMemo<TabStripContextMenu | undefined>(() => {
    if (!bridge) {
      return;
    }
    return {
      getStripTarget: () => ({ kind: 'tab-strip', stripId: 'browser' }),
      getTabTarget: (tabId) => {
        const tab = liveTabs().find((candidate) => candidate.tabId === tabId);
        return tab ? { kind: 'browser-tab', tabId, title: tab.title, url: tab.url } : null;
      },
      localActions: createBrowserTabActions(bridge, settleTabAction),
    };
  }, [bridge, settleTabAction]);

  const handleNavigate = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const trimmed = displayedUrl.trim();
      setDraft(null); // back to following the active tab
      if (!(bridge && trimmed)) {
        return;
      }
      if (activeTab) {
        runTabAction(bridge.navigate(activeTab.tabId, trimmed), 'navigate');
      } else {
        runTabAction(bridge.createTab(trimmed), 'createTab');
      }
    },
    [activeTab, bridge, displayedUrl, runTabAction]
  );

  if (!bridge) {
    // Capability gating means this surface is only mounted with a live bridge;
    // this is a defensive fallback, never expected to render.
    return <div className="p-4 text-muted-foreground text-xs">Browser pane unavailable.</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="browser-pane">
      <TabStrip
        activeId={activeTab?.tabId ?? null}
        aria-label="Browser tabs"
        chrome="standalone"
        contextMenu={stripContextMenu}
        items={stripItems}
        onActivate={(tabId) => runTabAction(bridge.selectTab(tabId), 'selectTab')}
        onClose={(tabId) => runTabAction(bridge.closeTab(tabId), 'closeTab')}
        onMenuOpenChange={handleStripMenuOpenChange}
        trailing={
          <Button
            aria-label="New tab"
            className={TAB_STRIP_ICON_BUTTON_CLASS_NAME}
            data-testid="browser-new-tab"
            onClick={() => runTabAction(bridge.createTab(), 'createTab')}
            size="icon-xs"
            title="New tab"
            type="button"
            variant="ghost"
          >
            <Plus className="size-3.5" />
          </Button>
        }
      />
      <div className="flex h-9 shrink-0 items-center gap-1 border-border border-b px-2">
        <Button
          aria-label="Back"
          disabled={!activeTab?.canGoBack}
          onClick={() => activeTab && runTabAction(bridge.goBack(activeTab.tabId), 'goBack')}
          size="icon-sm"
          variant="ghost"
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          aria-label="Forward"
          disabled={!activeTab?.canGoForward}
          onClick={() => activeTab && runTabAction(bridge.goForward(activeTab.tabId), 'goForward')}
          size="icon-sm"
          variant="ghost"
        >
          <ArrowRight className="size-3.5" />
        </Button>
        <Button
          aria-label="Reload"
          disabled={!activeTab}
          onClick={() => activeTab && runTabAction(bridge.reload(activeTab.tabId), 'reload')}
          size="icon-sm"
          variant="ghost"
        >
          <RotateCw className="size-3.5" />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={handleNavigate}>
          <Input
            aria-label="Address"
            className="h-6 text-xs"
            data-testid="browser-url-input"
            onBlur={() => setDraft(null)}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Search or enter address"
            value={displayedUrl}
          />
        </form>
      </div>
      {/* Native WebContentsView overlays exactly this reserved region. */}
      <div
        aria-labelledby={activeTab ? `browser-tab-${activeTab.tabId}` : undefined}
        className="min-h-0 flex-1"
        data-testid="browser-pane-viewport"
        id={BROWSER_TAB_PANEL_DOM_ID}
        ref={paneRef}
        role="tabpanel"
      />
    </div>
  );
}
