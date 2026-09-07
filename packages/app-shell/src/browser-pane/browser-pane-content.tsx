import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { createLogger } from '@brainstrike/logging';
import { Button, Input } from '@brainstrike/ui';
import { ArrowLeft, ArrowRight, Plus, RotateCw, X } from 'lucide-react';
import { type FormEvent, type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { useCommandPaletteStore } from '../stores/command-palette-store';
import { useQuickOpenStore } from '../stores/quick-open-store';
import { resolveBrowserBridge } from './browser-bridge';
import { selectActiveBrowserTab, useBrowserTabsStore } from './browser-tabs-store';

/**
 * The embedded browser pane surface (BST-1174). Renders the chrome — tab
 * strip, URL bar, back/forward — as DOM, and reserves an empty region whose
 * on-screen rect it reports to main so the native `WebContentsView` overlays
 * exactly that box.
 *
 * OCCLUSION (novel — a native view paints above all DOM): the pane must hide
 * whenever it would be covered. Four sources, unified into a single
 * `setOccluded`:
 * 1. this nav-rail route is not the active shell tab (its DOM is
 *    `display:none`, so the reserved region reports a zero rect);
 * 2. the Settings modal is open;
 * 3. the command palette is open;
 * 4. Quick Open (Cmd/Ctrl+P) is open — a SEPARATE store from the command
 *    palette, and `QuickOpenHost` portals a full-screen dialog on every route.
 * (Smaller transient overlays — toasts, popovers, page context menus — are a
 * documented follow-up; see the ui-conventions native-layer note.)
 */
const logger = createLogger('BrowserPane');

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
  const occluded = !routeActive || paletteOpen || quickOpenOpen;

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
  const runTabAction = useCallback(
    (action: Promise<unknown>, label: string) => {
      action.catch((error: unknown) => {
        logger.error('Browser pane tab action failed; resyncing tabs', { error, label });
        bridge
          ?.listTabs()
          .then(setTabs)
          .catch((resyncError: unknown) =>
            logger.error('Browser pane tab resync failed', { error: resyncError })
          );
      });
    },
    [bridge, setTabs]
  );

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
      <div className="flex h-8 shrink-0 items-center gap-1 border-border border-b px-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist">
          {tabs.map((tab) => (
            <div
              className={`flex h-6 max-w-40 shrink-0 items-center gap-1 rounded px-2 text-xs ${
                tab.active ? 'bg-muted' : 'hover:bg-muted/50'
              }`}
              key={tab.tabId}
            >
              <button
                aria-selected={tab.active}
                className="min-w-0 truncate"
                data-testid={`browser-tab-${tab.tabId}`}
                onClick={() => runTabAction(bridge.selectTab(tab.tabId), 'selectTab')}
                role="tab"
                type="button"
              >
                {tab.title || tab.url || 'New Tab'}
              </button>
              <button
                aria-label="Close tab"
                className="shrink-0 opacity-60 hover:opacity-100"
                onClick={() => runTabAction(bridge.closeTab(tab.tabId), 'closeTab')}
                type="button"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
        <Button
          aria-label="New tab"
          data-testid="browser-new-tab"
          onClick={() => runTabAction(bridge.createTab(), 'createTab')}
          size="icon-sm"
          variant="ghost"
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
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
      <div className="min-h-0 flex-1" data-testid="browser-pane-viewport" ref={paneRef} />
    </div>
  );
}
